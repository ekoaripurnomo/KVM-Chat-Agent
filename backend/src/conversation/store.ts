import { randomUUID } from 'node:crypto';
import type { NormalizedConfig, NormalizedDownload, VmIntent } from '../vm/intent.js';

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
  /** Which operation this proposal will execute once confirmed. */
  kind: 'create_vm' | 'download_master_image' | 'delete_vm';
  intent: VmIntent;
  /** Present for create_vm proposals. */
  normalized?: NormalizedConfig;
  /** Present for download_master_image proposals. */
  download?: NormalizedDownload;
  /** Present for delete_vm proposals: the target VM name. */
  targetVm?: string;
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

/** Login user the app provisioned for a VM (autoinstall). Password not kept. */
export interface VmProvisionInfo {
  username: string;
  installedByAutoinstall: boolean;
}

/**
 * In-memory conversation store with an explicit state machine (spec §10).
 * Persistence is intentionally simple for the MVP; swap for a DB later.
 */
export class ConversationStore {
  private readonly conversations = new Map<string, Conversation>();
  /** VM name -> provisioning info the app set (survives across conversations). */
  private readonly provisioned = new Map<string, VmProvisionInfo>();

  rememberProvision(vmName: string, info: VmProvisionInfo): void {
    this.provisioned.set(vmName, info);
  }

  getProvision(vmName: string): VmProvisionInfo | undefined {
    return this.provisioned.get(vmName);
  }

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

  /** Attach a frozen, validated create proposal and move to PROPOSING. */
  setProposal(conv: Conversation, intent: VmIntent, normalized: NormalizedConfig): PendingProposal {
    const confirmationId = randomUUID();
    const proposal: PendingProposal = {
      confirmationId,
      kind: 'create_vm',
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

  /** Attach a frozen VM-deletion proposal and move to PROPOSING. */
  setDeleteProposal(conv: Conversation, targetVm: string): PendingProposal {
    const confirmationId = randomUUID();
    const proposal: PendingProposal = {
      confirmationId,
      kind: 'delete_vm',
      intent: { operation: 'delete_vm', vm: {}, missing_fields: [], warnings: [], validation_status: 'valid', requires_confirmation: true },
      targetVm,
      createdAt: Date.now(),
      consumed: false,
      requestId: `${conv.id}:${confirmationId}`,
    };
    conv.pendingProposal = proposal;
    conv.state = 'PROPOSING';
    return proposal;
  }

  /** Attach a frozen master-image download proposal and move to PROPOSING. */
  setDownloadProposal(
    conv: Conversation,
    intent: VmIntent,
    download: NormalizedDownload,
  ): PendingProposal {
    const confirmationId = randomUUID();
    const proposal: PendingProposal = {
      confirmationId,
      kind: 'download_master_image',
      intent,
      download,
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
