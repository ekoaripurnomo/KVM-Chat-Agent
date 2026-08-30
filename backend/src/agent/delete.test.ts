import { describe, expect, it } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import { VmAgent } from './agent.js';
import { ConversationStore } from '../conversation/store.js';
import { ValidationEngine } from '../validation/engine.js';
import { VmService } from '../vm/service.js';
import { MockMcpClient } from '../mcp/client.js';
import { AuditLogger } from '../audit/logger.js';
import { testConfig, unavailableProvider } from '../test-helpers.js';

function makeOrchestrator() {
  const cfg = testConfig();
  const store = new ConversationStore();
  const agent = new VmAgent(cfg, unavailableProvider);
  const validator = new ValidationEngine(cfg);
  const mcp = new MockMcpClient();
  const vmService = new VmService(cfg, mcp);
  const audit = new AuditLogger('./audit/test-audit.log');
  const orchestrator = new Orchestrator(cfg, store, agent, validator, vmService, audit);
  return { orchestrator, store, mcp };
}

describe('delete_vm', () => {
  it('proposes deletion and requires confirmation (does not delete yet)', async () => {
    const { orchestrator, store, mcp } = makeOrchestrator();
    const res = await orchestrator.chat(undefined, 'hapus vm demo-vm-01');
    expect(res.requiresConfirmation).toBe(true);
    expect(res.state).toBe('PROPOSING');
    expect(res.message.toLowerCase()).toMatch(/menghapus|tidak dapat dibatalkan/);

    // Still present — nothing deleted on a mere proposal.
    const vms = (await mcp.callTool('list_vms', { use_cache: false })) as { name: string }[];
    expect(vms.some((v) => v.name === 'demo-vm-01')).toBe(true);
    expect(store.get(res.conversationId)!.pendingProposal?.kind).toBe('delete_vm');
  });

  it('deletes only after explicit confirmation', async () => {
    const { orchestrator, store, mcp } = makeOrchestrator();
    const propose = await orchestrator.chat(undefined, 'hapus vm demo-vm-01');
    const conv = store.get(propose.conversationId)!;
    const cid = conv.pendingProposal!.confirmationId;

    const res = await orchestrator.execute(conv, cid, true);
    expect(res.ok).toBe(true);
    expect(res.state).toBe('COMPLETED');
    expect(res.message.toLowerCase()).toContain('berhasil dihapus');

    const vms = (await mcp.callTool('list_vms', { use_cache: false })) as { name: string }[];
    expect(vms.some((v) => v.name === 'demo-vm-01')).toBe(false);
  });

  it('cancels without deleting when the user declines', async () => {
    const { orchestrator, store, mcp } = makeOrchestrator();
    const propose = await orchestrator.chat(undefined, 'hapus vm demo-vm-01');
    const conv = store.get(propose.conversationId)!;
    const cid = conv.pendingProposal!.confirmationId;

    const res = await orchestrator.execute(conv, cid, false);
    expect(res.ok).toBe(false);
    const vms = (await mcp.callTool('list_vms', { use_cache: false })) as { name: string }[];
    expect(vms.some((v) => v.name === 'demo-vm-01')).toBe(true);
  });

  it('reports when the VM does not exist', async () => {
    const { orchestrator } = makeOrchestrator();
    const res = await orchestrator.chat(undefined, 'hapus vm ghost-vm');
    expect(res.message.toLowerCase()).toMatch(/tidak ditemukan/);
    expect(res.requiresConfirmation).toBe(false);
  });

  it('asks which VM when none is specified', async () => {
    const { orchestrator } = makeOrchestrator();
    const res = await orchestrator.chat(undefined, 'hapus vm');
    expect(res.message.toLowerCase()).toContain('vm mana');
  });
});
