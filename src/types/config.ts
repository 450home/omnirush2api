/**
 * Server and runtime configuration types
 */

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly apiKey?: string | undefined;
  readonly tokensFilePath?: string | undefined;
  readonly gatewayUrl: string;
  readonly timeoutMs?: number | undefined;
}

export interface WorkerKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface WorkerEnv {
  readonly OMNIRUSH_REFRESH_TOKEN?: string | undefined;
  readonly OMNIRUSH_ACCESS_TOKEN?: string | undefined;
  readonly API_KEY?: string | undefined;
  readonly GATEWAY_URL?: string | undefined;
  readonly TOKEN_KV?: WorkerKVNamespace | undefined;
}

export interface HealthStatusResponse {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly version: string;
  readonly mode: "local-daemon" | "cloudflare-worker";
  readonly api_key_configured: boolean;
  readonly account_count: number;
  readonly active_accounts: number;
  readonly cooldown_accounts: number;
  readonly supported_models: readonly string[];
}

export interface CliOptions {
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly key?: string | undefined;
  readonly gatewayUrl?: string | undefined;
  readonly token?: string | undefined;
  readonly help?: boolean | undefined;
  readonly version?: boolean | undefined;
}
