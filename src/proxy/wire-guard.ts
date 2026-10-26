/**
 * Anti-Ban & Official Client Wire Guard
 * Replicates official Omnirush CLI & Desktop wire signatures (from omnirush@2.4.3),
 * handles one-time Refresh Token Rotation (RTR), and detects account suspension notices.
 */

export interface AntiBanHeaderOptions {
  readonly accessToken: string;
  readonly requestId?: string | undefined;
  readonly isStream?: boolean | undefined;
  readonly platform?: "win32" | "darwin" | "linux" | undefined;
}

export interface AccountBanCheckResult {
  readonly isBanned: boolean;
  readonly reason?: string | undefined;
}

// The OmniRush gateway enforces a minimum official-client version and raises
// it over time (2.4.3 -> 2.6.7 -> 2.6.8 -> ...). This must track the current
// requirement or the gateway answers "update_required".
export const OFFICIAL_VERSION = "2.7.0";

const BAN_PATTERNS: readonly RegExp[] = [
  /closed\s+automatically/i,
  /unofficial\s+client/i,
  /used\s+from\s+another\s+place/i,
  /account\s+was\s+closed/i,
  /account\s+(?:has\s+been\s+)?suspended/i,
  /account\s+(?:has\s+been\s+)?banned/i,
  /terms\s+of\s+service\s+violation/i,
  /terms\s+of\s+service\s+don't\s+allow/i,
];

/**
 * Detects whether an upstream response indicates account closure, suspension, or ban
 */
export function detectAccountBan(
  statusCode: number,
  bodyText: string
): AccountBanCheckResult {
  // Only 400, 401, 403, or 451 are returned for bans
  if (![400, 401, 403, 451].includes(statusCode)) {
    return { isBanned: false };
  }

  for (const pattern of BAN_PATTERNS) {
    if (pattern.test(bodyText)) {
      return {
        isBanned: true,
        reason: bodyText.slice(0, 300).trim(),
      };
    }
  }

  return { isBanned: false };
}

/**
 * Returns platform signature string matching OmniRush conventions
 */
export function detectPlatformSignature(): "win32" | "darwin" | "linux" {
  if (typeof process !== "undefined" && process.platform) {
    if (process.platform === "darwin") return "darwin";
    if (process.platform === "linux") return "linux";
  }
  return "win32";
}

/**
 * Generates realistic machine hostname (DESKTOP-XXXXXX or MacBook-XXXX)
 */
export function generateRealisticDeviceName(): string {
  const chars = "0123456789ABCDEF";
  let suffix = "";
  for (let i = 0; i < 7; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const platform = detectPlatformSignature();
  if (platform === "darwin") {
    return `MacBook-${suffix.slice(0, 4)}`;
  }
  return `DESKTOP-${suffix}`;
}

/**
 * Constructs official headers for model requests (/responses, /chat/completions)
 * Matches official token-proxy.js lines 278-295:
 * - User-Agent: "omnirush" (bare product name, versioned "omnirush/x" is refused as lookalike)
 * - X-OmniRush-Client: "cli/<version>"
 *
 * NOTE: x-omnirush-session-id is deliberately NOT sent. The official
 * token-proxy only forwards it when the engine itself supplied X-Session-Id
 * (a session the gateway already knows). A made-up value makes the gateway
 * answer 403 official_client_required; omitting the header is accepted.
 */
export function createAntiBanHeaders(
  options: AntiBanHeaderOptions
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: options.isStream ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${options.accessToken}`,
    "User-Agent": "omnirush",
    "X-OmniRush-Client": `cli/${OFFICIAL_VERSION}`,
  };

  return headers;
}

/**
 * Constructs official headers for device authentication endpoints (/device/*)
 * Matches official auth.js lines 68-94:
 * - User-Agent: "omnirush/<version> (<platform>; <arch>)"
 * - X-OmniRush-Client: "cli/<version>"
 */
export function createAuthApiHeaders(): Record<string, string> {
  const platform = detectPlatformSignature();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `omnirush/${OFFICIAL_VERSION} (${platform}; x64)`,
    "X-OmniRush-Client": `cli/${OFFICIAL_VERSION}`,
  };
}
