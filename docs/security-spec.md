# Security Specification

## Trust model

- The LLM is **untrusted**. Its JSON output is always re-validated by
  deterministic backend code before use.
- User messages are **untrusted data**. The system prompt forbids them from
  overriding policy, skipping confirmation, or triggering execution.
- The frontend is untrusted for authorization. The "Create VM" button maps to a
  server-side confirmation record (`confirmation_id`), not to arbitrary text.

## Forbidden flow

```
LLM → arbitrary shell command → KVM        (never allowed)
```

Allowed flow only:

```
User → LLM → Structured Intent → Application Validation → User Confirmation
     → MCP Tool → KVM
```

There is no code path from LLM output to shell execution. The VM Service builds
MCP arguments deterministically from a validated, normalized config.

## Secret handling

Secrets (`LLM_API_KEY`, MCP credentials, SSH keys, VM passwords) live only in
environment variables. They are:
- never hard-coded,
- never placed in the system prompt,
- never sent to the frontend,
- never written to logs or audit records.

`/api/health` reports only whether the LLM key is `configured` or `missing`,
not its value.

## Prompt-injection protection

The system prompt explicitly states the rules above. Regardless of LLM output,
the deterministic layers enforce:
- schema + policy validation,
- explicit confirmation gate,
- idempotency,
- no shell execution.

So even a fully compromised LLM cannot create infrastructure without a valid,
unconsumed confirmation for an unchanged, valid configuration.

## Audit

Every infrastructure operation is appended to the audit log with request and
conversation IDs, the requested and validated configuration, the MCP tool and
arguments, and the result — with secrets stripped.
