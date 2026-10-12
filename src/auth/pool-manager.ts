import type { AccountState } from "../types/auth.js";
import { isTokenExpired, refreshDeviceToken, DEFAULT_GATEWAY_URL } from "./oauth-client.js";

const DEFAULT_COOLDOWN_MS = 3_600_000; // 1 hour

/**
 * Extracts cooldown duration in milliseconds from HTTP response headers or body
 */
export function parseCooldownDuration(
  retryAfterHeader?: string | null,
  bodyText?: string | null
): number {
  if (retryAfterHeader && retryAfterHeader.trim() !== "") {
    const seconds = parseInt(retryAfterHeader.trim(), 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }

  if (bodyText) {
    // Check for "Try again in Xh Ym" or similar patterns
    const timeMatch = /try again in (?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i.exec(bodyText);
    if (timeMatch) {
      const hours = parseInt(timeMatch[1] ?? "0", 10);
      const minutes = parseInt(timeMatch[2] ?? "0", 10);
      const seconds = parseInt(timeMatch[3] ?? "0", 10);
      const totalSec = hours * 3600 + minutes * 60 + seconds;
      if (totalSec > 0) {
        return totalSec * 1000;
      }
    }
  }

  return DEFAULT_COOLDOWN_MS;
}

export interface PoolStats {
  readonly total: number;
  readonly active: number;
  readonly inCooldown: number;
  readonly banned: number;
}

/**
 * Manages an in-memory pool of accounts with round-robin rotation and cooldown backoff
 */
export class AccountPoolManager {
  private accounts: AccountState[] = [];
  private currentIndex = 0;
  private defaultGatewayUrl: string;

  constructor(defaultGatewayUrl: string = DEFAULT_GATEWAY_URL) {
    this.defaultGatewayUrl = defaultGatewayUrl;
  }

  /**
   * Initializes the pool from a delimiter-separated token string (newlines, commas) or JSON array
   */
  public initFromTokenList(tokenList: string): void {
    const trimmed = tokenList.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === "string" && item.trim()) {
              this.addAccount(item.trim());
            } else if (item && typeof item === "object") {
              const rec = item as Record<string, unknown>;
              const ref =
                typeof rec["refreshToken"] === "string"
                  ? rec["refreshToken"]
                  : typeof rec["refresh_token"] === "string"
                    ? rec["refresh_token"]
                    : null;
              if (ref && ref.trim()) {
                const gateway =
                  typeof rec["gatewayUrl"] === "string"
                    ? rec["gatewayUrl"]
                    : typeof rec["gateway_url"] === "string"
                      ? rec["gateway_url"]
                      : undefined;
                const email = typeof rec["email"] === "string" ? rec["email"] : undefined;
                this.addAccount(ref.trim(), gateway, email);
              }
            }
          }
          return;
        }
      } catch {
        // Fallback to delimiter splitting
      }
    }

    const tokens = trimmed
      .split(/[\r\n,]+/)
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter((t) => t.length > 0);

    for (const token of tokens) {
      this.addAccount(token);
    }
  }

  /**
   * Adds an account to the pool
   */
  public addAccount(
    refreshToken: string,
    gatewayUrl?: string,
    email?: string,
    initialAccessToken?: string
  ): void {
    const trimmed = refreshToken.trim();
    if (trimmed === "" || this.accounts.some((a) => a.refreshToken === trimmed)) {
      return;
    }

    const id = `account-${this.accounts.length + 1}`;
    this.accounts.push({
      id,
      refreshToken: trimmed,
      accessToken: initialAccessToken ?? null,
      gatewayUrl: gatewayUrl || this.defaultGatewayUrl,
      expiresAt: initialAccessToken ? Date.now() + 3600_000 : 0,
      cooldownUntil: 0,
      failureCount: 0,
      lastUsedAt: 0,
      email,
    });
  }

  private locks = new Map<string, Promise<void>>();

  /**
   * Executes an action under a per-account mutual exclusion lock to prevent concurrent sessions
   */
  public async withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    while (this.locks.has(accountId)) {
      await this.locks.get(accountId);
    }
    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((res) => {
      resolveLock = res;
    });
    this.locks.set(accountId, lockPromise);

    try {
      return await fn();
    } finally {
      this.locks.delete(accountId);
      resolveLock();
    }
  }

  /**
   * Marks an account as permanently banned / suspended, quarantining it from the pool
   */
  public markBanned(accountId: string, reason?: string): void {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return;

    account.isBanned = true;
    account.bannedReason = reason ?? "Account suspended/closed by upstream";
    account.cooldownUntil = Number.MAX_SAFE_INTEGER;
    console.error(
      `[Omnirush2API Guard] 🚨 DANGER: Account ${account.id} was permanently BANNED/SUSPENDED by Omnirush: ${account.bannedReason}. Quarantined from pool.`
    );
  }

  /**
   * Marks an account as in cooldown for specified duration
   */
  public markCooldown(accountId: string, durationMs: number, reason?: string): void {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account || account.isBanned) return;

    account.cooldownUntil = Date.now() + durationMs;
    account.failureCount++;
    console.warn(
      `[Omnirush2API Pool] Account ${account.id} placed in cooldown for ${Math.round(durationMs / 1000)}s: ${reason ?? "Rate limit / Quota reached"}`
    );
  }

  /**
   * Selects the next available ready account via round-robin, refreshing tokens if needed
   */
  public async getNextAvailableAccount(): Promise<AccountState | null> {
    const total = this.accounts.length;
    if (total === 0) return null;

    const now = Date.now();
    for (let i = 0; i < total; i++) {
      const idx = (this.currentIndex + i) % total;
      const candidate = this.accounts[idx];
      if (!candidate || candidate.isBanned) continue;

      if (now < candidate.cooldownUntil) {
        continue;
      }

      // Check if access token needs refresh
      if (candidate.accessToken === null || isTokenExpired(candidate.expiresAt)) {
        const refreshResult = await refreshDeviceToken(candidate.refreshToken, {
          gatewayUrl: candidate.gatewayUrl,
        });

        if (refreshResult.success && refreshResult.accessToken) {
          candidate.accessToken = refreshResult.accessToken;
          if (refreshResult.refreshToken) {
            candidate.refreshToken = refreshResult.refreshToken;
          }
          if (refreshResult.gatewayUrl) {
            candidate.gatewayUrl = refreshResult.gatewayUrl;
          }
          const expiresIn = refreshResult.expiresIn ?? 3600;
          candidate.expiresAt = now + expiresIn * 1000;
          candidate.failureCount = 0;
        } else {
          // Token refresh failed, put account on 60s cooldown and try next candidate
          this.markCooldown(candidate.id, 60_000, refreshResult.error);
          continue;
        }
      }

      this.currentIndex = (idx + 1) % total;
      candidate.lastUsedAt = now;
      return candidate;
    }

    return null;
  }

  /**
   * Returns current pool metrics
   */
  public getStats(): PoolStats {
    const now = Date.now();
    let active = 0;
    let inCooldown = 0;
    let banned = 0;

    for (const account of this.accounts) {
      if (account.isBanned) {
        banned++;
      } else if (now < account.cooldownUntil) {
        inCooldown++;
      } else {
        active++;
      }
    }

    return {
      total: this.accounts.length,
      active,
      inCooldown,
      banned,
    };
  }

  public getAllAccounts(): readonly AccountState[] {
    return this.accounts;
  }
}
