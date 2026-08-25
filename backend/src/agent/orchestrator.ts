import type { AppConfig } from '../config.js';
import type { AuditLogger } from '../audit/logger.js';
import { type Conversation, ConversationStore } from '../conversation/store.js';
import { VmAgent } from './agent.js';
import { isAmbiguous, looksLikeConfirmation } from '../llm/fallback.js';
import { ValidationEngine } from '../validation/engine.js';
import { emptyIntent, osLabel, type VmIntent } from '../vm/intent.js';
import type { VmService } from '../vm/service.js';
import { McpError } from '../mcp/client.js';

export interface ChatResponse {
  conversationId: string;
  state: string;
  message: string;
  proposal?: {
    confirmation_id: string;
    name: string;
    os: string;
    vcpus: number;
    memory_mb: number;
    disk_gb: number;
    network: string;
    display: string;
  };
  requiresConfirmation: boolean;
  warnings: string[];
  vms?: unknown;
}

export interface ConfirmResult {
  conversationId: string;
  state: string;
  message: string;
  ok: boolean;
}

function gb(mb: number): string {
  return Number.isInteger(mb / 1024) ? `${mb / 1024} GB` : `${mb} MB`;
}

/**
 * Orchestrates the mandatory pipeline (spec §37): NL → agent → intent →
 * deterministic validation → human confirmation → deterministic VM service.
 * Nothing here executes infrastructure without a valid, unconsumed confirmation.
 */
export class Orchestrator {
  constructor(
    private readonly cfg: AppConfig,
    private readonly store: ConversationStore,
    private readonly agent: VmAgent,
    private readonly validator: ValidationEngine,
    private readonly vmService: VmService,
    private readonly audit: AuditLogger,
  ) {}

  async chat(conversationId: string | undefined, message: string): Promise<ChatResponse> {
    const conv = this.store.getOrCreate(conversationId);
    this.store.addMessage(conv, 'user', message);

    // If a proposal is pending, a chat message might be a text confirmation.
    // The structured confirm endpoint is the primary path; text is a fallback.
    if (conv.pendingProposal && !conv.pendingProposal.consumed) {
      if (isAmbiguous(message)) {
        const reply =
          'Jawaban Anda belum jelas. Balas "Ya, buat" untuk membuat VM, atau "Batal" untuk membatalkan.';
        this.store.addMessage(conv, 'assistant', reply);
        return this.proposingResponse(conv, reply);
      }
      if (/\b(batal|cancel|tidak|no)\b/i.test(message)) {
        this.store.clearProposal(conv);
        this.store.setState(conv, 'COLLECTING_INFORMATION');
        const reply = 'Baik, dibatalkan. Anda bisa mengubah konfigurasi atau memulai lagi.';
        this.store.addMessage(conv, 'assistant', reply);
        return this.simpleResponse(conv, reply);
      }
      if (looksLikeConfirmation(message)) {
        const result = await this.execute(conv, conv.pendingProposal.confirmationId, true);
        return this.simpleResponse(conv, result.message);
      }
      // Otherwise fall through and re-plan (user may be changing the config).
    }

    this.store.setState(conv, 'UNDERSTANDING');
    const agentResult = await this.agent.run(this.store.history(conv), message);

    // Lifecycle actions (list/start/stop/reboot/get) — read-only list is safe;
    // mutating lifecycle still runs directly but is audited.
    if (agentResult.intent === 'list_vms') {
      const vms = await this.vmService.listVms();
      const reply =
        vms.length === 0 ? 'Belum ada VM.' : `Ada ${vms.length} VM.`;
      this.store.addMessage(conv, 'assistant', reply);
      return { ...this.simpleResponse(conv, reply), vms };
    }
    if (
      agentResult.intent === 'start_vm' ||
      agentResult.intent === 'stop_vm' ||
      agentResult.intent === 'reboot_vm'
    ) {
      const target = agentResult.target_vm;
      if (!target) {
        const reply = 'VM mana yang Anda maksud? Sebutkan nama VM-nya.';
        this.store.addMessage(conv, 'assistant', reply);
        return this.simpleResponse(conv, reply);
      }
      const reply = await this.runLifecycle(conv, agentResult.intent, target);
      this.store.addMessage(conv, 'assistant', reply);
      return this.simpleResponse(conv, reply);
    }

    if (agentResult.intent !== 'create_vm') {
      const reply = agentResult.user_message || 'Ada yang bisa saya bantu terkait VM?';
      this.store.addMessage(conv, 'assistant', reply);
      return this.simpleResponse(conv, reply);
    }

    // Build a canonical intent from the (untrusted) agent result.
    const intent: VmIntent = emptyIntent('create_vm');
    intent.vm.name = agentResult.configuration.name;
    intent.vm.os = {
      family: agentResult.configuration.os.family,
      version: agentResult.configuration.os.version,
      variant: agentResult.configuration.os.variant,
      installation: 'master_image',
    };
    intent.vm.resources = {
      vcpus: agentResult.configuration.resources.vcpus,
      memory_mb: agentResult.configuration.resources.memory_mb,
      disk_gb: agentResult.configuration.resources.disk_gb,
    };
    intent.vm.network = { bridge: agentResult.configuration.network.bridge };

    // Deterministic re-validation (LLM output is untrusted).
    this.store.setState(conv, 'VALIDATING');
    const validation = this.validator.validateCreate(intent);

    if (validation.status === 'incomplete') {
      this.store.setState(conv, 'COLLECTING_INFORMATION');
      const reply = this.askForMissing(validation.missingFields, agentResult.user_message);
      this.store.addMessage(conv, 'assistant', reply);
      return this.simpleResponse(conv, reply);
    }

    if (!validation.ok) {
      this.store.setState(conv, 'COLLECTING_INFORMATION');
      const reply =
        (agentResult.user_message ? agentResult.user_message + '\n\n' : '') +
        validation.errors.map((e) => `• ${e.message}`).join('\n');
      this.store.addMessage(conv, 'assistant', reply);
      return this.simpleResponse(conv, reply);
    }

    // Valid & complete → freeze proposal, require explicit confirmation.
    const proposal = this.store.setProposal(conv, intent, validation.normalized!);
    const n = validation.normalized!;
    const warnings = validation.warnings;
    const message2 = this.buildProposalMessage(intent, n, warnings);
    this.store.addMessage(conv, 'assistant', message2);

    this.audit.record({
      requestId: proposal.requestId,
      conversationId: conv.id,
      confirmationId: proposal.confirmationId,
      operation: 'propose_create_vm',
      requestedConfiguration: intent,
      validatedConfiguration: n,
      confirmation: false,
    });

    return {
      conversationId: conv.id,
      state: conv.state,
      message: message2,
      proposal: {
        confirmation_id: proposal.confirmationId,
        name: n.name,
        os: osLabel(intent),
        vcpus: n.vcpus,
        memory_mb: n.memoryMb,
        disk_gb: n.diskGb,
        network: n.network,
        display: n.display,
      },
      requiresConfirmation: true,
      warnings,
    };
  }

  /**
   * Confirmation gate + idempotent execution (spec §11, §20, §26).
   * Verifies the confirmation belongs to the conversation, is unconsumed, the
   * config is still valid, and the request has not already executed.
   */
  async execute(
    conv: Conversation,
    confirmationId: string,
    confirmed: boolean,
  ): Promise<ConfirmResult> {
    const proposal = conv.pendingProposal;

    if (!confirmed) {
      this.store.clearProposal(conv);
      this.store.setState(conv, 'COLLECTING_INFORMATION');
      return { conversationId: conv.id, state: conv.state, ok: false, message: 'Dibatalkan.' };
    }

    // Idempotency first: a successful create clears the proposal, so a repeated
    // confirmation must be recognized by its request_id (conversation + id)
    // BEFORE the "unknown proposal" check (spec §20).
    const requestId = `${conv.id}:${confirmationId}`;
    if (this.store.hasExecuted(conv, requestId)) {
      return {
        conversationId: conv.id,
        state: 'COMPLETED',
        ok: true,
        message: 'Permintaan ini sudah diproses sebelumnya.',
      };
    }

    if (!proposal || proposal.confirmationId !== confirmationId) {
      return {
        conversationId: conv.id,
        state: conv.state,
        ok: false,
        message: 'Konfirmasi tidak valid atau sudah kedaluwarsa.',
      };
    }
    if (proposal.consumed) {
      return {
        conversationId: conv.id,
        state: 'COMPLETED',
        ok: true,
        message: 'Permintaan ini sudah diproses sebelumnya.',
      };
    }

    // Re-validate the frozen config (defense in depth).
    const revalidation = this.validator.validateCreate(proposal.intent);
    if (!revalidation.ok) {
      this.store.setState(conv, 'FAILED');
      return {
        conversationId: conv.id,
        state: conv.state,
        ok: false,
        message: 'Konfigurasi tidak lagi valid. VM belum dibuat.',
      };
    }

    // Infrastructure precondition (e.g. master_image configured).
    const precheck = this.validator.checkCreatePreconditions();
    if (precheck) {
      this.store.setState(conv, 'FAILED');
      const msg = precheck.errors[0]?.message ?? 'Prasyarat infrastruktur tidak terpenuhi.';
      this.audit.record({
        requestId: proposal.requestId,
        conversationId: conv.id,
        confirmationId,
        operation: 'create_vm',
        validatedConfiguration: proposal.normalized,
        confirmation: true,
        error: msg,
      });
      return { conversationId: conv.id, state: conv.state, ok: false, message: msg };
    }

    // Consume the confirmation BEFORE calling MCP so retries can't double-run.
    proposal.consumed = true;
    this.store.markExecuted(conv, proposal.requestId);
    this.store.setState(conv, 'EXECUTING');

    const started = Date.now();
    try {
      const result = await this.vmService.createVm(proposal.normalized);
      const durationMs = Date.now() - started;
      this.audit.record({
        requestId: proposal.requestId,
        conversationId: conv.id,
        confirmationId,
        operation: 'create_vm',
        validatedConfiguration: proposal.normalized,
        confirmation: true,
        mcpTool: result.mcpTool,
        mcpArguments: result.mcpArguments,
        result: result.data,
        error: result.ok ? undefined : result.message,
        durationMs,
      });

      if (!result.ok) {
        this.store.setState(conv, 'FAILED');
        const reply = this.friendlyMcpError(result.message);
        this.store.addMessage(conv, 'assistant', reply);
        return { conversationId: conv.id, state: conv.state, ok: false, message: reply };
      }

      this.store.setState(conv, 'COMPLETED');
      this.store.clearProposal(conv);
      const n = proposal.normalized;
      const reply = [
        `VM ${n.name} berhasil dibuat.`,
        '',
        `• CPU: ${n.vcpus} vCPU`,
        `• RAM: ${gb(n.memoryMb)}`,
        `• Disk: ${n.diskGb} GB`,
        `• Network: ${n.network}`,
      ].join('\n');
      this.store.addMessage(conv, 'assistant', reply);
      return { conversationId: conv.id, state: conv.state, ok: true, message: reply };
    } catch (err) {
      const durationMs = Date.now() - started;
      const detail = err instanceof McpError ? err.message : (err as Error).message;
      this.store.setState(conv, 'FAILED');
      this.audit.record({
        requestId: proposal.requestId,
        conversationId: conv.id,
        confirmationId,
        operation: 'create_vm',
        validatedConfiguration: proposal.normalized,
        confirmation: true,
        error: detail,
        durationMs,
      });
      const reply =
        'Server virtualisasi sedang tidak dapat diakses. VM belum dibuat. Silakan coba lagi nanti.';
      this.store.addMessage(conv, 'assistant', reply);
      return { conversationId: conv.id, state: conv.state, ok: false, message: reply };
    }
  }

  private async runLifecycle(
    conv: Conversation,
    op: 'start_vm' | 'stop_vm' | 'reboot_vm',
    target: string,
  ): Promise<string> {
    const started = Date.now();
    try {
      const result =
        op === 'start_vm'
          ? await this.vmService.startVm(target)
          : op === 'stop_vm'
            ? await this.vmService.stopVm(target)
            : await this.vmService.rebootVm(target);
      this.audit.record({
        requestId: `${conv.id}:${op}:${target}:${started}`,
        conversationId: conv.id,
        operation: op,
        confirmation: true,
        mcpTool: result.mcpTool,
        mcpArguments: result.mcpArguments,
        result: result.data,
        error: result.ok ? undefined : result.message,
        durationMs: Date.now() - started,
      });
      return result.ok
        ? `VM ${target}: ${result.message}`
        : `Tidak dapat menjalankan aksi pada VM ${target}: ${result.message}`;
    } catch (err) {
      const detail = err instanceof McpError ? err.message : (err as Error).message;
      this.audit.record({
        requestId: `${conv.id}:${op}:${target}:${started}`,
        conversationId: conv.id,
        operation: op,
        confirmation: true,
        error: detail,
        durationMs: Date.now() - started,
      });
      return 'Server virtualisasi sedang tidak dapat diakses.';
    }
  }

  private askForMissing(missing: string[], preface: string): string {
    const label: Record<string, string> = {
      name: 'nama VM',
      os: 'sistem operasi',
      vcpus: 'jumlah vCPU',
      memory_mb: 'ukuran RAM',
      disk_gb: 'ukuran disk',
    };
    const asked = missing.map((m) => label[m] ?? m).join(', ');
    const base = preface && preface.trim() ? preface.trim() + '\n\n' : '';
    return `${base}Saya masih membutuhkan: ${asked}. Bisa Anda lengkapi?`;
  }

  private buildProposalMessage(
    intent: VmIntent,
    n: { name: string; vcpus: number; memoryMb: number; diskGb: number; network: string; display: string },
    warnings: string[],
  ): string {
    const lines = [
      'Saya akan membuat VM dengan konfigurasi:',
      '',
      `• Nama: ${n.name}`,
      `• OS: ${osLabel(intent)}`,
      `• CPU: ${n.vcpus} vCPU`,
      `• RAM: ${gb(n.memoryMb)}`,
      `• Disk: ${n.diskGb} GB`,
      `• Network: ${n.network}`,
      `• Display: ${n.display.toUpperCase()}`,
    ];
    if (warnings.length) {
      lines.push('', ...warnings.map((w) => `(catatan) ${w}`));
    }
    lines.push('', 'Konfigurasi sudah lengkap dan valid.', '', 'Apakah Anda ingin saya membuat VM ini?');
    return lines.join('\n');
  }

  private friendlyMcpError(message: string): string {
    if (/already exists/i.test(message)) {
      return 'Nama VM tersebut sudah digunakan. Silakan pilih nama lain.';
    }
    if (/master image/i.test(message)) {
      return 'Master image yang dibutuhkan tidak ditemukan pada server KVM. VM belum dibuat.';
    }
    return 'VM gagal dibuat. Detail teknis telah dicatat. Silakan coba lagi.';
  }

  private simpleResponse(conv: Conversation, message: string): ChatResponse {
    return {
      conversationId: conv.id,
      state: conv.state,
      message,
      requiresConfirmation: false,
      warnings: [],
    };
  }

  private proposingResponse(conv: Conversation, message: string): ChatResponse {
    const p = conv.pendingProposal!;
    const n = p.normalized;
    return {
      conversationId: conv.id,
      state: conv.state,
      message,
      proposal: {
        confirmation_id: p.confirmationId,
        name: n.name,
        os: osLabel(p.intent),
        vcpus: n.vcpus,
        memory_mb: n.memoryMb,
        disk_gb: n.diskGb,
        network: n.network,
        display: n.display,
      },
      requiresConfirmation: true,
      warnings: [],
    };
  }
}
