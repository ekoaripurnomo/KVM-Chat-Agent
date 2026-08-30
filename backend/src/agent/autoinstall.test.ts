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

// ISO-configured host so create_vm goes down the unattended-install path.
function isoConfig(): AppConfig {
  const base = testConfig();
  return {
    ...base,
    mcp: { ...base.mcp, defaultMasterImage: '/home/x/kvm/images/ubuntu-22.04.iso' },
  };
}

function makeOrchestrator(cfg: AppConfig = isoConfig()) {
  const store = new ConversationStore();
  const agent = new VmAgent(cfg, unavailableProvider);
  const validator = new ValidationEngine(cfg);
  const mcp = new MockMcpClient();
  const vmService = new VmService(cfg, mcp);
  const audit = new AuditLogger('./audit/test-audit.log');
  const orchestrator = new Orchestrator(cfg, store, agent, validator, vmService, audit);
  return { orchestrator, store, mcp };
}

const REQ = 'Buat VM Ubuntu 2 CPU RAM 4GB disk 40GB nama web-03.';

describe('unattended install (autoinstall)', () => {
  it('proposes generated credentials for an ISO install', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const res = await orchestrator.chat(undefined, REQ);
    expect(res.requiresConfirmation).toBe(true);
    expect(res.message.toLowerCase()).toContain('username');
    expect(res.message.toLowerCase()).toContain('password');

    const conv = store.get(res.conversationId)!;
    const creds = conv.pendingProposal?.normalized?.credentials;
    expect(creds).toBeDefined();
    expect(creds!.username).toBe('web-03'.replace(/[^a-z0-9_-]/g, ''));
    expect(creds!.password.length).toBeGreaterThanOrEqual(12);
  });

  it('reports the credentials after create', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const propose = await orchestrator.chat(undefined, REQ);
    const conv = store.get(propose.conversationId)!;
    const cid = conv.pendingProposal!.confirmationId;
    const creds = conv.pendingProposal!.normalized!.credentials!;

    const res = await orchestrator.execute(conv, cid, true);
    expect(res.ok).toBe(true);
    expect(res.message).toContain(creds.username);
    expect(res.message).toContain(creds.password);
    expect(res.message.toLowerCase()).toMatch(/otomatis|autoinstall|menginstal/);
  });

  it('passes username+password to the create_vm tool', async () => {
    const cfg = isoConfig();
    const vmService = new VmService(cfg, new MockMcpClient());
    const args = vmService.buildCreateArguments({
      name: 'web-03',
      osFamily: 'ubuntu',
      osVersion: '22.04',
      osVariant: 'generic',
      vcpus: 2,
      memoryMb: 4096,
      diskGb: 40,
      network: 'virbr0',
      display: 'vnc',
      credentials: { username: 'web03', password: 'p@ssw0rd-generated', hostname: 'web-03' },
    });
    expect(args.install_iso).toBe('/home/x/kvm/images/ubuntu-22.04.iso');
    expect(args.username).toBe('web03');
    expect(args.password).toBe('p@ssw0rd-generated');
    expect(args.hostname).toBe('web-03');
  });

  it('does NOT generate credentials for a qcow2 master image', async () => {
    // Non-ISO config -> master-image path, no autoinstall creds.
    const { orchestrator, store } = makeOrchestrator(testConfig());
    const res = await orchestrator.chat(undefined, REQ);
    const conv = store.get(res.conversationId)!;
    expect(conv.pendingProposal?.normalized?.credentials).toBeUndefined();
    expect(res.message.toLowerCase()).not.toContain('password');
  });
});
