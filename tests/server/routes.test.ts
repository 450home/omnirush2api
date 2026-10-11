import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { RequestDispatcher } from "../../src/server/routes.js";
import { AccountPoolManager } from "../../src/auth/pool-manager.js";
import type { ServerConfig } from "../../src/types/config.js";

function createMockDispatcher(configPartial?: Partial<ServerConfig>): {
  dispatcher: RequestDispatcher;
  pool: AccountPoolManager;
} {
  const pool = new AccountPoolManager();
  const config: ServerConfig = {
    port: 20129,
    host: "127.0.0.1",
    gatewayUrl: "https://omnirush.ai/omnirush/v1",
    ...configPartial,
  };
  const dispatcher = new RequestDispatcher(config, pool);
  return { dispatcher, pool };
}

describe("server routes", () => {
  it("handles CORS OPTIONS preflight request", async () => {
    const { dispatcher } = createMockDispatcher();
    let statusCode = 0;
    const headers: Record<string, string> = {};

    const req = {
      method: "OPTIONS",
      url: "/v1/chat/completions",
      headers: { host: "localhost" },
    } as unknown as http.IncomingMessage;

    const res = {
      setHeader(name: string, val: string) {
        headers[name] = val;
      },
      writeHead(code: number) {
        statusCode = code;
      },
      end() {},
    } as unknown as http.ServerResponse;

    await dispatcher.dispatch(req, res);
    assert.equal(statusCode, 204);
    assert.equal(headers["Access-Control-Allow-Origin"], "*");
  });

  it("returns health status with pool metrics", async () => {
    const { dispatcher, pool } = createMockDispatcher();
    pool.addAccount("mock_refresh", "https://omnirush.ai/omnirush/v1", "user@test.com", "mock_acc");

    let statusCode = 0;
    let body = "";

    const req = {
      method: "GET",
      url: "/v1/health",
      headers: { host: "localhost" },
    } as unknown as http.IncomingMessage;

    const res = {
      setHeader() {},
      writeHead(code: number) {
        statusCode = code;
      },
      end(data: string) {
        body = data;
      },
    } as unknown as http.ServerResponse;

    await dispatcher.dispatch(req, res);
    assert.equal(statusCode, 200);

    const parsed = JSON.parse(body);
    assert.equal(parsed.status, "healthy");
    assert.equal(parsed.account_count, 1);
    assert.ok(parsed.supported_models.includes("gpt-6-astra"));
  });

  it("enforces bearer API key when configured", async () => {
    const { dispatcher } = createMockDispatcher({ apiKey: "secret-token-123" });

    let statusCode = 0;
    let body = "";

    const req = {
      method: "GET",
      url: "/v1/models",
      headers: { host: "localhost", authorization: "Bearer wrong-key" },
    } as unknown as http.IncomingMessage;

    const res = {
      setHeader() {},
      writeHead(code: number) {
        statusCode = code;
      },
      end(data: string) {
        body = data;
      },
    } as unknown as http.ServerResponse;

    await dispatcher.dispatch(req, res);
    assert.equal(statusCode, 401);
    const parsed = JSON.parse(body);
    assert.equal(parsed.error.code, "invalid_api_key");
  });

  it("returns 404 for unknown endpoints", async () => {
    const { dispatcher } = createMockDispatcher();
    let statusCode = 0;

    const req = {
      method: "GET",
      url: "/v1/non-existent-endpoint",
      headers: { host: "localhost" },
    } as unknown as http.IncomingMessage;

    const res = {
      setHeader() {},
      writeHead(code: number) {
        statusCode = code;
      },
      end() {},
    } as unknown as http.ServerResponse;

    await dispatcher.dispatch(req, res);
    assert.equal(statusCode, 404);
  });
});
