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
const VISION_ENCODER_INPUTS = Object.freeze({
  pixelValues: "pixel_values",
  pixelAttentionMask: "pixel_attention_mask",
});
const VISION_ENCODER_OUTPUT_NAME = "image_features";

/**
 * ONNX runtime foundation.
 *
 * This class satisfies the VisionRuntime contract and owns ONNX Runtime
 * backend/session lifecycle state. Model-specific orchestration stays outside
 * this runtime unless an explicit pipeline stage is added.
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

  async runVisionEncoder(processedImage) {
    this._assertReadyForVisionEncoder();
    const validatedImage = validateProcessedImage(processedImage);
    assertVisionEncoderInputContract(this.sessions.visionEncoder);

    const memoryBefore = getRssMemoryUsage();
    const feeds = this._createVisionEncoderFeeds(validatedImage);
    const startedAt = Date.now();
    const outputs = await this.sessions.visionEncoder.run(feeds);
    const executionTimeMs = Date.now() - startedAt;
    const memoryAfter = getRssMemoryUsage();
    const outputName = selectVisionEncoderOutputName(outputs);
    const outputTensor = outputs[outputName];
    const shape = normalizeShape(outputTensor && outputTensor.dims);
    const dtype = String(outputTensor && outputTensor.type || "");
    const imageFeatures = outputTensor ? outputTensor.data : undefined;
    const diagnostics = calculateTensorDiagnostics(imageFeatures);

    return {
      imageFeatures,
      shape,
      dtype,
      metadata: {
        outputName,
        elementCount: getElementCount(shape, imageFeatures),
        tileCount: validatedImage.tileCount,
        imageSeqLen: validatedImage.imageSeqLen,
        executionTimeMs,
        memoryDeltaBytes: memoryAfter - memoryBefore,
        diagnostics,
      },
    };
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

  _assertReadyForVisionEncoder() {
    if (!this.initialized || !this.onnxRuntime) {
      throw new Error("OnnxVisionRuntime must be initialized before running the vision encoder.");
    }

    if (!this.modelLoaded || this.status !== ONNX_RUNTIME_STATUS.MODEL_LOADED) {
      throw new Error("OnnxVisionRuntime must have a loaded model before running the vision encoder.");
    }

    if (!this.sessions || !this.sessions.visionEncoder) {
      throw new Error("Vision encoder session is not loaded.");
    }
  }

  _createVisionEncoderFeeds(processedImage) {
    return {
      [VISION_ENCODER_INPUTS.pixelValues]: new this.onnxRuntime.Tensor(
        "float32",
        processedImage.pixelData,
        processedImage.pixelDataShape
      ),
      [VISION_ENCODER_INPUTS.pixelAttentionMask]: new this.onnxRuntime.Tensor(
        "bool",
        processedImage.pixelAttentionMask,
        processedImage.pixelAttentionMaskShape
      ),
    };
  }

  _clearSessions() {
    this.sessions = createEmptySessions();
    this.modelLoaded = false;
    this.loadedModelId = "";
    this.sessionLoadError = "";
    this.lastSessionLoadMs = 0;
  }
}

function validateProcessedImage(processedImage) {
  if (!processedImage || typeof processedImage !== "object") {
    throw new Error("runVisionEncoder requires a processed image object.");
  }

  const pixelDataShape = validateShape(processedImage.pixelDataShape, 5, "pixelDataShape");
  const pixelAttentionMaskShape = validateShape(processedImage.pixelAttentionMaskShape, 4, "pixelAttentionMaskShape");

  if (!(processedImage.pixelData instanceof Float32Array)) {
    throw new Error("processedImage.pixelData must be a Float32Array.");
  }

  if (!(processedImage.pixelAttentionMask instanceof Uint8Array)) {
    throw new Error("processedImage.pixelAttentionMask must be a Uint8Array.");
  }

  if (pixelDataShape[0] !== 1 || pixelAttentionMaskShape[0] !== 1) {
    throw new Error("Vision encoder input batch size must be 1.");
  }

  if (pixelDataShape[2] !== 3) {
    throw new Error("Vision encoder pixelDataShape must use 3 RGB channels.");
  }

  if (pixelDataShape[1] !== pixelAttentionMaskShape[1]) {
    throw new Error("pixelDataShape and pixelAttentionMaskShape must contain the same tile count.");
  }

  if (pixelDataShape[3] !== pixelAttentionMaskShape[2] || pixelDataShape[4] !== pixelAttentionMaskShape[3]) {
    throw new Error("pixelDataShape and pixelAttentionMaskShape spatial dimensions must match.");
  }

  const declaredTileCount = toPositiveInteger(processedImage.tileCount, 0);
  if (declaredTileCount && declaredTileCount !== pixelDataShape[1]) {
    throw new Error("processedImage.tileCount does not match tensor shapes.");
  }

  const expectedPixelDataLength = multiplyShape(pixelDataShape);
  const expectedMaskLength = multiplyShape(pixelAttentionMaskShape);

  if (processedImage.pixelData.length !== expectedPixelDataLength) {
    throw new Error("processedImage.pixelData length does not match pixelDataShape.");
  }

  if (processedImage.pixelAttentionMask.length !== expectedMaskLength) {
    throw new Error("processedImage.pixelAttentionMask length does not match pixelAttentionMaskShape.");
  }

  return {
    pixelData: processedImage.pixelData,
    pixelDataShape,
    pixelAttentionMask: processedImage.pixelAttentionMask,
    pixelAttentionMaskShape,
    tileCount: pixelDataShape[1],
    imageSeqLen: readImageSeqLen(processedImage),
  };
}

function validateShape(shape, expectedRank, label) {
  if (!Array.isArray(shape) || shape.length !== expectedRank) {
    throw new Error(`processedImage.${label} must be an array with rank ${expectedRank}.`);
  }

  return shape.map((dimension, index) => {
    const normalized = Number(dimension);
    if (!Number.isSafeInteger(normalized) || normalized <= 0) {
      throw new Error(`processedImage.${label}[${index}] must be a positive integer.`);
    }
    return normalized;
  });
}

function multiplyShape(shape) {
  return shape.reduce((product, dimension) => product * dimension, 1);
}

function readImageSeqLen(processedImage) {
  const imageSeqLen = processedImage
    && processedImage.metadata
    && Number(processedImage.metadata.imageSeqLen);
  return Number.isFinite(imageSeqLen) ? imageSeqLen : null;
}

function assertVisionEncoderInputContract(visionEncoderSession) {
  if (!Array.isArray(visionEncoderSession.inputNames)) {
    return;
  }

  const missingInputNames = [
    VISION_ENCODER_INPUTS.pixelValues,
    VISION_ENCODER_INPUTS.pixelAttentionMask,
  ].filter((inputName) => !visionEncoderSession.inputNames.includes(inputName));

  if (missingInputNames.length > 0) {
    throw new Error(
      `Vision encoder input contract mismatch. Missing expected input(s): ${missingInputNames.join(", ")}.`
    );
  }
}

function selectVisionEncoderOutputName(outputs) {
  if (!outputs || typeof outputs !== "object") {
    throw new Error("Vision encoder returned no outputs.");
  }

  if (outputs[VISION_ENCODER_OUTPUT_NAME]) {
    return VISION_ENCODER_OUTPUT_NAME;
  }

  const outputNames = Object.keys(outputs);
  if (outputNames.length === 0) {
    throw new Error("Vision encoder returned an empty output map.");
  }

  return outputNames[0];
}

function normalizeShape(dims) {
  if (!Array.isArray(dims)) {
    return [];
  }

  return dims.map((dimension) => Number(dimension));
}

function getElementCount(shape, data) {
  if (shape.length > 0) {
    return multiplyShape(shape);
  }

  return data && Number.isSafeInteger(data.length) ? data.length : 0;
}

function calculateTensorDiagnostics(data) {
  if (!data || !Number.isSafeInteger(data.length) || data.length === 0) {
    return {
      min: null,
      max: null,
      mean: null,
    };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;

  for (let index = 0; index < data.length; index += 1) {
    const value = Number(data[index]);
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
    sum += value;
  }

  return {
    min,
    max,
    mean: sum / data.length,
  };
}

function getRssMemoryUsage() {
  if (typeof process === "undefined" || typeof process.memoryUsage !== "function") {
    return 0;
  }

  return process.memoryUsage().rss;
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

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
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
