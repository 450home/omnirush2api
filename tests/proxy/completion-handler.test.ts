import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CompletionProxyHandler } from "../../src/proxy/completion-handler.js";
import { AccountPoolManager } from "../../src/auth/pool-manager.js";

describe("completion-handler", () => {
  it("proxies non-streaming request successfully", async () => {
    const pool = new AccountPoolManager();
    pool.addAccount("valid_refresh", "https://omnirush.ai/omnirush/v1", "user@test.com", "valid_access");

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, init) => {
        assert.ok(url.toString().includes("/responses") || url.toString().includes("/chat/completions"));
        assert.equal((init?.headers as Record<string, string>)?.["Authorization"], "Bearer valid_access");
        assert.ok((init?.headers as Record<string, string>)?.["X-OmniRush-Client"]);

        return new Response(
          JSON.stringify({
            id: "resp_proxy_1",
            model: "gpt-6-astra",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Successful response" },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const handler = new CompletionProxyHandler({ pool });
      const result = await handler.handleCompletion({
        model: "astra",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      });

      assert.equal(result.status, 200);
      assert.equal(result.isStream, false);
      assert.equal(result.jsonResponse?.choices[0]?.message.content, "Successful response");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails over to second account on 429 rate limit", async () => {
    const pool = new AccountPoolManager();
    pool.addAccount("refresh_1", "https://omnirush.ai/omnirush/v1", "u1@test.com", "access_1");
    pool.addAccount("refresh_2", "https://omnirush.ai/omnirush/v1", "u2@test.com", "access_2");

    const originalFetch = globalThis.fetch;
    let callCount = 0;
    try {
      globalThis.fetch = async (_url, init) => {
        callCount++;
        const auth = (init?.headers as Record<string, string>)?.["Authorization"];
        if (auth === "Bearer access_1") {
          return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
            status: 429,
            headers: { "Retry-After": "60" },
          });
        }
        return new Response(
          JSON.stringify({
            id: "resp_failover",
            choices: [{ message: { role: "assistant", content: "Failover worked" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const handler = new CompletionProxyHandler({ pool });
      const result = await handler.handleCompletion({
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "Hello" }],
      });

      assert.equal(callCount, 2);
      assert.equal(result.status, 200);
      assert.equal(result.jsonResponse?.choices[0]?.message.content, "Failover worked");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
