import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveModelId,
  getModelList,
  isKnownModel,
} from "../../src/proxy/model-catalog.js";

describe("model-catalog", () => {
  it("resolves canonical models and aliases correctly", () => {
    // Defaults & aliases for gpt-6-astra
    assert.equal(resolveModelId("gpt-6-astra"), "gpt-6-astra");
    assert.equal(resolveModelId("astra"), "gpt-6-astra");
    assert.equal(resolveModelId("gpt-6"), "gpt-6-astra");
    assert.equal(resolveModelId("omnirush"), "gpt-6-astra");
    assert.equal(resolveModelId(""), "gpt-6-astra");

    // Sol models
    assert.equal(resolveModelId("gpt-6.1-sol"), "gpt-6.1-sol");
    assert.equal(resolveModelId("sol-pro"), "gpt-6.1-sol");
    assert.equal(resolveModelId("gpt-6-sol"), "gpt-6-sol");
    assert.equal(resolveModelId("sol"), "gpt-6-sol");

    // Unknown models pass through verbatim
    assert.equal(resolveModelId("custom-finetune"), "custom-finetune");
  });

  it("checks whether a model id or alias is recognized", () => {
    assert.equal(isKnownModel("gpt-6-astra"), true);
    assert.equal(isKnownModel("astra"), true);
    assert.equal(isKnownModel("sol"), true);
    assert.equal(isKnownModel("unknown-model-xyz"), false);
  });

  it("returns OpenAI-formatted model list", () => {
    const list = getModelList();
    assert.equal(list.object, "list");
    assert.ok(list.data.length >= 3);

    const ids = list.data.map((m) => m.id);
    assert.ok(ids.includes("gpt-6-astra"));
    assert.ok(ids.includes("gpt-6.1-sol"));
    assert.ok(ids.includes("gpt-6-sol"));

    for (const model of list.data) {
      assert.equal(model.object, "model");
      assert.equal(model.owned_by, "omnirush.ai");
      assert.ok(model.created > 0);
    }
  });
});
