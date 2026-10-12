import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "../../src/worker/index.js";
import type { WorkerEnv } from "../../src/types/config.js";

describe("cloudflare worker", () => {
  it("handles CORS OPTIONS preflight", async () => {
    const req = new Request("https://worker.dev/v1/chat/completions", {
      method: "OPTIONS",
    });
    const env: WorkerEnv = {};

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("handles health check GET /health", async () => {
    const req = new Request("https://worker.dev/health", { method: "GET" });
    const env: WorkerEnv = {
      OMNIRUSH_REFRESH_TOKEN: "tok_1, tok_2",
    };

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(json["mode"], "cloudflare-worker");
    assert.equal(json["account_count"], 2);
    assert.ok(Array.isArray(json["supported_models"]));
  });

  it("enforces API_KEY secret when configured", async () => {
    const req = new Request("https://worker.dev/v1/models", {
      method: "GET",
      headers: { Authorization: "Bearer wrong-key" },
    });
    const env: WorkerEnv = { API_KEY: "my-secret-key" };

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 401);
  });

  it("returns model list on GET /v1/models", async () => {
    const req = new Request("https://worker.dev/v1/models", { method: "GET" });
    const env: WorkerEnv = {};

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(json["object"], "list");
    assert.ok(Array.isArray(json["data"]));
  });

  it("reads token pair from TOKEN_KV namespace and reports kv_storage_configured", async () => {
    const store = new Map<string, string>();
    store.set("omnirush_token", "kv_ref_tok|kv_acc_tok");

    const mockKv = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    };

    const req = new Request("https://worker.dev/health", { method: "GET" });
    const env: WorkerEnv = {
      TOKEN_KV: mockKv,
    };

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(json["kv_storage_configured"], true);
    assert.equal(json["account_count"], 1);
  });
});
