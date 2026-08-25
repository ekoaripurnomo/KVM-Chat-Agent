import type { LlmConfig } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Provider abstraction so the LLM implementation is replaceable (spec Rule 12).
 * Business logic depends only on this interface, never on a concrete model.
 */
export interface LlmProvider {
  /** Returns the raw assistant text (expected to be a single JSON object). */
  complete(messages: ChatMessage[]): Promise<string>;
  readonly available: boolean;
}

/**
 * OpenAI-compatible Chat Completions provider.
 * Uses global fetch (Node 18+). API key comes only from configuration.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  constructor(private readonly cfg: LlmConfig) {}

  get available(): boolean {
    return this.cfg.configured;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          temperature: 0.1,
          // Ask for a JSON object where the server supports it. Harmless if ignored.
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LlmError(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new LlmError('LLM returned an empty response.');
      return content;
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new LlmError('LLM request timed out.');
      }
      throw new LlmError(`LLM request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class LlmError extends Error {}
