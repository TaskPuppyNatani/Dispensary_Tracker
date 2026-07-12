"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
  PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
  resolveLocalAIProviderMode,
  buildOpenAICompatibleProviderOptions,
  readManagedRuntimeEnvironment,
  buildManagedRuntimeOptions,
  managedRuntimeNeedsRestart,
  ensureManagedOpenAICompatibleRuntime,
  stopManagedRuntime,
} = require("./local-ai/ManagedOpenAICompatibleSupport.js");

function makeSettings() {
  return {
    openAICompatibleBaseUrl: "http://localhost:1234/v1/chat/completions",
    openAICompatibleModel: "lm-studio-model",
    openAICompatibleTimeoutMs: 120000,
    openAICompatibleTemperature: 0,
    openAICompatibleMaxNewTokens: 2048,
  };
}

function makeInspection(overrides = {}) {
  return {
    supported: true,
    modelId: "qwen2.5-vl-3b-gguf",
    displayName: "Qwen2.5-VL 3B",
    modelPath: "C:/models/qwen/model.gguf",
    mmprojPath: "C:/models/qwen/mmproj.gguf",
    contextSize: 16384,
    recommendedMaxTokens: 2048,
    capabilities: ["vision", "chat", "receipt-extraction"],
    warnings: [],
    errors: [],
    ...overrides,
  };
}

function makeValidRuntimeValidation() {
  return {
    valid: true,
    executablePath: "C:/tools/llama-server.exe",
    platform: "win32",
    exists: true,
    executable: true,
    reason: null,
    warnings: [],
  };
}

function createRuntimeManager(overrides = {}) {
  const calls = {
    start: [],
    restart: [],
    stop: 0,
  };
  const state = {
    status: {
      running: false,
      ready: false,
      executablePath: "",
      modelPath: "",
      mmprojPath: "",
      ctxSize: null,
      gpuLayers: null,
      chatCompletionsUrl: "",
      logs: [],
      lastError: null,
    },
  };

  const runtimeManager = {
    start: async (options) => {
      calls.start.push(options);
      state.status = {
        ...state.status,
        ...options,
        running: true,
        ready: true,
        chatCompletionsUrl: "http://127.0.0.1:34567/v1/chat/completions",
        logs: [{ stream: "stdout", message: "ready" }],
        lastError: null,
      };
      return state.status;
    },
    restart: async (options) => {
      calls.restart.push(options);
      state.status = {
        ...state.status,
        ...options,
        running: true,
        ready: true,
        chatCompletionsUrl: "http://127.0.0.1:34568/v1/chat/completions",
        logs: [{ stream: "stdout", message: "restarted" }],
        lastError: null,
      };
      return state.status;
    },
    stop: async () => {
      calls.stop += 1;
      state.status = {
        ...state.status,
        running: false,
        ready: false,
      };
      return state.status;
    },
    isRunning: () => Boolean(state.status.running),
    getStatus: () => ({ ...state.status }),
    ...overrides,
  };

  return { runtimeManager, calls, state };
}

async function run() {
  const summaries = [];

  async function test(name, fn) {
    await fn();
    summaries.push(name);
  }

  await test("external mode remains unchanged by default", async function() {
    assert.strictEqual(resolveLocalAIProviderMode({}), PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE);

    const options = buildOpenAICompatibleProviderOptions(makeSettings());
    assert.deepStrictEqual(options, {
      baseUrl: "http://localhost:1234/v1/chat/completions",
      model: "lm-studio-model",
      timeoutMs: 120000,
      temperature: 0,
      defaultMaxNewTokens: 2048,
    });
  });

  await test("managed mode validates manifest and constructs runtime config", async function() {
    const env = {
      LOCAL_AI_PROVIDER_MODE: PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
      LOCAL_AI_LLAMA_SERVER_PATH: "C:/tools/llama-server.exe",
      LOCAL_AI_MODEL_DIR: "C:/models/qwen",
      LOCAL_AI_CTX_SIZE: "32768",
      LOCAL_AI_GPU_LAYERS: "20",
      LOCAL_AI_STARTUP_TIMEOUT_MS: "45000",
    };
    const envConfig = readManagedRuntimeEnvironment(env, {
      app: { isPackaged: false },
      process: {
        platform: "win32",
        arch: "x64",
      },
      baseDirectory: "C:/repo",
    });
    const inspection = makeInspection();
    const runtimeOptions = buildManagedRuntimeOptions({ envConfig, inspection });

    assert.deepStrictEqual(runtimeOptions, {
      executablePath: "C:/tools/llama-server.exe",
      modelPath: "C:/models/qwen/model.gguf",
      mmprojPath: "C:/models/qwen/mmproj.gguf",
      ctxSize: 32768,
      gpuLayers: 20,
      startupTimeoutMs: 45000,
    });
    assert.strictEqual(envConfig.executableSource, "env");
    assert.strictEqual(envConfig.executableReason, null);
  });

  await test("managed mode uses runtime endpoint for provider options", async function() {
    const { runtimeManager, calls } = createRuntimeManager();
    const result = await ensureManagedOpenAICompatibleRuntime({
      env: {
        LOCAL_AI_PROVIDER_MODE: PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
        LOCAL_AI_LLAMA_SERVER_PATH: "C:/tools/llama-server.exe",
        LOCAL_AI_MODEL_DIR: "C:/models/qwen",
      },
      localAISettings: makeSettings(),
      runtimeManager,
      inspectModel: async () => makeInspection(),
      validateExecutable: makeValidRuntimeValidation,
      app: { isPackaged: false },
      process: {
        platform: "win32",
        arch: "x64",
      },
      baseDirectory: "C:/repo",
    });

    assert.strictEqual(result.available, true);
    assert.strictEqual(calls.start.length, 1);
    assert.strictEqual(result.providerOptions.baseUrl, "http://127.0.0.1:34567/v1/chat/completions");
    assert.strictEqual(result.providerOptions.model, "qwen2.5-vl-3b-gguf");
    assert.strictEqual(result.providerOptions.defaultMaxNewTokens, 2048);
  });

  await test("validation failure leaves AI unavailable without crashing", async function() {
    const { runtimeManager, calls } = createRuntimeManager();
    const result = await ensureManagedOpenAICompatibleRuntime({
      env: {
        LOCAL_AI_PROVIDER_MODE: PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
        LOCAL_AI_LLAMA_SERVER_PATH: "C:/tools/llama-server.exe",
        LOCAL_AI_MODEL_DIR: "C:/models/qwen",
      },
      localAISettings: makeSettings(),
      runtimeManager,
      inspectModel: async () => makeInspection({
        supported: false,
        errors: ["Manifest invalid."],
      }),
      validateExecutable: makeValidRuntimeValidation,
      app: { isPackaged: false },
      process: {
        platform: "win32",
        arch: "x64",
      },
      baseDirectory: "C:/repo",
    });

    assert.strictEqual(result.available, false);
    assert.strictEqual(result.reason, "Manifest invalid.");
    assert.strictEqual(calls.start.length, 0);
  });

  await test("runtime startup failure leaves AI unavailable without crashing", async function() {
    const { runtimeManager, calls } = createRuntimeManager({
      start: async () => {
        calls.start.push("attempt");
        throw new Error("spawn failed");
      },
      getStatus: () => ({
        running: false,
        ready: false,
        chatCompletionsUrl: "",
        logs: [],
        lastError: "spawn failed",
      }),
    });

    const result = await ensureManagedOpenAICompatibleRuntime({
      env: {
        LOCAL_AI_PROVIDER_MODE: PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
        LOCAL_AI_LLAMA_SERVER_PATH: "C:/tools/llama-server.exe",
        LOCAL_AI_MODEL_DIR: "C:/models/qwen",
      },
      localAISettings: makeSettings(),
      runtimeManager,
      inspectModel: async () => makeInspection(),
      validateExecutable: makeValidRuntimeValidation,
      app: { isPackaged: false },
      process: {
        platform: "win32",
        arch: "x64",
      },
      baseDirectory: "C:/repo",
    });

    assert.strictEqual(result.available, false);
    assert.strictEqual(result.reason, "spawn failed");
    assert.strictEqual(calls.start.length, 1);
  });

  await test("runtime restart is triggered when managed config changes", async function() {
    const { runtimeManager, calls, state } = createRuntimeManager();
    state.status = {
      running: true,
      ready: true,
      executablePath: "C:/tools/llama-server.exe",
      modelPath: "C:/old/model.gguf",
      mmprojPath: "C:/old/mmproj.gguf",
      ctxSize: 16384,
      gpuLayers: null,
      chatCompletionsUrl: "http://127.0.0.1:34560/v1/chat/completions",
      logs: [],
      lastError: null,
    };

    const result = await ensureManagedOpenAICompatibleRuntime({
      env: {
        LOCAL_AI_PROVIDER_MODE: PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
        LOCAL_AI_LLAMA_SERVER_PATH: "C:/tools/llama-server.exe",
        LOCAL_AI_MODEL_DIR: "C:/models/qwen",
      },
      localAISettings: makeSettings(),
      runtimeManager,
      inspectModel: async () => makeInspection(),
      validateExecutable: makeValidRuntimeValidation,
      app: { isPackaged: false },
      process: {
        platform: "win32",
        arch: "x64",
      },
      baseDirectory: "C:/repo",
    });

    assert.strictEqual(result.available, true);
    assert.strictEqual(calls.restart.length, 1);
    assert.strictEqual(calls.start.length, 0);
    assert.strictEqual(result.providerOptions.baseUrl, "http://127.0.0.1:34568/v1/chat/completions");
  });

  await test("packaged runtime path is used when env override is absent", async function() {
    const { runtimeManager, calls } = createRuntimeManager();
    const result = await ensureManagedOpenAICompatibleRuntime({
      env: {
        LOCAL_AI_PROVIDER_MODE: PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
        LOCAL_AI_MODEL_DIR: "C:/models/qwen",
      },
      localAISettings: makeSettings(),
      runtimeManager,
      inspectModel: async () => makeInspection(),
      validateExecutable: makeValidRuntimeValidation,
      app: { isPackaged: true },
      process: {
        platform: "win32",
        arch: "x64",
        resourcesPath: "C:/Program Files/Dispensary Tracker/resources",
      },
      baseDirectory: "C:/repo",
    });

    assert.strictEqual(result.available, true);
    assert.strictEqual(calls.start.length, 1);
    assert.strictEqual(
      calls.start[0].executablePath,
      path.resolve(
        "C:/Program Files/Dispensary Tracker/resources",
        "local-ai-runtime",
        "win32",
        "x64",
        "llama-server.exe"
      )
    );
    assert.strictEqual(result.envConfig.executableSource, "packaged");
  });

  await test("missing executable resolution leaves AI unavailable without crashing", async function() {
    const { runtimeManager, calls } = createRuntimeManager();
    const result = await ensureManagedOpenAICompatibleRuntime({
      env: {
        LOCAL_AI_PROVIDER_MODE: PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
        LOCAL_AI_MODEL_DIR: "C:/models/qwen",
      },
      localAISettings: makeSettings(),
      runtimeManager,
      inspectModel: async () => makeInspection(),
      app: { isPackaged: true },
      process: {
        platform: "linux",
        arch: "x64",
        resourcesPath: "",
      },
      baseDirectory: "C:/repo",
    });

    assert.strictEqual(result.available, false);
    assert.strictEqual(result.reason, "process.resourcesPath is unavailable.");
    assert.strictEqual(calls.start.length, 0);
    assert.strictEqual(result.envConfig.executableSource, "packaged");
  });

  await test("invalid executable leaves AI unavailable before manifest inspection or runtime start", async function() {
    const { runtimeManager, calls } = createRuntimeManager();
    let manifestInspectionCalls = 0;
    const result = await ensureManagedOpenAICompatibleRuntime({
      env: {
        LOCAL_AI_PROVIDER_MODE: PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
        LOCAL_AI_LLAMA_SERVER_PATH: "C:/missing/llama-server.exe",
        LOCAL_AI_MODEL_DIR: "C:/models/qwen",
      },
      localAISettings: makeSettings(),
      runtimeManager,
      inspectModel: async () => {
        manifestInspectionCalls += 1;
        return makeInspection();
      },
      validateExecutable: () => ({
        valid: false,
        executablePath: "C:/missing/llama-server.exe",
        platform: "win32",
        exists: false,
        executable: false,
        reason: "Managed llama-server executable does not exist: C:/missing/llama-server.exe",
        warnings: [],
      }),
      app: { isPackaged: false },
      process: {
        platform: "win32",
        arch: "x64",
      },
      baseDirectory: "C:/repo",
    });

    assert.strictEqual(result.available, false);
    assert.strictEqual(result.reason, "Managed llama-server executable does not exist: C:/missing/llama-server.exe");
    assert.strictEqual(result.runtimeValidation.exists, false);
    assert.strictEqual(manifestInspectionCalls, 0);
    assert.strictEqual(calls.start.length, 0);
    assert.strictEqual(calls.restart.length, 0);
  });

  await test("app shutdown helper stops managed runtime only when running", async function() {
    const { runtimeManager, calls, state } = createRuntimeManager();
    state.status.running = true;
    state.status.ready = true;
    await stopManagedRuntime(runtimeManager);
    await stopManagedRuntime(runtimeManager);

    assert.strictEqual(calls.stop, 1);
  });

  await test("renderer does not import runtime manager or manifest helper", async function() {
    const rendererFiles = [
      path.join(__dirname, "js", "app.js"),
      path.join(__dirname, "js", "state.js"),
      path.join(__dirname, "preload.js"),
    ];
    const forbidden = [
      "LocalAIRuntimeManager",
      "ManagedOpenAICompatibleSupport",
      "GGUFVisionModelManifest",
    ];

    for (const filePath of rendererFiles) {
      const source = fs.readFileSync(filePath, "utf8");
      for (const term of forbidden) {
        assert.strictEqual(source.includes(term), false, `${path.basename(filePath)} should not reference ${term}`);
      }
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Managed runtime provider wiring summaries:");
  for (const summary of summaries) {
    console.log(`- ${summary}`);
  }
}

run().catch((error) => {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
