import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChoice,
  CompletionUsage,
} from "../types/openai.js";
import { resolveModelId } from "./model-catalog.js";

export interface OmnirushWirePayload {
  readonly model: string;
  readonly input: readonly unknown[];
  readonly stream: boolean;
  readonly store: false;
  readonly temperature?: number | undefined;
  readonly top_p?: number | undefined;
  readonly max_tokens?: number | undefined;
  readonly stop?: string | readonly string[] | undefined;
  readonly reasoning?: {
    readonly effort: string;
    readonly summary?: string;
  } | undefined;
}

/**
 * Normalizes client OpenAI ChatCompletionRequest for the Omnirush backend
 */
export function normalizeCompletionRequest(
  request: ChatCompletionRequest
): OmnirushWirePayload {
  const targetModel = resolveModelId(request.model);

  // Determine reasoning configuration
  let reasoning: { effort: string; summary: string } | undefined;
  if (request.reasoning_effort) {
    reasoning = {
      effort: request.reasoning_effort,
      summary: "auto",
    };
  } else if (targetModel.includes("astra")) {
    reasoning = {
      effort: "medium",
      summary: "auto",
    };
  }

  return {
    model: targetModel,
    // The upstream /responses endpoint takes `input` only — a `messages`
    // field is refused with "Unsupported parameter: messages".
    input: request.messages,
    // The gateway refuses a non-streaming request ("Stream must be set to
    // true") and requires store=false ("Store must be set to false").
    stream: true,
    store: false,
    ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
    ...(typeof request.top_p === "number" ? { top_p: request.top_p } : {}),
    ...(typeof request.max_tokens === "number" ? { max_tokens: request.max_tokens } : {}),
    ...(request.stop ? { stop: request.stop } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

/**
 * Normalizes upstream payload into standard OpenAI ChatCompletionResponse
 */
export function normalizeCompletionResponse(
  raw: unknown,
  fallbackModel: string
): ChatCompletionResponse {
  const now = Math.floor(Date.now() / 1000);
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const id = typeof data["id"] === "string" ? data["id"] : `chatcmpl-${Date.now()}`;
  const model = typeof data["model"] === "string" ? data["model"] : fallbackModel;
  const created = typeof data["created"] === "number" ? data["created"] : now;

  let choices: ChatCompletionChoice[] = [];

  if (Array.isArray(data["choices"])) {
    choices = (data["choices"] as Array<Record<string, unknown>>).map((c, i) => {
      const msg = (c["message"] && typeof c["message"] === "object" ? c["message"] : {}) as Record<string, unknown>;
      const role = typeof msg["role"] === "string" ? (msg["role"] as "assistant") : "assistant";
      const content = typeof msg["content"] === "string" ? msg["content"] : null;
      const reasoning =
        typeof msg["reasoning_content"] === "string"
          ? msg["reasoning_content"]
          : typeof msg["reasoning"] === "string"
            ? msg["reasoning"]
            : undefined;

      return {
        index: typeof c["index"] === "number" ? c["index"] : i,
        message: {
          role,
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason:
          (c["finish_reason"] as "stop" | "length" | "tool_calls" | "content_filter" | null) ?? "stop",
      };
    });
  } else if (typeof data["output"] === "string") {
    choices = [
      {
        index: 0,
        message: {
          role: "assistant",
          content: data["output"],
        },
        finish_reason: "stop",
      },
    ];
  }

  if (choices.length === 0) {
    choices = [
      {
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "stop",
      },
    ];
  }

  let usage: CompletionUsage | undefined;
  if (data["usage"] && typeof data["usage"] === "object") {
    const u = data["usage"] as Record<string, unknown>;
    usage = {
      prompt_tokens: typeof u["prompt_tokens"] === "number" ? u["prompt_tokens"] : 0,
      completion_tokens: typeof u["completion_tokens"] === "number" ? u["completion_tokens"] : 0,
      total_tokens: typeof u["total_tokens"] === "number" ? u["total_tokens"] : 0,
    };
  }

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices,
    ...(usage ? { usage } : {}),
  };
}
