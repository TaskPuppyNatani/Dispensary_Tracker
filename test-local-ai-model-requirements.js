"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  calculateModelStorageRequirements,
  evaluateModelCompatibility,
  evaluateRegisteredModelCompatibility,
} = require("./local-ai/LocalAIModelRequirements.js");

const FIXTURE_MODEL = {
  modelId: "fixture-qwen-vl",
  download: { modelBytes: 1000, mmprojBytes: 200 },
  storage: { installedBytes: 1200, temporaryDownloadBytes: 1200, safetyBufferBytes: 100 },
  memory: { minimumRamBytes: 400, recommendedRamBytes: 800, minimumVramBytes: 300, recommendedVramBytes: 600 },
  cpuSupported: true,
};

function systemProfile(overrides = {}) {
  return {
    totalRamBytes: 800,
    availableRamBytes: 800,
    freeDiskBytes: 3000,
    gpuDetected: false,
    vramBytes: 0,
    gpuRuntimeCompatible: false,
    ...overrides,
  };
}

function run() {
  const summaries = [];
  const test = (name, fn) => { fn(); summaries.push(name); };

  test("storage calculation sums model and mmproj without double-counting temporary overhead", () => {
    const result = calculateModelStorageRequirements(FIXTURE_MODEL);
    assert.deepStrictEqual(result, {
      modelDownloadBytes: 1000,
      mmprojDownloadBytes: 200,
      totalDownloadBytes: 1200,
      installedBytes: 1200,
      temporaryDownloadBytes: 1200,
      safetyBufferBytes: 100,
      requiredFreeDiskBytes: 2500,
    });
  });

  test("exact minimum RAM supports CPU execution", () => {
    const result = evaluateModelCompatibility(FIXTURE_MODEL, systemProfile({ availableRamBytes: 400 }));
    assert.strictEqual(result.canRunMinimum, true);
    assert.strictEqual(result.compatible, true);
    assert.strictEqual(result.suggestedMode, "cpu");
    assert.strictEqual(result.ram.status, "sufficient");
  });

  test("below minimum RAM is unsupported", () => {
    const result = evaluateModelCompatibility(FIXTURE_MODEL, systemProfile({ availableRamBytes: 399 }));
    assert.strictEqual(result.canRunMinimum, false);
    assert.strictEqual(result.suggestedMode, "unsupported");
    assert.ok(result.blockers.some((blocker) => blocker.includes("RAM")));
  });

  test("recommended RAM is identified", () => {
    const result = evaluateModelCompatibility(FIXTURE_MODEL, systemProfile({ availableRamBytes: 800 }));
    assert.strictEqual(result.ram.status, "recommended");
    assert.strictEqual(result.meetsRecommended, true);
  });

  test("no GPU uses CPU for a CPU-supported model", () => {
    const result = evaluateModelCompatibility(FIXTURE_MODEL, systemProfile());
    assert.strictEqual(result.suggestedMode, "cpu");
  });

  test("insufficient VRAM falls back to CPU", () => {
    const result = evaluateModelCompatibility(FIXTURE_MODEL, systemProfile({
      gpuDetected: true,
      gpuRuntimeCompatible: true,
      vramBytes: 299,
    }));
    assert.strictEqual(result.suggestedMode, "cpu");
    assert.ok(result.warnings.some((warning) => warning.includes("VRAM")));
  });

  test("sufficient compatible VRAM chooses GPU and recommended VRAM is recognized", () => {
    const result = evaluateModelCompatibility(FIXTURE_MODEL, systemProfile({
      gpuDetected: true,
      gpuRuntimeCompatible: true,
      vramBytes: 600,
    }));
    assert.strictEqual(result.suggestedMode, "gpu");
    assert.strictEqual(result.vram.status, "recommended");
  });

  test("insufficient disk prevents overall compatibility", () => {
    const result = evaluateModelCompatibility(FIXTURE_MODEL, systemProfile({ freeDiskBytes: 2499 }));
    assert.strictEqual(result.compatible, false);
    assert.strictEqual(result.disk.status, "insufficient");
  });

  test("GPU is not assumed compatible from VRAM alone", () => {
    const gpuOnlyModel = { ...FIXTURE_MODEL, cpuSupported: false };
    const result = evaluateModelCompatibility(gpuOnlyModel, systemProfile({
      gpuDetected: true,
      gpuRuntimeCompatible: false,
      vramBytes: 600,
    }));
    assert.strictEqual(result.suggestedMode, "unsupported");
    assert.ok(result.blockers.some((blocker) => blocker.includes("compatible GPU runtime")));
  });

  test("registered catalog entries evaluate while custom models remain accepted", () => {
    const catalogModel = { ...FIXTURE_MODEL };
    const catalogResult = evaluateRegisteredModelCompatibility(
      { supported: true, modelId: "fixture-qwen-vl" },
      systemProfile(),
      [catalogModel]
    );
    const customResult = evaluateRegisteredModelCompatibility(
      { supported: true, modelId: "custom-model" },
      systemProfile(),
      [catalogModel]
    );
    assert.strictEqual(catalogResult.kind, "catalog");
    assert.strictEqual(catalogResult.compatibility.compatible, true);
    assert.strictEqual(customResult.kind, "custom");
    assert.strictEqual(customResult.compatibility, null);
  });

  test("requirements helper is isolated from UI, providers, runtime launch, database, OCR, and OS detection", () => {
    const source = fs.readFileSync(path.join(__dirname, "local-ai", "LocalAIModelRequirements.js"), "utf8");
    const forbidden = [
      "ReceiptVisionProvider", "OpenAICompatibleReceiptVisionProvider", "LocalAIRuntimeManager",
      "ManagedOpenAICompatibleSupport", "document.", "window.", "ipcMain", "ipcRenderer",
      "child_process", "spawn", "parseTextForStore", "addReceipt", "updateReceiptRecord",
      "system_profiler", "WMIC", "lspci", "PowerShell",
    ];
    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `requirements should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Local AI model requirements summaries:");
  for (const summary of summaries) console.log(`- ${summary}`);
}

try { run(); } catch (error) {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
}
