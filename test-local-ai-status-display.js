"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function loadStatusDisplay() {
  return await import("./js/services/LocalAIStatusDisplay.js");
}

async function run() {
  const { buildLocalAIStatusDisplay } = await loadStatusDisplay();
  const summaries = [];

  function test(name, fn) {
    fn();
    summaries.push(name);
  }

  test("managed runtime ready", function() {
    const display = buildLocalAIStatusDisplay({
      available: true,
      initialized: true,
      providerMode: "managed-openai-compatible",
      backend: "managed-openai-compatible",
      displayName: "Qwen2.5-VL 3B",
      modelId: "qwen2.5-vl-3b-gguf",
      endpointUrl: "http://127.0.0.1:12345/v1/chat/completions",
      managedRuntimeStatus: {
        status: "ready",
        health: { available: true },
      },
      runtimeLogs: [
        { at: "2026-07-06T12:00:00.000Z", stream: "stdout", message: "ready" },
      ],
    });

    assert.deepStrictEqual(display.rows, [
      { label: "Provider Mode", value: "Managed Runtime" },
      { label: "Status", value: "Ready" },
      { label: "Runtime", value: "llama-server" },
      { label: "Model", value: "Qwen2.5-VL 3B" },
      { label: "Model ID", value: "qwen2.5-vl-3b-gguf" },
      { label: "Endpoint", value: "http://127.0.0.1:12345/v1/chat/completions" },
      { label: "Health", value: "Healthy" },
    ]);
    assert.strictEqual(display.showReason, false);
    assert.strictEqual(display.showWarnings, false);
    assert.strictEqual(display.showLogs, true);
    assert.deepStrictEqual(display.recentLogs, [
      "2026-07-06T12:00:00.000Z stdout ready",
    ]);
  });

  test("managed runtime unavailable missing model", function() {
    const display = buildLocalAIStatusDisplay({
      available: false,
      initialized: false,
      providerMode: "managed-openai-compatible",
      backend: "managed-openai-compatible",
      reason: "Managed GGUF vision model is invalid.",
      managedRuntimeStatus: {
        status: "idle",
        health: { available: false },
      },
      warnings: ["Manifest field missing."],
    });

    assert.strictEqual(display.rows[0].value, "Managed Runtime");
    assert.strictEqual(display.rows[1].value, "Unavailable");
    assert.strictEqual(display.rows[6].value, "Unavailable");
    assert.strictEqual(display.reason, "Managed GGUF vision model is invalid.");
    assert.deepStrictEqual(display.warnings, ["Manifest field missing."]);
  });

  test("external mode available", function() {
    const display = buildLocalAIStatusDisplay({
      available: true,
      initialized: false,
      providerMode: "external-openai-compatible",
      backend: "openai-compatible",
      modelId: "qwen-vl",
      endpointUrl: "http://localhost:1234/v1/chat/completions",
    });

    assert.strictEqual(display.rows[0].value, "External LM Studio");
    assert.strictEqual(display.rows[1].value, "Ready");
    assert.strictEqual(display.rows[2].value, "External OpenAI-compatible server");
    assert.strictEqual(display.rows[6].value, "Healthy");
    assert.strictEqual(display.showLogs, false);
  });

  test("startup failure is reported as failed", function() {
    const display = buildLocalAIStatusDisplay({
      available: false,
      initialized: false,
      providerMode: "managed-openai-compatible",
      reason: "spawn failed",
      managedRuntimeStatus: {
        status: "error",
        lastError: "spawn failed",
        health: { available: false },
      },
      runtimeLogs: [
        { at: "2026-07-06T12:00:00.000Z", stream: "stderr", message: "spawn failed" },
      ],
    });

    assert.strictEqual(display.rows[1].value, "Failed");
    assert.strictEqual(display.reason, "spawn failed");
    assert.strictEqual(display.showLogs, true);
  });

  test("recent logs are truncated to the last twenty entries", function() {
    const logs = Array.from({ length: 25 }, (_, index) => ({
      at: `2026-07-06T12:00:${String(index).padStart(2, "0")}.000Z`,
      stream: "stdout",
      message: `line-${index}`,
    }));
    const display = buildLocalAIStatusDisplay({
      available: true,
      providerMode: "managed-openai-compatible",
      runtimeLogs: logs,
    });

    assert.strictEqual(display.recentLogs.length, 20);
    assert.strictEqual(display.recentLogs[0], "2026-07-06T12:00:05.000Z stdout line-5");
    assert.strictEqual(display.recentLogs[19], "2026-07-06T12:00:24.000Z stdout line-24");
  });

  test("static no side-effect imports or calls", function() {
    const source = fs.readFileSync(
      path.join(__dirname, "js", "services", "LocalAIStatusDisplay.js"),
      "utf8"
    );
    const forbidden = [
      "ReceiptVisionProvider",
      "OpenAICompatibleReceiptVisionProvider",
      "LocalAIRuntimeManager",
      "GGUFVisionModelManifest",
      "ReceiptIntelligenceService",
      "OnnxVisionRuntime",
      "ReceiptProcessingPipeline",
      "document.",
      "window.",
      "localStorage",
      "ipcRenderer",
      "fetch(",
    ];

    assert.strictEqual(source.includes("import "), false);
    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `status display helper should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Local AI status display summaries:");
  for (const summary of summaries) {
    console.log(`- ${summary}`);
  }
}

run().catch((error) => {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
