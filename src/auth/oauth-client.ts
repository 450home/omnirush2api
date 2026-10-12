import type {
  DeviceAuthorizeResponse,
  DeviceTokenResponse,
  TokenRefreshResult,
  AccountProfile,
} from "../types/auth.js";
import {
  generateRealisticDeviceName,
  detectPlatformSignature,
} from "../proxy/wire-guard.js";

export const DEFAULT_GATEWAY_URL = "https://omnirush.ai/omnirush/v1";

/**
 * Derives the control plane base URL by removing trailing `/v1` or `/v1/`
 */
export function getControlPlaneUrl(gatewayUrl: string = DEFAULT_GATEWAY_URL): string {
  const trimmed = gatewayUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -3);
  }
  return trimmed;
}

/**
 * Checks if a token is expired or approaching expiration (< bufferSeconds)
 */
export function isTokenExpired(expiresAt: number | undefined, bufferSeconds = 300): boolean {
  if (expiresAt === undefined || expiresAt <= 0) {
    return true;
  }
  const now = Date.now();
  return expiresAt - bufferSeconds * 1000 <= now;
}

export interface InitiateDeviceFlowOptions {
  readonly gatewayUrl?: string | undefined;
  readonly deviceName?: string | undefined;
  readonly platform?: string | undefined;
}

/**
 * Starts the OAuth 2.0 Device Authorization Flow
 */
export async function initiateDeviceFlow(
  options: InitiateDeviceFlowOptions = {}
): Promise<DeviceAuthorizeResponse> {
  const {
    gatewayUrl = DEFAULT_GATEWAY_URL,
    deviceName = generateRealisticDeviceName(),
    platform = detectPlatformSignature(),
  } = options;

  const controlPlaneUrl = getControlPlaneUrl(gatewayUrl);
  const maxAttempts = 4;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`${controlPlaneUrl}/device/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          device_name: deviceName,
          platform,
        }),
      });

      if (response.ok) {
        return (await response.json()) as DeviceAuthorizeResponse;
      }

      const errorText = await response.text().catch(() => "");
      const isRetryable = [500, 502, 503, 504].includes(response.status);
      lastError = new Error(
        `Device authorization failed (${response.status}): ${errorText.slice(0, 200)}`
      );

      if (!isRetryable || attempt === maxAttempts) {
        throw lastError;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxAttempts) {
        throw lastError;
      }
    }

    // Exponential backoff on upstream 5xx errors (1s, 2s, 3s)
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }

  throw lastError ?? new Error("Device authorization timed out.");
}

export interface PollDeviceTokenOptions {
  readonly gatewayUrl?: string | undefined;
  readonly intervalSeconds?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Polls for user authorization of the device code
 */
export async function pollDeviceToken(
  deviceCode: string,
  options: PollDeviceTokenOptions = {}
): Promise<TokenRefreshResult> {
  const {
    gatewayUrl = DEFAULT_GATEWAY_URL,
    intervalSeconds = 5,
    maxAttempts = 180, // up to 15 minutes by default
    signal,
  } = options;

  const controlPlaneUrl = getControlPlaneUrl(gatewayUrl);
  const delayMs = Math.max(10, Math.floor(intervalSeconds * 1000));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      return { success: false, error: "Polling aborted by client." };
    }

    try {
      const response = await fetch(`${controlPlaneUrl}/device/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ device_code: deviceCode }),
        ...(signal ? { signal } : {}),
      });

      // 428 Precondition Required means pending user authorization in browser
      if (response.status === 428) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      if (response.ok) {
        const data = (await response.json()) as DeviceTokenResponse;
        return {
          success: true,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          gatewayUrl: data.gateway_url || gatewayUrl,
          expiresIn: 3600,
        };
      }

      const errorText = await response.text().catch(() => "");
      return {
        success: false,
        error: `Device token request rejected (${response.status}): ${errorText.slice(0, 200)}`,
      };
    } catch (err) {
      if (signal?.aborted) {
        return { success: false, error: "Polling aborted by client." };
      }
      return {
        success: false,
        error: `Network error polling device token: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { success: false, error: "Device code authorization timed out." };
}

export interface RefreshDeviceTokenOptions {
  readonly gatewayUrl?: string | undefined;
}

/**
 * Rotates device access token using the refresh token
 */
export async function refreshDeviceToken(
  refreshToken: string,
  options: RefreshDeviceTokenOptions = {}
): Promise<TokenRefreshResult> {
  const trimmed = refreshToken.trim();
  if (trimmed === "") {
    return { success: false, error: "Refresh token is empty." };
  }

  const gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const controlPlaneUrl = getControlPlaneUrl(gatewayUrl);

  try {
    const response = await fetch(`${controlPlaneUrl}/device/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ refresh_token: trimmed }),
    });

    const responseText = await response.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(responseText) as Record<string, unknown>;
    } catch {
      return {
        success: false,
        error: `Invalid JSON from refresh endpoint (${response.status}): ${responseText.slice(0, 150)}`,
      };
    }

    if (!response.ok) {
      const errorMsg =
        (typeof data["error_description"] === "string" ? data["error_description"] : null) ??
        (typeof data["error"] === "string" ? data["error"] : null) ??
        `HTTP ${response.status}`;
      return { success: false, error: errorMsg };
    }

    const accessToken = typeof data["access_token"] === "string" ? data["access_token"] : undefined;
    const newRefreshToken =
      typeof data["refresh_token"] === "string" ? data["refresh_token"] : trimmed;
    const resolvedGatewayUrl =
      typeof data["gateway_url"] === "string" ? data["gateway_url"] : gatewayUrl;

    if (!accessToken) {
      return { success: false, error: "Missing access_token in refresh response." };
    }

    return {
      success: true,
      accessToken,
      refreshToken: newRefreshToken,
      gatewayUrl: resolvedGatewayUrl,
      expiresIn: 3600,
    };
  } catch (err) {
    return {
      success: false,
      error: `Network error refreshing token: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Queries account profile and usage quota from `/device/me`
 */
export async function fetchAccountProfile(
  accessToken: string,
  gatewayUrl: string = DEFAULT_GATEWAY_URL
): Promise<AccountProfile | null> {
  const controlPlaneUrl = getControlPlaneUrl(gatewayUrl);
  try {
    const response = await fetch(`${controlPlaneUrl}/device/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken.trim()}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as AccountProfile;
  } catch {
    return null;
  }
}
