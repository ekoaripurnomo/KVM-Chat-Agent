import os
import logging
import tempfile
import urllib.request
import urllib.error
from typing import Dict
from urllib.parse import urlparse

from ..config.config import config

logger = logging.getLogger('kvm_mcp')

# Only these schemes are ever fetched. No file://, ftp://, data:, etc.
ALLOWED_SCHEMES = ("http", "https")


def _master_image_dir() -> str:
    """Directory where master/base images are stored.

    Uses config["vm"]["master_image_dir"] when set, otherwise falls back to the
    directory of default_master_image, otherwise disk_path. Overridable via the
    VM_MASTER_IMAGE_DIR environment variable (handled by config loader).
    """
    vm = config.get("vm", {})
    explicit = vm.get("master_image_dir")
    if explicit:
        return explicit
    default_img = vm.get("default_master_image")
    if default_img:
        return os.path.dirname(default_img) or "/iso"
    return vm.get("disk_path", "/vm")


async def download_master_image(arguments: dict = None, **kwargs) -> Dict:
    """Download a master/base image from an http(s) URL into the master-image
    directory on the KVM host.

    Arguments:
      url       (str, required) http/https URL to fetch.
      filename  (str, optional) destination file name. Derived from the URL when
                omitted. The caller (backend) supplies a validated name.
      dest_dir  (str, optional) override destination directory.

    The destination directory is host-side configuration, never invented by the
    LLM. Returns {status, message, path}.
    """
    if arguments is None:
        arguments = kwargs
    try:
        url = arguments.get("url")
        if not url or not isinstance(url, str):
            return {"status": "error", "message": "Download URL is required"}

        parsed = urlparse(url)
        if parsed.scheme.lower() not in ALLOWED_SCHEMES:
            return {
                "status": "error",
                "message": f"Unsupported URL scheme '{parsed.scheme}'. Only http/https are allowed.",
            }
        if not parsed.netloc:
            return {"status": "error", "message": "Invalid URL"}

        dest_dir = arguments.get("dest_dir") or _master_image_dir()
        filename = arguments.get("filename") or os.path.basename(parsed.path)
        if not filename:
            return {"status": "error", "message": "Could not determine a destination file name"}
        # Guard against path traversal — keep only the base name.
        filename = os.path.basename(filename)

        dest_path = os.path.join(dest_dir, filename)

        if not os.path.isdir(dest_dir):
            try:
                os.makedirs(dest_dir, exist_ok=True)
            except OSError as e:
                return {"status": "error", "message": f"Destination directory is not usable: {e}"}

        if os.path.exists(dest_path):
            return {
                "status": "success",
                "message": f"Image already present at {dest_path}",
                "path": dest_path,
                "already_present": True,
            }

        logger.info("Downloading master image from %s to %s", url, dest_path)

        # Stream to a temp file in the destination dir, then atomically rename.
        fd, tmp_path = tempfile.mkstemp(prefix=".dl-", dir=dest_dir)
        os.close(fd)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "kvm-mcp/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 (scheme checked above)
                status = getattr(resp, "status", 200)
                if status and status >= 400:
                    os.unlink(tmp_path)
                    return {"status": "error", "message": f"Download failed: HTTP {status}"}
                total = 0
                with open(tmp_path, "wb") as out:
                    while True:
                        chunk = resp.read(1024 * 256)
                        if not chunk:
                            break
                        out.write(chunk)
                        total += len(chunk)
            # mkstemp creates the file as 0600; make it world-readable so the
            # hypervisor (libvirt-qemu) can read the image without extra ACLs.
            try:
                os.chmod(tmp_path, 0o644)
            except OSError:
                pass
            os.replace(tmp_path, dest_path)
            logger.info("Downloaded %d bytes to %s", total, dest_path)
            return {
                "status": "success",
                "message": f"Downloaded image to {dest_path} ({total} bytes)",
                "path": dest_path,
                "bytes": total,
            }
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            return {"status": "error", "message": f"Download failed: {e}"}
        except Exception as e:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            return {"status": "error", "message": f"Download error: {e}"}

    except Exception as e:
        return {"status": "error", "message": f"Unexpected error: {e}"}
