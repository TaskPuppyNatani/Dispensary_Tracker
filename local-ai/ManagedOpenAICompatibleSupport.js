"use strict";

const {
  inspectGGUFVisionModel,
} = require("./GGUFVisionModelManifest.js");
const {
  resolveManagedRuntimeExecutablePath,
} = require("./LocalAIRuntimePaths.js");

const PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE = "external-openai-compatible";
const PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE = "managed-openai-compatible";

function resolveLocalAIProviderMode(env = process.env) {
  const rawMode = readString(env.LOCAL_AI_PROVIDER_MODE).toLowerCase();
  return rawMode === PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE
    ? PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE
    : PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE;
}

function buildOpenAICompatibleProviderOptions(localAISettings = {}, overrides = {}) {
  return {
    baseUrl: localAISettings.openAICompatibleBaseUrl,
    model: localAISettings.openAICompatibleModel,
    timeoutMs: localAISettings.openAICompatibleTimeoutMs,
    temperature: localAISettings.openAICompatibleTemperature,
    defaultMaxNewTokens: localAISettings.openAICompatibleMaxNewTokens,
    ...(overrides && typeof overrides === "object" ? overrides : {}),
  };
}

function readManagedRuntimeEnvironment(env = process.env, options = {}) {
  const executableResolution = resolveManagedRuntimeExecutablePath({
    env,
    app: options.app,
    process: options.process,
    path: options.path,
    baseDirectory: options.baseDirectory,
  });

  return {
    providerMode: resolveLocalAIProviderMode(env),
    executablePath: executableResolution.found ? executableResolution.executablePath : "",
    executableSource: executableResolution.source,
    executableReason: executableResolution.reason,
    modelDirectory: readString(env.LOCAL_AI_MODEL_DIR),
    ctxSize: readOptionalPositiveInteger(env.LOCAL_AI_CTX_SIZE, "LOCAL_AI_CTX_SIZE"),
    gpuLayers: readOptionalNonNegativeInteger(env.LOCAL_AI_GPU_LAYERS, "LOCAL_AI_GPU_LAYERS"),
    startupTimeoutMs: readOptionalPositiveInteger(
      env.LOCAL_AI_STARTUP_TIMEOUT_MS,
      "LOCAL_AI_STARTUP_TIMEOUT_MS"
    ),
  };
}

function buildManagedRuntimeOptions({ envConfig = {}, inspection = {} } = {}) {
  if (!readString(envConfig.executablePath)) {
    throw new Error(envConfig.executableReason || "No managed llama-server executable path could be resolved.");
  }

  if (!inspection || inspection.supported !== true) {
    throw new Error("A supported GGUF vision model inspection result is required.");
  }

  return {
    executablePath: envConfig.executablePath,
    modelPath: inspection.modelPath,
    mmprojPath: inspection.mmprojPath,
    ctxSize: envConfig.ctxSize || inspection.contextSize,
    gpuLayers: envConfig.gpuLayers,
    startupTimeoutMs: envConfig.startupTimeoutMs,
  };
}

function managedRuntimeNeedsRestart(runtimeStatus = {}, options = {}) {
  if (!runtimeStatus || !runtimeStatus.running) {
    return false;
  }

  return readString(runtimeStatus.executablePath) !== readString(options.executablePath)
    || readString(runtimeStatus.modelPath) !== readString(options.modelPath)
    || readString(runtimeStatus.mmprojPath) !== readString(options.mmprojPath)
    || readNullableNumber(runtimeStatus.ctxSize) !== readNullableNumber(options.ctxSize)
    || readNullableNumber(runtimeStatus.gpuLayers) !== readNullableNumber(options.gpuLayers);
}

async function ensureManagedOpenAICompatibleRuntime({
  env = process.env,
  localAISettings = {},
  runtimeManager,
  inspectModel = inspectGGUFVisionModel,
  app,
  process: processObject,
  path: pathObject,
  baseDirectory,
} = {}) {
  if (!runtimeManager || typeof runtimeManager.start !== "function" || typeof runtimeManager.getStatus !== "function") {
    throw new Error("A runtimeManager with start() and getStatus() is required.");
  }

  const envConfig = readManagedRuntimeEnvironment(env, {
    app,
    process: processObject,
    path: pathObject,
    baseDirectory,
  });
  if (!envConfig.modelDirectory) {
    return createManagedResult({
      available: false,
      reason: "LOCAL_AI_MODEL_DIR is required for managed-openai-compatible mode.",
      envConfig,
      runtimeStatus: runtimeManager.getStatus(),
    });
  }

  const inspection = await inspectModel(envConfig.modelDirectory);
  if (!inspection.supported) {
    return createManagedResult({
      available: false,
      reason: inspection.errors[0] || "Managed GGUF vision model is invalid.",
      envConfig,
      inspection,
      runtimeStatus: runtimeManager.getStatus(),
      warnings: inspection.warnings,
      errors: inspection.errors,
    });
  }

  let runtimeOptions;
  try {
    runtimeOptions = buildManagedRuntimeOptions({ envConfig, inspection });
  } catch (error) {
    return createManagedResult({
      available: false,
      reason: getErrorMessage(error),
      envConfig,
      inspection,
      runtimeStatus: runtimeManager.getStatus(),
      warnings: inspection.warnings,
      errors: inspection.errors,
    });
  }

  try {
    const currentStatus = runtimeManager.getStatus();
    if (managedRuntimeNeedsRestart(currentStatus, runtimeOptions)) {
      await runtimeManager.restart(runtimeOptions);
    } else {
      await runtimeManager.start(runtimeOptions);
    }
  } catch (error) {
    const runtimeStatus = runtimeManager.getStatus();
    return createManagedResult({
      available: false,
      reason: getErrorMessage(error),
      envConfig,
      inspection,
      runtimeStatus,
      warnings: inspection.warnings,
      errors: inspection.errors,
    });
  }

  const runtimeStatus = runtimeManager.getStatus();
  if (!runtimeStatus.ready) {
    return createManagedResult({
      available: false,
      reason: runtimeStatus.lastError || "Managed Local AI runtime is not ready.",
      envConfig,
      inspection,
      runtimeStatus,
      warnings: inspection.warnings,
      errors: inspection.errors,
    });
  }

  return createManagedResult({
    available: true,
    reason: null,
    envConfig,
    inspection,
    runtimeStatus,
    providerOptions: buildOpenAICompatibleProviderOptions(localAISettings, {
      baseUrl: runtimeStatus.chatCompletionsUrl,
      model: inspection.modelId,
    }),
    warnings: inspection.warnings,
    errors: inspection.errors,
  });
}

function stopManagedRuntime(runtimeManager) {
  if (!runtimeManager || typeof runtimeManager.isRunning !== "function" || typeof runtimeManager.stop !== "function") {
    return Promise.resolve(null);
  }

  if (!runtimeManager.isRunning()) {
    return Promise.resolve(runtimeManager.getStatus ? runtimeManager.getStatus() : null);
  }

  return runtimeManager.stop();
}

function createManagedResult(options = {}) {
  return {
    available: Boolean(options.available),
    reason: options.reason || null,
    envConfig: options.envConfig || {},
    inspection: options.inspection || null,
    runtimeStatus: options.runtimeStatus || null,
    providerOptions: options.providerOptions || null,
    warnings: Array.isArray(options.warnings) ? options.warnings : [],
    errors: Array.isArray(options.errors) ? options.errors : [],
  };
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readOptionalPositiveInteger(value, label) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }

  return normalized;
}

function readOptionalNonNegativeInteger(value, label) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }

  return normalized;
}

function readNullableNumber(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function getErrorMessage(error) {
  return error && error.message ? String(error.message) : String(error);
}

module.exports = {
  PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
  PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
  resolveLocalAIProviderMode,
  buildOpenAICompatibleProviderOptions,
  readManagedRuntimeEnvironment,
  buildManagedRuntimeOptions,
  managedRuntimeNeedsRestart,
  ensureManagedOpenAICompatibleRuntime,
  stopManagedRuntime,
};
