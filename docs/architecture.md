# Architecture

## Layers

```
Web Chat UI (React/Vite)
        │  HTTP JSON
        ▼
Chat Backend (Express/TypeScript)
        │
        ├── Conversation Store        conversation state machine + history
        ├── AI Agent                  LLM call + intent extraction
        │       └── LLM Provider      OpenAI-compatible (replaceable)
        ├── Configuration Engine      schema → policy → infra → mcp validation
        ├── Confirmation Gate         idempotency + consumed-once semantics
        ├── VM Service                deterministic tool-argument construction
        │       └── MCP Client        JSON-RPC 2.0 over stdio (or mock)
        └── Audit Logger              append-only, secret-free
                                          │
                                          ▼
                                   kvm-mcp → libvirt/QEMU
```

## Mandatory pipeline (spec §37)

```
Natural Language → LLM → Structured Intent → Deterministic Validator
→ Human Confirmation → Deterministic VM Service → MCP → KVM
```

The LLM never produces the final MCP call. It produces intent only. The backend
owns validation and execution.

## Conversation state machine (spec §10)

```
NEW → UNDERSTANDING → COLLECTING_INFORMATION → VALIDATING → PROPOSING
   → CONFIRMED → EXECUTING → COMPLETED
PROPOSING → COLLECTING_INFORMATION   (user changes config)
EXECUTING → FAILED                    (execution error)
```

State is persisted per `conversation_id`. A pending confirmation is bound to a
`confirmation_id` and a frozen, validated configuration.

## Trust boundaries

- Frontend is untrusted for authorization; the confirm action maps to a
  server-side confirmation record, not to free text.
- LLM output is untrusted; re-validated by deterministic code.
- User messages are untrusted data (prompt-injection resistant system prompt).
