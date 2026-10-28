import type {
  ChatCompletionChunk,
  ChatCompletionChunkChoice,
} from "../types/openai.js";

export const SSE_DONE_MESSAGE = "data: [DONE]\n\n";

export interface ChunkDeltaOptions {
  readonly id: string;
  readonly model: string;
  readonly index?: number;
  readonly role?: "assistant";
  readonly content?: string | null;
  readonly reasoningContent?: string | null;
  readonly finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

/**
 * Parses a single line from an SSE stream
 */
export function parseSSELine(line: string): Record<string, unknown> | "[DONE]" | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }

  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") {
    return "[DONE]";
  }

  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON SSE payload
  }
  return null;
}

/**
 * Creates an OpenAI-compliant streaming chunk
 */
export function createChunkDelta(options: ChunkDeltaOptions): ChatCompletionChunk {
  const choice: ChatCompletionChunkChoice = {
    index: options.index ?? 0,
    delta: {
      ...(options.role !== undefined ? { role: options.role } : {}),
      ...(options.content !== undefined ? { content: options.content } : {}),
      ...(options.reasoningContent !== undefined
        ? { reasoning_content: options.reasoningContent }
        : {}),
    },
    finish_reason: options.finishReason ?? null,
  };

  return {
    id: options.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    choices: [choice],
  };
}

/**
 * Transforms an upstream raw JSON chunk to guarantee OpenAI compliance
 */
export function transformUpstreamChunk(
  upstream: Record<string, unknown>,
  requestedModel: string
): ChatCompletionChunk | null {
  const id = typeof upstream["id"] === "string" ? upstream["id"] : `chatcmpl-${Date.now()}`;
  const choicesRaw = Array.isArray(upstream["choices"]) ? upstream["choices"] : [];

  if (choicesRaw.length > 0) {
    const choices: ChatCompletionChunkChoice[] = [];
    for (let i = 0; i < choicesRaw.length; i++) {
      const rawChoice = choicesRaw[i];
      if (rawChoice !== null && typeof rawChoice === "object") {
        const deltaObj = (rawChoice as Record<string, unknown>)["delta"];
        const finishReason = (rawChoice as Record<string, unknown>)["finish_reason"];

        let content: string | null = null;
        let reasoningContent: string | null = null;
        let role: "assistant" | undefined = undefined;

        if (deltaObj !== null && typeof deltaObj === "object") {
          const d = deltaObj as Record<string, unknown>;
          if (typeof d["content"] === "string") content = d["content"];
          if (typeof d["reasoning_content"] === "string") reasoningContent = d["reasoning_content"];
          else if (typeof d["reasoning"] === "string") reasoningContent = d["reasoning"];
          if (d["role"] === "assistant") role = "assistant";
        }

        choices.push({
          index: i,
          delta: {
            ...(role !== undefined ? { role } : {}),
            ...(content !== null ? { content } : {}),
            ...(reasoningContent !== null ? { reasoning_content: reasoningContent } : {}),
          },
          finish_reason:
            (finishReason as "stop" | "length" | "tool_calls" | "content_filter" | null) ?? null,
        });
      }
    }

    return {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices,
    };
  }

  // Handle the Responses API event format the gateway actually speaks:
  // { type: "response.output_text.delta", delta: "..." } and
  // { type: "response.reasoning_summary_text.delta", delta: "..." }
  const eventType = typeof upstream["type"] === "string" ? (upstream["type"] as string) : "";
  if (eventType === "response.output_text.delta" && typeof upstream["delta"] === "string") {
    return createChunkDelta({
      id,
      model: requestedModel,
      content: upstream["delta"],
    });
  }

  if (
    eventType === "response.reasoning_summary_text.delta" &&
    typeof upstream["delta"] === "string"
  ) {
    return createChunkDelta({
      id,
      model: requestedModel,
      reasoningContent: upstream["delta"],
    });
  }

  // An upstream `event: error` frame carries a failure inside a 200 body.
  // Surface it as an OpenAI error chunk instead of dropping it silently.
  if (eventType === "error" || eventType === "response.failed") {
    const errObj = upstream["error"];
    const message =
      errObj && typeof errObj === "object" && typeof (errObj as Record<string, unknown>)["message"] === "string"
        ? ((errObj as Record<string, unknown>)["message"] as string)
        : "Upstream error";
    return {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [],
      error: { message, type: "upstream_error" },
    } as unknown as ChatCompletionChunk;
  }

  // Handle alternative Responses API delta format. Restricted to text deltas:
  // a blanket `typeof delta === "string"` check also swallowed
  // `response.refusal.delta` and `response.function_call_arguments.delta`,
  // which then leaked into the assistant content as stray text.
  if (eventType.endsWith(".output_text.delta") && typeof upstream["delta"] === "string") {
    return createChunkDelta({
      id,
      model: requestedModel,
      content: upstream["delta"],
    });
  }

  return null;
}

/**
 * Formats a chunk as a standard SSE line
 */
export function formatSSEChunk(chunk: ChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Recovers the `delta` text from a truncated `data:` line.
 *
 * When the upstream connection dies mid-frame the trailing JSON is incomplete,
 * so JSON.parse throws and the partial answer would be lost. This walks the
 * raw string, pulls out whatever the `delta` field had accumulated, and
 * unescapes the common JSON escapes.
 */
export function rescueTruncatedDelta(raw: string): string | null {
  const start = raw.search(/"delta"\s*:\s*"/);
  if (start === -1) return null;

  let i = raw.indexOf('"', raw.indexOf(":", start)) + 1;
  let out = "";
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === undefined) break; // escape split across the cut point
      switch (next) {
        case "n": out += "\n"; break;
        case "t": out += "\t"; break;
        case "r": out += "\r"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "u": {
          const hex = raw.slice(i + 2, i + 6);
          if (hex.length < 4) return out.length > 0 ? out : null;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default: out += next;
      }
      i += 2;
      continue;
    }
    if (ch === '"') break; // closing quote reached
    out += ch;
    i += 1;
  }
  return out.length > 0 ? out : null;
}

/**
 * Creates a TransformStream converting upstream SSE events into standard OpenAI SSE chunks
 */
export interface SSETransformOptions {
  /**
   * Fail the stream when no upstream bytes arrive for this long. This is an
   * *idle* timeout, not a total-duration timeout: a slow but healthy answer
   * that keeps producing tokens is never cut off, while a stalled one fails
   * fast. Set to 0 to disable.
   */
  readonly idleTimeoutMs?: number;
  /** Called when the idle watchdog fires, so the caller can cool the account. */
  readonly onIdleTimeout?: (idleMs: number) => void;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export function createSSETransformStream(
  requestedModel: string,
  options?: SSETransformOptions
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  let buffer = "";
  let lastByteAt = Date.now();
  let finished = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      if (idleTimeoutMs <= 0) return;
      // A stalled upstream emits nothing at all — no events, no errors — so
      // only a wall-clock check can notice it. Keep-alive comments such as
      // `: queued position=3` still arrive as bytes and therefore reset the
      // clock, which is exactly what we want: the gateway is alive.
      const tick = Math.min(5_000, Math.max(1_000, Math.floor(idleTimeoutMs / 6)));
      watchdog = setInterval(() => {
        if (finished) return;
        const idleMs = Date.now() - lastByteAt;
        if (idleMs >= idleTimeoutMs) {
          finished = true;
          if (watchdog !== undefined) clearInterval(watchdog);
          options?.onIdleTimeout?.(idleMs);
          controller.error(new Error(`Upstream stalled: no data for ${Math.round(idleMs / 1000)}s`));
        }
      }, tick);
      // Do not keep the Node process alive just for this timer.
      if (typeof (watchdog as { unref?: () => void }).unref === "function") {
        (watchdog as unknown as { unref: () => void }).unref();
      }
    },
    transform(chunk, controller) {
      lastByteAt = Date.now();
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
        } else {
          // The stream was cut mid-line, so `buffer` is a truncated JSON
          // object that JSON.parse cannot handle. Rescue the text that was
          // already there instead of dropping it silently.
          const rescued = rescueTruncatedDelta(buffer);
          if (rescued !== null) {
            controller.enqueue(
              encoder.encode(
                formatSSEChunk(
                  createChunkDelta({
                    id: `chatcmpl-${Date.now()}`,
                    model: requestedModel,
                    content: rescued,
                  })
                )
              )
            );
          }
        }
      }
      finished = true;
      if (watchdog !== undefined) clearInterval(watchdog);
      controller.enqueue(encoder.encode(SSE_DONE_MESSAGE));
    },
  });
}
