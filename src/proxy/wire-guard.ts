/**
 * Anti-Ban & Desktop Client Wire Guard
 * Emulates official OmniRush desktop client signatures, masks unofficial runtimes,
 * and detects upstream account suspension/ban notices.
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

const DESKTOP_CLIENT_VERSION = "1.2.4";
const ELECTRON_VERSION = "32.2.0";
const CHROME_VERSION = "128.0.6613.186";

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
 * Returns platform signature string matching OmniRush desktop Electron conventions
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
 * Constructs official OmniRush desktop headers to avoid unofficial client detection
 */
export function createAntiBanHeaders(
  options: AntiBanHeaderOptions
): Record<string, string> {
  const platform = options.platform ?? detectPlatformSignature();

  let osSegment = "Windows NT 10.0; Win64; x64";
  let secPlatform = '"Windows"';

  if (platform === "darwin") {
    osSegment = "Macintosh; Intel Mac OS X 10_15_7";
    secPlatform = '"macOS"';
  } else if (platform === "linux") {
    osSegment = "X11; Linux x86_64";
    secPlatform = '"Linux"';
  }

  const userAgent = `Mozilla/5.0 (${osSegment}) AppleWebKit/537.36 (KHTML, like Gecko) OmniRush/${DESKTOP_CLIENT_VERSION} Chrome/${CHROME_VERSION} Electron/${ELECTRON_VERSION} Safari/537.36`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: options.isStream ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${options.accessToken}`,
    "User-Agent": userAgent,
    "X-OmniRush-Client": "desktop-app",
    "X-OmniRush-Client-Version": DESKTOP_CLIENT_VERSION,
    "X-OmniRush-Platform": platform,
    "Sec-Ch-Ua": `"Chromium";v="128", "Not;A=Brand";v="24", "Electron";v="32"`,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": secPlatform,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
    "Accept-Language": "en-US,en;q=0.9",
  };

  if (options.requestId) {
    headers["x-omnirush-client-request-id"] = options.requestId;
  }

  return headers;
}
