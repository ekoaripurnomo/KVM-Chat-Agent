# Running the KVM Chat Agent — full sequence

This is the end-to-end startup sequence for the whole system: the KVM host setup,
the MCP server, the backend, and the frontend. Follow the sections in order.

Paths below assume the project is at `/home/ithokben/data/KVM-Chat-Agent` and your
user is `ithokben`. Adjust if yours differ.

---

## 0. One-time host setup (only needed once, for real VM management)

These prepare the KVM host so the agent can actually create VMs. Skip this whole
section if you only run in mock mode (`MCP_MODE=mock`).

### 0.1 Install host tools

```bash
sudo apt-get update
sudo apt-get install -y virtinst libvirt-daemon-system qemu-system-x86 libvirt-dev pkg-config gcc python3-dev
```

- `virtinst` provides `virt-install` (creates the VM).
- `qemu-system-x86` / `libvirt-daemon-system` run the VMs.
- `libvirt-dev`, `pkg-config`, `gcc`, `python3-dev` are needed to build the
  Python `libvirt` binding for the MCP server.

### 0.2 Add your user to the `libvirt` group

```bash
sudo usermod -aG libvirt "$USER"
```

Then **log out and log back in** (or reboot) so the group takes effect.
Verify it is active in your shell:

```bash
id -nG | tr ' ' '\n' | grep libvirt      # must print: libvirt
```

> If `libvirt` does not appear, your session has not picked up the group yet.
> Log out/in. Every process (including the backend) inherits the group from the
> shell that starts it.

### 0.3 Create the image + disk directories (owned by you)

```bash
mkdir -p /home/ithokben/kvm/images /home/ithokben/kvm/disks
```

- `images/` — where the agent downloads master images / ISOs.
- `disks/`  — where per-VM disk files are created.

### 0.4 Let the hypervisor read those directories

VMs run as the `libvirt-qemu` user, which cannot enter your home directory by
default. Grant it traverse access to your home, and read+traverse on the KVM
tree. Use lowercase `rx` (not `rX`) so regular files — the ISO and disk images —
also get read access:

```bash
sudo setfacl -m u:libvirt-qemu:x /home/ithokben
sudo setfacl -R -m u:libvirt-qemu:rx /home/ithokben/kvm
sudo setfacl -R -d -m u:libvirt-qemu:rx /home/ithokben/kvm
```

Verify (the ISO/disk files must show read for libvirt-qemu):

```bash
getfacl /home/ithokben/kvm/images/*.iso | grep libvirt-qemu   # expect user:libvirt-qemu:r--
```

> `rX` (capital) only adds read to directories and already-executable files, so
> plain image files stay unreadable. Use lowercase `rx`. Downloaded images are
> also written world-readable (0644) by the download tool for the same reason.

### 0.5 Set up the MCP server Python environment

```bash
cd /home/ithokben/data/KVM-Chat-Agent/mcp-server
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
```

---

## 1. Configure the backend

```bash
cd /home/ithokben/data/KVM-Chat-Agent/backend
cp ../.env.example .env    # only the first time
```

Edit `backend/.env`. Key settings for **real** mode:

```dotenv
LLM_API_KEY=<your key>
LLM_BASE_URL=http://172.18.101.88:8080/v1
LLM_MODEL=gpt-oss

MCP_MODE=stdio
MCP_SERVER_COMMAND=/home/ithokben/data/KVM-Chat-Agent/mcp-server/.venv/bin/python
MCP_SERVER_ARGS=kvm_mcp_server.py
MCP_SERVER_CWD=/home/ithokben/data/KVM-Chat-Agent/mcp-server

# The install image used by create_vm.
#   *.iso   -> ISO install (boots the installer via VNC)
#   *.qcow2 -> master-image import (Fedora CoreOS style)
MCP_DEFAULT_MASTER_IMAGE=/home/ithokben/kvm/images/ubuntu-22.04.1-live-server-amd64.iso
MCP_MASTER_IMAGE_DIR=/home/ithokben/kvm/images

# Network bridge VMs attach to. Must be a bridge that exists on the host.
# 'virbr0' is libvirt's built-in NAT bridge (check: virsh net-list --all).
DEFAULT_NETWORK=virbr0
```

> The network must be a real bridge on your host. Check with
> `ip -o link show type bridge` or `virsh -c qemu:///system net-list --all`.
> `virbr0` (the libvirt default NAT network) works out of the box. If you use a
> custom bridge like `brforvms`, create it first or VM creation fails with
> `Cannot get interface MTU on '<name>': No such device`.

For a safe demo without KVM, instead set `MCP_MODE=mock` and skip section 0.

Install backend dependencies (first time only):

```bash
npm install
```

---

## 2. Start the backend  (Terminal 1)

The backend spawns the MCP server automatically — you do NOT start the MCP
server yourself.

The shell that starts the backend MUST have the `libvirt` group active
(section 0.2). If you have logged out/in since adding the group, just run:

```bash
cd /home/ithokben/data/KVM-Chat-Agent/backend
npm run dev
```

If you have NOT logged out/in yet, activate the group for this shell first:

```bash
cd /home/ithokben/data/KVM-Chat-Agent/backend
newgrp libvirt        # opens a shell with the group active
npm run dev           # run this in that same shell
```

Expected output:

```
[mcp] connected in "stdio" mode
[server] KVM Chat Agent listening on http://localhost:8787
[server] MCP mode: stdio
```

Verify libvirt access (should list your real VMs, empty is fine):

```bash
curl http://localhost:8787/api/vms          # {"vms":[...]}
curl http://localhost:8787/api/health        # {"status":"ok","mcp":"stdio","llm":"configured"}
```

> If you see `libvirt-sock ... Permission denied`, the backend was started
> without the `libvirt` group. Stop it and restart via `newgrp libvirt` (above).

---

## 3. Start the frontend  (Terminal 2)

```bash
cd /home/ithokben/data/KVM-Chat-Agent/frontend
npm install            # first time only
npm run dev            # http://localhost:5173
```

Open http://localhost:5173 in your browser.

---

## 4. Use it

Type (or click a suggestion), e.g.:

> Buat VM Ubuntu 22.04, 2 core, 4GB RAM, 40 GB disk, nama web-01.

Confirm the proposal. For an **ISO** image the VM boots the installer — connect
to its VNC console to finish the OS install.

Other things you can ask:
- `tampilkan list vm` — list VMs
- `unduh master image dari https://.../image.iso` — download an image (asks for
  confirmation, saves into `MCP_MASTER_IMAGE_DIR`)

---

## Quick restart (after the one-time setup is done)

1. Terminal 1: `cd backend && npm run dev`  (in a `libvirt`-group session)
2. Terminal 2: `cd frontend && npm run dev`
3. Browser: http://localhost:5173

---

## Troubleshooting

| Symptom (shown in chat / logs)                          | Fix |
| ------------------------------------------------------- | --- |
| `virt-install is not installed`                         | `sudo apt-get install -y virtinst` |
| `libvirt-sock ... Permission denied`                    | Start backend in a shell with `libvirt` group active (0.2 / `newgrp libvirt`) |
| `Cannot access storage file ... Permission denied` or `grant the 'libvirt-qemu' user search permissions` | Run the `setfacl` commands in 0.4 |
| `Master image ... does not exist`                       | Point `MCP_DEFAULT_MASTER_IMAGE` at an existing file |
| `Cannot get interface MTU on '<name>': No such device`  | The bridge doesn't exist. Set `DEFAULT_NETWORK` to a real bridge (e.g. `virbr0`) and restart backend |
| Agent reports a `demo-vm-01`                            | Backend is in `MCP_MODE=mock`; switch to `stdio` and restart |
| `/api/health` shows `"llm":"missing"`                   | Set `LLM_API_KEY` in `backend/.env` |
| `Disk image ... already exists`                         | A prior attempt left a disk; remove it from `~/kvm/disks/` or use a new VM name |

Create failures now show the real technical detail directly in the chat, and the
backend also logs it to Terminal 1.
