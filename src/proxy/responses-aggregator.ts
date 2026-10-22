import type {
  ChatCompletionResponse,
  ChatCompletionChoice,
  CompletionUsage,
} from "../types/openai.js";
import { parseSSELine } from "./stream-transformer.js";

export interface AggregatedResponses {
  readonly id: string;
  readonly model: string;
  readonly text: string;
  readonly reasoning: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Set when the upstream answered 200 but carried an SSE `error` event. */
  readonly error: string | undefined;
  /** The upstream error code, e.g. "server_is_overloaded". */
  readonly errorCode: string | undefined;
}

/**
 * Extracts the upstream SSE error event, if any.
 *
 * The gateway answers an overloaded backend with HTTP 200 whose body is a
 * single `event: error` frame — a 2xx that carries a failure.
 */
export function extractSseError(
  sseText: string
): { message: string; code: string | undefined } | null {
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload.startsWith("{")) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed["type"] !== "error" && parsed["type"] !== "response.failed") continue;
    const err = parsed["error"];
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      const message = typeof e["message"] === "string" ? e["message"] : "Upstream error";
      const code = typeof e["code"] === "string" ? e["code"] : undefined;
      return { message, code };
    }
    return { message: "Upstream error", code: undefined };
  }
  return null;
}


/**
 * Aggregates an upstream Responses-API SSE stream into plain text.
 *
 * The gateway refuses a non-streaming model request ("Stream must be set to
 * true"), so a client that asked for `stream: false` still gets a streamed
 * upstream answer and this collapses it into one JSON body.
 */
export function aggregateResponsesSse(
  sseText: string,
  fallbackModel: string
): AggregatedResponses {
  let id = `chatcmpl-${Date.now()}`;
  let model = fallbackModel;
  let text = "";
  let reasoning = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let error: string | undefined;
  let errorCode: string | undefined;

  // The gateway answers an overloaded backend with HTTP 200 whose body is a
  // single `event: error` frame — a 2xx that carries a failure.
  const sseError = extractSseError(sseText);
  if (sseError) {
    error = sseError.message;
    errorCode = sseError.code;
  }

  for (const line of sseText.split("\n")) {
    const parsed = parseSSELine(line);
    if (parsed === null || parsed === "[DONE]") continue;

    const event = parsed as Record<string, unknown>;
    const type = typeof event["type"] === "string" ? (event["type"] as string) : "";

    if (type === "response.created" || type === "response.in_progress") {
      const resp = event["response"];
      if (resp && typeof resp === "object") {
        const r = resp as Record<string, unknown>;
        if (typeof r["id"] === "string") id = r["id"];
        if (typeof r["model"] === "string") model = r["model"];
      }
      continue;
    }

    if (type === "response.output_text.delta" && typeof event["delta"] === "string") {
      text += event["delta"] as string;
      continue;
    }

    if (type === "response.reasoning_summary_text.delta" && typeof event["delta"] === "string") {
      reasoning += event["delta"] as string;
      continue;
    }

    if (type === "response.completed" || type === "response.incomplete") {
      const resp = event["response"];
      if (resp && typeof resp === "object") {
        const r = resp as Record<string, unknown>;
        if (typeof r["id"] === "string") id = r["id"];
        if (typeof r["model"] === "string") model = r["model"];
        const usage = r["usage"];
        if (usage && typeof usage === "object") {
          const u = usage as Record<string, unknown>;
          if (typeof u["input_tokens"] === "number") promptTokens = u["input_tokens"];
          if (typeof u["output_tokens"] === "number") completionTokens = u["output_tokens"];
          if (typeof u["total_tokens"] === "number") {
            promptTokens = promptTokens || u["total_tokens"];
          }
        }
        // A completed event may carry the full text; use it when the deltas
        // never arrived (some gateway builds skip the delta frames).
        if (!text) {
          const output = r["output"];
          if (Array.isArray(output)) {
            for (const item of output) {
              if (!item || typeof item !== "object") continue;
              const content = (item as Record<string, unknown>)["content"];
              if (!Array.isArray(content)) continue;
              for (const part of content) {
                if (!part || typeof part !== "object") continue;
                const t = (part as Record<string, unknown>)["text"];
                if (typeof t === "string") text += t;
              }
            }
          }
        }
      }
    }
  }

  return { id, model, text, reasoning, promptTokens, completionTokens, error, errorCode };
}

/**
 * Builds an OpenAI chat.completion response from aggregated upstream text.
 */
export function aggregatedToChatCompletion(
  agg: AggregatedResponses,
  fallbackModel: string
): ChatCompletionResponse {
  const choice: ChatCompletionChoice = {
    index: 0,
    message: {
      role: "assistant",
      content: agg.text,
      ...(agg.reasoning ? { reasoning_content: agg.reasoning } : {}),
    },
    finish_reason: "stop",
  };

  const usage: CompletionUsage = {
    prompt_tokens: agg.promptTokens,
    completion_tokens: agg.completionTokens,
    total_tokens: agg.promptTokens + agg.completionTokens,
  };

  return {
    id: agg.id.startsWith("resp_") ? `chatcmpl-${agg.id.slice(5, 21)}` : agg.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: agg.model || fallbackModel,
    choices: [choice],
    usage,
  };
}
