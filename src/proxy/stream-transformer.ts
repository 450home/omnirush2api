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

  // Handle alternative Responses API delta format
  if (typeof upstream["delta"] === "string") {
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
 * Creates a TransformStream converting upstream SSE events into standard OpenAI SSE chunks
 */
export function createSSETransformStream(
  requestedModel: string
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  return new TransformStream<Uint8Array, Uint8Array>({
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
    },
  });
}
