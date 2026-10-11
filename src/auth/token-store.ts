import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DEFAULT_GATEWAY_URL } from "./oauth-client.js";

export interface StoredTokenEntry {
  readonly refreshToken: string;
  readonly accessToken?: string | undefined;
  readonly gatewayUrl?: string | undefined;
  readonly email?: string | undefined;
  readonly updatedAt?: number | undefined;
}

interface StoredTokenPayload {
  readonly tokens: readonly StoredTokenEntry[];
}

/**
 * Returns default token store path: ~/.omnirush2api/tokens.json
 */
export function getDefaultTokenStorePath(): string {
  return path.join(os.homedir(), ".omnirush2api", "tokens.json");
}

/**
 * Loads stored token entries from disk
 */
export async function loadStoredTokens(
  customPath?: string
): Promise<StoredTokenEntry[]> {
  const targetPath = customPath ?? getDefaultTokenStorePath();
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as StoredTokenPayload).tokens)
    ) {
      return [...(parsed as StoredTokenPayload).tokens];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Atomically saves token entries to disk with 0o600 permissions
 */
export async function saveStoredTokens(
  tokens: readonly StoredTokenEntry[],
  customPath?: string
): Promise<void> {
  const targetPath = customPath ?? getDefaultTokenStorePath();
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const tempPath = `${targetPath}.tmp.${Date.now()}`;
  const payload: StoredTokenPayload = { tokens };
  const content = JSON.stringify(payload, null, 2);

  await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, targetPath);
}

/**
 * Adds or updates a token entry in the store
 */
export async function addOrUpdateToken(
  entry: StoredTokenEntry,
  customPath?: string
): Promise<void> {
  const tokens = await loadStoredTokens(customPath);
  const now = Date.now();
  const updatedEntry: StoredTokenEntry = {
    ...entry,
    gatewayUrl: entry.gatewayUrl || DEFAULT_GATEWAY_URL,
    updatedAt: now,
  };

  const existingIndex = tokens.findIndex((t) => t.refreshToken === entry.refreshToken);
  if (existingIndex >= 0) {
    tokens[existingIndex] = updatedEntry;
  } else {
    tokens.push(updatedEntry);
  }

  await saveStoredTokens(tokens, customPath);
}

/**
 * Removes a token from the store
 */
export async function removeToken(
  refreshToken: string,
  customPath?: string
): Promise<boolean> {
  const tokens = await loadStoredTokens(customPath);
  const filtered = tokens.filter((t) => t.refreshToken !== refreshToken);
  if (filtered.length === tokens.length) {
    return false;
  }
  await saveStoredTokens(filtered, customPath);
  return true;
}
