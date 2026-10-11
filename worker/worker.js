// src/proxy/model-catalog.ts
var DEFAULT_MODEL = "gpt-6-astra";
var KNOWN_MODELS = [
  {
    id: "gpt-6-astra",
    displayName: "GPT 6 Astra",
    family: "astra",
    contextLimit: 2e5,
    outputLimit: 16384,
    aliases: ["astra", "gpt-6", "omnirush", "gpt-6-astra-preview"]
  },
  {
    id: "gpt-6.1-sol",
    displayName: "GPT 6.1 Sol",
    family: "sol",
    contextLimit: 2e5,
    outputLimit: 16384,
    aliases: ["sol-pro", "gpt-6.1-sol-preview"]
  },
  {
    id: "gpt-6-sol",
    displayName: "GPT 6 Sol",
    family: "sol",
    contextLimit: 128e3,
    outputLimit: 8192,
    aliases: ["sol", "gpt-6-sol-preview"]
  }
];
function resolveModelId(requestedModel) {
  if (!requestedModel || requestedModel.trim() === "") {
    return DEFAULT_MODEL;
  }
  const normalized = requestedModel.trim().toLowerCase();
  for (const def of KNOWN_MODELS) {
    if (def.id.toLowerCase() === normalized) {
      return def.id;
    }
    if (def.aliases.some((alias) => alias.toLowerCase() === normalized)) {
      return def.id;
    }
  }
  return requestedModel.trim();
}
function getModelList() {
  const now = Math.floor(Date.now() / 1e3);
  const models = KNOWN_MODELS.map((def) => ({
    id: def.id,
    object: "model",
    created: now,
    owned_by: "omnirush.ai",
    root: def.id
  }));
  return {
    object: "list",
    data: models
  };
}

// src/auth/oauth-client.ts
var DEFAULT_GATEWAY_URL = "https://omnirush.ai/omnirush/v1";
function getControlPlaneUrl(gatewayUrl = DEFAULT_GATEWAY_URL) {
  const trimmed = gatewayUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -3);
  }
  return trimmed;
}
function isTokenExpired(expiresAt, bufferSeconds = 300) {
  if (expiresAt === void 0 || expiresAt <= 0) {
    return true;
  }
  const now = Date.now();
  return expiresAt - bufferSeconds * 1e3 <= now;
}
async function refreshDeviceToken(refreshToken, options = {}) {
  const trimmed = refreshToken.trim();
  if (trimmed === "") {
    return { success: false, error: "Refresh token is empty." };
  }
  const gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const controlPlaneUrl = getControlPlaneUrl(gatewayUrl);
  try {
    const response = await fetch(`${controlPlaneUrl}/device/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ refresh_token: trimmed })
    });
    const responseText = await response.text();
    let data = {};
    try {
      data = JSON.parse(responseText);
    } catch {
      return {
        success: false,
        error: `Invalid JSON from refresh endpoint (${response.status}): ${responseText.slice(0, 150)}`
      };
    }
    if (!response.ok) {
      const errorMsg = (typeof data["error_description"] === "string" ? data["error_description"] : null) ?? (typeof data["error"] === "string" ? data["error"] : null) ?? `HTTP ${response.status}`;
      return { success: false, error: errorMsg };
    }
    const accessToken = typeof data["access_token"] === "string" ? data["access_token"] : void 0;
    const newRefreshToken = typeof data["refresh_token"] === "string" ? data["refresh_token"] : trimmed;
    const resolvedGatewayUrl = typeof data["gateway_url"] === "string" ? data["gateway_url"] : gatewayUrl;
    if (!accessToken) {
      return { success: false, error: "Missing access_token in refresh response." };
    }
    return {
      success: true,
      accessToken,
      refreshToken: newRefreshToken,
      gatewayUrl: resolvedGatewayUrl,
      expiresIn: 3600
    };
  } catch (err) {
    return {
      success: false,
      error: `Network error refreshing token: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

// src/auth/pool-manager.ts
var DEFAULT_COOLDOWN_MS = 36e5;
function parseCooldownDuration(retryAfterHeader, bodyText) {
  if (retryAfterHeader && retryAfterHeader.trim() !== "") {
    const seconds = parseInt(retryAfterHeader.trim(), 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1e3;
    }
  }
  if (bodyText) {
    const timeMatch = /try again in (?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i.exec(bodyText);
    if (timeMatch) {
      const hours = parseInt(timeMatch[1] ?? "0", 10);
      const minutes = parseInt(timeMatch[2] ?? "0", 10);
      const seconds = parseInt(timeMatch[3] ?? "0", 10);
      const totalSec = hours * 3600 + minutes * 60 + seconds;
      if (totalSec > 0) {
        return totalSec * 1e3;
      }
    }
  }
  return DEFAULT_COOLDOWN_MS;
}
var AccountPoolManager = class {
  accounts = [];
  currentIndex = 0;
  defaultGatewayUrl;
  constructor(defaultGatewayUrl = DEFAULT_GATEWAY_URL) {
    this.defaultGatewayUrl = defaultGatewayUrl;
  }
  /**
   * Initializes the pool from a delimiter-separated token string (newlines, commas)
   */
  initFromTokenList(tokenList) {
    const tokens = tokenList.split(/[\r\n,]+/).map((t) => t.trim()).filter((t) => t.length > 0);
    for (const token of tokens) {
      this.addAccount(token);
    }
  }
  /**
   * Adds an account to the pool
   */
  addAccount(refreshToken, gatewayUrl, email, initialAccessToken) {
    const trimmed = refreshToken.trim();
    if (trimmed === "" || this.accounts.some((a) => a.refreshToken === trimmed)) {
      return;
    }
    const id = `account-${this.accounts.length + 1}`;
    this.accounts.push({
      id,
      refreshToken: trimmed,
      accessToken: initialAccessToken ?? null,
      gatewayUrl: gatewayUrl || this.defaultGatewayUrl,
      expiresAt: initialAccessToken ? Date.now() + 36e5 : 0,
      cooldownUntil: 0,
      failureCount: 0,
      lastUsedAt: 0,
      email
    });
  }
  /**
   * Marks an account as in cooldown for specified duration
   */
  markCooldown(accountId, durationMs, reason) {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return;
    account.cooldownUntil = Date.now() + durationMs;
    account.failureCount++;
    console.warn(
      `[Omnirush2API Pool] Account ${account.id} placed in cooldown for ${Math.round(durationMs / 1e3)}s: ${reason ?? "Rate limit / Quota reached"}`
    );
  }
  /**
   * Selects the next available ready account via round-robin, refreshing tokens if needed
   */
  async getNextAvailableAccount() {
    const total = this.accounts.length;
    if (total === 0) return null;
    const now = Date.now();
    for (let i = 0; i < total; i++) {
      const idx = (this.currentIndex + i) % total;
      const candidate = this.accounts[idx];
      if (!candidate) continue;
      if (now < candidate.cooldownUntil) {
        continue;
      }
      if (candidate.accessToken === null || isTokenExpired(candidate.expiresAt)) {
        const refreshResult = await refreshDeviceToken(candidate.refreshToken, {
          gatewayUrl: candidate.gatewayUrl
        });
        if (refreshResult.success && refreshResult.accessToken) {
          candidate.accessToken = refreshResult.accessToken;
          if (refreshResult.refreshToken) {
            candidate.refreshToken = refreshResult.refreshToken;
          }
          if (refreshResult.gatewayUrl) {
            candidate.gatewayUrl = refreshResult.gatewayUrl;
          }
          const expiresIn = refreshResult.expiresIn ?? 3600;
          candidate.expiresAt = now + expiresIn * 1e3;
          candidate.failureCount = 0;
        } else {
          this.markCooldown(candidate.id, 6e4, refreshResult.error);
          continue;
        }
      }
      this.currentIndex = (idx + 1) % total;
      candidate.lastUsedAt = now;
      return candidate;
    }
    return null;
  }
  /**
   * Returns current pool metrics
   */
  getStats() {
    const now = Date.now();
    let active = 0;
    let inCooldown = 0;
    for (const account of this.accounts) {
      if (now < account.cooldownUntil) {
        inCooldown++;
      } else {
        active++;
      }
    }
    return {
      total: this.accounts.length,
      active,
      inCooldown
    };
  }
  getAllAccounts() {
    return this.accounts;
  }
};

// src/proxy/normalizer.ts
function normalizeCompletionRequest(request) {
  const targetModel = resolveModelId(request.model);
  const stream = request.stream === true;
  let reasoning;
  if (request.reasoning_effort) {
    reasoning = {
      effort: request.reasoning_effort,
      summary: "auto"
    };
  } else if (targetModel.includes("astra")) {
    reasoning = {
      effort: "medium",
      summary: "auto"
    };
  }
  return {
    model: targetModel,
    messages: request.messages,
    input: request.messages,
    stream,
    ...typeof request.temperature === "number" ? { temperature: request.temperature } : {},
    ...typeof request.top_p === "number" ? { top_p: request.top_p } : {},
    ...typeof request.max_tokens === "number" ? { max_tokens: request.max_tokens } : {},
    ...request.stop ? { stop: request.stop } : {},
    ...reasoning ? { reasoning } : {}
  };
}
function normalizeCompletionResponse(raw, fallbackModel) {
  const now = Math.floor(Date.now() / 1e3);
  const data = raw && typeof raw === "object" ? raw : {};
  const id = typeof data["id"] === "string" ? data["id"] : `chatcmpl-${Date.now()}`;
  const model = typeof data["model"] === "string" ? data["model"] : fallbackModel;
  const created = typeof data["created"] === "number" ? data["created"] : now;
  let choices = [];
  if (Array.isArray(data["choices"])) {
    choices = data["choices"].map((c, i) => {
      const msg = c["message"] && typeof c["message"] === "object" ? c["message"] : {};
      const role = typeof msg["role"] === "string" ? msg["role"] : "assistant";
      const content = typeof msg["content"] === "string" ? msg["content"] : null;
      const reasoning = typeof msg["reasoning_content"] === "string" ? msg["reasoning_content"] : typeof msg["reasoning"] === "string" ? msg["reasoning"] : void 0;
      return {
        index: typeof c["index"] === "number" ? c["index"] : i,
        message: {
          role,
          content,
          ...reasoning ? { reasoning_content: reasoning } : {}
        },
        finish_reason: c["finish_reason"] ?? "stop"
      };
    });
  } else if (typeof data["output"] === "string") {
    choices = [
      {
        index: 0,
        message: {
          role: "assistant",
          content: data["output"]
        },
        finish_reason: "stop"
      }
    ];
  }
  if (choices.length === 0) {
    choices = [
      {
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "stop"
      }
    ];
  }
  let usage;
  if (data["usage"] && typeof data["usage"] === "object") {
    const u = data["usage"];
    usage = {
      prompt_tokens: typeof u["prompt_tokens"] === "number" ? u["prompt_tokens"] : 0,
      completion_tokens: typeof u["completion_tokens"] === "number" ? u["completion_tokens"] : 0,
      total_tokens: typeof u["total_tokens"] === "number" ? u["total_tokens"] : 0
    };
  }
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices,
    ...usage ? { usage } : {}
  };
}

// src/proxy/stream-transformer.ts
var SSE_DONE_MESSAGE = "data: [DONE]\n\n";
function parseSSELine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") {
    return "[DONE]";
  }
  try {
    const parsed = JSON.parse(payload);
    if (parsed !== null && typeof parsed === "object") {
      return parsed;
    }
  } catch {
  }
  return null;
}
function createChunkDelta(options) {
  const choice = {
    index: options.index ?? 0,
    delta: {
      ...options.role !== void 0 ? { role: options.role } : {},
      ...options.content !== void 0 ? { content: options.content } : {},
      ...options.reasoningContent !== void 0 ? { reasoning_content: options.reasoningContent } : {}
    },
    finish_reason: options.finishReason ?? null
  };
  return {
    id: options.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1e3),
    model: options.model,
    choices: [choice]
  };
}
function transformUpstreamChunk(upstream, requestedModel) {
  const id = typeof upstream["id"] === "string" ? upstream["id"] : `chatcmpl-${Date.now()}`;
  const choicesRaw = Array.isArray(upstream["choices"]) ? upstream["choices"] : [];
  if (choicesRaw.length > 0) {
    const choices = [];
    for (let i = 0; i < choicesRaw.length; i++) {
      const rawChoice = choicesRaw[i];
      if (rawChoice !== null && typeof rawChoice === "object") {
        const deltaObj = rawChoice["delta"];
        const finishReason = rawChoice["finish_reason"];
        let content = null;
        let reasoningContent = null;
        let role = void 0;
        if (deltaObj !== null && typeof deltaObj === "object") {
          const d = deltaObj;
          if (typeof d["content"] === "string") content = d["content"];
          if (typeof d["reasoning_content"] === "string") reasoningContent = d["reasoning_content"];
          else if (typeof d["reasoning"] === "string") reasoningContent = d["reasoning"];
          if (d["role"] === "assistant") role = "assistant";
        }
        choices.push({
          index: i,
          delta: {
            ...role !== void 0 ? { role } : {},
            ...content !== null ? { content } : {},
            ...reasoningContent !== null ? { reasoning_content: reasoningContent } : {}
          },
          finish_reason: finishReason ?? null
        });
      }
    }
    return {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1e3),
      model: requestedModel,
      choices
    };
  }
  if (typeof upstream["delta"] === "string") {
    return createChunkDelta({
      id,
      model: requestedModel,
      content: upstream["delta"]
    });
  }
  return null;
}
function formatSSEChunk(chunk) {
  return `data: ${JSON.stringify(chunk)}

`;
}
function createSSETransformStream(requestedModel) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseSSELine(line);
        if (parsed === "[DONE]") {
          controller.enqueue(encoder.encode(SSE_DONE_MESSAGE));
          return;
        }
        if (parsed !== null) {
          const transformed = transformUpstreamChunk(parsed, requestedModel);
          if (transformed !== null) {
            controller.enqueue(encoder.encode(formatSSEChunk(transformed)));
          }
        }
      }
    },
    flush(controller) {
      if (buffer.trim()) {
        const parsed = parseSSELine(buffer);
        if (parsed === "[DONE]") {
          controller.enqueue(encoder.encode(SSE_DONE_MESSAGE));
        } else if (parsed !== null) {
          const transformed = transformUpstreamChunk(parsed, requestedModel);
          if (transformed !== null) {
            controller.enqueue(encoder.encode(formatSSEChunk(transformed)));
          }
        }
      }
      controller.enqueue(encoder.encode(SSE_DONE_MESSAGE));
    }
  });
}

// src/proxy/completion-handler.ts
function generateRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
var CompletionProxyHandler = class {
  pool;
  upstreamBaseUrl;
  requestTimeoutMs;
  constructor(options) {
    this.pool = options.pool;
    this.upstreamBaseUrl = options.upstreamBaseUrl ?? DEFAULT_GATEWAY_URL;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 12e4;
  }
  async handleCompletion(request, signal) {
    if (signal?.aborted) {
      return {
        status: 499,
        isStream: false,
        errorResponse: {
          error: { message: "Client cancelled request.", type: "client_closed_request" }
        }
      };
    }
    const targetModel = resolveModelId(request.model);
    const normalizedPayload = normalizeCompletionRequest(request);
    const isStream = request.stream === true;
    const maxAttempts = Math.max(1, this.pool.getStats().total);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) {
        return {
          status: 499,
          isStream: false,
          errorResponse: {
            error: { message: "Client cancelled request.", type: "client_closed_request" }
          }
        };
      }
      const account = await this.pool.getNextAvailableAccount();
      if (!account) {
        return {
          status: 429,
          isStream: false,
          errorResponse: {
            error: {
              message: "All OmniRush accounts in pool are currently in cooldown or unavailable.",
              type: "rate_limit_error",
              code: "all_accounts_cooling_down"
            }
          }
        };
      }
      const requestId = generateRequestId();
      const gatewayUrl = (account.gatewayUrl || this.upstreamBaseUrl).replace(/\/+$/, "");
      const headers = {
        "Content-Type": "application/json",
        Accept: isStream ? "text/event-stream" : "application/json",
        Authorization: `Bearer ${account.accessToken}`,
        "X-OmniRush-Client": "omnirush2api/1.0.0",
        "x-omnirush-client-request-id": requestId
      };
      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        const response = await fetch(`${gatewayUrl}/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify(normalizedPayload),
          signal: combinedSignal
        });
        if (response.status === 401) {
          this.pool.markCooldown(account.id, 6e4, "HTTP 401 Unauthorized");
          continue;
        }
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const bodyText = await response.text().catch(() => "");
          const cooldownMs = parseCooldownDuration(retryAfter, bodyText);
          this.pool.markCooldown(account.id, cooldownMs, `HTTP 429: ${bodyText.slice(0, 100)}`);
          continue;
        }
        if (isStream && response.ok && response.body) {
          const transformedStream = response.body.pipeThrough(
            createSSETransformStream(targetModel)
          );
          return {
            status: 200,
            isStream: true,
            streamResponse: transformedStream
          };
        }
        const responseText = await response.text();
        let parsedJson = {};
        try {
          parsedJson = JSON.parse(responseText);
        } catch {
          return {
            status: response.status,
            isStream: false,
            errorResponse: {
              error: {
                message: `Invalid JSON from OmniRush gateway: ${responseText.slice(0, 200)}`,
                type: "gateway_error"
              }
            }
          };
        }
        if (response.ok) {
          return {
            status: 200,
            isStream: false,
            jsonResponse: normalizeCompletionResponse(parsedJson, targetModel)
          };
        }
        return {
          status: response.status,
          isStream: false,
          errorResponse: parsedJson ?? {
            error: { message: `Gateway error (${response.status})`, type: "gateway_error" }
          }
        };
      } catch (err) {
        if (signal?.aborted) {
          return {
            status: 499,
            isStream: false,
            errorResponse: {
              error: { message: "Client cancelled request.", type: "client_closed_request" }
            }
          };
        }
        this.pool.markCooldown(
          account.id,
          3e4,
          `Network error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return {
      status: 502,
      isStream: false,
      errorResponse: {
        error: {
          message: "All retry attempts against OmniRush gateway failed.",
          type: "bad_gateway"
        }
      }
    };
  }
};

// src/worker/index.ts
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-OmniRush-Client"
};
var globalPool = null;
var lastTokenHash = "";
function getOrCreatePool(env) {
  const tokens = env.OMNIRUSH_REFRESH_TOKEN ?? "";
  const gatewayUrl = env.GATEWAY_URL || DEFAULT_GATEWAY_URL;
  if (globalPool === null || lastTokenHash !== tokens) {
    globalPool = new AccountPoolManager(gatewayUrl);
    if (tokens.trim() !== "") {
      globalPool.initFromTokenList(tokens);
    }
    lastTokenHash = tokens;
  }
  return globalPool;
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}
var index_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (env.API_KEY && env.API_KEY.trim() !== "") {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== `Bearer ${env.API_KEY}`) {
        return jsonResponse(
          {
            error: {
              message: "Invalid API key provided.",
              type: "invalid_request_error",
              code: "invalid_api_key"
            }
          },
          401
        );
      }
    }
    const pool = getOrCreatePool(env);
    if (request.method === "GET" && (pathname === "/v1/health" || pathname === "/health" || pathname === "/")) {
      const stats = pool.getStats();
      const isDegraded = stats.total > 0 && stats.active === 0;
      const isUnhealthy = stats.total === 0;
      return jsonResponse({
        status: isUnhealthy ? "unhealthy" : isDegraded ? "degraded" : "healthy",
        version: "1.0.0",
        mode: "cloudflare-worker",
        api_key_configured: Boolean(env.API_KEY && env.API_KEY.trim() !== ""),
        account_count: stats.total,
        active_accounts: stats.active,
        cooldown_accounts: stats.inCooldown,
        supported_models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol"]
      });
    }
    if (request.method === "GET" && pathname === "/v1/models") {
      return jsonResponse(getModelList());
    }
    if (request.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/v1/responses")) {
      let body;
      try {
        body = await request.json();
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
        upstreamBaseUrl: env.GATEWAY_URL || DEFAULT_GATEWAY_URL
      });
      const result = await handler.handleCompletion(body, request.signal);
      if (result.isStream && result.streamResponse) {
        return new Response(result.streamResponse, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...CORS_HEADERS
          }
        });
      }
      if (result.jsonResponse) {
        return jsonResponse(result.jsonResponse, result.status);
      }
      return jsonResponse(result.errorResponse ?? {}, result.status);
    }
    return jsonResponse(
      {
        error: {
          message: `Unknown path: ${pathname}`,
          type: "invalid_request_error",
          code: "resource_not_found"
        }
      },
      404
    );
  }
};
export {
  index_default as default
};
