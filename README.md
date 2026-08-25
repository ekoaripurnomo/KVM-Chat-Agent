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
└── .env.example     Configuration template (never commit real secrets)
```

## Prerequisites

- Node.js 18+ (uses global `fetch`)
- A running OpenAI-compatible LLM endpoint
- (For real VM creation) a reachable `steveydevey/kvm-mcp` server. Without it the
  app runs in **mock MCP mode** so the full workflow can be exercised safely.

## Quick start

```bash
# 1. Backend
cd backend
cp ../.env.example .env      # then edit .env with your LLM endpoint + secret
npm install
npm run dev                  # http://localhost:8787

# 2. Frontend (separate terminal)
cd frontend
npm install
npm run dev                  # http://localhost:5173 (proxies /api to backend)
```

Then open the frontend URL and describe a VM, e.g.:

> Saya mau buat Ubuntu Server dengan 4 CPU, RAM 8 GB, disk 100 GB.

## Configuration

All configuration is via environment variables. See `.env.example` for the full
list. **Never hard-code secrets** — the LLM API key and MCP credentials must come
from the environment.

## MCP integration note

The real `kvm-mcp` `create_vm` tool is Fedora-CoreOS/ignition oriented and
requires a host-side `master_image` plus an `ignition` config. The spec assumes an
ISO/Ubuntu flow. This app maps the canonical intent onto the **actual** tool
schema and surfaces an explicit error when required host-side artifacts
(`master_image`) are not configured, rather than inventing them. See
`docs/mcp-spec.md` for the full analysis.

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
