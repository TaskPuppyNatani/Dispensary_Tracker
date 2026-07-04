const assert = require("assert");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");

const { LocalAIRuntimeManager } = require("./local-ai/LocalAIRuntimeManager.js");

class FakeChildProcess extends EventEmitter {
  constructor(pid = 1234) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killSignals = [];
  }

  kill(signal) {
    this.killSignals.push(signal);
    if (signal === "SIGTERM") {
      setTimeout(() => this.emit("exit", 0, null), 0);
    }
    return true;
  }
}

function createManager(overrides = {}) {
  const spawned = [];
  const children = [];
  const manager = new LocalAIRuntimeManager({
    executablePath: "C:/tools/llama-server.exe",
    modelPath: "C:/models/qwen.gguf",
    mmprojPath: "C:/models/mmproj.gguf",
    validatePaths: false,
    startupTimeoutMs: 50,
    healthCheckIntervalMs: 1,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "qwen-vision" }] }),
    }),
    spawn: (executable, args, options) => {
      const child = new FakeChildProcess(4000 + spawned.length);
      spawned.push({ executable, args, options, child });
      children.push(child);
      return child;
    },
    ...overrides,
  });

  return { manager, spawned, children };
}

async function run() {
  const summaries = [];

  async function test(name, fn) {
    await fn();
    summaries.push(name);
  }

  await test("launches llama-server with model mmproj host port and runtime args", async function() {
    const { manager, spawned } = createManager({
      port: 34567,
      ctxSize: 16384,
      gpuLayers: 12,
      extraArgs: ["--no-webui"],
    });

    const status = await manager.start();

    assert.strictEqual(status.ready, true);
    assert.strictEqual(status.port, 34567);
    assert.strictEqual(status.chatCompletionsUrl, "http://127.0.0.1:34567/v1/chat/completions");
    assert.strictEqual(spawned.length, 1);
    assert.strictEqual(spawned[0].executable, path.resolve("C:/tools/llama-server.exe"));
    assert.deepStrictEqual(spawned[0].args, [
      "-m",
      path.resolve("C:/models/qwen.gguf"),
      "--mmproj",
      path.resolve("C:/models/mmproj.gguf"),
      "--host",
      "127.0.0.1",
      "--port",
      "34567",
      "--ctx-size",
      "16384",
      "--gpu-layers",
      "12",
      "--no-webui",
    ]);
    assert.strictEqual(spawned[0].options.windowsHide, true);
  });

  await test("selects a free localhost port when no port is configured", async function() {
    const { manager, spawned } = createManager({ port: 0 });

    const status = await manager.start();
    const portIndex = spawned[0].args.indexOf("--port") + 1;
    const selectedPort = Number(spawned[0].args[portIndex]);

    assert.strictEqual(status.ready, true);
    assert.ok(Number.isSafeInteger(selectedPort));
    assert.ok(selectedPort > 0);
    assert.strictEqual(status.port, selectedPort);
  });

  await test("health timeout reports startup failure and stops child", async function() {
    const { manager, spawned } = createManager({
      startupTimeoutMs: 5,
      fetch: async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      }),
    });

    await assert.rejects(
      () => manager.start(),
      /health check timed out|HTTP 503/
    );

    assert.strictEqual(spawned.length, 1);
    assert.deepStrictEqual(spawned[0].child.killSignals, ["SIGTERM"]);
    assert.strictEqual(manager.getStatus().status, "error");
  });

  await test("captures bounded runtime logs", async function() {
    const { manager, children } = createManager({ logLimit: 2 });
    await manager.start();

    children[0].stdout.emit("data", "one\ntwo\n");
    children[0].stderr.emit("data", "three\n");

    assert.deepStrictEqual(
      manager.getLogs().map((entry) => `${entry.stream}:${entry.message}`),
      ["stdout:two", "stderr:three"]
    );
  });

  await test("stop terminates running process and is idempotent", async function() {
    const { manager, children } = createManager();
    await manager.start();

    const stopped = await manager.stop();
    const stoppedAgain = await manager.stop();

    assert.strictEqual(stopped.status, "stopped");
    assert.strictEqual(stoppedAgain.status, "stopped");
    assert.deepStrictEqual(children[0].killSignals, ["SIGTERM"]);
  });

  await test("missing executable fails before spawn when path validation is enabled", async function() {
    let spawnCalled = false;
    const manager = new LocalAIRuntimeManager({
      executablePath: "C:/missing/llama-server.exe",
      modelPath: "C:/models/qwen.gguf",
      mmprojPath: "C:/models/mmproj.gguf",
      spawn: () => {
        spawnCalled = true;
        return new FakeChildProcess();
      },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
    });

    await assert.rejects(
      () => manager.start(),
      /executablePath does not exist/
    );
    assert.strictEqual(spawnCalled, false);
  });

  await test("status exposes health process exit and URLs", async function() {
    const { manager, children } = createManager({ port: 45678 });
    await manager.start();
    children[0].stderr.emit("data", "server ready\n");

    const status = manager.getStatus();

    assert.strictEqual(status.backend, undefined);
    assert.strictEqual(status.ready, true);
    assert.strictEqual(status.modelsUrl, "http://127.0.0.1:45678/v1/models");
    assert.deepStrictEqual(status.health.models, ["qwen-vision"]);
    assert.strictEqual(status.logs.length, 1);
  });

  await test("static no provider OCR UI database or review imports", async function() {
    const source = fs.readFileSync(
      path.join(__dirname, "local-ai", "LocalAIRuntimeManager.js"),
      "utf8"
    );
    const forbidden = [
      "OpenAICompatibleReceiptVisionProvider",
      "ReceiptVisionProvider",
      "ReceiptIntelligenceService",
      "ReceiptProcessingPipeline",
      "onScanReceipt",
      "parseTextForStore",
      "addReceipt",
      "updateReceiptRecord",
      "document.",
      "window.",
      "ipcMain",
    ];

    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `runtime manager should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Local AI runtime manager summaries:");
  for (const summary of summaries) {
    console.log(`- ${summary}`);
  }
}

run().catch((error) => {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
