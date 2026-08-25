# Agent Specification

The agent turns natural language into a structured intent. It never executes
infrastructure and never authorizes creation.

- System prompt: versioned at `prompts/vm-agent-system.md` (v1). Prompt changes
  are reviewed and tested like code.
- Prompt context assembly (spec §29):
  `SYSTEM PROMPT + APPLICATION POLICY + SUPPORTED VM SCHEMA + INFRA CONTEXT
   + CONVERSATION HISTORY + CURRENT USER MESSAGE`.
- Output: a single JSON object (see prompt). The backend parses it, then
  **re-validates deterministically**. Prose is not parsed with regex as the
  primary mechanism; a minimal keyword extractor exists only as a fallback when
  the LLM is unreachable or returns non-JSON.
- Units are normalized (GB→MB, "core"→vcpus).
- The agent lists missing required fields instead of inventing values.
- Ambiguous confirmations are not treated as authorization; the deterministic
  confirmation gate is the only path to execution.
