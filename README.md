# KVM Chat Agent

Chat-based virtual machine provisioning for KVM/libvirt, driven by a local
OpenAI-compatible LLM and the [`steveydevey/kvm-mcp`](https://github.com/steveydevey/kvm-mcp)
MCP server.

A user describes a VM in natural language (Indonesian or English). A local LLM
extracts a **structured VM intent**. The backend **deterministically validates**
that intent, presents a human-readable proposal, and only creates the VM after
**explicit user confirmation**. The LLM never touches the KVM host directly.

> Built following the spec in `../kvm-chat-mcp-spec-driven-development.md`.

## Architecture

```
Web Chat UI (React) → Chat Backend (Express)
                        ├─ AI Agent (LLM intent extraction)
                        ├─ Configuration Engine (schema + policy + infra validation)
                        ├─ Confirmation Gate (idempotency)
                        ├─ MCP Client (JSON-RPC over stdio) → kvm-mcp → libvirt/QEMU
                        └─ Audit Log
```

The mandatory pipeline (see `docs/architecture.md`):

```
NL → LLM → Structured Intent → Deterministic Validator → Human Confirmation
   → Deterministic VM Service → MCP → KVM
```

## Repository layout

```
kvm-chat-agent/
├── docs/            Specification artifacts (requirements, architecture, ...)
├── prompts/         Versioned system prompt for the agent
├── schemas/         JSON Schema for the canonical VM intent
├── backend/         Express + TypeScript orchestration layer
├── frontend/        React + Vite chat UI
├── mcp-server/      Cloned steveydevey/kvm-mcp server (Python, talks to libvirt)
└── .env.example     Configuration template (never commit real secrets)
```

## Prerequisites

- **Node.js 18+** (uses global `fetch`) — for the backend and frontend
- A running **OpenAI-compatible LLM endpoint** (e.g. Ollama serving `gpt-oss`)
- **For real VM management** (`MCP_MODE=stdio`):
  - **Python 3.6+** with a virtualenv
  - **KVM + libvirt** installed and running on the host (`virsh` available)
  - System build deps for `libvirt-python`: `libvirt-dev`, `pkg-config`, `gcc`,
    `python3-dev` (Debian/Ubuntu names)
  - The bridge network the server uses (default `brforvms`) and a writable VM disk
    directory (default `/vm`)
- Without a working MCP server you can run in **mock MCP mode** (`MCP_MODE=mock`),
  which serves a fake VM so the full chat workflow can be exercised safely — no
  real infrastructure is touched.

## Components and ports

| Component  | Path          | Default            | How it runs                          |
| ---------- | ------------- | ------------------ | ------------------------------------ |
| MCP server | `mcp-server/` | (stdio, no port)   | Spawned by the backend as a child    |
| Backend    | `backend/`    | `:8787`            | `npm run dev`                        |
| Frontend   | `frontend/`   | `:5173`            | `npm run dev` (proxies `/api` → 8787)|

> The MCP server is **not** started manually. In `stdio` mode the backend spawns
> it as a subprocess and talks JSON-RPC over stdin/stdout. You only set up its
> virtualenv once.

## Running everything

### 0. (Real mode only) Set up the MCP server virtualenv — one time

```bash
# Install libvirt build headers (Debian/Ubuntu)
sudo apt-get install -y libvirt-dev pkg-config gcc python3-dev

cd mcp-server
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
```

Grant your user access to libvirt (so the server can reach the socket without
`sudo`):

```bash
sudo usermod -aG libvirt "$USER"
# then LOG OUT and back in (or reboot) so the new group takes effect
newgrp libvirt        # or verify with:  id -nG | tr ' ' '\n' | grep libvirt
```

> If the backend logs `Permission denied ... /var/run/libvirt/libvirt-sock`,
> your shell session has not picked up the `libvirt` group yet. Log out/in.

Review `mcp-server/config.json` (disk path, default network, master image) and
make sure the referenced paths exist on the host.

### 1. Backend

```bash
cd backend
cp ../.env.example .env      # then edit .env: LLM endpoint + secret, MCP settings
npm install
npm run dev                  # http://localhost:8787
```

For **real VM management**, set these in `backend/.env` (adjust the absolute paths
to your checkout):

```dotenv
MCP_MODE=stdio
MCP_SERVER_COMMAND=/absolute/path/to/kvm-chat-agent/mcp-server/.venv/bin/python
MCP_SERVER_ARGS=kvm_mcp_server.py
MCP_SERVER_CWD=/absolute/path/to/kvm-chat-agent/mcp-server
MCP_DEFAULT_MASTER_IMAGE=/iso/fedora-coreos-41-qemu.x86_64.qcow2
```

For a **safe demo without KVM**, just set `MCP_MODE=mock` and skip step 0.

### 2. Frontend (separate terminal)

```bash
cd frontend
npm install
npm run dev                  # http://localhost:5173 (proxies /api to backend)
```

### 3. Verify

```bash
curl http://localhost:8787/api/health
# stdio mode:  {"status":"ok","mcp":"stdio","llm":"configured"}
# mock  mode:  {"status":"ok","mcp":"mock", "llm":"configured"}
```

Then open the frontend URL and describe a VM, e.g.:

> Saya mau buat Ubuntu Server dengan 4 CPU, RAM 8 GB, disk 100 GB.

Or ask it to list VMs (`tampilkan list vm`) — in `stdio` mode this reflects the
real `virsh list --all` output.

## Configuration

All configuration is via environment variables. See `.env.example` for the full
list. **Never hard-code secrets** — the LLM API key and MCP credentials must come
from the environment.

## MCP integration note

The `kvm-mcp` server is bundled under `mcp-server/` (cloned from
[`steveydevey/kvm-mcp`](https://github.com/steveydevey/kvm-mcp)). It speaks
JSON-RPC 2.0 over stdio and exposes `list_vms`, `start_vm`, `stop_vm`,
`reboot_vm`, and `create_vm`. The backend spawns it as a subprocess in `stdio`
mode.

Its `create_vm` tool is Fedora-CoreOS/ignition oriented and requires a host-side
`master_image` plus an `ignition` config. The spec assumes an ISO/Ubuntu flow.
This app maps the canonical intent onto the **actual** tool schema and surfaces an
explicit error when required host-side artifacts (`master_image`) are not
configured, rather than inventing them. See `docs/mcp-spec.md` for the full
analysis.

### Downloading a master image

When a create fails because the master image is missing, you can ask the agent
to download one, e.g. "unduh master image dari https://.../image.qcow2". The
agent extracts only the URL from your message; the destination directory is
taken from `MCP_MASTER_IMAGE_DIR` (never invented by the model). The download
runs through the same confirmation gate as VM creation — nothing is fetched
until you confirm. Only `http`/`https` URLs are accepted. The `download_master_image`
tool is served by the bundled MCP server and writes the file into the configured
directory on the KVM host.

## Troubleshooting

- **`Permission denied ... /var/run/libvirt/libvirt-sock`** — your user is not in
  the `libvirt` group in the *current* session. Run `sudo usermod -aG libvirt
  "$USER"`, then log out and back in. Verify with `id -nG | grep libvirt`.
- **`pip install` fails building `libvirt-python`** — install the libvirt build
  headers: `sudo apt-get install -y libvirt-dev pkg-config gcc python3-dev`.
- **`Master image ... does not exist`** on create — set `MCP_DEFAULT_MASTER_IMAGE`
  to a path that exists on the KVM host and ensure the `/vm` disk directory is
  writable.
- **Agent still reports a `demo-vm-01`** — the backend is running in `MCP_MODE=mock`.
  Switch to `MCP_MODE=stdio` and restart the backend.
- **`/api/health` shows `"llm":"missing"`** — set `LLM_API_KEY` (and
  `LLM_BASE_URL` / `LLM_MODEL`) in `backend/.env`.

## Testing

```bash
cd backend && npm test
```

Covers schema validation, policy limits, confirmation logic, idempotency,
MCP argument transformation, NL contract expectations, and prompt-injection
resistance.

## Security model

- The LLM is treated as **untrusted**. Its JSON output is always re-validated.
- No LLM-driven shell execution. All KVM actions go through the validated
  `VMService` → `MCPClient`.
- Explicit confirmation is required for every infrastructure mutation.
- Secrets live only in environment variables and are never logged.

See `docs/security-spec.md`.
