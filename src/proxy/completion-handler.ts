import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../types/openai.js";
import { resolveModelId } from "./model-catalog.js";
import { AccountPoolManager, parseCooldownDuration } from "../auth/pool-manager.js";
import { normalizeCompletionRequest, normalizeCompletionResponse } from "./normalizer.js";
import {
  aggregateResponsesSse,
  aggregatedToChatCompletion,
  extractSseError,
} from "./responses-aggregator.js";
import { createSSETransformStream } from "./stream-transformer.js";
import { DEFAULT_GATEWAY_URL } from "../auth/oauth-client.js";
import { createAntiBanHeaders, detectAccountBan } from "./wire-guard.js";

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

/** A response that must be retried on another account. */
const RETRY = Symbol("retry");

export class CompletionProxyHandler {
  private pool: AccountPoolManager;
  private upstreamBaseUrl: string;
  private requestTimeoutMs: number;

  constructor(options: ProxyHandlerOptions) {
    this.pool = options.pool;
    this.upstreamBaseUrl = options.upstreamBaseUrl ?? DEFAULT_GATEWAY_URL;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  /**
   * Turns an upstream response into a client answer.
   *
   * Returns RETRY when the account should be skipped and the request
   * retried (upstream overload, rate limit, ban, dead token).
   */
  private async readUpstreamResponse(
    response: Response,
    targetModel: string,
    isStream: boolean,
    accountId: string
  ): Promise<ProxyResult | typeof RETRY> {
    // --- streaming client -------------------------------------------------
    if (isStream && response.ok && response.body) {
      // Peek the first frames: an overloaded backend answers with a 200 whose
      // body is a single `event: error` frame. Catching that before the
      // stream reaches the client lets the request be retried.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let peeked = "";
      const peekedBytes: Uint8Array[] = [];

      while (peekedBytes.length === 0 || !peeked.includes("\n\n")) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          peekedBytes.push(value);
          peeked += decoder.decode(value, { stream: true });
        }
        if (peeked.length > 8192) break;
      }

      if (peeked.includes("event: error")) {
        await reader.cancel().catch(() => undefined);
        this.pool.markCooldown(
          accountId,
          5_000,
          `Upstream SSE error: ${extractSseError(peeked)?.code ?? "unknown"}`
        );
        return RETRY;
      }

      const replay = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of peekedBytes) controller.enqueue(chunk);
          controller.close();
        },
      });

      // Re-attach the remainder of the upstream body to the replayed head.
      const rest = new ReadableStream<Uint8Array>({
        start(controller) {
          void (async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) controller.enqueue(value);
              }
              controller.close();
            } catch (err) {
              controller.error(err);
            }
          })();
        },
      });

      const combined = new ReadableStream<Uint8Array>({
        start(controller) {
          void (async () => {
            try {
              for await (const chunk of replay as unknown as AsyncIterable<Uint8Array>) {
                controller.enqueue(chunk);
              }
              for await (const chunk of rest as unknown as AsyncIterable<Uint8Array>) {
                controller.enqueue(chunk);
              }
              controller.close();
            } catch (err) {
              controller.error(err);
            }
          })();
        },
      });

      const transformedStream = combined.pipeThrough(createSSETransformStream(targetModel));
      return { status: 200, isStream: true, streamResponse: transformedStream };
    }

    // --- non-streaming client --------------------------------------------
    const responseText = await response.text();

    // The gateway always answers a model request as an SSE stream (a
    // non-streaming request is refused with "Stream must be set to true"),
    // so a client that asked for stream:false gets the frames collapsed.
    if (
      response.ok &&
      (responseText.trimStart().startsWith("event:") || responseText.includes("data:"))
    ) {
      const agg = aggregateResponsesSse(responseText, targetModel);
      // A 200 whose body carries an SSE `error` frame is a failure (the
      // gateway does this when its backend is overloaded). Retry the request
      // instead of returning an empty answer.
      if (agg.error) {
        this.pool.markCooldown(
          accountId,
          5_000,
          `Upstream SSE error: ${agg.errorCode ?? "unknown"}`
        );
        return RETRY;
      }
      return {
        status: 200,
        isStream: false,
        jsonResponse: aggregatedToChatCompletion(agg, targetModel),
      };
    }

    // 1. Account ban / suspension (403 / 401 with a closure notice)
    const banCheck = detectAccountBan(response.status, responseText);
    if (banCheck.isBanned) {
      this.pool.markBanned(accountId, banCheck.reason);
      return RETRY;
    }

    // 2. 429 Rate Limit / Quota Exceeded
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const cooldownMs = parseCooldownDuration(retryAfter, responseText);
      this.pool.markCooldown(accountId, cooldownMs, `HTTP 429: ${responseText.slice(0, 100)}`);
      return RETRY;
    }

    // 3. Parse the body as JSON (a plain error envelope)
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
        const stats = this.pool.getStats();
        if (stats.banned > 0 && stats.active === 0) {
          return {
            status: 403,
            isStream: false,
            errorResponse: {
              error: {
                message:
                  "OmniRush account was closed or suspended by upstream (unofficial client / multi-session detection). Account quarantined.",
                type: "account_suspended_error",
                code: "account_banned_by_upstream",
              },
            },
          };
        }
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

      const headers = createAntiBanHeaders({
        accessToken: account.accessToken ?? "",
        requestId,
        // The gateway always answers a model request as an SSE stream, and
        // only sends the output_text.delta frames when the client asks for
        // event-stream. A client that wanted stream:false still gets the
        // frames and has them collapsed into one JSON body further down.
        isStream: true,
      });

      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      const send = async (): Promise<Response> =>
        await this.pool.withAccountLock(account.id, async () => {
          return await fetch(`${gatewayUrl}/responses`, {
            method: "POST",
            headers,
            body: JSON.stringify(normalizedPayload),
            signal: combinedSignal,
          });
        });

      try {
        let response = await send();

        // The gateway rotates the access token on every refresh, so a token
        // read from disk can already be dead when the daemon starts. Refresh
        // this account once and retry with the fresh token.
        if (response.status === 401) {
          const fresh = await this.pool.refreshAccountToken(account.id);
          if (fresh) {
            headers["Authorization"] = `Bearer ${fresh}`;
            response = await send();
          }
          if (response.status === 401) {
            this.pool.invalidateAccountToken(account.id);
            this.pool.markCooldown(account.id, 10_000, "HTTP 401 Unauthorized");
            continue;
          }
        }

        const result = await this.readUpstreamResponse(
          response,
          targetModel,
          isStream,
          account.id
        );
        if (result !== RETRY) return result;
        // RETRY: this account is on cooldown now; try the next one.
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
