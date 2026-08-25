import type { AppConfig } from '../config.js';
import type { McpClient } from '../mcp/client.js';
import { McpError } from '../mcp/client.js';
import type { NormalizedConfig } from './intent.js';

export interface VmSummary {
  name: string;
  id: number;
  state: string;
  autostart: boolean;
  persistent: boolean;
}

export interface OperationResult {
  ok: boolean;
  message: string;
  data?: unknown;
  /** The exact MCP tool + arguments used (for audit). */
  mcpTool: string;
  mcpArguments: Record<string, unknown>;
}

/**
 * Higher-level, deterministic service that isolates MCP details from the agent
 * (spec §18/§30). It builds validated MCP arguments from a NormalizedConfig —
 * the LLM never constructs these arguments directly.
 */
export class VmService {
  constructor(
    private readonly cfg: AppConfig,
    private readonly mcp: McpClient,
  ) {}

  /**
   * Map the canonical, validated config onto the REAL create_vm tool schema.
   * master_image and ignition come from app configuration, never the LLM.
   */
  buildCreateArguments(config: NormalizedConfig): Record<string, unknown> {
    return {
      name: config.name,
      memory: config.memoryMb,
      vcpus: config.vcpus,
      disk_size: config.diskGb,
      network: config.network,
      os_variant: config.osVariant,
      master_image: this.cfg.mcp.defaultMasterImage,
      // Minimal valid ignition object; the real server requires a dict.
      ignition: {
        hostname: config.name,
      },
    };
  }

  async createVm(config: NormalizedConfig): Promise<OperationResult> {
    const args = this.buildCreateArguments(config);
    const raw = await this.mcp.callTool('create_vm', args);
    const result = raw as { status?: string; message?: string };
    const ok = result?.status === 'success';
    return {
      ok,
      message: result?.message ?? (ok ? 'VM created.' : 'VM creation failed.'),
      data: raw,
      mcpTool: 'create_vm',
      mcpArguments: args,
    };
  }

  async listVms(): Promise<VmSummary[]> {
    const raw = await this.mcp.callTool('list_vms', { use_cache: false });
    if (!Array.isArray(raw)) return [];
    return raw as VmSummary[];
  }

  async getVm(name: string): Promise<VmSummary | null> {
    const vms = await this.listVms();
    return vms.find((v) => v.name === name) ?? null;
  }

  async startVm(name: string): Promise<OperationResult> {
    return this.lifecycle('start_vm', { vm_name: name });
  }

  async stopVm(name: string, force = false): Promise<OperationResult> {
    return this.lifecycle('stop_vm', { vm_name: name, force });
  }

  async rebootVm(name: string): Promise<OperationResult> {
    return this.lifecycle('reboot_vm', { vm_name: name });
  }

  private async lifecycle(
    tool: 'start_vm' | 'stop_vm' | 'reboot_vm',
    args: Record<string, unknown>,
  ): Promise<OperationResult> {
    const raw = await this.mcp.callTool(tool, args);
    const result = raw as { success?: boolean; message?: string; error?: string };
    const ok = result?.success === true;
    return {
      ok,
      message: result?.message ?? result?.error ?? (ok ? 'OK' : 'Operation failed.'),
      data: raw,
      mcpTool: tool,
      mcpArguments: args,
    };
  }
}

export { McpError };
