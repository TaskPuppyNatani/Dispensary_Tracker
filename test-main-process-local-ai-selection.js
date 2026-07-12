"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
  PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
  resolveMainProcessLocalAISelection,
  isManagedSelectionStartupReady,
  getSelectedManagedModelDirectory,
  createReceiptVisionProviderCacheKey,
  createProviderSelectionDiagnostics,
} = require("./local-ai/MainProcessLocalAISelectionSupport.js");

function createSelection(overrides = {}) {
  return {
    requestedMode: null,
    resolvedMode: PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
    selectionSource: "single-managed-model",
    reasonCode: "single-managed-model",
    reason: "One valid model was discovered.",
    runtimeInspection: { available: true, reasonCode: null, reason: null, resolution: {}, validation: {} },
    selectedModel: {
      supported: true,
      modelId: "qwen-vl",
      displayName: "Qwen VL",
      modelDirectory: "C:/models/qwen",
      manifestPath: "C:/models/qwen/local-ai.json",
      modelPath: "C:/models/qwen/model.gguf",
      mmprojPath: "C:/models/qwen/mmproj.gguf",
      selectionSource: "single-managed-model",
    },
    validModelCandidates: [{}],
    invalidCandidates: [],
    warnings: [],
    ...overrides,
  };
}

async function run() {
  const summaries = [];
  const test = async (name, fn) => { await fn(); summaries.push(name); };

  await test("startup-ready managed selection exposes only its selected model directory", async () => {
    const selection = createSelection();
    assert.strictEqual(isManagedSelectionStartupReady(selection), true);
    assert.strictEqual(getSelectedManagedModelDirectory(selection), "C:/models/qwen");
  });

  await test("blocked managed selections do not qualify for startup", async () => {
    const missingRuntime = createSelection({ runtimeInspection: { available: false }, selectedModel: null });
    const ambiguousModels = createSelection({ selectedModel: null, validModelCandidates: [{}, {}] });
    assert.strictEqual(isManagedSelectionStartupReady(missingRuntime), false);
    assert.strictEqual(isManagedSelectionStartupReady(ambiguousModels), false);
    assert.strictEqual(getSelectedManagedModelDirectory(missingRuntime), "");
  });

  await test("provider cache keys distinguish models and external configuration", async () => {
    const managedOne = createReceiptVisionProviderCacheKey({ providerType: "openai-compatible", selection: createSelection() });
    const managedTwo = createReceiptVisionProviderCacheKey({ providerType: "openai-compatible", selection: createSelection({ selectedModel: { ...createSelection().selectedModel, modelId: "second", modelDirectory: "C:/models/second" } }) });
    const external = createReceiptVisionProviderCacheKey({
      providerType: "openai-compatible",
      selection: { resolvedMode: PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE },
      externalOptions: { baseUrl: "http://localhost:1234/v1/chat/completions", model: "lm-studio" },
    });
    assert.notStrictEqual(managedOne, managedTwo);
    assert.notStrictEqual(managedOne, external);
    assert.ok(external.includes("http://localhost:1234/v1/chat/completions"));
  });

  await test("selection diagnostics are IPC-safe and omit internal manifest data", async () => {
    const diagnostics = createProviderSelectionDiagnostics(createSelection({
      invalidCandidates: [{ modelDirectory: "C:/models/bad", errors: ["missing mmproj"] }],
      warnings: ["ignored invalid model"],
    }));
    assert.doesNotThrow(() => JSON.stringify(diagnostics));
    assert.deepStrictEqual(diagnostics.selectedModel, {
      modelId: "qwen-vl",
      displayName: "Qwen VL",
      modelDirectory: "C:/models/qwen",
      selectionSource: "single-managed-model",
    });
    assert.strictEqual(diagnostics.validModelCandidateCount, 1);
  });

  await test("main-process resolver wrapper invokes one pure resolution without provider or runtime objects", async () => {
    let resolveCalls = 0;
    const selection = await resolveMainProcessLocalAISelection({
      env: {}, platform: "win32", arch: "x64", resourcesPath: "", baseDirectory: "C:/repo", automaticModelRoots: [],
      resolveExecutablePath: async () => { resolveCalls += 1; return { found: false, reason: "missing" }; },
      validateExecutable: async () => { throw new Error("should not validate missing path"); },
      inspectModel: async () => { throw new Error("should not inspect"); },
      discoverModels: async () => ({ models: [], invalidCandidates: [], warnings: [] }),
      selectRegisteredModel: () => ({ available: false, model: null }),
    });
    assert.strictEqual(resolveCalls, 1);
    assert.strictEqual(selection.resolvedMode, PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE);
    assert.strictEqual(selection.reasonCode, "managed-runtime-missing");
  });

  await test("support helper remains independent of Electron, providers, and runtime launch", async () => {
    const source = fs.readFileSync(path.join(__dirname, "local-ai", "MainProcessLocalAISelectionSupport.js"), "utf8");
    const forbidden = ["require(\"electron\")", "LocalAIRuntimeManager", "OpenAICompatibleReceiptVisionProvider", "child_process", "spawn", "process.env", "document.", "window."];
    for (const term of forbidden) assert.strictEqual(source.includes(term), false, `selection support should not reference ${term}`);
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Main-process Local AI selection summaries:");
  for (const summary of summaries) console.log(`- ${summary}`);
}

run().catch((error) => {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
