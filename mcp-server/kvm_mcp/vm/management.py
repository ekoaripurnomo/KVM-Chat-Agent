import libvirt
import logging
import subprocess
import json
from typing import Dict, Optional

from ..connection.pool import connection_pool
from ..cache.vm_cache import vm_info_cache
from ..utils.decorators import timing_decorator

logger = logging.getLogger('kvm_mcp')

@timing_decorator
async def list_vms(use_cache: bool = True) -> list:
    """List all available virtual machines"""
    if use_cache:
        cached_list = vm_info_cache.get("_all_vms_")
        if cached_list:
            logger.debug("Returning cached VM list")
            return cached_list
    
    logger.info("Fetching VM list from libvirt")
    async with connection_pool.get_connection() as conn:
        domains = conn.listAllDomains()
        result = []
        for domain in domains:
            try:
                state, reason = domain.state()
                state_str = {
                    libvirt.VIR_DOMAIN_NOSTATE: "no state",
                    libvirt.VIR_DOMAIN_RUNNING: "running",
                    libvirt.VIR_DOMAIN_BLOCKED: "blocked",
                    libvirt.VIR_DOMAIN_PAUSED: "paused",
                    libvirt.VIR_DOMAIN_SHUTDOWN: "shutdown",
                    libvirt.VIR_DOMAIN_SHUTOFF: "shutoff",
                    libvirt.VIR_DOMAIN_CRASHED: "crashed",
                    libvirt.VIR_DOMAIN_PMSUSPENDED: "suspended"
                }.get(state, "unknown")
                
                vm_info = {
                    "name": domain.name(),
                    "id": domain.ID(),
                    "state": state_str,
                    "autostart": domain.autostart(),
                    "persistent": domain.isPersistent()
                }
                result.append(vm_info)
            except libvirt.libvirtError as e:
                logger.error(f"Error getting info for domain {domain.name()}: {str(e)}")
    
    if use_cache:
        vm_info_cache.set("_all_vms_", result)
    return result

@timing_decorator
async def start_vm(vm_name: str) -> Dict:
    """Start a virtual machine"""
    async with connection_pool.get_connection() as conn:
        try:
            domain = conn.lookupByName(vm_name)
            if domain.isActive():
                return {"success": False, "error": "VM is already running"}
            
            domain.create()
            vm_info_cache.invalidate(vm_name)
            vm_info_cache.invalidate("_all_vms_")
            
            return {"success": True, "message": f"VM {vm_name} started successfully"}
        except libvirt.libvirtError as e:
            return {"success": False, "error": f"Failed to start VM: {str(e)}"}

@timing_decorator
async def stop_vm(vm_name: str, force: bool = False) -> Dict:
    """Stop a virtual machine"""
    async with connection_pool.get_connection() as conn:
        try:
            domain = conn.lookupByName(vm_name)
            if not domain.isActive():
                return {"success": False, "error": "VM is not running"}
            
            if force:
                domain.destroy()
            else:
                domain.shutdown()
            
            vm_info_cache.invalidate(vm_name)
            vm_info_cache.invalidate("_all_vms_")
            
            return {"success": True, "message": f"VM {vm_name} {'destroyed' if force else 'shutdown'} successfully"}
        except libvirt.libvirtError as e:
            return {"success": False, "error": f"Failed to stop VM: {str(e)}"}

@timing_decorator
async def reboot_vm(vm_name: str) -> Dict:
    """Reboot a virtual machine"""
    async with connection_pool.get_connection() as conn:
        try:
            domain = conn.lookupByName(vm_name)
            if not domain.isActive():
                return {"success": False, "error": "VM is not running"}
            
            domain.reboot()
            vm_info_cache.invalidate(vm_name)
            vm_info_cache.invalidate("_all_vms_")
            
            return {"success": True, "message": f"VM {vm_name} rebooted successfully"}
        except libvirt.libvirtError as e:
            return {"success": False, "error": f"Failed to reboot VM: {str(e)}"}

def get_vm_ip(domain) -> Optional[str]:
    """Get the IP address of a VM using virsh domifaddr"""
    try:
        cmd = ["virsh", "domifaddr", domain.name()]
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode != 0:
            logger.error(f"Failed to get VM IP: {result.stderr}")
            return None
        
        # Parse the output to find the IP address
        lines = result.stdout.strip().split('\n')
        if len(lines) < 3:  # Need at least header + separator + data
            return None
        
        for line in lines[2:]:  # Skip header and separator
            parts = line.split()
            if len(parts) >= 4:
                ip = parts[3].split('/')[0]  # Remove CIDR notation if present
                return ip
        
        return None
    except Exception as e:
        logger.error(f"Error getting VM IP: {str(e)}")
        return None


def _parse_domifaddr(vm_name: str, source: str) -> list:
    """Run `virsh domifaddr <vm> [--source <source>]` and return IPv4 addresses."""
    cmd = ["virsh", "domifaddr", vm_name]
    if source:
        cmd += ["--source", source]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except Exception as e:
        logger.debug("domifaddr (%s) failed for %s: %s", source or "lease", vm_name, e)
        return []
    if result.returncode != 0:
        return []
    ips = []
    for line in result.stdout.strip().split('\n')[2:]:  # skip header + separator
        parts = line.split()
        if len(parts) >= 4 and parts[3] not in ("N/A", "-"):
            ip = parts[3].split('/')[0]
            if ip and ip not in ips:
                ips.append(ip)
    return ips


@timing_decorator
async def delete_vm(vm_name: str, remove_disks: bool = True) -> Dict:
    """Delete a VM: stop it if running, undefine the domain, and (optionally)
    remove its disk image and autoinstall seed ISO from the disk directory.

    This is destructive and irreversible. The backend only calls it after an
    explicit user confirmation.
    """
    if not vm_name or not isinstance(vm_name, str):
        return {"status": "error", "message": "vm_name is required"}

    removed = []
    async with connection_pool.get_connection() as conn:
        try:
            domain = conn.lookupByName(vm_name)
        except libvirt.libvirtError:
            return {"status": "error", "message": f"VM {vm_name} not found"}

        # Collect disk paths from the domain XML before undefining it.
        disk_paths = []
        try:
            import xml.etree.ElementTree as ET
            root = ET.fromstring(domain.XMLDesc())
            for disk in root.findall("./devices/disk"):
                dev = disk.get("device")
                src = disk.find("source")
                if src is None:
                    continue
                path = src.get("file")
                if not path:
                    continue
                # Remove VM disk images and our generated seed ISOs, never the
                # shared installer ISO / master image.
                if dev == "disk" or path.endswith("-seed.iso"):
                    disk_paths.append(path)
        except Exception as e:
            logger.warning("Could not parse disks for %s: %s", vm_name, e)

        try:
            if domain.isActive():
                domain.destroy()
            # Undefine, removing any NVRAM too.
            try:
                domain.undefineFlags(getattr(libvirt, "VIR_DOMAIN_UNDEFINE_NVRAM", 0))
            except Exception:
                domain.undefine()
        except libvirt.libvirtError as e:
            return {"status": "error", "message": f"Failed to delete VM: {str(e)}"}

    vm_info_cache.invalidate(vm_name)
    vm_info_cache.invalidate("_all_vms_")

    if remove_disks:
        import os
        for path in disk_paths:
            try:
                if os.path.exists(path):
                    os.unlink(path)
                    removed.append(path)
            except OSError as e:
                logger.warning("Could not remove %s: %s", path, e)

    return {
        "status": "success",
        "message": f"VM {vm_name} deleted",
        "removed": removed,
    }


@timing_decorator
async def get_vm_access(vm_name: str) -> Dict:
    """Return access info for a VM: running state and any known IPv4 addresses.

    IPs are discovered via the DHCP lease table first, then the qemu guest agent
    (if installed in the guest). Credentials are NOT returned — the server does
    not know guest passwords for interactively-installed VMs.
    """
    if not vm_name or not isinstance(vm_name, str):
        return {"status": "error", "message": "vm_name is required"}
    async with connection_pool.get_connection() as conn:
        try:
            domain = conn.lookupByName(vm_name)
        except libvirt.libvirtError:
            return {"status": "error", "message": f"VM {vm_name} not found"}
        active = domain.isActive()

    # IP lookups shell out to virsh; try the lease table then the guest agent.
    ips = _parse_domifaddr(vm_name, "") or _parse_domifaddr(vm_name, "lease")
    source = "lease" if ips else None
    if not ips:
        agent_ips = _parse_domifaddr(vm_name, "agent")
        if agent_ips:
            ips = agent_ips
            source = "agent"

    return {
        "status": "success",
        "name": vm_name,
        "active": bool(active),
        "ips": ips,
        "ip_source": source,
    }