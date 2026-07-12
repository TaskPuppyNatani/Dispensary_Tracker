"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  OFFICIAL_LOCAL_AI_MODELS,
  listOfficialLocalAIModels,
  getOfficialLocalAIModel,
  findCatalogModel,
  resolveRegisteredModelCatalogEntry,
} = require("./local-ai/LocalAIModelCatalog.js");

const FIXTURE_CATALOG = [{
  modelId: "fixture-qwen-vl",
  displayName: "Fixture Qwen VL",
  provider: "llama-server",
  modelFamily: "qwen-vl",
  version: "fixture",
  quantization: "Q4_K_M",
  download: {
    modelUrl: "https://example.invalid/model.gguf",
    mmprojUrl: "https://example.invalid/mmproj.gguf",
    modelSha256: "fixture-model-sha256",
    mmprojSha256: "fixture-mmproj-sha256",
    modelBytes: 100,
    mmprojBytes: 20,
  },
  storage: { installedBytes: 120, temporaryDownloadBytes: 120, safetyBufferBytes: 10 },
  memory: { minimumRamBytes: 100, recommendedRamBytes: 200, minimumVramBytes: 50, recommendedVramBytes: 100 },
  cpuSupported: true,
  recommendedContextSize: 16384,
  recommendedMaxTokens: 2048,
  capabilities: ["vision", "chat"],
  license: "fixture-license",
  source: "fixture-source",
  notes: "Fixture only.",
}];

function run() {
  const summaries = [];
  const test = (name, fn) => {
    fn();
    summaries.push(name);
  };

  test("production catalog remains empty until official release metadata is verified", () => {
    assert.deepStrictEqual(OFFICIAL_LOCAL_AI_MODELS, []);
    assert.deepStrictEqual(listOfficialLocalAIModels(), []);
    assert.strictEqual(getOfficialLocalAIModel("fixture-qwen-vl"), null);
  });

  test("fixture catalog supports canonical lookup without exposing mutable arrays", () => {
    const result = findCatalogModel(FIXTURE_CATALOG, "fixture-qwen-vl");
    assert.strictEqual(result.modelId, "fixture-qwen-vl");
    result.capabilities.push("changed");
    assert.deepStrictEqual(FIXTURE_CATALOG[0].capabilities, ["vision", "chat"]);
  });

  test("registered catalog model resolves by canonical model ID", () => {
    const result = resolveRegisteredModelCatalogEntry(
      { supported: true, modelId: "fixture-qwen-vl" },
      FIXTURE_CATALOG
    );
    assert.strictEqual(result.kind, "catalog");
    assert.strictEqual(result.catalogModel.modelId, "fixture-qwen-vl");
  });

  test("valid custom registered model remains accepted without a catalog entry", () => {
    const registeredModel = { supported: true, modelId: "custom-qwen", modelDirectory: "C:/models/custom" };
    const result = resolveRegisteredModelCatalogEntry(registeredModel, FIXTURE_CATALOG);
    assert.strictEqual(result.kind, "custom");
    assert.strictEqual(result.catalogModel, null);
    assert.strictEqual(result.registeredModel, registeredModel);
  });

  test("catalog helper is isolated from UI, runtime, provider, OCR, and database modules", () => {
    const source = fs.readFileSync(path.join(__dirname, "local-ai", "LocalAIModelCatalog.js"), "utf8");
    const forbidden = [
      "ReceiptVisionProvider", "OpenAICompatibleReceiptVisionProvider", "LocalAIRuntimeManager",
      "ManagedOpenAICompatibleSupport", "document.", "window.", "ipcMain", "ipcRenderer",
      "child_process", "spawn", "parseTextForStore", "addReceipt", "updateReceiptRecord",
      "system_profiler", "WMIC", "lspci", "PowerShell",
    ];
    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `catalog should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Local AI model catalog summaries:");
  for (const summary of summaries) console.log(`- ${summary}`);
}

try { run(); } catch (error) {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
}

module.exports = { FIXTURE_CATALOG };
