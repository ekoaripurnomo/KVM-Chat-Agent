# API Specification

Base path: `/api`. All bodies are JSON.

## POST /api/chat
Request:
```json
{ "conversation_id": "uuid?", "message": "Buat VM Ubuntu 4 CPU RAM 8GB disk 100GB" }
```
Response:
```json
{
  "conversation_id": "uuid",
  "state": "PROPOSING",
  "message": "Saya akan membuat VM ...",
  "proposal": {
    "confirmation_id": "uuid",
    "name": "ubuntu-server-01",
    "os": "Ubuntu Server 24.04",
    "vcpus": 4, "memory_mb": 8192, "disk_gb": 100,
    "network": "brforvms", "display": "vnc"
  },
  "requires_confirmation": true,
  "warnings": []
}
```
`proposal` is present only when `state = PROPOSING`. Raw intent JSON is never
returned to normal clients.

## POST /api/vm/confirm
```json
{ "conversation_id": "uuid", "confirmation_id": "uuid", "confirmed": true }
```
Backend verifies the confirmation belongs to the conversation, the config is
unchanged and still valid, the confirmation has not been consumed, and the
request has not already executed. Then it runs the MCP operation and returns a
natural-language result plus `state`.

## POST /api/vm/cancel
```json
{ "conversation_id": "uuid", "confirmation_id": "uuid" }
```

## GET /api/vms
List VMs via MCP.

## GET /api/vms/:name
Get one VM (derived from list).

## POST /api/vms/:name/start | /stop | /reboot
Direct lifecycle actions (still audited).

## GET /api/health
`{ "status": "ok", "mcp": "mock|stdio", "llm": "configured|missing" }`

## GET /api/mcp/tools
Returns the static, source-derived MCP tool catalog.

## Errors
`{ "error": { "category": "user|missing_resource|infrastructure|mcp|internal", "message": "..." } }`
Technical detail is logged; the user-facing message is friendly.
