import os
import json
import logging
import subprocess
import tempfile
from typing import Dict

from .ignition import generate_ignition_config
from .autoinstall import hash_password, build_user_data, build_seed_iso, valid_username
from ..config.config import config

logger = logging.getLogger('kvm_mcp')

INVALID_NAME_CHARS = "!@#$%^&*()+={}[]|\\:;\"'<>?/"


def _disk_dir() -> str:
    """Directory where per-VM disk images are created."""
    return config.get("vm", {}).get("disk_path", "/vm")


def _validate_common(vm_name, memory, vcpus, disk_size, network):
    """Shared parameter validation. Returns an error dict or None."""
    if not vm_name or not isinstance(vm_name, str):
        return {"status": "error", "message": "Invalid VM name"}
    if any(c in INVALID_NAME_CHARS for c in vm_name):
        return {"status": "error", "message": "VM name contains invalid characters"}
    if not isinstance(memory, int) or memory < 256:
        return {"status": "error", "message": "Memory must be at least 256MB"}
    if memory > 1024 * 1024:
        return {"status": "error", "message": "Memory exceeds maximum limit of 1TB"}
    if not isinstance(vcpus, int) or vcpus < 1:
        return {"status": "error", "message": "Must have at least 1 vCPU"}
    if vcpus > 128:
        return {"status": "error", "message": "vCPUs exceed maximum limit of 128"}
    if not isinstance(disk_size, int) or disk_size < 1:
        return {"status": "error", "message": "Disk size must be at least 1GB"}
    if disk_size > 10000:
        return {"status": "error", "message": "Disk size exceeds maximum limit of 10TB"}
    if not network or not isinstance(network, str):
        return {"status": "error", "message": "Invalid network name"}
    return None


async def create_vm(arguments: dict = None, **kwargs) -> Dict:
    """Create a new VM using virt-install.

    Two installation modes are supported, chosen by which argument is present:

    - ISO install (``install_iso``): boots an installer ISO via ``--cdrom`` onto
      a fresh blank disk. This is the general-purpose path (Ubuntu, Debian, etc.).
    - Master-image import (``master_image``): creates a qcow2 disk backed by a
      base image and boots it directly with ``--import`` plus an Ignition config
      (Fedora CoreOS style).

    Accepts either a single ``arguments`` dict or keyword arguments.
    """
    if arguments is None:
        arguments = kwargs
    try:
        vm_name = arguments.get("name")
        memory = arguments.get("memory")
        vcpus = arguments.get("vcpus")
        disk_size = arguments.get("disk_size", 20)
        network = arguments.get("network", "brforvms")
        os_variant = arguments.get("os_variant", "generic")
        install_iso = arguments.get("install_iso")
        master_image = arguments.get("master_image")

        err = _validate_common(vm_name, memory, vcpus, disk_size, network)
        if err:
            return err

        # Determine installation mode. install_iso takes precedence.
        if install_iso:
            if not os.path.exists(install_iso):
                return {"status": "error", "message": f"Installer ISO {install_iso} does not exist"}
            mode = "iso"
        elif master_image:
            if not os.path.exists(master_image):
                return {"status": "error", "message": f"Master image {master_image} does not exist"}
            mode = "master_image"
        else:
            return {
                "status": "error",
                "message": "Either install_iso or master_image must be provided",
            }

        # Prepare disk path in the configured disk directory.
        disk_dir = _disk_dir()
        try:
            os.makedirs(disk_dir, exist_ok=True)
        except OSError as e:
            return {"status": "error", "message": f"Disk directory {disk_dir} is not usable: {e}"}
        disk_path = os.path.join(disk_dir, f"{vm_name}.qcow2")
        if os.path.exists(disk_path):
            return {"status": "error", "message": f"Disk image {disk_path} already exists"}

        if mode == "iso":
            # Unattended (autoinstall) when credentials are supplied.
            username = arguments.get("username")
            password = arguments.get("password")
            password_hash = arguments.get("password_hash")
            if username and (password or password_hash):
                if not valid_username(username):
                    return {"status": "error", "message": "Invalid username"}
                return _create_from_iso_autoinstall(
                    vm_name, memory, vcpus, disk_size, network, os_variant, install_iso,
                    disk_path, disk_dir, username, password, password_hash,
                    arguments.get("hostname") or vm_name, arguments.get("ssh_key", ""),
                )
            return _create_from_iso(
                vm_name, memory, vcpus, disk_size, network, os_variant, install_iso, disk_path
            )
        return _create_from_master_image(
            vm_name, memory, vcpus, disk_size, network, os_variant,
            master_image, disk_path, arguments.get("ignition"),
        )

    except Exception as e:
        return {"status": "error", "message": f"Unexpected error: {str(e)}"}


def _create_from_iso(vm_name, memory, vcpus, disk_size, network, os_variant, iso, disk_path) -> Dict:
    """Create a VM that boots an installer ISO onto a fresh blank disk."""
    result = subprocess.run(
        ["qemu-img", "create", "-f", "qcow2", disk_path, f"{disk_size}G"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return {"status": "error", "message": f"Failed to create disk image: {result.stderr}"}

    virtinstall_cmd = [
        "virt-install",
        "--connect=qemu:///system",
        f"--name={vm_name}",
        f"--memory={memory}",
        f"--vcpus={vcpus}",
        f"--os-variant={os_variant}",
        f"--disk=path={disk_path},format=qcow2,bus=virtio",
        f"--cdrom={iso}",
        f"--network=bridge={network},model=virtio",
        "--graphics=vnc,listen=0.0.0.0",
        "--noautoconsole",
    ]
    try:
        result = subprocess.run(virtinstall_cmd, capture_output=True, text=True)
    except FileNotFoundError:
        _cleanup_disk(disk_path)
        return {
            "status": "error",
            "message": "virt-install is not installed on the host (package 'virtinst').",
        }
    except Exception as e:
        _cleanup_disk(disk_path)
        return {"status": "error", "message": f"virt-install error: {e}"}
    if result.returncode != 0:
        _cleanup_disk(disk_path)
        return {"status": "error", "message": f"virt-install failed: {result.stderr}"}

    return {
        "status": "success",
        "message": f"VM {vm_name} created from ISO. Boot the installer via VNC to complete setup.",
    }


def _create_from_iso_autoinstall(
    vm_name, memory, vcpus, disk_size, network, os_variant, iso, disk_path, disk_dir,
    username, password, password_hash, hostname, ssh_key,
) -> Dict:
    """Unattended Ubuntu install: build a cloud-init `cidata` seed ISO and boot
    the installer with it attached. The installer detects NoCloud and installs
    without interaction, creating the given user with the given password."""
    # Hash the password if only plaintext was provided (hashing happens here,
    # host-side; plaintext never lands in the VM config or logs).
    try:
        if not password_hash:
            password_hash = hash_password(password)
    except Exception as e:
        return {"status": "error", "message": f"Failed to hash password: {e}"}

    # Create the target disk.
    result = subprocess.run(
        ["qemu-img", "create", "-f", "qcow2", disk_path, f"{disk_size}G"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return {"status": "error", "message": f"Failed to create disk image: {result.stderr}"}

    # Build the seed ISO.
    try:
        user_data = build_user_data(hostname, username, password_hash, ssh_key)
        seed_iso = build_seed_iso(disk_dir, vm_name, user_data)
    except Exception as e:
        _cleanup_disk(disk_path)
        return {"status": "error", "message": f"Failed to build autoinstall seed: {e}"}

    virtinstall_cmd = [
        "virt-install",
        "--connect=qemu:///system",
        f"--name={vm_name}",
        f"--memory={memory}",
        f"--vcpus={vcpus}",
        f"--os-variant={os_variant}",
        f"--disk=path={disk_path},format=qcow2,bus=virtio",
        # Boot the installer ISO; attach the seed as a second cdrom.
        f"--disk=path={iso},device=cdrom,bus=sata",
        f"--disk=path={seed_iso},device=cdrom,bus=sata",
        "--boot=cdrom,hd",
        f"--network=bridge={network},model=virtio",
        "--graphics=vnc,listen=0.0.0.0",
        "--noautoconsole",
        # Do not wait; the install runs unattended in the background.
        "--wait=0",
    ]
    try:
        result = subprocess.run(virtinstall_cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        # virt-install may block until install finishes; --wait=0 should avoid
        # this, but guard anyway. The domain is defined and installing.
        return {
            "status": "success",
            "message": f"VM {vm_name} sedang menginstal Ubuntu tanpa pengawasan.",
            "autoinstall": True,
            "username": username,
        }
    except FileNotFoundError:
        _cleanup_disk(disk_path)
        _cleanup_disk(seed_iso)
        return {"status": "error", "message": "virt-install is not installed on the host (package 'virtinst')."}
    if result.returncode != 0:
        _cleanup_disk(disk_path)
        _cleanup_disk(seed_iso)
        return {"status": "error", "message": f"virt-install failed: {result.stderr}"}

    return {
        "status": "success",
        "message": f"VM {vm_name} sedang menginstal Ubuntu tanpa pengawasan (autoinstall).",
        "autoinstall": True,
        "username": username,
    }


def _create_from_master_image(
    vm_name, memory, vcpus, disk_size, network, os_variant, master_image, disk_path, ignition
) -> Dict:
    """Create a VM from a qcow2 master image using Ignition (Fedora CoreOS style)."""
    if not ignition or not isinstance(ignition, dict):
        return {"status": "error", "message": "Ignition config must be provided as a dict"}

    result = subprocess.run(
        ["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", master_image, disk_path, f"{disk_size}G"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return {"status": "error", "message": f"Failed to create disk image: {result.stderr}"}

    ign_path = None
    try:
        ignition_config = generate_ignition_config(vm_name, ignition)
        with tempfile.NamedTemporaryFile("w", delete=False, suffix=".ign") as ign_file:
            ign_file.write(ignition_config)
            ign_path = ign_file.name

        try:
            subprocess.run(["chcon", "--verbose", "--type", "svirt_home_t", ign_path], check=False)
        except Exception:
            pass

        virtinstall_cmd = [
            "virt-install",
            "--connect=qemu:///system",
            f"--name={vm_name}",
            f"--memory={memory}",
            f"--vcpus={vcpus}",
            f"--os-variant={os_variant}",
            "--import",
            f"--disk=path={disk_path},format=qcow2,bus=virtio",
            f"--network=bridge={network},model=virtio",
            "--graphics=vnc,listen=0.0.0.0",
            f"--qemu-commandline=optargs='-fw_cfg name=opt/com.coreos/config,file={ign_path}'",
        ]
        try:
            result = subprocess.run(virtinstall_cmd, capture_output=True, text=True)
        except FileNotFoundError:
            os.unlink(ign_path)
            _cleanup_disk(disk_path)
            return {
                "status": "error",
                "message": "virt-install is not installed on the host (package 'virtinst').",
            }
        if result.returncode != 0:
            os.unlink(ign_path)
            _cleanup_disk(disk_path)
            return {"status": "error", "message": f"virt-install failed: {result.stderr}"}

        os.unlink(ign_path)
        return {"status": "success", "message": f"VM {vm_name} created successfully using virt-install"}

    except Exception as e:
        if ign_path and os.path.exists(ign_path):
            try:
                os.unlink(ign_path)
            except OSError:
                pass
        _cleanup_disk(disk_path)
        return {"status": "error", "message": f"Error during VM creation: {str(e)}"}


def _cleanup_disk(disk_path: str) -> None:
    try:
        if os.path.exists(disk_path):
            os.unlink(disk_path)
    except OSError:
        pass
