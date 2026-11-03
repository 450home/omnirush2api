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
import { createSSETransformStream, DEFAULT_IDLE_TIMEOUT_MS } from "./stream-transformer.js";
import {
  cooldownFromQueue,
  formatQueueStatus,
  isQueueTimeoutCode,
  parseQueueStatus,
  type QueueStatus,
} from "./queue-status.js";
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
  readonly idleTimeoutMs?: number | undefined;
  /** How many full passes over the account pool to make. Default 2. */
  readonly maxRetryRounds?: number | undefined;
  /** Pause between rounds, honouring the gateway's `retry_after`. Default 15s. */
  readonly retryDelayMs?: number | undefined;
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
  private idleTimeoutMs: number;
  private maxRetryRounds: number;
  private retryDelayMs: number;

  constructor(options: ProxyHandlerOptions) {
    this.pool = options.pool;
    this.upstreamBaseUrl = options.upstreamBaseUrl ?? DEFAULT_GATEWAY_URL;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxRetryRounds = options.maxRetryRounds ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 15_000;
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

      // Stop only once a real `data:` line has arrived. The previous guard
      // waited for "\n\n", which every `: queued` keep-alive comment already
      // carries — so the poke ended on the first heartbeat and the error
      // frame further downstream was never inspected.
      while (!peeked.includes("data: ") && !peeked.includes("event: ")) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          peekedBytes.push(value);
          peeked += decoder.decode(value, { stream: true });
        }
        if (peeked.length > 32768) break;
      }

      // Remember the last queue position/ETA seen while waiting, so a queue
      // timeout can be parked for exactly as long as upstream asked instead
      // of being treated as a broken account.
      let queueStatus: QueueStatus | null = null;
      for (const line of peeked.split("\n")) {
        const snapshot = parseQueueStatus(line);
        if (snapshot) queueStatus = snapshot;
      }

      if (peeked.includes("event: error")) {
        await reader.cancel().catch(() => undefined);
        const sseError = extractSseError(peeked);
        this.penalizeUpstreamFailure(accountId, sseError?.code, sseError?.message, queueStatus);
        return RETRY;
      }

      // A 200 with an empty body is not a successful answer. It happens when
      // the upstream drops the connection right after the headers. This
      // used to reach the client as a valid 200 carrying nothing, so the user
      // saw a blank reply after waiting a full minute.
      if (peeked.trim() === "") {
        await reader.cancel().catch(() => undefined);
        this.penalizeUpstreamFailure(
          accountId,
          "upstream_empty_body",
          "Upstream returned 200 with an empty body",
          queueStatus
        );
        return RETRY;
      }

      this.pool.clearQueue(accountId);

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

      const transformedStream = combined.pipeThrough(
        createSSETransformStream(targetModel, {
          idleTimeoutMs: this.idleTimeoutMs,
          onIdleTimeout: (idleMs) => {
            this.pool.markCooldown(
              accountId,
              30_000,
              `Upstream idle for ${Math.round(idleMs / 1000)}s`
            );
          },
          onQueueStatus: (status) => {
            this.pool.recordQueueStatus(accountId, status);
          },
          onAdmitted: () => {
            this.pool.clearQueue(accountId);
          },
        })
      );
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
        this.penalizeUpstreamFailure(
          accountId,
          agg.errorCode ?? undefined,
          agg.error,
          this.lastQueueSnapshot(responseText)
        );
        return RETRY;
      }
      // Same guard as the streaming path: a 200 whose body produced no text
      // at all is a dropped connection, not an answer.
      if (agg.text.trim() === "" && agg.reasoning.trim() === "") {
        this.penalizeUpstreamFailure(
          accountId,
          "upstream_empty_body",
          "Upstream returned 200 with no output text",
          this.lastQueueSnapshot(responseText)
        );
        return RETRY;
      }
      this.pool.clearQueue(accountId);
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

  /**
   * Finds the last `: queued position=N eta=M` snapshot in a body we already
   * received in full (non-streaming path).
   */
  private lastQueueSnapshot(body: string): QueueStatus | null {
    let latest: QueueStatus | null = null;
    for (const line of body.split("\n")) {
      const snapshot = parseQueueStatus(line);
      if (snapshot) latest = snapshot;
    }
    return latest;
  }

  /**
   * Applies the right penalty for an upstream failure.
   *
   * A queue timeout is not an account fault: the account is healthy, it just
   * waited too long for its turn. Parking it for upstream's own ETA stops it
   * from being re-queued in a loop, while a genuinely broken upstream error
   * only gets the short cooldown it used to have.
   */
  private penalizeUpstreamFailure(
    accountId: string,
    code: string | undefined,
    message: string | undefined,
    queueStatus: QueueStatus | null
  ): void {
    if (isQueueTimeoutCode(code) || isQueueTimeoutCode(message)) {
      const cooldownMs = cooldownFromQueue(queueStatus);
      this.pool.markQueue(
        queueStatus ?? { position: undefined, etaSeconds: undefined, at: Date.now() },
        accountId,
        cooldownMs
      );
      console.warn(
        `[omnirush2api Queue] ${accountId} queue timeout (${formatQueueStatus(queueStatus)}); parked ${Math.round(cooldownMs / 1000)}s instead of counting it as an account fault.`
      );
      return;
    }

    if (queueStatus) {
      this.pool.markQueue(queueStatus, accountId);
    }
    this.pool.markCooldown(accountId, 5_000, `Upstream SSE error: ${code ?? "unknown"}`);
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
    const accountCount = Math.max(1, this.pool.getStats().total);

    // A single pass over the pool is not enough when the gateway is merely
    // overloaded: it answers `queue_timeout` with `retry_after: 15`, which
    // means "come back shortly" rather than "you are broken". Walk the pool
    // up to `maxRounds` times, sleeping between rounds. Every account that
    // failed is cooling down, so by the time we loop back the short 5s
    // cooldowns have usually expired.
    const maxRounds = Math.max(1, this.maxRetryRounds);
    let lastFailure: ProxyResult | null = null;

    for (let round = 0; round < maxRounds; round++) {
      if (round > 0) {
        const slept = await this.sleepUnlessAborted(this.retryDelayMs, signal);
        if (!slept) {
          return {
            status: 499,
            isStream: false,
            errorResponse: {
              error: { message: "Client cancelled request.", type: "client_closed_request" },
            },
          };
        }
      }

      for (let attempt = 0; attempt < accountCount; attempt++) {
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
          if (stats.banned > 0 && stats.active === 0 && stats.busy === 0) {
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
          // A dead refresh token is permanent. Reporting it as "all accounts
          // cooling down" made a re-login look like a one-minute queue, which
          // is exactly the symptom that wasted hours of debugging.
          if (stats.active === 0 && stats.busy === 0 && stats.needsReauth > 0) {
            return {
              status: 401,
              isStream: false,
              errorResponse: {
                error: {
                  message:
                    "OmniRush refresh token was rejected by upstream (refresh_token_invalid_or_expired). Re-login required: run `npm run login`, then POST /admin/reload-tokens.",
                  type: "invalid_token",
                  code: "refresh_token_invalid_or_expired",
                },
              },
            };
          }
          // Every account is cooling down. Break out of the inner loop so the
          // outer loop can wait for the cooldown to expire before trying again.
          break;
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

        // `requestTimeoutMs` is a *connect/TTFB* budget only. The timer is
        // cleared the moment the response headers land, so it can never cut off
        // a body that is still streaming — AbortSignal.timeout() used to stay
        // armed for the whole fetch lifetime, which aborted healthy long
        // answers after 120s and cooled perfectly good accounts.
        //
        // Body liveness is enforced separately by the idle watchdog inside
        // createSSETransformStream (no bytes for N seconds => fail the stream).
        const send = async (): Promise<Response> =>
          await this.pool.withAccountLock(account.id, async () => {
            const connectController = new AbortController();
            const connectTimer = setTimeout(
              () => connectController.abort(),
              this.requestTimeoutMs
            );
            // Never keep the event loop alive just for this timer.
            if (typeof (connectTimer as { unref?: () => void }).unref === "function") {
              (connectTimer as unknown as { unref: () => void }).unref();
            }

            const abortFromCaller = (): void => connectController.abort();
            if (signal) {
              if (signal.aborted) connectController.abort();
              else signal.addEventListener("abort", abortFromCaller, { once: true });
            }

            try {
              return await fetch(`${gatewayUrl}/responses`, {
                method: "POST",
                headers,
                body: JSON.stringify(normalizedPayload),
                signal: connectController.signal,
              });
            } finally {
              // Headers arrived (or the attempt failed): the connect budget is
              // spent. From here on only the idle watchdog judges liveness.
              clearTimeout(connectTimer);
            }
          });

        try {
          let response = await send();

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

          // Distinguish "slow" from "broken". A connect timeout means the
          // account could not reach the gateway in time — a short pause is
          // enough. Any other network error gets the normal cooldown.
          const isAbort = err instanceof Error && err.name === "AbortError";

          // The account was still waiting in the upstream queue when the call
          // gave up: park it for upstream's own ETA instead of counting a
          // healthy account as broken.
          const observed = this.pool.getAccount(account.id);
          if (isAbort && observed?.queuePosition !== undefined) {
            const cooldownMs = cooldownFromQueue({
              position: observed.queuePosition,
              etaSeconds: observed.queueEtaSeconds,
              at: observed.queueObservedAt ?? Date.now(),
            });
            console.warn(
              `[omnirush2api Queue] ${account.id} aborted while queued (position=${observed.queuePosition} eta=${observed.queueEtaSeconds ?? "?"}s); parked ${Math.round(cooldownMs / 1000)}s.`
            );
            this.pool.markCooldown(
              account.id,
              cooldownMs,
              "Upstream queue: aborted while queued"
            );
            continue;
          }

          this.pool.markCooldown(
            account.id,
            isAbort ? 5_000 : 30_000,
            isAbort
              ? `Connect timeout after ${Math.round(this.requestTimeoutMs / 1000)}s`
              : `Network error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // Nothing came back after every round. Report the most informative of the
    // reasons we collected instead of a generic 502.
    if (lastFailure !== null) return lastFailure;

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

  /**
   * Sleeps for `ms`, returning false early if the client goes away.
   */
  private sleepUnlessAborted(ms: number, signal?: AbortSignal | undefined): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(true);
      }, ms);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve(false);
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
