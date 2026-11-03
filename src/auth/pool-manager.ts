import type { AccountState } from "../types/auth.js";
import { isTokenExpired, refreshDeviceToken, DEFAULT_GATEWAY_URL } from "./oauth-client.js";
import { detectAccountBan } from "../proxy/wire-guard.js";
import type { QueueStatus } from "../proxy/queue-status.js";

const DEFAULT_COOLDOWN_MS = 3_600_000; // 1 hour

/**
 * Upstream error strings that mean "this refresh token will never work again".
 *
 * A rejected refresh token is permanent: retrying it only burns the pool and
 * makes every client look like it is waiting in a queue. Such an account is
 * quarantined and flagged `needsReauth` so the answer is "log in again",
 * not "wait 60 seconds".
 */
const PERMANENT_REFRESH_FAILURES: readonly RegExp[] = [
  /refresh_token_invalid_or_expired/i,
  /invalid_grant/i,
  /refresh token.*(?:invalid|expired|revoked)/i,
];

export function isPermanentRefreshFailure(error: string | undefined | null): boolean {
  if (!error) return false;
  return PERMANENT_REFRESH_FAILURES.some((re) => re.test(error));
}

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
  readonly busy: number;
  readonly needsReauth: number;
}

export interface AccountDiagnostics {
  readonly id: string;
  readonly email?: string | undefined;
  readonly accessToken: string | null;
  readonly status: "active" | "in_flight" | "cooldown" | "banned" | "needs_reauth";
  readonly cooldownRemainingMs: number;
  readonly lastUsedAt: number;
  readonly failureCount: number;
  readonly queue: string;
  readonly bannedReason?: string | undefined;
}

export type TokenRotatedCallback = (
  oldRefreshToken: string,
  account: AccountState
) => Promise<void> | void;

export interface AccountPoolOptions {
  readonly defaultGatewayUrl?: string | undefined;
  readonly onTokenRotated?: TokenRotatedCallback | undefined;
}

/**
 * Manages an in-memory pool of accounts with round-robin rotation and cooldown backoff
 */
export class AccountPoolManager {
  private accounts: AccountState[] = [];
  private currentIndex = 0;
  private defaultGatewayUrl: string;
  private onTokenRotated?: TokenRotatedCallback | undefined;

  constructor(
    gatewayUrlOrOptions?: string | AccountPoolOptions | undefined,
    onTokenRotated?: TokenRotatedCallback | undefined
  ) {
    if (typeof gatewayUrlOrOptions === "object" && gatewayUrlOrOptions !== null) {
      this.defaultGatewayUrl = gatewayUrlOrOptions.defaultGatewayUrl || DEFAULT_GATEWAY_URL;
      this.onTokenRotated = gatewayUrlOrOptions.onTokenRotated;
    } else {
      this.defaultGatewayUrl = gatewayUrlOrOptions || DEFAULT_GATEWAY_URL;
      this.onTokenRotated = onTokenRotated;
    }
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
                const acc =
                  typeof rec["accessToken"] === "string"
                    ? rec["accessToken"]
                    : typeof rec["access_token"] === "string"
                      ? rec["access_token"]
                      : undefined;
                this.addAccount(ref.trim(), gateway, email, acc?.trim());
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
    let token = refreshToken.trim();
    let initialToken = initialAccessToken;

    // Support pair format: "<refreshToken>|<accessToken>"
    if (token.includes("|")) {
      const parts = token.split("|");
      token = (parts[0] ?? "").trim();
      if (!initialToken && parts[1]) {
        initialToken = parts[1].trim();
      }
    }

    if (token === "" || this.accounts.some((a) => a.refreshToken === token)) {
      return;
    }

    const id = `account-${this.accounts.length + 1}`;
    this.accounts.push({
      id,
      refreshToken: token,
      accessToken: initialToken ?? null,
      gatewayUrl: gatewayUrl || this.defaultGatewayUrl,
      // A stored access token is not trusted to still be live: the gateway
      // rotates it on every refresh, so a token read from disk can already be
      // dead. Treating it as expired makes the pool refresh it up front
      // instead of discovering the 401 on the first real request.
      expiresAt: initialToken ? Date.now() + 3600_000 : 0,
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
    const locked = this.accounts.find((a) => a.id === accountId);
    if (locked) locked.inFlight = true;

    try {
      return await fn();
    } finally {
      this.locks.delete(accountId);
      resolveLock();
      if (locked) locked.inFlight = false;
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
      `[omnirush2api Guard] 🚨 DANGER: Account ${account.id} was permanently BANNED/SUSPENDED by Omnirush: ${account.bannedReason}. Quarantined from pool.`
    );
  }

  /**
   * Marks an account as in cooldown for specified duration
   */
  public markCooldown(accountId: string, durationMs: number, reason?: string): void {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account || account.isBanned) return;

    // Never shrink an existing cooldown: a short failure that lands while the
    // account is already parked must not put it back into the rotation early.
    const next = Date.now() + durationMs;
    account.cooldownUntil = Math.max(account.cooldownUntil, next);
    account.failureCount++;
    console.warn(
      `[omnirush2api Pool] Account ${account.id} placed in cooldown for ${Math.round(durationMs / 1000)}s: ${reason ?? "Rate limit / Quota reached"}`
    );
  }

  /** Records a queue snapshot without touching the cooldown. */
  public recordQueueStatus(accountId: string, status: QueueStatus): void {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return;
    account.queuePosition = status.position;
    account.queueEtaSeconds = status.etaSeconds;
    account.queueObservedAt = status.at;
  }

  /**
   * Records a queue snapshot and optionally parks the account until upstream's
   * own ETA, so it is not hammered back into the queue while still waiting.
   */
  public markQueue(status: QueueStatus, accountId: string, cooldownMs?: number): void {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return;

    account.queuePosition = status.position;
    account.queueEtaSeconds = status.etaSeconds;
    account.queueObservedAt = status.at;

    if (cooldownMs !== undefined && cooldownMs > 0) {
      this.markCooldown(
        accountId,
        cooldownMs,
        `Upstream queue: position=${status.position ?? "?"} eta=${status.etaSeconds ?? "?"}s`
      );
    }
  }

  /** Clears the queue snapshot once the request got admitted. */
  public clearQueue(accountId: string): void {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return;
    account.queuePosition = undefined;
    account.queueEtaSeconds = undefined;
    account.queueObservedAt = undefined;
  }

  /**
   * Quarantines an account whose refresh token can never work again.
   *
   * Kept separate from `markBanned` (upstream closure/suspension): the account
   * itself is fine, the local credential is dead, and the fix is a new login.
   */
  public markNeedsReauth(accountId: string, reason?: string): void {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return;

    account.needsReauth = true;
    account.accessToken = null;
    account.expiresAt = 0;
    account.cooldownUntil = Number.MAX_SAFE_INTEGER;
    console.error(
      `[omnirush2api Pool] 🔑 Account ${account.id} refresh token is dead (${reason ?? "unknown"}). Re-login required: run \`npm run login\` and restart, or POST /admin/reload-tokens.`
    );
  }

  /** Re-arms an account after a successful re-login / token reload. */
  public clearReauth(accountId: string): void {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return;
    account.needsReauth = false;
    account.cooldownUntil = 0;
    account.failureCount = 0;
  }

  public getAccount(accountId: string): AccountState | undefined {
    return this.accounts.find((a) => a.id === accountId);
  }

  /**
   * Replaces the whole account list from a fresh token file.
   *
   * Used by `POST /admin/reload-tokens` so a re-login does not require a
   * restart: restarting while another instance still holds the same refresh
   * token is exactly how tokens get rotated out from under each other.
   */
  public replaceAccounts(
    entries: readonly {
      readonly refreshToken: string;
      readonly accessToken?: string | undefined;
      readonly gatewayUrl?: string | undefined;
      readonly email?: string | undefined;
    }[]
  ): number {
    const previous = new Map(this.accounts.map((a) => [a.refreshToken, a]));
    const next: AccountState[] = [];

    entries.forEach((entry, index) => {
      const old = previous.get(entry.refreshToken);
      next.push({
        id: old?.id ?? `account-${index + 1}`,
        refreshToken: entry.refreshToken,
        accessToken: entry.accessToken ?? null,
        gatewayUrl: entry.gatewayUrl || this.defaultGatewayUrl,
        expiresAt: 0,
        cooldownUntil: 0,
        failureCount: 0,
        lastUsedAt: 0,
        email: entry.email,
      });
    });

    this.accounts = next;
    this.currentIndex = 0;
    return next.length;
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
      if (!candidate || candidate.isBanned || candidate.needsReauth) continue;

      if (now < candidate.cooldownUntil) {
        continue;
      }

      // An account already serving a request is skipped: `withAccountLock`
      // would otherwise serialize the new request behind it, and the client
      // would wait for a queue it never asked for.
      if (candidate.inFlight) {
        continue;
      }

      // Check if access token needs refresh
      if (candidate.accessToken === null || isTokenExpired(candidate.expiresAt)) {
        const refreshResult = await refreshDeviceToken(candidate.refreshToken, {
          gatewayUrl: candidate.gatewayUrl,
        });

        const oldRefreshToken = candidate.refreshToken;
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

          if (
            this.onTokenRotated &&
            refreshResult.refreshToken &&
            refreshResult.refreshToken !== oldRefreshToken
          ) {
            try {
              await this.onTokenRotated(oldRefreshToken, candidate);
            } catch (err) {
              console.error("[omnirush2api Pool] onTokenRotated callback error:", err);
            }
          }
        } else {
          const banCheck = detectAccountBan(403, refreshResult.error ?? "");
          if (banCheck.isBanned) {
            this.markBanned(candidate.id, banCheck.reason ?? refreshResult.error);
          } else if (isPermanentRefreshFailure(refreshResult.error)) {
            // Permanent: a 60s cooldown only makes the client look stuck in a
            // queue. Quarantine the account and ask for a re-login.
            this.markNeedsReauth(candidate.id, refreshResult.error);
          } else {
            this.markCooldown(candidate.id, 60_000, refreshResult.error);
          }
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
    let busy = 0;
    let needsReauth = 0;

    for (const account of this.accounts) {
      if (account.isBanned) {
        banned++;
      } else if (account.needsReauth) {
        needsReauth++;
      } else if (now < account.cooldownUntil) {
        inCooldown++;
      } else if (account.inFlight) {
        busy++;
      } else {
        active++;
      }
    }

    return {
      total: this.accounts.length,
      active,
      inCooldown,
      banned,
      busy,
      needsReauth,
    };
  }

  /**
   * Per-account view for /health: which account is doing what, and where it
   * stands in the upstream queue.
   */
  public getDiagnostics(): readonly AccountDiagnostics[] {
    const now = Date.now();
    return this.accounts.map((account) => {
      let status: AccountDiagnostics["status"] = "active";
      if (account.isBanned) status = "banned";
      else if (account.needsReauth) status = "needs_reauth";
      else if (now < account.cooldownUntil) status = "cooldown";
      else if (account.inFlight) status = "in_flight";

      const queue =
        account.queuePosition !== undefined
          ? `position=${account.queuePosition} eta=${account.queueEtaSeconds ?? "?"}s observed ${Math.max(0, Math.round((now - (account.queueObservedAt ?? now)) / 1000))}s ago`
          : "not queued";

      return {
        id: account.id,
        email: account.email,
        accessToken: account.accessToken ? `${account.accessToken.slice(0, 12)}…` : null,
        status,
        cooldownRemainingMs: Math.max(0, account.cooldownUntil - now),
        lastUsedAt: account.lastUsedAt,
        failureCount: account.failureCount,
        queue,
        bannedReason: account.bannedReason,
      };
    });
  }

  public invalidateAccountToken(accountId: string): void {
    const account = this.accounts.find((a) => a.id === accountId);
    if (account) {
      account.accessToken = null;
      account.expiresAt = 0;
    }
  }

  /**
   * Forces a refresh of one account's access token.
   *
   * The gateway rotates the access token on every refresh, so a token that
   * was stored on disk can already be dead when the daemon starts. Returns
   * the fresh access token, or null when the refresh itself failed.
   */
  public async refreshAccountToken(accountId: string): Promise<string | null> {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return null;

    const oldRefreshToken = account.refreshToken;
    const refreshResult = await refreshDeviceToken(account.refreshToken, {
      gatewayUrl: account.gatewayUrl,
    });

    if (!refreshResult.success || !refreshResult.accessToken) {
      if (isPermanentRefreshFailure(refreshResult.error)) {
        this.markNeedsReauth(account.id, refreshResult.error);
      } else {
        this.markCooldown(account.id, 60_000, refreshResult.error ?? "Token refresh failed");
      }
      return null;
    }

    account.accessToken = refreshResult.accessToken;
    if (refreshResult.refreshToken) {
      account.refreshToken = refreshResult.refreshToken;
    }
    if (refreshResult.gatewayUrl) {
      account.gatewayUrl = refreshResult.gatewayUrl;
    }
    account.expiresAt = Date.now() + (refreshResult.expiresIn ?? 3600) * 1000;
    account.failureCount = 0;

    if (
      this.onTokenRotated &&
      refreshResult.refreshToken &&
      refreshResult.refreshToken !== oldRefreshToken
    ) {
      try {
        await this.onTokenRotated(oldRefreshToken, account);
      } catch (err) {
        console.error("[omnirush2api Pool] onTokenRotated callback error:", err);
      }
    }

    return account.accessToken;
  }

  public getAllAccounts(): readonly AccountState[] {
    return this.accounts;
  }
}
