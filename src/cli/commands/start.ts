import { startHttpServer } from "../../server/http-server.js";
import { AccountPoolManager } from "../../auth/pool-manager.js";
import { findLocalCredentials } from "../../auth/clicreds.js";
import { loadStoredTokens } from "../../auth/token-store.js";
import { DEFAULT_GATEWAY_URL } from "../../auth/oauth-client.js";
import type { ServerConfig } from "../../types/config.js";

export interface StartCommandOptions {
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly key?: string | undefined;
  readonly gatewayUrl?: string | undefined;
  readonly token?: string | undefined;
}

export async function runStartCommand(options: StartCommandOptions = {}): Promise<void> {
  const port = options.port ?? 20129;
  const host = options.host ?? "127.0.0.1";
  const apiKey = options.key || process.env["API_KEY"];
  const gatewayUrl = options.gatewayUrl || process.env["OMNIRUSH_GATEWAY_URL"] || DEFAULT_GATEWAY_URL;

  const pool = new AccountPoolManager(gatewayUrl);

  // 1. If explicit token passed via --token
  if (options.token) {
    pool.initFromTokenList(options.token);
  }

  // 2. Load stored tokens from ~/.omnirush2api/tokens.json
  const stored = await loadStoredTokens();
  for (const s of stored) {
    pool.addAccount(s.refreshToken, s.gatewayUrl, s.email, s.accessToken);
  }

  // 3. Auto-discover from local desktop / env vars
  const discovered = await findLocalCredentials();
  for (const d of discovered) {
    pool.addAccount(d.refreshToken, d.gatewayUrl, d.email, d.accessToken);
  }

  const stats = pool.getStats();

  console.log("\n========================================================");
  console.log("   Omnirush2API - OpenAI Reverse Proxy & OAuth Router   ");
  console.log("========================================================\n");
  console.log(`✓ Listening:           http://${host}:${port}/v1`);
  console.log(`✓ Health Check:        http://${host}:${port}/health`);
  console.log(`✓ Upstream Gateway:    ${gatewayUrl}`);
  console.log(`✓ Authorization:       ${apiKey ? "Enabled (Bearer key enforced)" : "Open (No API key required)"}`);
  console.log(`✓ Configured Accounts: ${stats.total}`);

  if (stats.total === 0) {
    console.warn("\n⚠️  No accounts currently loaded in pool!");
    console.warn("Run 'omnirush2api login' or set OMNIRUSH_REFRESH_TOKEN to authenticate.\n");
  } else {
    console.log("✓ Ready to proxy requests for Claude Code, Cursor, Codex, OpenCode, etc.\n");
  }

  const config: ServerConfig = {
    port,
    host,
    apiKey,
    gatewayUrl,
  };

  const runningServer = await startHttpServer(config, pool);

  const shutdown = async (): Promise<void> => {
    console.log("\n[Omnirush2API] Shutting down server gracefully...");
    await runningServer.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
