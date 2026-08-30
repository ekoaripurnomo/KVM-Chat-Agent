import type { AppConfig } from './config.js';
import type { LlmProvider, ChatMessage } from './llm/provider.js';

/** Deterministic config for tests (no external services). */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    port: 0,
    corsOrigin: [],
    llm: {
      baseUrl: 'http://localhost/v1',
      model: 'test-model',
      apiKey: '',
      timeoutMs: 1000,
      configured: false,
    },
    policy: {
      minVcpu: 1,
      minMemoryMb: 512,
      minDiskGb: 5,
      maxVcpu: 16,
      maxMemoryMb: 32768,
      maxDiskGb: 500,
    },
    defaults: {
      network: 'brforvms',
      diskGb: 20,
      osVariant: 'generic',
      display: 'vnc',
    },
    mcp: {
      mode: 'mock',
      command: 'python3',
      args: ['kvm_mcp_server.py'],
      cwd: undefined,
      defaultMasterImage: '/iso/base.qcow2',
      masterImageDir: '/iso',
      sshPublicKey: '',
      callTimeoutMs: 5000,
    },
    auditLogFile: './audit/test-audit.log',
  };
  return { ...base, ...overrides };
}

/** A provider that is never available, forcing the deterministic fallback. */
export const unavailableProvider: LlmProvider = {
  available: false,
  async complete(_messages: ChatMessage[]): Promise<string> {
    throw new Error('should not be called');
  },
};

/** A provider that returns a fixed JSON string (to test LLM-path parsing). */
export function scriptedProvider(response: string): LlmProvider {
  return {
    available: true,
    async complete(): Promise<string> {
      return response;
    },
  };
}
