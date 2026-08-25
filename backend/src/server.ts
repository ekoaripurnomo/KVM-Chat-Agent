import { loadConfig } from './config.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { app, mcp } = buildApp(cfg);

  try {
    await mcp.connect();
    console.log(`[mcp] connected in "${mcp.mode}" mode`);
  } catch (err) {
    console.error('[mcp] initial connect failed:', (err as Error).message);
    // The server still starts; MCP calls will surface errors gracefully.
  }

  const server = app.listen(cfg.port, () => {
    console.log(`[server] KVM Chat Agent listening on http://localhost:${cfg.port}`);
    console.log(`[server] LLM: ${cfg.llm.configured ? cfg.llm.model : 'not configured'}`);
    console.log(`[server] MCP mode: ${cfg.mcp.mode}`);
  });

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[server] received ${sig}, shutting down...`);
    server.close();
    await mcp.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
