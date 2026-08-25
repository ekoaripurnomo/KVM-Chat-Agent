import { randomUUID } from 'node:crypto';
import type { NormalizedConfig, VmIntent } from '../vm/intent.js';

export type ConversationState =
  | 'NEW'
  | 'UNDERSTANDING'
  | 'COLLECTING_INFORMATION'
  | 'VALIDATING'
  | 'PROPOSING'
  | 'CONFIRMED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED';

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

export interface PendingProposal {
  confirmationId: string;
  intent: VmIntent;
  normalized: NormalizedConfig;
  createdAt: number;
  consumed: boolean;
  /** Idempotency key: conversation_id + confirmation_id. */
  requestId: string;
}

export interface Conversation {
  id: string;
  state: ConversationState;
  messages: StoredMessage[];
  pendingProposal?: PendingProposal;
  /** request_ids that have already executed (idempotency). */
  executedRequestIds: Set<string>;
}

/**
 * In-memory conversation store with an explicit state machine (spec §10).
 * Persistence is intentionally simple for the MVP; swap for a DB later.
 */
export class ConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  getOrCreate(id?: string): Conversation {
    if (id && this.conversations.has(id)) {
      return this.conversations.get(id)!;
    }
    const conv: Conversation = {
      id: id ?? randomUUID(),
      state: 'NEW',
      messages: [],
      executedRequestIds: new Set(),
    };
    this.conversations.set(conv.id, conv);
    return conv;
  }

  get(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  addMessage(conv: Conversation, role: 'user' | 'assistant', content: string): void {
    conv.messages.push({ role, content, ts: Date.now() });
  }

  setState(conv: Conversation, state: ConversationState): void {
    conv.state = state;
  }

  /** Attach a frozen, validated proposal and move to PROPOSING. */
  setProposal(conv: Conversation, intent: VmIntent, normalized: NormalizedConfig): PendingProposal {
    const confirmationId = randomUUID();
    const proposal: PendingProposal = {
      confirmationId,
      intent,
      normalized,
      createdAt: Date.now(),
      consumed: false,
      requestId: `${conv.id}:${confirmationId}`,
    };
    conv.pendingProposal = proposal;
    conv.state = 'PROPOSING';
    return proposal;
  }

  clearProposal(conv: Conversation): void {
    conv.pendingProposal = undefined;
  }

  markExecuted(conv: Conversation, requestId: string): void {
    conv.executedRequestIds.add(requestId);
  }

  hasExecuted(conv: Conversation, requestId: string): boolean {
    return conv.executedRequestIds.has(requestId);
  }

  history(conv: Conversation): { role: 'user' | 'assistant'; content: string }[] {
    return conv.messages.map((m) => ({ role: m.role, content: m.content }));
  }
}
