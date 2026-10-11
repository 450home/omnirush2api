import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../types/openai.js";
import { resolveModelId } from "./model-catalog.js";
import { AccountPoolManager, parseCooldownDuration } from "../auth/pool-manager.js";
import { normalizeCompletionRequest, normalizeCompletionResponse } from "./normalizer.js";
import { createSSETransformStream } from "./stream-transformer.js";
import { DEFAULT_GATEWAY_URL } from "../auth/oauth-client.js";

function generateRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export interface ProxyHandlerOptions {
  readonly pool: AccountPoolManager;
  readonly upstreamBaseUrl?: string | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

export interface ProxyResult {
  readonly status: number;
  readonly isStream: boolean;
  readonly jsonResponse?: ChatCompletionResponse | undefined;
  readonly streamResponse?: ReadableStream<Uint8Array> | undefined;
  readonly errorResponse?: Record<string, unknown> | undefined;
}

export class CompletionProxyHandler {
  private pool: AccountPoolManager;
  private upstreamBaseUrl: string;
  private requestTimeoutMs: number;

  constructor(options: ProxyHandlerOptions) {
    this.pool = options.pool;
    this.upstreamBaseUrl = options.upstreamBaseUrl ?? DEFAULT_GATEWAY_URL;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  public async handleCompletion(
    request: ChatCompletionRequest,
    signal?: AbortSignal | undefined
  ): Promise<ProxyResult> {
    if (signal?.aborted) {
      return {
        status: 499,
        isStream: false,
        errorResponse: {
          error: { message: "Client cancelled request.", type: "client_closed_request" },
        },
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
            error: { message: "Client cancelled request.", type: "client_closed_request" },
          },
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
              code: "all_accounts_cooling_down",
            },
          },
        };
      }

      const requestId = generateRequestId();
      const gatewayUrl = (account.gatewayUrl || this.upstreamBaseUrl).replace(/\/+$/, "");

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: isStream ? "text/event-stream" : "application/json",
        Authorization: `Bearer ${account.accessToken}`,
        "X-OmniRush-Client": "omnirush2api/1.0.0",
        "x-omnirush-client-request-id": requestId,
      };

      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      try {
        const response = await fetch(`${gatewayUrl}/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify(normalizedPayload),
          signal: combinedSignal,
        });

        // 401 Unauthorized: token might be revoked or rotated
        if (response.status === 401) {
          this.pool.markCooldown(account.id, 60_000, "HTTP 401 Unauthorized");
          continue;
        }

        // 429 Rate Limit / Quota Exceeded
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const bodyText = await response.text().catch(() => "");
          const cooldownMs = parseCooldownDuration(retryAfter, bodyText);
          this.pool.markCooldown(account.id, cooldownMs, `HTTP 429: ${bodyText.slice(0, 100)}`);
          continue;
        }

        // Handle streaming response
        if (isStream && response.ok && response.body) {
          const transformedStream = response.body.pipeThrough(
            createSSETransformStream(targetModel)
          );
          return {
            status: 200,
            isStream: true,
            streamResponse: transformedStream,
          };
        }

        // Handle non-streaming response
        const responseText = await response.text();
        let parsedJson: unknown = {};
        try {
          parsedJson = JSON.parse(responseText);
        } catch {
          return {
            status: response.status,
            isStream: false,
            errorResponse: {
              error: {
                message: `Invalid JSON from OmniRush gateway: ${responseText.slice(0, 200)}`,
                type: "gateway_error",
              },
            },
          };
        }

        if (response.ok) {
          return {
            status: 200,
            isStream: false,
            jsonResponse: normalizeCompletionResponse(parsedJson, targetModel),
          };
        }

        // Other upstream error (e.g. 400 Bad Request, 500)
        return {
          status: response.status,
          isStream: false,
          errorResponse: (parsedJson as Record<string, unknown>) ?? {
            error: { message: `Gateway error (${response.status})`, type: "gateway_error" },
          },
        };
      } catch (err) {
        if (signal?.aborted) {
          return {
            status: 499,
            isStream: false,
            errorResponse: {
              error: { message: "Client cancelled request.", type: "client_closed_request" },
            },
          };
        }

        // Network failure or timeout on this account, place on short cooldown and retry next
        this.pool.markCooldown(
          account.id,
          30_000,
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
          type: "bad_gateway",
        },
      },
    };
  }
}
