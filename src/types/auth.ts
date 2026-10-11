export interface DeviceAuthorizeRequest {
  readonly device_name: string;
  readonly platform: string;
}

export interface DeviceAuthorizeResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
}

export interface DeviceTokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly gateway_url: string;
}

export interface TokenRefreshResult {
  readonly success: boolean;
  readonly accessToken?: string | undefined;
  readonly refreshToken?: string | undefined;
  readonly gatewayUrl?: string | undefined;
  readonly expiresIn?: number | undefined;
  readonly error?: string | undefined;
}

export interface AccountUsageWindow {
  readonly allowance?: number | undefined;
  readonly limit?: number | undefined;
  readonly used: number;
  readonly resets_at?: string | undefined;
}

export interface AccountUsage {
  readonly token_limit?: number | undefined;
  readonly used_tokens?: number | undefined;
  readonly remaining_tokens?: number | undefined;
  readonly day?: AccountUsageWindow | undefined;
  readonly week?: AccountUsageWindow | undefined;
  readonly pot?: number | undefined;
}

export interface AccountProfile {
  readonly id: string;
  readonly email?: string | undefined;
  readonly display_name?: string | undefined;
  readonly status: string;
  readonly usage?: AccountUsage | undefined;
}

export interface AccountState {
  readonly id: string;
  refreshToken: string;
  accessToken: string | null;
  gatewayUrl: string;
  expiresAt: number;
  cooldownUntil: number;
  failureCount: number;
  lastUsedAt: number;
  email?: string | undefined;
}

export interface DiscoveredCredential {
  readonly source: string;
  readonly path?: string | undefined;
  readonly refreshToken: string;
  readonly accessToken?: string | undefined;
  readonly gatewayUrl?: string | undefined;
  readonly email?: string | undefined;
}
