"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  discoverGGUFVisionModels,
  inspectManagedModelRoots,
  selectRegisteredModel,
} = require("./local-ai/GGUFVisionModelRegistry.js");

function createTempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gguf-vision-registry-"));
}

function createModelDirectory(rootDirectory, directoryName, overrides = {}) {
  const modelDirectory = path.join(rootDirectory, directoryName);
  fs.mkdirSync(modelDirectory, { recursive: true });
  const manifest = {
    id: "qwen-vl-receipt-4b",
    displayName: "Qwen VL Receipt 4B",
    provider: "llama-server",
    modelFamily: "qwen-vl",
    modelFile: "model.gguf",
    mmprojFile: "mmproj.gguf",
    contextSize: 16384,
    recommendedMaxTokens: 2048,
    capabilities: ["vision", "chat", "receipt-extraction"],
    runtimeArgs: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(modelDirectory, "local-ai.json"), JSON.stringify(manifest, null, 2));
  if (manifest.modelFile && !String(manifest.modelFile).includes("..")) {
    fs.writeFileSync(path.join(modelDirectory, manifest.modelFile), "model");
  }
  if (manifest.mmprojFile && !String(manifest.mmprojFile).includes("..")) {
    fs.writeFileSync(path.join(modelDirectory, manifest.mmprojFile), "mmproj");
  }
  return modelDirectory;
}

async function run() {
  const summaries = [];
  const test = async (name, fn) => {
    await fn();
    summaries.push(name);
  };

  await test("single valid model is discovered", async () => {
    const root = createTempDirectory();
    const modelDirectory = createModelDirectory(root, "qwen");
    const registry = await discoverGGUFVisionModels({ modelRoots: [root] });
    assert.strictEqual(registry.models.length, 1);
    assert.strictEqual(registry.models[0].modelDirectory, modelDirectory);
    assert.strictEqual(registry.models[0].modelId, "qwen-vl-receipt-4b");
    assert.deepStrictEqual(registry.invalidCandidates, []);
  });

  await test("multiple valid immediate child models are discovered", async () => {
    const root = createTempDirectory();
    createModelDirectory(root, "qwen-a", { id: "qwen-a", displayName: "Qwen A" });
    createModelDirectory(root, "qwen-b", { id: "qwen-b", displayName: "Qwen B" });
    const registry = await discoverGGUFVisionModels({ modelRoots: root });
    assert.deepStrictEqual(registry.models.map((model) => model.modelId).sort(), ["qwen-a", "qwen-b"]);
  });

  await test("root itself can be a model directory", async () => {
    const root = createTempDirectory();
    createModelDirectory(root, ".", { id: "direct-root", displayName: "Direct Root" });
    const registry = await inspectManagedModelRoots([root]);
    assert.strictEqual(registry.models.length, 1);
    assert.strictEqual(registry.models[0].modelId, "direct-root");
  });

  await test("missing root is a warning and does not abort discovery", async () => {
    const root = createTempDirectory();
    createModelDirectory(root, "qwen");
    const registry = await discoverGGUFVisionModels({
      modelRoots: [path.join(root, "missing"), root],
    });
    assert.strictEqual(registry.models.length, 1);
    assert.ok(registry.warnings.some((warning) => warning.includes("does not exist or is unreadable")));
  });

  await test("invalid manifest beside valid model is retained as an invalid candidate", async () => {
    const root = createTempDirectory();
    createModelDirectory(root, "valid", { id: "valid-model" });
    const invalidDirectory = createModelDirectory(root, "invalid", { id: "invalid-model", contextSize: 0 });
    const registry = await discoverGGUFVisionModels({ modelRoots: [root] });
    assert.strictEqual(registry.models.length, 1);
    assert.strictEqual(registry.invalidCandidates.length, 1);
    assert.strictEqual(registry.invalidCandidates[0].modelDirectory, invalidDirectory);
    assert.ok(registry.invalidCandidates[0].errors.includes("contextSize must be a positive safe integer."));
  });

  await test("missing main GGUF and mmproj become invalid candidates", async () => {
    const root = createTempDirectory();
    const missingModel = createModelDirectory(root, "missing-model", { id: "missing-model" });
    const missingProjector = createModelDirectory(root, "missing-mmproj", { id: "missing-mmproj" });
    fs.unlinkSync(path.join(missingModel, "model.gguf"));
    fs.unlinkSync(path.join(missingProjector, "mmproj.gguf"));
    const registry = await discoverGGUFVisionModels({ modelRoots: [root] });
    assert.strictEqual(registry.invalidCandidates.length, 2);
    assert.ok(registry.invalidCandidates.some((candidate) => candidate.errors.some((error) => error.includes("modelFile does not exist"))));
    assert.ok(registry.invalidCandidates.some((candidate) => candidate.errors.some((error) => error.includes("mmprojFile does not exist"))));
  });

  await test("duplicate model IDs are reported and cannot be selected", async () => {
    const root = createTempDirectory();
    const first = createModelDirectory(root, "first", { id: "duplicate" });
    const second = createModelDirectory(root, "second", { id: "duplicate" });
    const registry = await discoverGGUFVisionModels({ modelRoots: [root] });
    assert.ok(registry.warnings.some((warning) => warning.includes("Duplicate registered model ID \"duplicate\"")));
    const selection = selectRegisteredModel(registry.models, "duplicate");
    assert.strictEqual(selection.available, false);
    assert.strictEqual(selection.duplicateModelId, "duplicate");
    assert.deepStrictEqual(selection.conflictingDirectories.sort(), [first, second].sort());
  });

  await test("registered model selection reports found and missing models", async () => {
    const model = { supported: true, modelId: "selected", modelDirectory: "C:/models/selected" };
    const selected = selectRegisteredModel([model], "selected");
    const missing = selectRegisteredModel([model], "absent");
    assert.strictEqual(selected.available, true);
    assert.strictEqual(selected.model, model);
    assert.strictEqual(missing.available, false);
    assert.match(missing.reason, /No registered model/);
  });

  await test("manifest path traversal remains invalid through the manifest inspector", async () => {
    const root = createTempDirectory();
    const candidate = createModelDirectory(root, "traversal", {
      id: "traversal",
      modelFile: "../model.gguf",
      mmprojFile: "../mmproj.gguf",
    });
    const registry = await discoverGGUFVisionModels({ modelRoots: [root] });
    assert.strictEqual(registry.models.length, 0);
    assert.strictEqual(registry.invalidCandidates[0].modelDirectory, candidate);
    assert.ok(registry.invalidCandidates[0].errors.includes("modelFile must resolve inside the model directory."));
  });

  await test("unreadable candidate failures do not abort other candidates", async () => {
    const root = createTempDirectory();
    createModelDirectory(root, "valid", { id: "valid" });
    const unreadable = path.join(root, "unreadable");
    fs.mkdirSync(unreadable);
    const registry = await discoverGGUFVisionModels({
      modelRoots: [root],
      inspectModel: async (candidatePath) => {
        if (candidatePath === unreadable) {
          throw new Error("EACCES");
        }
        return await require("./local-ai/GGUFVisionModelManifest.js").inspectGGUFVisionModel(candidatePath);
      },
    });
    assert.strictEqual(registry.models.length, 1);
    assert.ok(registry.invalidCandidates.some((candidate) => candidate.modelDirectory === unreadable));
  });

  await test("registry helper has no renderer, provider, runtime, or receipt workflow dependencies", async () => {
    const source = fs.readFileSync(path.join(__dirname, "local-ai", "GGUFVisionModelRegistry.js"), "utf8");
    const forbidden = [
      "ReceiptVisionProvider",
      "OpenAICompatibleReceiptVisionProvider",
      "ReceiptIntelligenceService",
      "LocalAIRuntimeManager",
      "ManagedOpenAICompatibleSupport",
      "child_process",
      "spawn",
      "document.",
      "window.",
      "ipcMain",
      "ipcRenderer",
      "parseTextForStore",
      "addReceipt",
      "updateReceiptRecord",
    ];
    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `registry helper should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("GGUF vision model registry summaries:");
  for (const summary of summaries) {
    console.log(`- ${summary}`);
  }
}

run().catch((error) => {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
