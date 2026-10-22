import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CompletionProxyHandler } from "../../src/proxy/completion-handler.js";
import { AccountPoolManager } from "../../src/auth/pool-manager.js";

/**
 * The upstream gateway answers every model request as an SSE stream (a
 * non-streaming request is refused with "Stream must be set to true"), so a
 * mocked upstream has to return SSE frames too.
 */
function sseResponse(text: string, id = "resp_test"): Response {
  const frames = [
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: { id, model: "gpt-6-astra" },
    })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      delta: text,
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id, model: "gpt-6-astra", usage: { input_tokens: 5, output_tokens: 3 } },
    })}\n\n`,
  ].join("");
  return new Response(frames, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("completion-handler", () => {
  it("proxies non-streaming request successfully", async () => {
    const pool = new AccountPoolManager();
    pool.addAccount("valid_refresh", "https://omnirush.ai/omnirush/v1", "user@test.com", "valid_access");

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, init) => {
        assert.ok(url.toString().includes("/responses"));
        const headers = init?.headers as Record<string, string>;
        assert.equal(headers?.["Authorization"], "Bearer valid_access");
        assert.ok(headers?.["X-OmniRush-Client"]);
        // The gateway only speaks the Responses API.
        assert.equal(headers?.["Accept"], "text/event-stream");

        const body = JSON.parse(String(init?.body));
        assert.equal(body.store, false);
        assert.equal(body.stream, true);
        assert.equal(body.messages, undefined);
        assert.ok(Array.isArray(body.input));

        return sseResponse("Successful response", "resp_proxy_1");
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
        return sseResponse("Failover worked", "resp_failover");
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

  it("retries when the upstream answers 200 with an SSE error frame", async () => {
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
          // An overloaded backend answers 200 with a single error frame.
          return new Response(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: {
                message: "Our servers are currently overloaded. Please try again later.",
                type: "service_unavailable_error",
                code: "server_is_overloaded",
              },
            })}\n\n`,
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        }
        return sseResponse("Recovered", "resp_recovered");
      };

      const handler = new CompletionProxyHandler({ pool });
      const result = await handler.handleCompletion({
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      });

      assert.equal(callCount, 2);
      assert.equal(result.status, 200);
      assert.equal(result.jsonResponse?.choices[0]?.message.content, "Recovered");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refreshes the token and retries once on a 401", async () => {
    const pool = new AccountPoolManager();
    pool.addAccount("refresh_1", "https://omnirush.ai/omnirush/v1", "u1@test.com", "stale_access");

    const originalFetch = globalThis.fetch;
    let modelCalls = 0;
    try {
      globalThis.fetch = async (url, init) => {
        const target = url.toString();

        // The account refresh goes to the control plane, not the model API.
        if (target.includes("/device/refresh")) {
          return new Response(
            JSON.stringify({
              access_token: "fresh_access",
              refresh_token: "fresh_refresh",
              token_type: "Bearer",
              expires_in: 3600,
              gateway_url: "https://omnirush.ai/omnirush/v1",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        modelCalls++;
        const auth = (init?.headers as Record<string, string>)?.["Authorization"];
        if (auth === "Bearer stale_access") {
          return new Response(JSON.stringify({ detail: "device_token_invalid" }), { status: 401 });
        }
        return sseResponse("After refresh", "resp_refreshed");
      };

      const handler = new CompletionProxyHandler({ pool });
      const result = await handler.handleCompletion({
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      });

      assert.equal(modelCalls, 2, "the model request is retried with the fresh token");
      assert.equal(result.status, 200);
      assert.equal(result.jsonResponse?.choices[0]?.message.content, "After refresh");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
