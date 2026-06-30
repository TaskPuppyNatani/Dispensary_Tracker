"use strict";

const path = require("path");
const { VisionRuntime } = require("./VisionRuntime.js");

const ONNX_RUNTIME_STATUS = Object.freeze({
  UNINITIALIZED: "uninitialized",
  READY: "ready",
  MODEL_LOADED: "model-loaded",
  ERROR: "error",
});

const DEFAULT_EXECUTION_PROVIDERS = Object.freeze(["default"]);
const ONNX_BACKEND_NAME = "onnxruntime-node";

/**
 * Inert ONNX runtime foundation.
 *
 * This class satisfies the VisionRuntime contract without importing ONNX
 * Runtime, loading models, creating sessions, or performing inference.
 */
class OnnxVisionRuntime extends VisionRuntime {
  constructor(options = {}) {
    super({ name: options.name || "OnnxVisionRuntime" });
    this.initialized = false;
    this.status = ONNX_RUNTIME_STATUS.UNINITIALIZED;
    this.onnxRuntime = null;
    this.backendAvailable = false;
    this.backendError = "";
    this.executionProviders = normalizeExecutionProviders(options.executionProviders);
    this.sessions = createEmptySessions();
    this.modelLoaded = false;
    this.loadedModelId = "";
    this.sessionLoadError = "";
    this.lastSessionLoadMs = 0;
  }

  async initialize(options = {}) {
    this.executionProviders = normalizeExecutionProviders(options.executionProviders, this.executionProviders);

    try {
      const onnxRuntime = require(ONNX_BACKEND_NAME);
      assertOnnxRuntimeBackend(onnxRuntime);

      this.onnxRuntime = onnxRuntime;
      this.backendAvailable = true;
      this.backendError = "";
      this.initialized = true;
      this.status = ONNX_RUNTIME_STATUS.READY;
      return this.getStatus();
    } catch (error) {
      this.onnxRuntime = null;
      this.backendAvailable = false;
      this.backendError = getErrorMessage(error);
      this.initialized = false;
      this.status = ONNX_RUNTIME_STATUS.ERROR;
      throw error;
    }
  }

  async shutdown() {
    this._clearSessions();
    this.onnxRuntime = null;
    this.backendAvailable = false;
    this.backendError = "";
    this.executionProviders = Array.from(DEFAULT_EXECUTION_PROVIDERS);
    this.initialized = false;
    this.status = ONNX_RUNTIME_STATUS.UNINITIALIZED;
    return this.getStatus();
  }

  getStatus() {
    return {
      name: this.name,
      runtimeType: "onnx",
      initialized: this.initialized,
      status: this.status,
      backend: ONNX_BACKEND_NAME,
      backendAvailable: this.backendAvailable,
      executionProviders: Array.from(this.executionProviders),
      modelLoaded: this.modelLoaded,
      loadedModelId: this.loadedModelId,
      sessionsLoaded: {
        visionEncoder: Boolean(this.sessions.visionEncoder),
        embedTokens: Boolean(this.sessions.embedTokens),
        decoder: Boolean(this.sessions.decoder),
      },
      sessionCount: countLoadedSessions(this.sessions),
      lastSessionLoadMs: this.lastSessionLoadMs,
      ...(this.backendError ? { backendError: this.backendError } : {}),
      ...(this.sessionLoadError ? { sessionLoadError: this.sessionLoadError } : {}),
    };
  }

  isInitialized() {
    return this.initialized;
  }

  supportsModel(modelMetadata) {
    void modelMetadata;
    return false;
  }

  async loadModel(modelInspection) {
    const startedAt = Date.now();

    try {
      this._assertReadyToLoad();
      const sessionPaths = resolveSessionPaths(modelInspection);
      const sessions = await this._loadSessions(sessionPaths);

      this.sessions = sessions;
      this.loadedModelId = String(modelInspection.modelId || "");
      this.modelLoaded = true;
      this.sessionLoadError = "";
      this.lastSessionLoadMs = Date.now() - startedAt;
      this.status = ONNX_RUNTIME_STATUS.MODEL_LOADED;
      return this.getStatus();
    } catch (error) {
      this._clearSessions();
      this.sessionLoadError = getErrorMessage(error);
      this.lastSessionLoadMs = Date.now() - startedAt;
      this.status = ONNX_RUNTIME_STATUS.ERROR;
      throw error;
    }
  }

  async run(input) {
    void input;
    throwNotImplemented("run");
  }

  async _loadSessions(sessionPaths) {
    return {
      visionEncoder: await this.onnxRuntime.InferenceSession.create(sessionPaths.visionEncoder),
      embedTokens: await this.onnxRuntime.InferenceSession.create(sessionPaths.embedTokens),
      decoder: await this.onnxRuntime.InferenceSession.create(sessionPaths.decoder),
    };
  }

  _assertReadyToLoad() {
    if (!this.initialized || !this.onnxRuntime) {
      throw new Error("OnnxVisionRuntime must be initialized before loading model sessions.");
    }
  }

  _clearSessions() {
    this.sessions = createEmptySessions();
    this.modelLoaded = false;
    this.loadedModelId = "";
    this.sessionLoadError = "";
    this.lastSessionLoadMs = 0;
  }
}

function throwNotImplemented(methodName) {
  throw new Error(`Not Implemented: OnnxVisionRuntime.${methodName} is reserved for a future ONNX integration phase.`);
}

function assertOnnxRuntimeBackend(onnxRuntime) {
  if (!onnxRuntime || typeof onnxRuntime !== "object") {
    throw new Error("ONNX Runtime backend did not load.");
  }

  if (typeof onnxRuntime.InferenceSession !== "function" && typeof onnxRuntime.InferenceSession !== "object") {
    throw new Error("ONNX Runtime backend is missing InferenceSession.");
  }

  if (typeof onnxRuntime.Tensor !== "function") {
    throw new Error("ONNX Runtime backend is missing Tensor.");
  }
}

function normalizeExecutionProviders(value, fallback = DEFAULT_EXECUTION_PROVIDERS) {
  if (!Array.isArray(value)) {
    return Array.from(fallback);
  }

  const providers = value
    .map((provider) => String(provider || "").trim())
    .filter(Boolean);

  return providers.length > 0 ? providers : Array.from(DEFAULT_EXECUTION_PROVIDERS);
}

function createEmptySessions() {
  return {
    visionEncoder: null,
    embedTokens: null,
    decoder: null,
  };
}

function countLoadedSessions(sessions) {
  return [
    sessions && sessions.visionEncoder,
    sessions && sessions.embedTokens,
    sessions && sessions.decoder,
  ].filter(Boolean).length;
}

function resolveSessionPaths(modelInspection) {
  if (!modelInspection || typeof modelInspection !== "object") {
    throw new Error("A model inspection result is required to load ONNX sessions.");
  }

  if (modelInspection.supported !== true) {
    throw new Error("Cannot load ONNX sessions for an unsupported model inspection result.");
  }

  const rawModelPath = String(modelInspection.modelPath || "").trim();
  if (!rawModelPath) {
    throw new Error("Model inspection result is missing modelPath.");
  }
  const modelPath = path.resolve(rawModelPath);

  const onnxFiles = modelInspection.requiredFiles
    && modelInspection.requiredFiles.onnx
    && typeof modelInspection.requiredFiles.onnx === "object"
    ? modelInspection.requiredFiles.onnx
    : {};

  return {
    visionEncoder: resolveModelRelativePath(modelPath, onnxFiles.visionEncoder, "vision encoder"),
    embedTokens: resolveModelRelativePath(modelPath, onnxFiles.embedTokens, "embed tokens"),
    decoder: resolveModelRelativePath(modelPath, onnxFiles.decoder, "decoder"),
  };
}

function resolveModelRelativePath(modelPath, relativePath, label) {
  const normalizedRelativePath = String(relativePath || "").trim();
  if (!normalizedRelativePath) {
    throw new Error(`Model inspection result is missing ${label} ONNX path.`);
  }

  const resolvedPath = path.resolve(modelPath, normalizedRelativePath);
  const relativeToModel = path.relative(modelPath, resolvedPath);
  if (relativeToModel.startsWith("..") || path.isAbsolute(relativeToModel)) {
    throw new Error(`Refusing to load ${label} ONNX path outside the model directory.`);
  }

  return resolvedPath;
}

function getErrorMessage(error) {
  return error && error.message ? String(error.message) : String(error || "Unknown ONNX Runtime initialization error.");
}

module.exports = {
  OnnxVisionRuntime,
  ONNX_RUNTIME_STATUS,
};
