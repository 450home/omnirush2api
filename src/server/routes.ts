import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerConfig } from "../types/config.js";
import type { ChatCompletionRequest } from "../types/openai.js";
import { getModelList } from "../proxy/model-catalog.js";
import { CompletionProxyHandler } from "../proxy/completion-handler.js";
import type { AccountPoolManager } from "../auth/pool-manager.js";

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-OmniRush-Client",
};

export class RequestDispatcher {
  private config: ServerConfig;
  private pool: AccountPoolManager;
  private handler: CompletionProxyHandler;

  constructor(config: ServerConfig, pool: AccountPoolManager) {
    this.config = config;
    this.pool = pool;
    this.handler = new CompletionProxyHandler({
      pool,
      upstreamBaseUrl: config.gatewayUrl,
    });
  }

  public async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      res.setHeader(key, value);
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Check optional Bearer authentication
    if (this.config.apiKey && this.config.apiKey.trim() !== "") {
      const authHeader = req.headers.authorization;
      const expected = `Bearer ${this.config.apiKey}`;
      if (authHeader !== expected) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Invalid API key provided.",
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          })
        );
        return;
      }
    }

    // Route: GET / or GET /v1/health or /health
    if (req.method === "GET" && (pathname === "/v1/health" || pathname === "/health" || pathname === "/")) {
      this.handleHealth(res);
      return;
    }

    // Route: GET /v1/models
    if (req.method === "GET" && pathname === "/v1/models") {
      this.handleModels(res);
      return;
    }

    // Route: POST /v1/chat/completions or POST /v1/responses
    if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/v1/responses")) {
      await this.handleChatCompletions(req, res);
      return;
    }

    // Fallback: 404 Not Found
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: `Unknown path: ${pathname}`,
          type: "invalid_request_error",
          code: "resource_not_found",
        },
      })
    );
  }

  private handleHealth(res: ServerResponse): void {
    const stats = this.pool.getStats();
    const isBanned = stats.total > 0 && stats.banned === stats.total;
    const isDegraded = stats.total > 0 && stats.active === 0;
    const isUnhealthy = stats.total === 0;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          status: isBanned ? "banned" : isUnhealthy ? "unhealthy" : isDegraded ? "degraded" : "healthy",
          version: "1.0.0",
          mode: "local-daemon",
          api_key_configured: Boolean(this.config.apiKey),
          account_count: stats.total,
          active_accounts: stats.active,
          cooldown_accounts: stats.inCooldown,
          banned_accounts: stats.banned,
          supported_models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol"],
        },
        null,
        2
      )
    );
  }

  private handleModels(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getModelList(), null, 2));
  }

  private async handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let rawBody = "";
    try {
      rawBody = await this.readRequestBody(req);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `Failed to read request body: ${err instanceof Error ? err.message : String(err)}`,
            type: "invalid_request_error",
          },
        })
      );
      return;
    }

    let payload: ChatCompletionRequest;
    try {
      payload = JSON.parse(rawBody) as ChatCompletionRequest;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Malformed JSON payload in request body.",
            type: "invalid_request_error",
          },
        })
      );
      return;
    }

    if (!payload.model || !Array.isArray(payload.messages)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Missing required 'model' or 'messages' field.",
            type: "invalid_request_error",
          },
        })
      );
      return;
    }

    const abortController = new AbortController();
    req.on("close", () => {
      abortController.abort();
    });

    const result = await this.handler.handleCompletion(payload, abortController.signal);

    if (result.isStream && result.streamResponse) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const reader = result.streamResponse.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch {
        // Stream aborted or connection broken
      } finally {
        res.end();
      }
      return;
    }

    if (result.jsonResponse) {
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.jsonResponse, null, 2));
      return;
    }

    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.errorResponse ?? {}, null, 2));
  }

  private readRequestBody(req: IncomingMessage, maxBytes = 25 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      let accumulated = "";
      let bytesCount = 0;

      req.on("data", (chunk: Buffer) => {
        bytesCount += chunk.length;
        if (bytesCount > maxBytes) {
          reject(new Error("Request payload exceeds 25MB limit."));
          req.destroy();
          return;
        }
        accumulated += chunk.toString("utf8");
      });

      req.on("end", () => resolve(accumulated));
      req.on("error", (err) => reject(err));
    });
  }
}
