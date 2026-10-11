import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  loadStoredTokens,
  saveStoredTokens,
  addOrUpdateToken,
  removeToken,
} from "../../src/auth/token-store.js";

describe("token-store", () => {
  it("saves and loads tokens from custom path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omnirush-store-"));
    const storePath = path.join(tmpDir, "tokens.json");

    try {
      const initial = await loadStoredTokens(storePath);
      assert.deepEqual(initial, []);

      await saveStoredTokens(
        [
          {
            refreshToken: "tok_1",
            accessToken: "acc_1",
            gatewayUrl: "https://omnirush.ai/omnirush/v1",
            email: "a@omnirush.ai",
          },
        ],
        storePath
      );

      const loaded = await loadStoredTokens(storePath);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]?.refreshToken, "tok_1");
      assert.equal(loaded[0]?.email, "a@omnirush.ai");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("adds and updates existing tokens without duplicates", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omnirush-store-"));
    const storePath = path.join(tmpDir, "tokens.json");

    try {
      await addOrUpdateToken(
        { refreshToken: "tok_abc", accessToken: "old_acc", email: "old@omnirush.ai" },
        storePath
      );

      let list = await loadStoredTokens(storePath);
      assert.equal(list.length, 1);
      assert.equal(list[0]?.accessToken, "old_acc");

      // Update with new access token
      await addOrUpdateToken(
        { refreshToken: "tok_abc", accessToken: "new_acc", email: "new@omnirush.ai" },
        storePath
      );

      list = await loadStoredTokens(storePath);
      assert.equal(list.length, 1);
      assert.equal(list[0]?.accessToken, "new_acc");
      assert.equal(list[0]?.email, "new@omnirush.ai");

      // Add another token
      await addOrUpdateToken({ refreshToken: "tok_xyz" }, storePath);
      list = await loadStoredTokens(storePath);
      assert.equal(list.length, 2);

      // Remove first token
      const removed = await removeToken("tok_abc", storePath);
      assert.equal(removed, true);
      list = await loadStoredTokens(storePath);
      assert.equal(list.length, 1);
      assert.equal(list[0]?.refreshToken, "tok_xyz");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
