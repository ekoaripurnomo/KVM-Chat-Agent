import { describe, expect, it } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import { VmAgent } from './agent.js';
import { ConversationStore } from '../conversation/store.js';
import { ValidationEngine } from '../validation/engine.js';
import { VmService } from '../vm/service.js';
import { MockMcpClient } from '../mcp/client.js';
import { AuditLogger } from '../audit/logger.js';
import { testConfig, unavailableProvider } from '../test-helpers.js';
import type { AppConfig } from '../config.js';

function makeOrchestrator(cfg: AppConfig = testConfig()) {
  const store = new ConversationStore();
  const agent = new VmAgent(cfg, unavailableProvider);
  const validator = new ValidationEngine(cfg);
  const mcp = new MockMcpClient();
  const vmService = new VmService(cfg, mcp);
  const audit = new AuditLogger('./audit/test-audit.log');
  const orchestrator = new Orchestrator(cfg, store, agent, validator, vmService, audit);
  return { orchestrator, store, mcp };
}

describe('get_vm_access', () => {
  it('returns the real IP and ssh command for a running VM', async () => {
    const { orchestrator } = makeOrchestrator();
    // The mock seeds a running "demo-vm-01".
    const res = await orchestrator.chat(undefined, 'how to ssh demo-vm-01');
    expect(res.message).toContain('demo-vm-01');
    expect(res.message).toContain('192.168.122.50');
    expect(res.message.toLowerCase()).toContain('ssh ');
    expect(res.requiresConfirmation).toBe(false);
  });

  it('never fabricates a password for ISO-installed VMs', async () => {
    const cfg = testConfig({
      mcp: { ...testConfig().mcp, defaultMasterImage: '/home/x/kvm/images/ubuntu-22.04.iso' },
    });
    const { orchestrator } = makeOrchestrator(cfg);
    const res = await orchestrator.chat(undefined, 'akses demo-vm-01');
    // Honest: tells the user the password is not stored.
    expect(res.message.toLowerCase()).toMatch(/tidak menyimpan password|instalasi/);
  });

  it('asks which VM when no name is given', async () => {
    const { orchestrator } = makeOrchestrator();
    const res = await orchestrator.chat(undefined, 'bagaimana cara ssh');
    expect(res.message.toLowerCase()).toContain('vm mana');
  });

  it('reports when the VM is not found', async () => {
    const { orchestrator } = makeOrchestrator();
    const res = await orchestrator.chat(undefined, 'ssh nonexistent-vm');
    expect(res.message.toLowerCase()).toMatch(/tidak ditemukan/);
  });
});
