import type { AppConfig } from '../config.js';
import type { AuditLogger } from '../audit/logger.js';
import { type Conversation, ConversationStore, type PendingProposal } from '../conversation/store.js';
import { VmAgent } from './agent.js';
import { type AgentResult, isAmbiguous, looksLikeConfirmation } from '../llm/fallback.js';
import { ValidationEngine } from '../validation/engine.js';
import { emptyIntent, osLabel, type NormalizedConfig, type VmIntent } from '../vm/intent.js';
import { generatePassword, usernameFromVmName } from '../vm/credentials.js';
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
  /** Present for a pending master-image download awaiting confirmation. */
  downloadProposal?: {
    confirmation_id: string;
    url: string;
    filename: string;
    dest_dir: string;
  };
  /** Present for a pending VM deletion awaiting confirmation. */
  deleteProposal?: {
    confirmation_id: string;
    name: string;
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
        const k = conv.pendingProposal.kind;
        const action =
          k === 'download_master_image' ? 'mengunduh image' : k === 'delete_vm' ? 'menghapus VM' : 'membuat VM';
        const affirm =
          k === 'download_master_image' ? '"Ya, unduh"' : k === 'delete_vm' ? '"Ya, hapus"' : '"Ya, buat"';
        const reply = `Jawaban Anda belum jelas. Balas ${affirm} untuk ${action}, atau "Batal" untuk membatalkan.`;
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
      const reply = this.buildVmListMessage(vms);
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

    // Destructive: delete a VM. Requires explicit confirmation via the gate.
    if (agentResult.intent === 'delete_vm') {
      const target = agentResult.target_vm;
      if (!target) {
        const reply = 'VM mana yang ingin Anda hapus? Sebutkan nama VM-nya.';
        this.store.addMessage(conv, 'assistant', reply);
        return this.simpleResponse(conv, reply);
      }
      return this.planDelete(conv, target);
    }

    // Read-only: how to access / SSH into a VM. Returns real IP + honest
    // credential guidance (no fabricated passwords).
    if (agentResult.intent === 'get_vm_access') {
      const target = agentResult.target_vm;
      if (!target) {
        const reply = 'VM mana yang ingin Anda akses? Sebutkan nama VM-nya.';
        this.store.addMessage(conv, 'assistant', reply);
        return this.simpleResponse(conv, reply);
      }
      const reply = await this.buildAccessReply(target);
      this.store.addMessage(conv, 'assistant', reply);
      return this.simpleResponse(conv, reply);
    }

    // Master-image download: ask for a URL if missing, else propose a download
    // that goes through the same confirmation gate as create_vm.
    if (agentResult.intent === 'download_master_image') {
      return this.planDownload(conv, agentResult);
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

    // For an ISO image we do an unattended (autoinstall) install: generate
    // login credentials now so we can show them in the proposal and set them
    // during install. The password is generated here; the MCP server hashes it.
    const n = validation.normalized!;
    const isIso = /\.iso$/i.test(this.cfg.mcp.defaultMasterImage);
    if (isIso) {
      n.credentials = {
        username: usernameFromVmName(n.name),
        password: generatePassword(),
        hostname: n.name,
      };
    }

    // Valid & complete → freeze proposal, require explicit confirmation.
    const proposal = this.store.setProposal(conv, intent, n);
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

    // Master-image download proposals run through their own execution path.
    if (proposal.kind === 'download_master_image') {
      return this.executeDownload(conv, confirmationId, proposal);
    }

    // VM deletion runs through its own path.
    if (proposal.kind === 'delete_vm') {
      return this.executeDelete(conv, confirmationId, proposal);
    }

    // From here on this is a create_vm proposal; the normalized config is set.
    const normalized = proposal.normalized;
    if (!normalized) {
      this.store.setState(conv, 'FAILED');
      return {
        conversationId: conv.id,
        state: conv.state,
        ok: false,
        message: 'Konfigurasi proposal tidak lengkap. VM belum dibuat.',
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
      const result = await this.vmService.createVm(normalized);
      const durationMs = Date.now() - started;
      this.audit.record({
        requestId: proposal.requestId,
        conversationId: conv.id,
        confirmationId,
        operation: 'create_vm',
        validatedConfiguration: normalized,
        confirmation: true,
        mcpTool: result.mcpTool,
        mcpArguments: result.mcpArguments,
        result: result.data,
        error: result.ok ? undefined : result.message,
        durationMs,
      });

      if (!result.ok) {
        this.store.setState(conv, 'FAILED');
        console.error('[create_vm] failed:', result.message);
        const reply = this.friendlyMcpError(result.message);
        this.store.addMessage(conv, 'assistant', reply);
        return { conversationId: conv.id, state: conv.state, ok: false, message: reply };
      }

      this.store.setState(conv, 'COMPLETED');
      this.store.clearProposal(conv);
      const n = normalized;
      const lines = [
        `VM ${n.name} berhasil dibuat.`,
        '',
        `• CPU: ${n.vcpus} vCPU`,
        `• RAM: ${gb(n.memoryMb)}`,
        `• Disk: ${n.diskGb} GB`,
        `• Network: ${n.network}`,
      ];
      if (n.credentials) {
        // Remember the username so later access queries report the right user.
        this.store.rememberProvision(n.name, {
          username: n.credentials.username,
          installedByAutoinstall: true,
        });
        lines.push(
          '',
          'Instalasi Ubuntu sedang berjalan otomatis (beberapa menit). Setelah selesai',
          'dan VM reboot, login dengan:',
          `• Username: ${n.credentials.username}`,
          `• Password: ${n.credentials.password}`,
          '',
          `Untuk mendapatkan IP, tanyakan: "ssh ${n.name}" setelah instalasi selesai.`,
        );
      }
      const reply = lines.join('\n');
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

  /**
   * Execute a confirmed master-image download. Mirrors the create path: consume
   * the confirmation before the MCP call so retries can't double-run, audit the
   * operation, and map the result to a friendly message.
   */
  private async executeDownload(
    conv: Conversation,
    confirmationId: string,
    proposal: PendingProposal,
  ): Promise<ConfirmResult> {
    const dl = proposal.download;
    if (!dl) {
      this.store.setState(conv, 'FAILED');
      return {
        conversationId: conv.id,
        state: conv.state,
        ok: false,
        message: 'Permintaan unduhan tidak lengkap.',
      };
    }

    // Precondition re-check (defense in depth).
    const precheck = this.validator.checkDownloadPreconditions();
    if (precheck) {
      this.store.setState(conv, 'FAILED');
      const msg = precheck.errors[0]?.message ?? 'Prasyarat infrastruktur tidak terpenuhi.';
      return { conversationId: conv.id, state: conv.state, ok: false, message: msg };
    }

    proposal.consumed = true;
    this.store.markExecuted(conv, proposal.requestId);
    this.store.setState(conv, 'EXECUTING');

    const started = Date.now();
    try {
      const result = await this.vmService.downloadMasterImage(dl);
      const durationMs = Date.now() - started;
      this.audit.record({
        requestId: proposal.requestId,
        conversationId: conv.id,
        confirmationId,
        operation: 'download_master_image',
        validatedConfiguration: dl,
        confirmation: true,
        mcpTool: result.mcpTool,
        mcpArguments: result.mcpArguments,
        result: result.data,
        error: result.ok ? undefined : result.message,
        durationMs,
      });

      if (!result.ok) {
        this.store.setState(conv, 'FAILED');
        const reply = `Gagal mengunduh master image: ${result.message}`;
        this.store.addMessage(conv, 'assistant', reply);
        return { conversationId: conv.id, state: conv.state, ok: false, message: reply };
      }

      this.store.setState(conv, 'COMPLETED');
      this.store.clearProposal(conv);
      const path = (result.data as { path?: string })?.path ?? `${dl.destDir}/${dl.filename}`;
      const reply = [
        'Master image berhasil diunduh.',
        '',
        `• File: ${dl.filename}`,
        `• Lokasi: ${path}`,
        '',
        'Anda sekarang bisa membuat VM menggunakan image ini.',
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
        operation: 'download_master_image',
        validatedConfiguration: dl,
        confirmation: true,
        error: detail,
        durationMs,
      });
      const reply =
        'Server sedang tidak dapat diakses untuk mengunduh image. Silakan coba lagi nanti.';
      this.store.addMessage(conv, 'assistant', reply);
      return { conversationId: conv.id, state: conv.state, ok: false, message: reply };
    }
  }

  /** Execute a confirmed VM deletion (destructive, idempotent). */
  private async executeDelete(
    conv: Conversation,
    confirmationId: string,
    proposal: PendingProposal,
  ): Promise<ConfirmResult> {
    const target = proposal.targetVm;
    if (!target) {
      this.store.setState(conv, 'FAILED');
      return { conversationId: conv.id, state: conv.state, ok: false, message: 'Target penghapusan tidak diketahui.' };
    }

    proposal.consumed = true;
    this.store.markExecuted(conv, proposal.requestId);
    this.store.setState(conv, 'EXECUTING');

    const started = Date.now();
    try {
      const result = await this.vmService.deleteVm(target);
      this.audit.record({
        requestId: proposal.requestId,
        conversationId: conv.id,
        confirmationId,
        operation: 'delete_vm',
        requestedConfiguration: { vm_name: target },
        confirmation: true,
        mcpTool: result.mcpTool,
        mcpArguments: result.mcpArguments,
        result: result.data,
        error: result.ok ? undefined : result.message,
        durationMs: Date.now() - started,
      });

      if (!result.ok) {
        this.store.setState(conv, 'FAILED');
        const reply = /not found/i.test(result.message)
          ? `VM ${target} tidak ditemukan.`
          : `Gagal menghapus VM ${target}: ${result.message}`;
        this.store.addMessage(conv, 'assistant', reply);
        return { conversationId: conv.id, state: conv.state, ok: false, message: reply };
      }

      this.store.setState(conv, 'COMPLETED');
      this.store.clearProposal(conv);
      const reply = `VM ${target} berhasil dihapus (domain di-undefine dan file disk dihapus).`;
      this.store.addMessage(conv, 'assistant', reply);
      return { conversationId: conv.id, state: conv.state, ok: true, message: reply };
    } catch (err) {
      const detail = err instanceof McpError ? err.message : (err as Error).message;
      this.store.setState(conv, 'FAILED');
      this.audit.record({
        requestId: proposal.requestId,
        conversationId: conv.id,
        confirmationId,
        operation: 'delete_vm',
        requestedConfiguration: { vm_name: target },
        confirmation: true,
        error: detail,
        durationMs: Date.now() - started,
      });
      const reply = 'Server virtualisasi sedang tidak dapat diakses. VM belum dihapus.';
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

  /**
   * Plan a VM deletion. Verifies the VM exists, then freezes a proposal that
   * requires explicit confirmation (destructive, irreversible).
   */
  private async planDelete(conv: Conversation, target: string): Promise<ChatResponse> {
    let exists = false;
    try {
      const vm = await this.vmService.getVm(target);
      exists = vm !== null;
    } catch {
      // If we can't verify, still let the delete proceed to a confirmed attempt.
      exists = true;
    }
    if (!exists) {
      const reply = `VM ${target} tidak ditemukan.`;
      this.store.addMessage(conv, 'assistant', reply);
      return this.simpleResponse(conv, reply);
    }

    const proposal = this.store.setDeleteProposal(conv, target);
    const message = [
      `⚠️ Anda akan MENGHAPUS VM ${target} secara permanen.`,
      '',
      'Tindakan ini akan:',
      '• Menghentikan VM jika sedang berjalan',
      '• Menghapus definisi domain dari libvirt',
      '• Menghapus file disk dan seed VM',
      '',
      'Tindakan ini TIDAK dapat dibatalkan. Ketik "Ya, hapus" untuk melanjutkan, atau "Batal".',
    ].join('\n');
    this.store.addMessage(conv, 'assistant', message);

    this.audit.record({
      requestId: proposal.requestId,
      conversationId: conv.id,
      confirmationId: proposal.confirmationId,
      operation: 'propose_delete_vm',
      requestedConfiguration: { vm_name: target },
      confirmation: false,
    });

    return {
      conversationId: conv.id,
      state: conv.state,
      message,
      deleteProposal: { confirmation_id: proposal.confirmationId, name: target },
      requiresConfirmation: true,
      warnings: [],
    };
  }

  /**
   * Plan a master-image download. If no URL was provided, ask for it. Otherwise
   * validate the URL and freeze a proposal that requires explicit confirmation
   * — the download only runs after the user confirms (spec pipeline).
   */
  private async planDownload(conv: Conversation, agentResult: AgentResult): Promise<ChatResponse> {
    this.store.setState(conv, 'VALIDATING');
    const validation = this.validator.validateDownload(agentResult.download_url);

    if (validation.status === 'incomplete') {
      this.store.setState(conv, 'COLLECTING_INFORMATION');
      const reply =
        agentResult.user_message && agentResult.user_message.trim()
          ? agentResult.user_message
          : 'Tentu, saya bisa membantu mengunduh master image. Kirimkan tautan (URL) file image-nya (http/https).';
      this.store.addMessage(conv, 'assistant', reply);
      return this.simpleResponse(conv, reply);
    }

    if (!validation.ok) {
      this.store.setState(conv, 'COLLECTING_INFORMATION');
      const reply = validation.errors.map((e) => `• ${e.message}`).join('\n');
      this.store.addMessage(conv, 'assistant', reply);
      return this.simpleResponse(conv, reply);
    }

    // Precondition: destination directory must be configured (stdio mode).
    const precheck = this.validator.checkDownloadPreconditions();
    if (precheck) {
      this.store.setState(conv, 'FAILED');
      const reply = precheck.errors[0]?.message ?? 'Prasyarat infrastruktur tidak terpenuhi.';
      this.store.addMessage(conv, 'assistant', reply);
      return this.simpleResponse(conv, reply);
    }

    const dl = validation.download!;
    const intent: VmIntent = emptyIntent('download_master_image');
    const proposal = this.store.setDownloadProposal(conv, intent, dl);
    const message = this.buildDownloadProposalMessage(dl, validation.warnings);
    this.store.addMessage(conv, 'assistant', message);

    this.audit.record({
      requestId: proposal.requestId,
      conversationId: conv.id,
      confirmationId: proposal.confirmationId,
      operation: 'propose_download_master_image',
      requestedConfiguration: { url: dl.url },
      validatedConfiguration: dl,
      confirmation: false,
    });

    return {
      conversationId: conv.id,
      state: conv.state,
      message,
      downloadProposal: {
        confirmation_id: proposal.confirmationId,
        url: dl.url,
        filename: dl.filename,
        dest_dir: dl.destDir,
      },
      requiresConfirmation: true,
      warnings: validation.warnings,
    };
  }

  private buildDownloadProposalMessage(
    dl: { url: string; filename: string; destDir: string },
    warnings: string[],
  ): string {
    const lines = [
      'Saya akan mengunduh master image berikut ke server KVM:',
      '',
      `• Sumber: ${dl.url}`,
      `• Nama file: ${dl.filename}`,
      `• Lokasi: ${dl.destDir}`,
    ];
    if (warnings.length) {
      lines.push('', ...warnings.map((w) => `(catatan) ${w}`));
    }
    lines.push('', 'Apakah Anda ingin saya mengunduh image ini?');
    return lines.join('\n');
  }

  /**
   * Build an honest access reply for a VM: real IP(s) from libvirt, the SSH
   * user implied by how VMs are provisioned, and the ssh command. Deliberately
   * does NOT invent a password — for ISO installs the credential is whatever
   * the user set during installation and is not stored anywhere.
   */
  private async buildAccessReply(target: string): Promise<string> {
    let access: Awaited<ReturnType<VmService['getVmAccess']>>;
    try {
      access = await this.vmService.getVmAccess(target);
    } catch (err) {
      const detail = err instanceof McpError ? err.message : (err as Error).message;
      return `Tidak dapat mengambil info akses untuk VM ${target}: ${detail}`;
    }

    if (!access.ok) {
      return access.message?.toLowerCase().includes('not found')
        ? `VM ${target} tidak ditemukan.`
        : `Tidak dapat mengambil info akses untuk VM ${target}.`;
    }

    if (!access.active) {
      return [
        `VM ${target} sedang tidak berjalan (mati).`,
        'Jalankan dulu (mis. "jalankan vm ' + target + '"), lalu minta info akses lagi.',
      ].join('\n');
    }

    // Prefer a username the app actually provisioned (autoinstall); else infer
    // from installation type.
    const provision = this.store.getProvision(target);
    const isIso = /\.iso$/i.test(this.cfg.mcp.defaultMasterImage);
    const sshUser = provision?.username ?? (isIso ? '<user-instalasi>' : 'core');

    const lines: string[] = [`Info akses untuk VM ${target}:`, ''];

    if (access.ips.length === 0) {
      lines.push('• IP address: belum tersedia.');
      lines.push(
        provision?.installedByAutoinstall
          ? '  Instalasi otomatis mungkin belum selesai (butuh beberapa menit + reboot). Coba lagi nanti.'
          : isIso
            ? '  VM ini diinstal dari ISO dan mungkin belum selesai instalasi atau belum mendapat IP.'
            : '  VM belum melaporkan IP (guest agent / DHCP lease belum tersedia).',
      );
    } else {
      lines.push(`• IP address: ${access.ips.join(', ')}`);
      lines.push('', `• Perintah SSH: ssh ${sshUser}@${access.ips[0]}`);
    }

    lines.push('');
    if (provision) {
      lines.push(
        `• Username: ${provision.username}`,
        '• Password: yang di-generate saat pembuatan VM (tampil di pesan konfirmasi pembuatan).',
        '  Demi keamanan, password tidak ditampilkan ulang di sini.',
      );
    } else if (isIso) {
      lines.push(
        '• User & password: gunakan akun yang Anda buat saat instalasi Ubuntu.',
        '  Sistem tidak menyimpan password VM hasil instalasi ISO manual.',
      );
    } else {
      lines.push(
        '• User: core (login memakai SSH key, bukan password).',
        '  Pastikan SSH key Anda sudah terpasang saat pembuatan VM.',
      );
    }

    return lines.join('\n');
  }

  private buildVmListMessage(
    vms: { name: string; id: number; state: string; autostart?: boolean }[],
  ): string {
    if (vms.length === 0) return 'Belum ada VM.';
    const stateLabel: Record<string, string> = {
      running: 'berjalan',
      shutoff: 'mati',
      shut_off: 'mati',
      paused: 'dijeda',
    };
    const lines = vms.map((v) => {
      const state = stateLabel[v.state] ?? v.state;
      return `• ${v.name} — ${state}`;
    });
    const header = vms.length === 1 ? 'Ada 1 VM:' : `Ada ${vms.length} VM:`;
    return [header, '', ...lines].join('\n');
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
    n: NormalizedConfig,
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
    if (n.credentials) {
      lines.push(
        '',
        'Instalasi OS akan berjalan otomatis (tanpa perlu konsol) dengan akun:',
        `• Username: ${n.credentials.username}`,
        `• Password: ${n.credentials.password}`,
        '(Simpan kredensial ini — password di-generate otomatis.)',
      );
    }
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
      return [
        'Master image yang dibutuhkan tidak ditemukan pada server KVM. VM belum dibuat.',
        '',
        'Saya bisa membantu mengunduhnya. Kirimkan tautan (URL) file image (http/https),',
        'misalnya: "unduh master image dari https://.../image.qcow2".',
      ].join('\n');
    }
    if (/virt-install is not installed/i.test(message)) {
      return 'virt-install belum terpasang di host. Jalankan: sudo apt-get install -y virtinst';
    }
    if (/libvirt-sock.*[Pp]ermission denied|[Pp]ermission denied.*libvirt-sock/.test(message)) {
      return [
        'Backend tidak punya izin ke libvirt (socket permission denied).',
        'Pastikan proses backend berjalan dengan grup "libvirt" aktif, lalu jalankan ulang backend.',
      ].join('\n');
    }
    if (/[Pp]ermission denied|[Cc]annot access|[Cc]ould not open/.test(message)) {
      return [
        'VM gagal dibuat karena masalah izin akses file (qemu tidak dapat membaca disk/ISO).',
        '',
        `Detail: ${message.trim()}`,
      ].join('\n');
    }
    // Surface the raw detail so failures are debuggable from the chat itself.
    return `VM gagal dibuat.\n\nDetail: ${message.trim()}`;
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
    // Download proposals have no create-shaped proposal payload to echo back.
    if (p.kind !== 'create_vm' || !p.normalized) {
      return {
        conversationId: conv.id,
        state: conv.state,
        message,
        requiresConfirmation: true,
        warnings: [],
      };
    }
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
