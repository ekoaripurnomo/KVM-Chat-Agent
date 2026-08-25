import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { McpConfig } from '../config.js';

/** Static, source-derived tool catalog (the real server has no tools/list). */
export interface McpToolSchema {
  name: string;
  description: string;
  arguments: Record<string, { type: string; required: boolean; note?: string }>;
}

export const MCP_TOOL_CATALOG: McpToolSchema[] = [
  {
    name: 'create_vm',
    description: 'Create a new VM using virt-install (Fedora CoreOS / ignition based).',
    arguments: {
      name: { type: 'string', required: true },
      memory: { type: 'integer(MB)', required: true, note: '256..1048576' },
      vcpus: { type: 'integer', required: true, note: '1..128' },
      disk_size: { type: 'integer(GB)', required: false, note: 'default 20, 1..10000' },
      network: { type: 'string', required: false, note: 'default brforvms' },
      master_image: { type: 'string', required: true, note: 'host path, must exist' },
      ignition: { type: 'object', required: true },
      os_variant: { type: 'string', required: false, note: 'default fedora-coreos-stable' },
    },
  },
  {
    name: 'list_vms',
    description: 'List all VMs with status.',
    arguments: { use_cache: { type: 'boolean', required: false, note: 'default true' } },
  },
  {
    name: 'start_vm',
    description: 'Start a VM.',
    arguments: { vm_name: { type: 'string', required: true } },
  },
  {
    name: 'stop_vm',
    description: 'Stop a VM (graceful shutdown, or destroy when force=true).',
    arguments: {
      vm_name: { type: 'string', required: true },
      force: { type: 'boolean', required: false, note: 'default false' },
    },
  },
  {
    name: 'reboot_vm',
    description: 'Reboot a running VM.',
    arguments: { vm_name: { type: 'string', required: true } },
  },
];

export interface McpClient {
  connect(): Promise<void>;
  listTools(): McpToolSchema[];
  getToolSchema(name: string): McpToolSchema | undefined;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  disconnect(): Promise<void>;
  readonly mode: 'mock' | 'stdio';
}

export class McpError extends Error {}

/** Shared static catalog helpers. */
abstract class BaseMcpClient implements McpClient {
  abstract readonly mode: 'mock' | 'stdio';
  abstract connect(): Promise<void>;
  abstract callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  abstract disconnect(): Promise<void>;

  listTools(): McpToolSchema[] {
    return MCP_TOOL_CATALOG;
  }
  getToolSchema(name: string): McpToolSchema | undefined {
    return MCP_TOOL_CATALOG.find((t) => t.name === name);
  }
}

/**
 * Talks to the real kvm-mcp server over JSON-RPC 2.0 on stdio.
 * One JSON request per line to stdin; one JSON response per line from stdout.
 */
export class StdioMcpClient extends BaseMcpClient {
  readonly mode = 'stdio' as const;
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly cfg: McpConfig) {
    super();
  }

  async connect(): Promise<void> {
    if (this.child) return;
    this.child = spawn(this.cfg.command, this.cfg.args, {
      cwd: this.cfg.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.child.on('error', (err) => this.failAll(new McpError(`MCP process error: ${err.message}`)));
    this.child.on('exit', (code) =>
      this.failAll(new McpError(`MCP process exited with code ${code ?? 'unknown'}`)),
    );

    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => this.onLine(line));

    await this.rpc('initialize', {});
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore non-JSON console noise
    }
    if (typeof msg.id !== 'number') return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    if (msg.error) entry.reject(new McpError(msg.error.message ?? 'MCP error'));
    else entry.resolve(msg.result);
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new McpError('MCP process is not connected.'));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError('MCP request timed out.'));
      }, this.cfg.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(payload + '\n');
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.getToolSchema(name)) throw new McpError(`Unknown MCP tool: ${name}`);
    return this.rpc('tools/call', { name, arguments: args });
  }

  async disconnect(): Promise<void> {
    this.rl?.close();
    this.rl = null;
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.failAll(new McpError('MCP disconnected.'));
  }
}

/**
 * In-process fake MCP server that honors the real schemas. Safe for demos and
 * tests — it never touches real infrastructure.
 */
export class MockMcpClient extends BaseMcpClient {
  readonly mode = 'mock' as const;
  private readonly vms = new Map<
    string,
    { name: string; id: number; state: string; autostart: boolean; persistent: boolean }
  >();
  private idSeq = 1;

  async connect(): Promise<void> {
    if (this.vms.size === 0) {
      this.vms.set('demo-vm-01', {
        name: 'demo-vm-01',
        id: this.idSeq++,
        state: 'running',
        autostart: true,
        persistent: true,
      });
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'create_vm': {
        const vmName = String(args.name ?? '');
        if (this.vms.has(vmName)) {
          return { status: 'error', message: `Disk image /vm/${vmName}.qcow2 already exists` };
        }
        this.vms.set(vmName, {
          name: vmName,
          id: this.idSeq++,
          state: 'running',
          autostart: false,
          persistent: true,
        });
        return { status: 'success', message: `VM ${vmName} created successfully using virt-install` };
      }
      case 'list_vms':
        return [...this.vms.values()];
      case 'start_vm': {
        const vm = this.vms.get(String(args.vm_name));
        if (!vm) return { success: false, error: 'Domain not found' };
        vm.state = 'running';
        return { success: true, message: `VM ${vm.name} started successfully` };
      }
      case 'stop_vm': {
        const vm = this.vms.get(String(args.vm_name));
        if (!vm) return { success: false, error: 'Domain not found' };
        vm.state = 'shutoff';
        return { success: true, message: `VM ${vm.name} shutdown successfully` };
      }
      case 'reboot_vm': {
        const vm = this.vms.get(String(args.vm_name));
        if (!vm) return { success: false, error: 'Domain not found' };
        return { success: true, message: `VM ${vm.name} rebooted successfully` };
      }
      default:
        throw new McpError(`Unknown MCP tool: ${name}`);
    }
  }

  async disconnect(): Promise<void> {
    // nothing to clean up
  }
}

export function createMcpClient(cfg: McpConfig): McpClient {
  return cfg.mode === 'stdio' ? new StdioMcpClient(cfg) : new MockMcpClient();
}
