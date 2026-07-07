"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  resolvePackagedLlamaServerPath,
  resolveManagedRuntimeExecutablePath,
} = require("./local-ai/LocalAIRuntimePaths.js");

async function run() {
  const summaries = [];

  function test(name, fn) {
    fn();
    summaries.push(name);
  }

  test("env override path wins over packaged and development candidates", function() {
    const result = resolveManagedRuntimeExecutablePath({
      env: {
        LOCAL_AI_LLAMA_SERVER_PATH: "C:/custom/llama-server.exe",
      },
      app: { isPackaged: true },
      process: {
        platform: "win32",
        arch: "x64",
        resourcesPath: "C:/Program Files/Dispensary Tracker/resources",
      },
      baseDirectory: "C:/repo",
    });

    assert.deepStrictEqual(result, {
      found: true,
      source: "env",
      executablePath: "C:/custom/llama-server.exe",
      reason: null,
      platform: "win32",
      arch: "x64",
    });
  });

  test("packaged windows path resolves to resources path exe", function() {
    const result = resolveManagedRuntimeExecutablePath({
      env: {},
      app: { isPackaged: true },
      process: {
        platform: "win32",
        arch: "x64",
        resourcesPath: "C:/Program Files/Dispensary Tracker/resources",
      },
    });

    assert.strictEqual(
      result.executablePath,
      path.resolve(
        "C:/Program Files/Dispensary Tracker/resources",
        "local-ai-runtime",
        "win32",
        "x64",
        "llama-server.exe"
      )
    );
    assert.strictEqual(result.source, "packaged");
  });

  test("packaged macos and linux paths resolve without exe suffix", function() {
    const macResult = resolveManagedRuntimeExecutablePath({
      env: {},
      app: { isPackaged: true },
      process: {
        platform: "darwin",
        arch: "arm64",
        resourcesPath: "/Applications/Dispensary Tracker.app/Contents/Resources",
      },
    });
    const linuxResult = resolveManagedRuntimeExecutablePath({
      env: {},
      app: { isPackaged: true },
      process: {
        platform: "linux",
        arch: "x64",
        resourcesPath: "/opt/dispensary-tracker/resources",
      },
    });

    assert.strictEqual(
      macResult.executablePath,
      path.resolve(
        "/Applications/Dispensary Tracker.app/Contents/Resources",
        "local-ai-runtime",
        "darwin",
        "universal",
        "llama-server"
      )
    );
    assert.strictEqual(
      linuxResult.executablePath,
      path.resolve(
        "/opt/dispensary-tracker/resources",
        "local-ai-runtime",
        "linux",
        "x64",
        "llama-server"
      )
    );
  });

  test("unpackaged development path resolves to repo relative runtime location", function() {
    const result = resolveManagedRuntimeExecutablePath({
      env: {},
      app: { isPackaged: false },
      process: {
        platform: "win32",
        arch: "x64",
      },
      baseDirectory: "C:/repo",
    });

    assert.strictEqual(
      result.executablePath,
      path.resolve(
        "C:/repo",
        "resources",
        "local-ai-runtime",
        "win32",
        "x64",
        "llama-server.exe"
      )
    );
    assert.strictEqual(result.source, "development");
  });

  test("missing packaged candidate returns structured unavailable reason", function() {
    const result = resolvePackagedLlamaServerPath({
      app: { isPackaged: true },
      process: {
        platform: "linux",
        arch: "x64",
        resourcesPath: "",
      },
    });

    assert.deepStrictEqual(result, {
      found: false,
      source: "packaged",
      executablePath: "",
      reason: "process.resourcesPath is unavailable.",
      platform: "linux",
      arch: "x64",
    });
  });

  test("static no renderer ui ocr database or provider imports", function() {
    const source = fs.readFileSync(
      path.join(__dirname, "local-ai", "LocalAIRuntimePaths.js"),
      "utf8"
    );
    const forbidden = [
      "ReceiptVisionProvider",
      "OpenAICompatibleReceiptVisionProvider",
      "ReceiptIntelligenceService",
      "OnnxVisionRuntime",
      "document.",
      "window.",
      "localStorage",
      "onScanReceipt",
      "parseTextForStore",
      "addReceipt",
      "updateReceiptRecord",
      "ipcRenderer",
    ];

    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `runtime path helper should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Local AI runtime path summaries:");
  for (const summary of summaries) {
    console.log(`- ${summary}`);
  }
}

run().catch((error) => {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
