import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Read an SSH public key file if present; empty string if none. */
function readSshPublicKey(configuredPath: string): string {
  const path = configuredPath.trim() || resolve(homedir(), '.ssh/id_rsa.pub');
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return '';
  }
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

export interface PolicyLimits {
  minVcpu: number;
  minMemoryMb: number;
  minDiskGb: number;
  maxVcpu: number;
  maxMemoryMb: number;
  maxDiskGb: number;
}

export interface AppDefaults {
  network: string;
  diskGb: number;
  osVariant: string;
  display: string;
}

export interface McpConfig {
  mode: 'mock' | 'stdio';
  command: string;
  args: string[];
  cwd?: string;
  defaultMasterImage: string;
  /** Host-side directory where downloaded master images are stored. */
  masterImageDir: string;
  /** Optional SSH public key injected into autoinstalled VMs. */
  sshPublicKey: string;
  callTimeoutMs: number;
}

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  configured: boolean;
}

export interface AppConfig {
  port: number;
  corsOrigin: string[];
  llm: LlmConfig;
  policy: PolicyLimits;
  defaults: AppDefaults;
  mcp: McpConfig;
  auditLogFile: string;
}

export function loadConfig(): AppConfig {
  const apiKey = str('LLM_API_KEY', '');
  const mode = str('MCP_MODE', 'mock') === 'stdio' ? 'stdio' : 'mock';

  return {
    port: num('PORT', 8787),
    corsOrigin: str('CORS_ORIGIN', 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    llm: {
      baseUrl: str('LLM_BASE_URL', 'http://172.18.101.88:8080/v1'),
      model: str('LLM_MODEL', 'gpt-oss'),
      apiKey,
      timeoutMs: num('LLM_TIMEOUT_MS', 60000),
      configured: apiKey.trim() !== '',
    },
    policy: {
      minVcpu: 1,
      minMemoryMb: 512,
      minDiskGb: 5,
      maxVcpu: num('MAX_VM_VCPU', 16),
      maxMemoryMb: num('MAX_VM_MEMORY_MB', 32768),
      maxDiskGb: num('MAX_VM_DISK_GB', 500),
    },
    defaults: {
      network: str('DEFAULT_NETWORK', 'brforvms'),
      diskGb: num('DEFAULT_DISK_GB', 20),
      osVariant: str('DEFAULT_OS_VARIANT', 'generic'),
      display: str('DEFAULT_DISPLAY', 'vnc'),
    },
    mcp: {
      mode,
      command: str('MCP_SERVER_COMMAND', 'python3'),
      args: str('MCP_SERVER_ARGS', 'kvm_mcp_server.py').split(' ').filter(Boolean),
      cwd: str('MCP_SERVER_CWD', '') || undefined,
      defaultMasterImage: str('MCP_DEFAULT_MASTER_IMAGE', ''),
      masterImageDir: str('MCP_MASTER_IMAGE_DIR', '/iso'),
      sshPublicKey: readSshPublicKey(str('SSH_PUBLIC_KEY_FILE', '')),
      callTimeoutMs: num('MCP_CALL_TIMEOUT_MS', 120000),
    },
    auditLogFile: str('AUDIT_LOG_FILE', './audit/audit.log'),
  };
}
