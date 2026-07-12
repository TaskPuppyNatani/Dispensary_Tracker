"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
  PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
  resolveLocalAIProviderSelection,
} = require("./local-ai/LocalAIProviderModeResolver.js");
const { selectRegisteredModel } = require("./local-ai/GGUFVisionModelRegistry.js");

function createDependencies(overrides = {}) {
  const calls = { resolveRuntime: 0, validateRuntime: 0, inspectModel: 0, discoverModels: 0, selectModel: 0 };
  const validModel = {
    supported: true,
    modelId: "qwen-vl-receipt",
    modelRoot: "C:/models/qwen",
    modelDirectory: "C:/models/qwen",
    manifestPath: "C:/models/qwen/local-ai.json",
    modelPath: "C:/models/qwen/model.gguf",
    mmprojPath: "C:/models/qwen/mmproj.gguf",
    displayName: "Qwen VL Receipt",
    warnings: [],
    errors: [],
  };
  const dependencies = {
    env: {},
    platform: "win32",
    arch: "x64",
    resourcesPath: "C:/resources",
    baseDirectory: "C:/repo",
    automaticModelRoots: ["C:/repo/models"],
    resolveExecutablePath: async () => {
      calls.resolveRuntime += 1;
      return { found: true, source: "development", executablePath: "C:/repo/resources/llama-server.exe", reason: null, platform: "win32", arch: "x64" };
    },
    validateExecutable: async () => {
      calls.validateRuntime += 1;
      return { valid: true, executablePath: "C:/repo/resources/llama-server.exe", platform: "win32", exists: true, executable: true, reason: null, warnings: [] };
    },
    inspectModel: async () => {
      calls.inspectModel += 1;
      return validModel;
    },
    discoverModels: async () => {
      calls.discoverModels += 1;
      return { models: [{ ...validModel, modelDirectory: "C:/repo/models/qwen" }], invalidCandidates: [], warnings: [] };
    },
    selectRegisteredModel: (models, modelId) => {
      calls.selectModel += 1;
      const model = models.find((entry) => entry.modelId === modelId);
      return { available: Boolean(model), model: model || null, reason: model ? null : "missing" };
    },
    ...overrides,
  };
  return { dependencies, calls, validModel };
}

function assertPlainData(value) {
  assert.doesNotThrow(() => JSON.stringify(value));
  assert.strictEqual(Object.getPrototypeOf(value), Object.prototype);
}

async function run() {
  const summaries = [];
  const test = async (name, fn) => { await fn(); summaries.push(name); };

  await test("explicit managed mode wins", async () => {
    const { dependencies } = createDependencies({ env: { LOCAL_AI_PROVIDER_MODE: PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE } });
    const result = await resolveLocalAIProviderSelection(dependencies);
    assert.strictEqual(result.requestedMode, PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE);
    assert.strictEqual(result.resolvedMode, PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE);
    assert.strictEqual(result.selectionSource, "explicit-managed-mode");
  });

  await test("explicit external mode wins without managed inspection", async () => {
    const { dependencies, calls } = createDependencies({ env: { LOCAL_AI_PROVIDER_MODE: PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE } });
    const result = await resolveLocalAIProviderSelection(dependencies);
    assert.strictEqual(result.resolvedMode, PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE);
    assert.strictEqual(result.selectionSource, "explicit-external-mode");
    assert.deepStrictEqual(calls, { resolveRuntime: 0, validateRuntime: 0, inspectModel: 0, discoverModels: 0, selectModel: 0 });
  });

  await test("valid explicit model directory plus valid runtime selects managed without discovery", async () => {
    const { dependencies, calls } = createDependencies({ env: { LOCAL_AI_MODEL_DIR: "C:/models/qwen" } });
    const result = await resolveLocalAIProviderSelection(dependencies);
    assert.strictEqual(result.resolvedMode, PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE);
    assert.strictEqual(result.selectionSource, "explicit-model-directory");
    assert.strictEqual(result.selectedModel.modelDirectory, "C:/models/qwen");
    assert.strictEqual(calls.discoverModels, 0);
  });

  await test("valid explicit model directory plus missing runtime falls back to external", async () => {
    const { dependencies } = createDependencies({
      env: { LOCAL_AI_MODEL_DIR: "C:/models/qwen" },
      resolveExecutablePath: async () => ({ found: false, source: "development", executablePath: "", reason: "runtime missing", platform: "win32", arch: "x64" }),
    });
    const result = await resolveLocalAIProviderSelection(dependencies);
    assert.strictEqual(result.resolvedMode, PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE);
    assert.strictEqual(result.reasonCode, "managed-runtime-missing");
  });

  await test("valid explicit model directory plus invalid runtime falls back to external", async () => {
    const { dependencies } = createDependencies({
      env: { LOCAL_AI_MODEL_DIR: "C:/models/qwen" },
      validateExecutable: async () => ({ valid: false, executablePath: "C:/repo/resources/llama-server.exe", platform: "win32", exists: true, executable: false, reason: "runtime invalid", warnings: [] }),
    });
    const result = await resolveLocalAIProviderSelection(dependencies);
    assert.strictEqual(result.resolvedMode, PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE);
    assert.strictEqual(result.reasonCode, "managed-runtime-invalid");
  });

  await test("single valid discovered model plus valid runtime selects managed through the registry selector", async () => {
    const { dependencies } = createDependencies({ selectRegisteredModel });
    const result = await resolveLocalAIProviderSelection(dependencies);
    assert.strictEqual(result.resolvedMode, PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE);
    assert.strictEqual(result.selectionSource, "single-managed-model");
  });

  await test("no valid models falls back to external", async () => {
    const { dependencies } = createDependencies({ discoverModels: async () => ({ models: [], invalidCandidates: [], warnings: [] }) });
    const result = await resolveLocalAIProviderSelection(dependencies);
    assert.strictEqual(result.resolvedMode, PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE);
    assert.strictEqual(result.reasonCode, "no-valid-managed-models");
  });

  await test("multiple valid models fall back with ambiguity", async () => {
    const { dependencies, validModel } = createDependencies({
      discoverModels: async () => ({ models: [
        { ...validModel, modelDirectory: "C:/models/one" },
        { ...validModel, modelId: "second", modelDirectory: "C:/models/two" },
      ], invalidCandidates: [], warnings: [] }),
    });
    const result = await resolveLocalAIProviderSelection(dependencies);
    assert.strictEqual(result.resolvedMode, PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE);
    assert.strictEqual(result.reasonCode, "multiple-managed-models");
  });

  await test("invalid candidates are excluded but retained in diagnostics", async () => {
    const { dependencies } = createDependencies({
      discoverModels: async () => ({ models: [], invalidCandidates: [{ modelDirectory: "C:/models/bad", errors: ["missing mmproj"] }], warnings: ["bad model ignored"] }),
    });
    const result = await resolveLocalAIProviderSelection(dependencies);
    assert.strictEqual(result.invalidCandidates.length, 1);
    assert.deepStrictEqual(result.invalidCandidates[0].errors, ["missing mmproj"]);
    assert.ok(result.warnings.includes("bad model ignored"));
  });

  await test("explicit managed mode remains managed when model selection fails", async () => {
    const { dependencies } = createDependencies({
      env: { LOCAL_AI_PROVIDER_MODE: PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE },
      discoverModels: async () => ({ models: [], invalidCandidates: [], warnings: [] }),
    });
    const result = await resolveLocalAIProviderSelection(dependencies);
    assert.strictEqual(result.resolvedMode, PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE);
    assert.strictEqual(result.reasonCode, "no-valid-managed-models");
  });

  await test("explicit managed mode remains managed when runtime is invalid", async () => {
    const { dependencies } = createDependencies({
      env: { LOCAL_AI_PROVIDER_MODE: PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE },
      validateExecutable: async () => ({ valid: false, executablePath: "C:/repo/resources/llama-server.exe", platform: "win32", exists: true, executable: false, reason: "runtime invalid", warnings: [] }),
    });
    const result = await resolveLocalAIProviderSelection(dependencies);
    assert.strictEqual(result.resolvedMode, PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE);
    assert.strictEqual(result.reasonCode, "managed-runtime-invalid");
  });

  await test("invalid provider mode selects external without runtime or model inspection", async () => {
    const { dependencies, calls } = createDependencies({ env: { LOCAL_AI_PROVIDER_MODE: "managed-typo" } });
    const result = await resolveLocalAIProviderSelection(dependencies);
    assert.strictEqual(result.resolvedMode, PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE);
    assert.strictEqual(result.reasonCode, "invalid-provider-mode");
    assert.deepStrictEqual(calls, { resolveRuntime: 0, validateRuntime: 0, inspectModel: 0, discoverModels: 0, selectModel: 0 });
  });

  await test("direct and registry models normalize to the same selected-model shape", async () => {
    const { dependencies } = createDependencies({ env: { LOCAL_AI_MODEL_DIR: "C:/models/qwen" } });
    const direct = await resolveLocalAIProviderSelection(dependencies);
    const { dependencies: automaticDependencies } = createDependencies();
    const automatic = await resolveLocalAIProviderSelection(automaticDependencies);
    assert.deepStrictEqual(Object.keys(direct.selectedModel).sort(), Object.keys(automatic.selectedModel).sort());
    assert.strictEqual(direct.selectedModel.modelId, automatic.selectedModel.modelId);
  });

  await test("resolver output is IPC-serializable plain data", async () => {
    const { dependencies } = createDependencies();
    const result = await resolveLocalAIProviderSelection(dependencies);
    assertPlainData(result);
    assertPlainData(result.selectedModel);
    assertPlainData(result.runtimeInspection);
  });

  await test("resolver source imports no Electron, runtime launcher, or provider modules", async () => {
    const source = fs.readFileSync(path.join(__dirname, "local-ai", "LocalAIProviderModeResolver.js"), "utf8");
    const forbidden = [
      "require(\"electron\")", "LocalAIRuntimeManager", "OpenAICompatibleReceiptVisionProvider",
      "ReceiptVisionProvider", "child_process", "spawn", "process.env", "app.getPath",
      "document.", "window.", "ipcMain", "ipcRenderer",
    ];
    for (const term of forbidden) assert.strictEqual(source.includes(term), false, `resolver should not reference ${term}`);
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Local AI provider-mode resolver summaries:");
  for (const summary of summaries) console.log(`- ${summary}`);
}

run().catch((error) => {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
