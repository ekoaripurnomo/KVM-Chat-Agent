import type { AppConfig } from '../config.js';
import type { McpClient } from '../mcp/client.js';
import { McpError } from '../mcp/client.js';
import type { NormalizedConfig, NormalizedDownload } from './intent.js';

export interface VmSummary {
  name: string;
  id: number;
  state: string;
  autostart: boolean;
  persistent: boolean;
}

export interface VmAccess {
  ok: boolean;
  name: string;
  active: boolean;
  ips: string[];
  ipSource: string | null;
  message?: string;
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
   * The install image path comes from app configuration, never the LLM.
   *
   * The install mode is chosen deterministically from the configured image's
   * extension: a `.iso` boots an installer via `--cdrom` (install_iso), any
   * other extension (e.g. `.qcow2`/`.img`) is treated as a master image that is
   * imported directly with an Ignition config.
   */
  buildCreateArguments(config: NormalizedConfig): Record<string, unknown> {
    const image = this.cfg.mcp.defaultMasterImage;
    const base: Record<string, unknown> = {
      name: config.name,
      memory: config.memoryMb,
      vcpus: config.vcpus,
      disk_size: config.diskGb,
      network: config.network,
      os_variant: config.osVariant,
    };

    if (/\.iso$/i.test(image)) {
      const iso: Record<string, unknown> = { ...base, install_iso: image };
      // Unattended install when credentials are present. The plaintext password
      // is hashed host-side by the MCP server, not stored in the VM config.
      if (config.credentials) {
        iso.username = config.credentials.username;
        iso.password = config.credentials.password;
        iso.hostname = config.credentials.hostname;
        if (this.cfg.mcp.sshPublicKey) iso.ssh_key = this.cfg.mcp.sshPublicKey;
      }
      return iso;
    }
    return {
      ...base,
      master_image: image,
      // Minimal valid ignition object; the master-image path requires a dict.
      ignition: { hostname: config.name },
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

  /** Build the deterministic download_master_image arguments. */
  buildDownloadArguments(dl: NormalizedDownload): Record<string, unknown> {
    return {
      url: dl.url,
      filename: dl.filename,
      dest_dir: dl.destDir,
    };
  }

  async downloadMasterImage(dl: NormalizedDownload): Promise<OperationResult> {
    const args = this.buildDownloadArguments(dl);
    const raw = await this.mcp.callTool('download_master_image', args);
    const result = raw as { status?: string; message?: string; path?: string };
    const ok = result?.status === 'success';
    return {
      ok,
      message: result?.message ?? (ok ? 'Image downloaded.' : 'Image download failed.'),
      data: raw,
      mcpTool: 'download_master_image',
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

  async deleteVm(name: string): Promise<OperationResult> {
    const args = { vm_name: name, remove_disks: true };
    const raw = await this.mcp.callTool('delete_vm', args);
    const result = raw as { status?: string; message?: string; removed?: string[] };
    const ok = result?.status === 'success';
    return {
      ok,
      message: result?.message ?? (ok ? 'VM deleted.' : 'Delete failed.'),
      data: raw,
      mcpTool: 'delete_vm',
      mcpArguments: args,
    };
  }

  async getVmAccess(name: string): Promise<VmAccess> {
    const raw = await this.mcp.callTool('get_vm_access', { vm_name: name });
    const r = (raw ?? {}) as {
      status?: string;
      name?: string;
      active?: boolean;
      ips?: string[];
      ip_source?: string | null;
      message?: string;
    };
    return {
      ok: r.status === 'success',
      name: r.name ?? name,
      active: r.active === true,
      ips: Array.isArray(r.ips) ? r.ips : [],
      ipSource: r.ip_source ?? null,
      message: r.message,
    };
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
