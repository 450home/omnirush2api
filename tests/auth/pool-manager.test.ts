import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AccountPoolManager,
  parseCooldownDuration,
} from "../../src/auth/pool-manager.js";

describe("pool-manager", () => {
  it("parses retry-after header and time strings correctly", () => {
    assert.equal(parseCooldownDuration("120"), 120_000);
    assert.equal(parseCooldownDuration(null, "Rate limit reached. Try again in 2h 30m."), 9_000_000);
    assert.equal(parseCooldownDuration(null, "Quota exceeded. Try again in 45s."), 45_000);
    // Default fallback when unspecified
    assert.equal(parseCooldownDuration(), 3_600_000);
  });

  it("initializes from JSON array and quoted tokens", () => {
    const pool = new AccountPoolManager();
    pool.initFromTokenList('["tok_json_1", "tok_json_2"]');
    assert.equal(pool.getStats().total, 2);

    const poolQuoted = new AccountPoolManager();
    poolQuoted.initFromTokenList('"tok_q1", "tok_q2"');
    assert.equal(poolQuoted.getStats().total, 2);
  });

  it("rotates multiple accounts in round-robin fashion", async () => {
    const pool = new AccountPoolManager();
    pool.initFromTokenList("token_one, token_two\ntoken_three");

    const stats = pool.getStats();
    assert.equal(stats.total, 3);
    assert.equal(stats.active, 3);
    assert.equal(stats.inCooldown, 0);

    // Mock global fetch for refresh calls
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            access_token: `acc_for_${body.refresh_token}`,
            refresh_token: body.refresh_token,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const a1 = await pool.getNextAvailableAccount();
      const a2 = await pool.getNextAvailableAccount();
      const a3 = await pool.getNextAvailableAccount();
      const a4 = await pool.getNextAvailableAccount();

      assert.equal(a1?.refreshToken, "token_one");
      assert.equal(a2?.refreshToken, "token_two");
      assert.equal(a3?.refreshToken, "token_three");
      assert.equal(a4?.refreshToken, "token_one");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips cooling down accounts and fails over to active ones", async () => {
    const pool = new AccountPoolManager();
    pool.initFromTokenList("tok_1, tok_2");

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({ access_token: "mock_acc", refresh_token: body.refresh_token }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const acc1 = await pool.getNextAvailableAccount();
      assert.equal(acc1?.refreshToken, "tok_1");

      // Put acc1 on cooldown
      pool.markCooldown(acc1!.id, 60_000, "429 Rate limit");

      const stats = pool.getStats();
      assert.equal(stats.active, 1);
      assert.equal(stats.inCooldown, 1);

      // Next account should be tok_2
      const acc2 = await pool.getNextAvailableAccount();
      assert.equal(acc2?.refreshToken, "tok_2");

      // Next call still skips tok_1 and returns tok_2
      const acc3 = await pool.getNextAvailableAccount();
      assert.equal(acc3?.refreshToken, "tok_2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns null when all accounts are cooling down", async () => {
    const pool = new AccountPoolManager();
    pool.addAccount("tok_only");
    pool.markCooldown("account-1", 120_000, "Exhausted");

    const acc = await pool.getNextAvailableAccount();
    assert.equal(acc, null);
  });
});
