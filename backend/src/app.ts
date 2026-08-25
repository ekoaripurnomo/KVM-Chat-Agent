import express, { type Express } from 'express';
import cors from 'cors';
import type { AppConfig } from './config.js';
import { AuditLogger } from './audit/logger.js';
import { ConversationStore } from './conversation/store.js';
import { ValidationEngine } from './validation/engine.js';
import { OpenAICompatibleProvider, type LlmProvider } from './llm/provider.js';
import { VmAgent } from './agent/agent.js';
import { Orchestrator } from './agent/orchestrator.js';
import { createMcpClient, type McpClient } from './mcp/client.js';
import { VmService } from './vm/service.js';
import { buildRouter } from './api/routes.js';

export interface BuiltApp {
  app: Express;
  mcp: McpClient;
  store: ConversationStore;
  orchestrator: Orchestrator;
  vmService: VmService;
}

export interface BuildOptions {
  /** Override the LLM provider (e.g. for tests). Defaults to OpenAI-compatible. */
  llmProvider?: LlmProvider;
  /** Override the MCP client (e.g. force mock in tests). */
  mcp?: McpClient;
}

/** Wire the whole backend. Reused by the server entry and by tests. */
export function buildApp(cfg: AppConfig, opts: BuildOptions = {}): BuiltApp {
  const audit = new AuditLogger(cfg.auditLogFile);
  const store = new ConversationStore();
  const validator = new ValidationEngine(cfg);
  const provider = opts.llmProvider ?? new OpenAICompatibleProvider(cfg.llm);
  const agent = new VmAgent(cfg, provider);
  const mcp = opts.mcp ?? createMcpClient(cfg.mcp);
  const vmService = new VmService(cfg, mcp);
  const orchestrator = new Orchestrator(cfg, store, agent, validator, vmService, audit);

  const app = express();
  app.use(cors({ origin: cfg.corsOrigin.length ? cfg.corsOrigin : true }));
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', buildRouter({ cfg, store, orchestrator, vmService, mcp }));

  return { app, mcp, store, orchestrator, vmService };
}
