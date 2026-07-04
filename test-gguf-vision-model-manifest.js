const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  inspectGGUFVisionModel,
  validateGGUFVisionModelDirectory,
} = require("./local-ai/GGUFVisionModelManifest.js");

function createTempModelDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gguf-vision-model-"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function touch(filePath) {
  fs.writeFileSync(filePath, "placeholder");
}

function createValidFixture(overrides = {}) {
  const modelDir = createTempModelDirectory();
  const manifest = {
    id: "qwen2.5-vl-3b-gguf",
    displayName: "Qwen2.5-VL 3B",
    provider: "llama-server",
    modelFamily: "qwen-vl",
    modelFile: "model.gguf",
    mmprojFile: "mmproj.gguf",
    contextSize: 16384,
    recommendedMaxTokens: 2048,
    capabilities: ["vision", "chat", "receipt-extraction"],
    runtimeArgs: ["--flash-attn"],
    ...overrides,
  };

  if (manifest.modelFile && !String(manifest.modelFile).includes("..")) {
    touch(path.join(modelDir, manifest.modelFile));
  }

  if (manifest.mmprojFile && !String(manifest.mmprojFile).includes("..")) {
    touch(path.join(modelDir, manifest.mmprojFile));
  }

  writeJson(path.join(modelDir, "local-ai.json"), manifest);

  return { modelDir, manifest };
}

async function run() {
  const summaries = [];

  async function test(name, fn) {
    await fn();
    summaries.push(name);
  }

  await test("valid manifest", async function() {
    const { modelDir } = createValidFixture();
    const result = await inspectGGUFVisionModel(modelDir);

    assert.strictEqual(result.supported, true);
    assert.strictEqual(result.modelId, "qwen2.5-vl-3b-gguf");
    assert.strictEqual(result.displayName, "Qwen2.5-VL 3B");
    assert.strictEqual(result.provider, "llama-server");
    assert.strictEqual(result.modelFamily, "qwen-vl");
    assert.strictEqual(result.modelPath, path.join(modelDir, "model.gguf"));
    assert.strictEqual(result.mmprojPath, path.join(modelDir, "mmproj.gguf"));
    assert.strictEqual(result.contextSize, 16384);
    assert.strictEqual(result.recommendedMaxTokens, 2048);
    assert.deepStrictEqual(result.capabilities, ["vision", "chat", "receipt-extraction"]);
    assert.deepStrictEqual(result.runtimeArgs, ["--flash-attn"]);
    assert.deepStrictEqual(result.errors, []);
  });

  await test("validation alias returns inspection result", async function() {
    const { modelDir } = createValidFixture();
    const result = await validateGGUFVisionModelDirectory(modelDir);

    assert.strictEqual(result.supported, true);
    assert.strictEqual(result.modelId, "qwen2.5-vl-3b-gguf");
  });

  await test("missing manifest", async function() {
    const modelDir = createTempModelDirectory();
    const result = await inspectGGUFVisionModel(modelDir);

    assert.strictEqual(result.supported, false);
    assert.ok(result.errors.includes("No model manifest found."));
  });

  await test("missing model file", async function() {
    const { modelDir } = createValidFixture();
    fs.unlinkSync(path.join(modelDir, "model.gguf"));

    const result = await inspectGGUFVisionModel(modelDir);

    assert.strictEqual(result.supported, false);
    assert.ok(result.errors.some((error) => error.includes("modelFile does not exist")));
  });

  await test("missing mmproj file", async function() {
    const { modelDir } = createValidFixture();
    fs.unlinkSync(path.join(modelDir, "mmproj.gguf"));

    const result = await inspectGGUFVisionModel(modelDir);

    assert.strictEqual(result.supported, false);
    assert.ok(result.errors.some((error) => error.includes("mmprojFile does not exist")));
  });

  await test("invalid context size", async function() {
    const { modelDir } = createValidFixture({ contextSize: 0 });
    const result = await inspectGGUFVisionModel(modelDir);

    assert.strictEqual(result.supported, false);
    assert.ok(result.errors.includes("contextSize must be a positive safe integer."));
  });

  await test("missing required fields", async function() {
    const modelDir = createTempModelDirectory();
    writeJson(path.join(modelDir, "local-ai.json"), {
      id: "incomplete",
      provider: "llama-server",
    });

    const result = await inspectGGUFVisionModel(modelDir);

    assert.strictEqual(result.supported, false);
    assert.ok(result.errors.includes("Missing required manifest field: displayName."));
    assert.ok(result.errors.includes("Missing required manifest field: modelFile."));
    assert.ok(result.errors.includes("Missing required manifest field: mmprojFile."));
  });

  await test("unsupported capabilities", async function() {
    const { modelDir } = createValidFixture({ capabilities: ["audio"] });
    const result = await inspectGGUFVisionModel(modelDir);

    assert.strictEqual(result.supported, false);
    assert.ok(result.errors.includes("capabilities must include vision or an equivalent vision capability."));
    assert.ok(result.errors.includes("capabilities must include chat or an equivalent chat capability."));
  });

  await test("capability equivalents are accepted", async function() {
    const { modelDir } = createValidFixture({ capabilities: ["image-to-text", "conversation"] });
    const result = await inspectGGUFVisionModel(modelDir);

    assert.strictEqual(result.supported, true);
    assert.deepStrictEqual(result.errors, []);
  });

  await test("path traversal is rejected", async function() {
    const modelDir = createTempModelDirectory();
    writeJson(path.join(modelDir, "local-ai.json"), {
      id: "bad-paths",
      displayName: "Bad Paths",
      provider: "llama-server",
      modelFamily: "qwen-vl",
      modelFile: "../model.gguf",
      mmprojFile: "../mmproj.gguf",
      contextSize: 16384,
      recommendedMaxTokens: 2048,
      capabilities: ["vision", "chat"],
    });

    const result = await inspectGGUFVisionModel(modelDir);

    assert.strictEqual(result.supported, false);
    assert.ok(result.errors.includes("modelFile must resolve inside the model directory."));
    assert.ok(result.errors.includes("mmprojFile must resolve inside the model directory."));
  });

  await test("non-GGUF files are rejected", async function() {
    const modelDir = createTempModelDirectory();
    touch(path.join(modelDir, "model.bin"));
    touch(path.join(modelDir, "mmproj.bin"));
    writeJson(path.join(modelDir, "local-ai.json"), {
      id: "bad-extension",
      displayName: "Bad Extension",
      provider: "llama-server",
      modelFamily: "qwen-vl",
      modelFile: "model.bin",
      mmprojFile: "mmproj.bin",
      contextSize: 16384,
      recommendedMaxTokens: 2048,
      capabilities: ["vision", "chat"],
    });

    const result = await inspectGGUFVisionModel(modelDir);

    assert.strictEqual(result.supported, false);
    assert.ok(result.errors.includes("modelFile must reference a .gguf file."));
    assert.ok(result.errors.includes("mmprojFile must reference a .gguf file."));
  });

  await test("static no provider OCR UI database runtime launch or receipt workflow imports", async function() {
    const source = fs.readFileSync(
      path.join(__dirname, "local-ai", "GGUFVisionModelManifest.js"),
      "utf8"
    );
    const forbidden = [
      "OpenAICompatibleReceiptVisionProvider",
      "ReceiptVisionProvider",
      "ReceiptIntelligenceService",
      "ReceiptProcessingPipeline",
      "LocalAIRuntimeManager",
      "child_process",
      "spawn",
      "onScanReceipt",
      "parseTextForStore",
      "addReceipt",
      "updateReceiptRecord",
      "document.",
      "window.",
      "ipcMain",
    ];

    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `manifest helper should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("GGUF vision model manifest summaries:");
  for (const summary of summaries) {
    console.log(`- ${summary}`);
  }
}

run().catch((error) => {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
