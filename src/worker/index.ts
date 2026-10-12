import type { WorkerEnv } from "../types/config.js";
import type { ChatCompletionRequest } from "../types/openai.js";
import { getModelList } from "../proxy/model-catalog.js";
import { CompletionProxyHandler } from "../proxy/completion-handler.js";
import { AccountPoolManager } from "../auth/pool-manager.js";
import { DEFAULT_GATEWAY_URL } from "../auth/oauth-client.js";

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-OmniRush-Client",
};

// Global pool instance in worker memory across invocations within the same isolate
let globalPool: AccountPoolManager | null = null;
let lastTokenHash = "";

async function getOrCreatePool(env: WorkerEnv): Promise<AccountPoolManager> {
  const envTokens = env.OMNIRUSH_REFRESH_TOKEN ?? "";
  const accessToken = env.OMNIRUSH_ACCESS_TOKEN ?? "";
  const gatewayUrl = env.GATEWAY_URL || DEFAULT_GATEWAY_URL;

  let kvToken: string | null = null;
  if (env.TOKEN_KV) {
    try {
      kvToken = await env.TOKEN_KV.get("omnirush_token");
    } catch {
      // Fallback to environment tokens
    }
  }

  const effectiveTokenString = kvToken || envTokens;
  const tokenHash = `${effectiveTokenString}::${accessToken}::${gatewayUrl}`;

  if (globalPool === null || lastTokenHash !== tokenHash) {
    globalPool = new AccountPoolManager(gatewayUrl, async (_oldToken, account) => {
      if (env.TOKEN_KV) {
        try {
          await env.TOKEN_KV.put(
            "omnirush_token",
            `${account.refreshToken}|${account.accessToken ?? ""}`
          );
        } catch (err) {
          console.error("[Omnirush2API Worker KV] Failed to store rotated token:", err);
        }
      }
    });

    if (effectiveTokenString.trim() !== "") {
      globalPool.initFromTokenList(effectiveTokenString);
      if (accessToken.trim() !== "") {
        const accounts = globalPool.getAllAccounts();
        if (accounts.length > 0 && accounts[0] && !accounts[0].accessToken) {
          (accounts[0] as { accessToken: string | null }).accessToken = accessToken.trim();
          (accounts[0] as { expiresAt: number }).expiresAt = Date.now() + 3600_000;
        }
      }
    }
    lastTokenHash = tokenHash;
  }
  return globalPool;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // Check optional API_KEY secret
    if (env.API_KEY && env.API_KEY.trim() !== "") {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== `Bearer ${env.API_KEY}`) {
        return jsonResponse(
          {
            error: {
              message: "Invalid API key provided.",
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          },
          401
        );
      }
    }

    const pool = await getOrCreatePool(env);

    // Route: GET /v1/health or /health or /
    if (request.method === "GET" && (pathname === "/v1/health" || pathname === "/health" || pathname === "/")) {
      const stats = pool.getStats();
      const isBanned = stats.total > 0 && stats.banned === stats.total;
      const isDegraded = stats.total > 0 && stats.active === 0;
      const isUnhealthy = stats.total === 0;

      return jsonResponse({
        status: isBanned ? "banned" : isUnhealthy ? "unhealthy" : isDegraded ? "degraded" : "healthy",
        version: "1.0.1",
        mode: "cloudflare-worker",
        api_key_configured: Boolean(env.API_KEY && env.API_KEY.trim() !== ""),
        kv_storage_configured: Boolean(env.TOKEN_KV),
        account_count: stats.total,
        active_accounts: stats.active,
        cooldown_accounts: stats.inCooldown,
        banned_accounts: stats.banned,
        supported_models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol"],
      });
    }

    // Route: GET /v1/models
    if (request.method === "GET" && pathname === "/v1/models") {
      return jsonResponse(getModelList());
    }

    // Route: POST /v1/chat/completions or POST /v1/responses
    if (request.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/v1/responses")) {
      let body: ChatCompletionRequest;
      try {
        body = (await request.json()) as ChatCompletionRequest;
      } catch {
        return jsonResponse(
          { error: { message: "Malformed JSON payload in request body.", type: "invalid_request_error" } },
          400
        );
      }

      if (!body.model || !Array.isArray(body.messages)) {
        return jsonResponse(
          { error: { message: "Missing required 'model' or 'messages' field.", type: "invalid_request_error" } },
          400
        );
      }

      const handler = new CompletionProxyHandler({
        pool,
        upstreamBaseUrl: env.GATEWAY_URL || DEFAULT_GATEWAY_URL,
      });

      const result = await handler.handleCompletion(body, request.signal);

      if (result.isStream && result.streamResponse) {
        return new Response(result.streamResponse, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...CORS_HEADERS,
          },
        });
      }

      if (result.jsonResponse) {
        return jsonResponse(result.jsonResponse, result.status);
      }

      return jsonResponse(result.errorResponse ?? {}, result.status);
    }

    // 404 Fallback
    return jsonResponse(
      {
        error: {
          message: `Unknown path: ${pathname}`,
          type: "invalid_request_error",
          code: "resource_not_found",
        },
      },
      404
    );
  },
};
