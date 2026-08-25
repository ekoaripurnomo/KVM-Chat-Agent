# Requirements

Derived from `../../kvm-chat-mcp-spec-driven-development.md`.

## Functional

- FR-1: User opens a web chat UI and describes a VM in Indonesian or English.
- FR-2: A local OpenAI-compatible LLM extracts a structured VM intent.
- FR-3: The backend deterministically validates the intent (schema, policy,
  infrastructure, MCP tool). The LLM output is never trusted.
- FR-4: When required information is missing, the agent asks targeted questions.
- FR-5: The user receives a human-readable configuration proposal (no raw JSON).
- FR-6: The user must explicitly confirm before any VM is created/changed.
- FR-7: On confirmation, the backend re-validates and invokes the MCP tool.
- FR-8: The result is returned to the chat in natural language.
- FR-9: Supported lifecycle operations: create, list, start, stop, reboot, get.
- FR-10: Duplicate execution of the same confirmed request is prevented
  (idempotency).
- FR-11: Every infrastructure operation is recorded in an audit log.

## Non-functional

- NFR-1: Chat response < 5s excluding long-running VM creation.
- NFR-2: MCP tool metadata is cached.
- NFR-3: Secrets only from environment; never logged or sent to the frontend.
- NFR-4: LLM provider is replaceable without changing business logic.
- NFR-5: Structured logs with request IDs and conversation IDs.

## Priority order (from spec §42)

Security > Correctness > Explicit confirmation > Deterministic validation >
MCP compatibility > User experience > Performance.

## Acceptance criteria

See spec §32. Tracked in `docs/testing-spec.md`.
