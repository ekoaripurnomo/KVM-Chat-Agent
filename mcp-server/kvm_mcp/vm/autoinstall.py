import os
import re
import shlex
import logging
import tempfile
import subprocess

logger = logging.getLogger('kvm_mcp')


def hash_password(plaintext: str) -> str:
    """Return a SHA-512 crypt hash suitable for cloud-init `passwd`.

    Uses `openssl passwd -6` because Python's `crypt` module was removed in
    3.13+. The plaintext is passed via stdin, never on the command line.
    """
    result = subprocess.run(
        ["openssl", "passwd", "-6", "-stdin"],
        input=plaintext,
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(f"Failed to hash password: {result.stderr.strip()}")
    return result.stdout.strip()


def _yaml_quote(s: str) -> str:
    """Quote a value for safe embedding in our generated YAML."""
    return '"' + str(s).replace('\\', '\\\\').replace('"', '\\"') + '"'


def build_user_data(hostname: str, username: str, password_hash: str, ssh_key: str = "") -> str:
    """Generate an Ubuntu autoinstall user-data document (cloud-init NoCloud).

    The Ubuntu live-server installer detects a NoCloud source labelled `cidata`
    and runs unattended using the `autoinstall` section.
    """
    ssh_block = ""
    if ssh_key:
        ssh_block = (
            "    ssh:\n"
            "      install-server: true\n"
            "      allow-pw: true\n"
            f"      authorized-keys:\n        - {_yaml_quote(ssh_key)}\n"
        )
    else:
        ssh_block = "    ssh:\n      install-server: true\n      allow-pw: true\n"

    return (
        "#cloud-config\n"
        "autoinstall:\n"
        "  version: 1\n"
        "  locale: en_US.UTF-8\n"
        "  keyboard:\n"
        "    layout: us\n"
        "  identity:\n"
        f"    hostname: {_yaml_quote(hostname)}\n"
        f"    username: {_yaml_quote(username)}\n"
        f"    password: {_yaml_quote(password_hash)}\n"
        f"{ssh_block}"
        "  storage:\n"
        "    layout:\n"
        "      name: direct\n"
        "  updates: security\n"
        "  shutdown: reboot\n"
    )


def build_seed_iso(dest_dir: str, vm_name: str, user_data: str) -> str:
    """Write user-data + meta-data and pack them into a `cidata` ISO.

    Returns the path to the generated seed ISO. Uses xorriso (present on the
    host); the volume label MUST be `cidata` for cloud-init NoCloud detection.
    """
    seed_path = os.path.join(dest_dir, f"{vm_name}-seed.iso")
    meta_data = f"instance-id: {vm_name}\nlocal-hostname: {vm_name}\n"

    with tempfile.TemporaryDirectory() as tmp:
        ud = os.path.join(tmp, "user-data")
        md = os.path.join(tmp, "meta-data")
        with open(ud, "w") as f:
            f.write(user_data)
        with open(md, "w") as f:
            f.write(meta_data)

        cmd = [
            "xorriso", "-as", "mkisofs",
            "-output", seed_path,
            "-volid", "cidata",
            "-joliet", "-rock",
            ud, md,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            raise RuntimeError(f"Failed to build seed ISO: {result.stderr.strip()}")

    try:
        os.chmod(seed_path, 0o644)
    except OSError:
        pass
    return seed_path


VALID_USERNAME = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")


def valid_username(name: str) -> bool:
    return bool(name and VALID_USERNAME.match(name))
