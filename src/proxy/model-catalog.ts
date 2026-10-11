import type { OpenAIModel, OpenAIModelListResponse } from "../types/openai.js";

export const DEFAULT_MODEL = "gpt-6-astra";

export interface OmniRushModelDef {
  readonly id: string;
  readonly displayName: string;
  readonly family: string;
  readonly contextLimit: number;
  readonly outputLimit: number;
  readonly aliases: readonly string[];
}

export const KNOWN_MODELS: readonly OmniRushModelDef[] = [
  {
    id: "gpt-6-astra",
    displayName: "GPT 6 Astra",
    family: "astra",
    contextLimit: 200_000,
    outputLimit: 16_384,
    aliases: ["astra", "gpt-6", "omnirush", "gpt-6-astra-preview"],
  },
  {
    id: "gpt-6.1-sol",
    displayName: "GPT 6.1 Sol",
    family: "sol",
    contextLimit: 200_000,
    outputLimit: 16_384,
    aliases: ["sol-pro", "gpt-6.1-sol-preview"],
  },
  {
    id: "gpt-6-sol",
    displayName: "GPT 6 Sol",
    family: "sol",
    contextLimit: 128_000,
    outputLimit: 8_192,
    aliases: ["sol", "gpt-6-sol-preview"],
  },
];

/**
 * Resolves a model alias or ID to its canonical OmniRush model ID
 */
export function resolveModelId(requestedModel?: string | null): string {
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

  // Pass-through unrecognized model ID
  return requestedModel.trim();
}

/**
 * Returns true if the model or alias is recognized
 */
export function isKnownModel(modelId: string): boolean {
  const resolved = resolveModelId(modelId);
  return KNOWN_MODELS.some((m) => m.id === resolved);
}

/**
 * Returns OpenAI-compatible model listing
 */
export function getModelList(): OpenAIModelListResponse {
  const now = Math.floor(Date.now() / 1000);
  const models: OpenAIModel[] = KNOWN_MODELS.map((def) => ({
    id: def.id,
    object: "model",
    created: now,
    owned_by: "omnirush.ai",
    root: def.id,
  }));

  return {
    object: "list",
    data: models,
  };
}

/**
 * Fetches models dynamically from upstream OmniRush API with fallback
 */
export async function fetchUpstreamModels(
  gatewayUrl: string,
  accessToken: string
): Promise<OpenAIModelListResponse> {
  try {
    const url = `${gatewayUrl.replace(/\/+$/, "")}/models`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return getModelList();
    }

    const payload = (await response.json()) as Record<string, unknown>;
    if (Array.isArray(payload["data"])) {
      const now = Math.floor(Date.now() / 1000);
      const dynamicModels: OpenAIModel[] = (payload["data"] as Array<Record<string, unknown>>)
        .filter((item) => typeof item["id"] === "string")
        .map((item) => ({
          id: String(item["id"]),
          object: "model",
          created: typeof item["created"] === "number" ? item["created"] : now,
          owned_by: "omnirush.ai",
          root: String(item["id"]),
        }));

      if (dynamicModels.length > 0) {
        return {
          object: "list",
          data: dynamicModels,
        };
      }
    }

    return getModelList();
  } catch {
    return getModelList();
  }
}
