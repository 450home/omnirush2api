import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isTokenExpired,
  getControlPlaneUrl,
  initiateDeviceFlow,
  pollDeviceToken,
  refreshDeviceToken,
  fetchAccountProfile,
} from "../../src/auth/oauth-client.js";

describe("oauth-client", () => {
  it("computes control plane URL correctly from gateway URL", () => {
    assert.equal(getControlPlaneUrl("https://omnirush.ai/omnirush/v1"), "https://omnirush.ai/omnirush");
    assert.equal(getControlPlaneUrl("https://omnirush.ai/omnirush/v1/"), "https://omnirush.ai/omnirush");
    assert.equal(getControlPlaneUrl("https://custom.gateway.com/v1"), "https://custom.gateway.com");
  });

  it("detects expired or near-expired tokens", () => {
    const now = Date.now();
    assert.equal(isTokenExpired(now - 1000), true);
    assert.equal(isTokenExpired(now + 100_000), true); // within 300s buffer
    assert.equal(isTokenExpired(now + 3600_000), false);
    assert.equal(isTokenExpired(undefined), true);
  });

  it("initiates device authorization flow", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, init) => {
        assert.equal(url.toString(), "https://omnirush.ai/omnirush/device/authorize");
        assert.equal(init?.method, "POST");
        const body = JSON.parse(init?.body as string);
        assert.equal(body.platform, "node");
        return new Response(
          JSON.stringify({
            device_code: "dev_12345",
            user_code: "USER-CODE-99",
            verification_uri: "https://omnirush.ai/device",
            verification_uri_complete: "https://omnirush.ai/device?user_code=USER-CODE-99",
            expires_in: 900,
            interval: 5,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await initiateDeviceFlow();
      assert.equal(res.device_code, "dev_12345");
      assert.equal(res.user_code, "USER-CODE-99");
      assert.equal(res.verification_uri_complete, "https://omnirush.ai/device?user_code=USER-CODE-99");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("polls device token handling 428 pending status", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    try {
      globalThis.fetch = async (_url) => {
        attempts++;
        if (attempts === 1) {
          return new Response(JSON.stringify({ status: "pending" }), { status: 428 });
        }
        return new Response(
          JSON.stringify({
            access_token: "omni_acc_approved",
            refresh_token: "omni_ref_approved",
            gateway_url: "https://omnirush.ai/omnirush/v1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await pollDeviceToken("dev_12345", {
        intervalSeconds: 0.01,
        maxAttempts: 3,
      });

      assert.equal(attempts, 2);
      assert.equal(res.success, true);
      assert.equal(res.accessToken, "omni_acc_approved");
      assert.equal(res.refreshToken, "omni_ref_approved");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles token refresh successfully", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, init) => {
        assert.equal(url.toString(), "https://omnirush.ai/omnirush/device/refresh");
        const body = JSON.parse(init?.body as string);
        assert.equal(body.refresh_token, "my_refresh_tok");
        return new Response(
          JSON.stringify({
            access_token: "new_rotated_access",
            refresh_token: "new_rotated_refresh",
            gateway_url: "https://omnirush.ai/omnirush/v1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const res = await refreshDeviceToken("my_refresh_tok");
      assert.equal(res.success, true);
      assert.equal(res.accessToken, "new_rotated_access");
      assert.equal(res.refreshToken, "new_rotated_refresh");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fetches account profile and quota", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, init) => {
        assert.equal(url.toString(), "https://omnirush.ai/omnirush/device/me");
        assert.equal((init?.headers as Record<string, string>)?.["Authorization"], "Bearer valid_token");
        return new Response(
          JSON.stringify({
            id: "usr_abc",
            email: "tester@omnirush.ai",
            display_name: "Tester",
            status: "active",
            usage: {
              token_limit: 1000000,
              used_tokens: 50000,
              remaining_tokens: 950000,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const profile = await fetchAccountProfile("valid_token");
      assert.equal(profile?.id, "usr_abc");
      assert.equal(profile?.email, "tester@omnirush.ai");
      assert.equal(profile?.usage?.remaining_tokens, 950000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
