import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AppConfig } from '../config.js';
import type { ChatMessage, LlmProvider } from '../llm/provider.js';
import { LlmError } from '../llm/provider.js';
import { type AgentResult, fallbackExtract } from '../llm/fallback.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// backend/src/agent -> repo root prompts/
const PROMPT_PATH = resolve(__dirname, '../../../prompts/vm-agent-system.md');

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface InfraContext {
  network: string;
  maxVcpu: number;
  maxMemoryMb: number;
  maxDiskGb: number;
}

/**
 * The agent turns natural language into a structured AgentResult. It calls the
 * LLM provider when available and falls back to the deterministic extractor
 * otherwise (or when the model returns non-JSON). It NEVER executes anything.
 */
export class VmAgent {
  private readonly systemPrompt: string;

  constructor(
    private readonly cfg: AppConfig,
    private readonly provider: LlmProvider,
  ) {
    this.systemPrompt = readFileSync(PROMPT_PATH, 'utf-8');
  }

  private buildPolicyContext(): string {
    const p = this.cfg.policy;
    const d = this.cfg.defaults;
    // Runtime context kept separate from the system prompt (spec §29).
    return [
      'APPLICATION POLICY AND CONFIGURATION (authoritative, supplied by the app):',
      `- Admin maximums: vcpus <= ${p.maxVcpu}, memory_mb <= ${p.maxMemoryMb}, disk_gb <= ${p.maxDiskGb}.`,
      `- Minimums: vcpus >= ${p.minVcpu}, memory_mb >= ${p.minMemoryMb}, disk_gb >= ${p.minDiskGb}.`,
      `- Default network bridge: ${d.network}. Default OS variant: ${d.osVariant}. Default display: ${d.display}.`,
      '- These are the only defaults you may use. Do not invent any other value.',
    ].join('\n');
  }

  private buildMessages(history: ConversationTurn[], userMessage: string): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'system', content: this.buildPolicyContext() },
    ];
    for (const turn of history.slice(-10)) {
      messages.push({ role: turn.role, content: turn.content });
    }
    messages.push({ role: 'user', content: userMessage });
    return messages;
  }

  /** Run the agent for one user message. Always returns a structured result. */
  async run(history: ConversationTurn[], userMessage: string): Promise<AgentResult> {
    if (!this.provider.available) {
      return fallbackExtract(userMessage);
    }
    try {
      const raw = await this.provider.complete(this.buildMessages(history, userMessage));
      const parsed = parseAgentJson(raw);
      if (parsed) return mergeWithFallback(parsed, userMessage);
      // Non-JSON output: fall back deterministically rather than trusting prose.
      return fallbackExtract(userMessage);
    } catch (err) {
      if (err instanceof LlmError) {
        const fb = fallbackExtract(userMessage);
        fb.warnings.push('LLM tidak tersedia; menggunakan analisis dasar.');
        return fb;
      }
      throw err;
    }
  }
}

/** Extract the first JSON object from raw LLM text. Never trusts prose. */
export function parseAgentJson(raw: string): Partial<AgentResult> | null {
  const trimmed = raw.trim();
  const candidates: string[] = [];
  // Strip common code fences.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(trimmed);
  // First balanced-looking object.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj === 'object') return obj as Partial<AgentResult>;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Merge LLM-provided fields with deterministic extraction as a safety net.
 * The LLM output is untrusted: any numeric field it omits is backfilled from
 * the deterministic extractor so the backend can still validate correctly.
 */
function mergeWithFallback(parsed: Partial<AgentResult>, userMessage: string): AgentResult {
  const fb = fallbackExtract(userMessage);
  const cfg = parsed.configuration ?? {};
  const res = (cfg as AgentResult['configuration']).resources ?? {};
  const os = (cfg as AgentResult['configuration']).os ?? {};
  const net = (cfg as AgentResult['configuration']).network ?? {};

  const merged: AgentResult = {
    intent: (parsed.intent as AgentResult['intent']) ?? fb.intent,
    status: (parsed.status as AgentResult['status']) ?? fb.status,
    configuration: {
      name: coalesce(cfg && (cfg as any).name, fb.configuration.name),
      os: {
        family: coalesce(os.family, fb.configuration.os.family),
        version: coalesce(os.version, fb.configuration.os.version),
        variant: coalesce(os.variant, fb.configuration.os.variant),
      },
      resources: {
        vcpus: coalesceNum(res.vcpus, fb.configuration.resources.vcpus),
        memory_mb: coalesceNum(res.memory_mb, fb.configuration.resources.memory_mb),
        disk_gb: coalesceNum(res.disk_gb, fb.configuration.resources.disk_gb),
      },
      network: { bridge: coalesce(net.bridge, fb.configuration.network.bridge) },
    },
    target_vm: coalesce(parsed.target_vm ?? null, fb.target_vm),
    missing_fields: Array.isArray(parsed.missing_fields) ? parsed.missing_fields : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    user_message:
      typeof parsed.user_message === 'string' && parsed.user_message.trim()
        ? parsed.user_message
        : fb.user_message,
  };
  return merged;
}

function coalesce<T>(a: T | null | undefined, b: T | null): T | null {
  return a === null || a === undefined || a === '' ? b : a;
}
function coalesceNum(a: unknown, b: number | null): number | null {
  return typeof a === 'number' && Number.isFinite(a) ? a : b;
}
