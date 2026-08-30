import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../config.js';
import type { ConversationStore } from '../conversation/store.js';
import type { Orchestrator } from '../agent/orchestrator.js';
import type { VmService } from '../vm/service.js';
import type { McpClient } from '../mcp/client.js';
import { McpError } from '../mcp/client.js';

export interface RouteDeps {
  cfg: AppConfig;
  store: ConversationStore;
  orchestrator: Orchestrator;
  vmService: VmService;
  mcp: McpClient;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

export function buildRouter(deps: RouteDeps): Router {
  const router = Router();
  const { cfg, store, orchestrator, vmService, mcp } = deps;

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      mcp: mcp.mode,
      llm: cfg.llm.configured ? 'configured' : 'missing',
    });
  });

  router.get('/mcp/tools', (_req: Request, res: Response) => {
    res.json({ tools: mcp.listTools() });
  });

  // POST /api/chat
  router.post('/chat', async (req: Request, res: Response) => {
    const message = asString(req.body?.message);
    if (!message) {
      return res
        .status(400)
        .json({ error: { category: 'user', message: 'Field "message" wajib diisi.' } });
    }
    const conversationId = asString(req.body?.conversation_id);
    try {
      const result = await orchestrator.chat(conversationId, message);
      res.json({
        conversation_id: result.conversationId,
        state: result.state,
        message: result.message,
        proposal: result.proposal,
        download_proposal: result.downloadProposal,
        delete_proposal: result.deleteProposal,
        requires_confirmation: result.requiresConfirmation,
        warnings: result.warnings,
        vms: result.vms,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/vm/confirm
  router.post('/vm/confirm', async (req: Request, res: Response) => {
    const conversationId = asString(req.body?.conversation_id);
    const confirmationId = asString(req.body?.confirmation_id);
    const confirmed = req.body?.confirmed === true;
    if (!conversationId || !confirmationId) {
      return res.status(400).json({
        error: { category: 'user', message: 'conversation_id dan confirmation_id wajib diisi.' },
      });
    }
    const conv = store.get(conversationId);
    if (!conv) {
      return res
        .status(404)
        .json({ error: { category: 'user', message: 'Percakapan tidak ditemukan.' } });
    }
    try {
      const result = await orchestrator.execute(conv, confirmationId, confirmed);
      res.json({
        conversation_id: result.conversationId,
        state: result.state,
        message: result.message,
        ok: result.ok,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/vm/cancel
  router.post('/vm/cancel', async (req: Request, res: Response) => {
    const conversationId = asString(req.body?.conversation_id);
    const confirmationId = asString(req.body?.confirmation_id);
    if (!conversationId || !confirmationId) {
      return res.status(400).json({
        error: { category: 'user', message: 'conversation_id dan confirmation_id wajib diisi.' },
      });
    }
    const conv = store.get(conversationId);
    if (!conv) {
      return res
        .status(404)
        .json({ error: { category: 'user', message: 'Percakapan tidak ditemukan.' } });
    }
    const result = await orchestrator.execute(conv, confirmationId, false);
    res.json({ conversation_id: result.conversationId, state: result.state, message: result.message });
  });

  // GET /api/vms
  router.get('/vms', async (_req: Request, res: Response) => {
    try {
      res.json({ vms: await vmService.listVms() });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/vms/:name
  router.get('/vms/:name', async (req: Request, res: Response) => {
    try {
      const vm = await vmService.getVm(req.params.name);
      if (!vm) return res.status(404).json({ error: { category: 'user', message: 'VM tidak ditemukan.' } });
      res.json({ vm });
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/vms/:name/start|stop|reboot
  for (const action of ['start', 'stop', 'reboot'] as const) {
    router.post(`/vms/:name/${action}`, async (req: Request, res: Response) => {
      try {
        const name = req.params.name;
        const result =
          action === 'start'
            ? await vmService.startVm(name)
            : action === 'stop'
              ? await vmService.stopVm(name, req.body?.force === true)
              : await vmService.rebootVm(name);
        res.json({ ok: result.ok, message: result.message });
      } catch (err) {
        handleError(res, err);
      }
    });
  }

  return router;
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof McpError) {
    return void res
      .status(502)
      .json({ error: { category: 'mcp', message: 'Server virtualisasi tidak dapat diakses.' } });
  }
  console.error('[api] unexpected error:', (err as Error).message);
  res
    .status(500)
    .json({ error: { category: 'internal', message: 'Terjadi kesalahan internal.' } });
}
