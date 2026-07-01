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
const EMBED_TOKENS_INPUT_NAME = "input_ids";
const EMBED_TOKENS_OUTPUT_NAME = "inputs_embeds";
const EXPECTED_SMOLVLM_HIDDEN_SIZE = 960;
const DECODER_INPUTS = Object.freeze({
  inputsEmbeds: "inputs_embeds",
  attentionMask: "attention_mask",
  positionIds: "position_ids",
});
const DECODER_OUTPUTS = Object.freeze({
  logits: "logits",
});
const DECODER_LAYER_COUNT = 32;
const DECODER_KV_HEAD_COUNT = 5;
const DECODER_HEAD_DIM = 64;
const EXPECTED_SMOLVLM_VOCAB_SIZE = 49280;

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

  async runEmbedTokens(encodedPrompt) {
    this._assertReadyForEmbedTokens();
    const validatedPrompt = validateEncodedPrompt(encodedPrompt);
    assertEmbedTokensInputContract(this.sessions.embedTokens);

    const memoryBefore = getRssMemoryUsage();
    const feeds = this._createEmbedTokensFeeds(validatedPrompt);
    const startedAt = Date.now();
    const outputs = await this.sessions.embedTokens.run(feeds);
    const executionTimeMs = Date.now() - startedAt;
    const memoryAfter = getRssMemoryUsage();
    const outputName = selectEmbedTokensOutputName(outputs);
    const outputTensor = outputs[outputName];
    const shape = normalizeShape(outputTensor && outputTensor.dims);
    const dtype = String(outputTensor && outputTensor.type || "");
    const inputsEmbeds = outputTensor ? outputTensor.data : undefined;
    const diagnostics = calculateTensorDiagnostics(inputsEmbeds);
    const hiddenSize = shape.length > 0 ? shape[shape.length - 1] : null;

    return {
      inputsEmbeds,
      shape,
      dtype,
      metadata: {
        outputName,
        tokenCount: validatedPrompt.tokenCount,
        executionTimeMs,
        memoryDeltaBytes: memoryAfter - memoryBefore,
        elementCount: getElementCount(shape, inputsEmbeds),
        expectedHiddenSize: EXPECTED_SMOLVLM_HIDDEN_SIZE,
        hiddenSizeMatchesExpected: hiddenSize === EXPECTED_SMOLVLM_HIDDEN_SIZE,
        diagnostics,
      },
    };
  }

  mergeEmbeddings({ imageFeatures, textEmbeddings, encodedPrompt } = {}) {
    this._assertReadyForEmbeddingMerge();
    const validatedMerge = validateEmbeddingMergeInputs({ imageFeatures, textEmbeddings, encodedPrompt });
    const inputsEmbeds = new Float32Array(validatedMerge.textEmbeddingData);

    for (let index = 0; index < validatedMerge.replaceableImageTokenIndices.length; index += 1) {
      const tokenIndex = validatedMerge.replaceableImageTokenIndices[index];
      const textOffset = tokenIndex * validatedMerge.hiddenSize;
      const imageOffset = index * validatedMerge.hiddenSize;

      for (let hiddenIndex = 0; hiddenIndex < validatedMerge.hiddenSize; hiddenIndex += 1) {
        inputsEmbeds[textOffset + hiddenIndex] = validatedMerge.imageFeatureData[imageOffset + hiddenIndex];
      }
    }

    return {
      inputsEmbeds,
      shape: Array.from(validatedMerge.textEmbeddingShape),
      dtype: "float32",
      metadata: {
        hiddenSize: validatedMerge.hiddenSize,
        textTokenCount: validatedMerge.textTokenCount,
        replaceableImageTokenCount: validatedMerge.replaceableImageTokenIndices.length,
        replacedEmbeddingCount: validatedMerge.replaceableImageTokenIndices.length,
        imageFeatureBlockCount: validatedMerge.imageFeatureBlockCount,
        diagnostics: calculateTensorDiagnostics(inputsEmbeds),
      },
    };
  }

  async runDecoderOnce({ mergedEmbeddings, encodedPrompt } = {}) {
    this._assertReadyForDecoder();
    assertDecoderSessionContract(this.sessions.decoder);
    const validatedInput = validateDecoderOnceInput({ mergedEmbeddings, encodedPrompt });
    const feeds = this._createDecoderOnceFeeds(validatedInput);
    const memoryBefore = getRssMemoryUsage();
    const startedAt = Date.now();
    const outputs = await this.sessions.decoder.run(feeds);
    const executionTimeMs = Date.now() - startedAt;
    const memoryAfter = getRssMemoryUsage();
    const logits = outputs[DECODER_OUTPUTS.logits];
    const logitsShape = normalizeShape(logits && logits.dims);
    const logitsType = String(logits && logits.type || "");
    const presentCache = collectPresentCache(outputs, this.sessions.decoder.outputNames);
    const postExecutionValidation = validateDecoderOnceOutputs({
      logits,
      logitsShape,
      presentCache,
      promptTokenCount: validatedInput.promptTokenCount,
    });
    const logitsDiagnostics = calculateTensorDiagnostics(logits ? logits.data : null);

    return {
      logits: logits ? logits.data : undefined,
      logitsShape,
      logitsType,
      presentCache,
      metadata: {
        executionTimeMs,
        memoryDeltaBytes: memoryAfter - memoryBefore,
        vocabSize: EXPECTED_SMOLVLM_VOCAB_SIZE,
        hiddenSize: EXPECTED_SMOLVLM_HIDDEN_SIZE,
        promptTokenCount: validatedInput.promptTokenCount,
        presentTensorCount: presentCache.length,
        diagnostics: {
          logitsMin: logitsDiagnostics.min,
          logitsMax: logitsDiagnostics.max,
          logitsMean: logitsDiagnostics.mean,
        },
        postExecutionValidation,
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

  _assertReadyForEmbedTokens() {
    if (!this.initialized || !this.onnxRuntime) {
      throw new Error("OnnxVisionRuntime must be initialized before running embed tokens.");
    }

    if (!this.modelLoaded || this.status !== ONNX_RUNTIME_STATUS.MODEL_LOADED) {
      throw new Error("OnnxVisionRuntime must have a loaded model before running embed tokens.");
    }

    if (!this.sessions || !this.sessions.embedTokens) {
      throw new Error("Embed tokens session is not loaded.");
    }
  }

  _assertReadyForEmbeddingMerge() {
    if (!this.initialized || !this.onnxRuntime) {
      throw new Error("OnnxVisionRuntime must be initialized before merging embeddings.");
    }

    if (!this.modelLoaded || this.status !== ONNX_RUNTIME_STATUS.MODEL_LOADED) {
      throw new Error("OnnxVisionRuntime must have a loaded model before merging embeddings.");
    }
  }

  _assertReadyForDecoder() {
    if (!this.initialized || !this.onnxRuntime) {
      throw new Error("OnnxVisionRuntime must be initialized before running the decoder.");
    }

    if (!this.modelLoaded || this.status !== ONNX_RUNTIME_STATUS.MODEL_LOADED) {
      throw new Error("OnnxVisionRuntime must have a loaded model before running the decoder.");
    }

    if (!this.sessions || !this.sessions.decoder) {
      throw new Error("Decoder session is not loaded.");
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

  _createEmbedTokensFeeds(encodedPrompt) {
    return {
      [EMBED_TOKENS_INPUT_NAME]: new this.onnxRuntime.Tensor(
        "int64",
        BigInt64Array.from(encodedPrompt.inputIds.map((inputId) => BigInt(inputId))),
        [1, encodedPrompt.tokenCount]
      ),
    };
  }

  _createDecoderOnceFeeds(decoderInput) {
    const feeds = {
      [DECODER_INPUTS.inputsEmbeds]: new this.onnxRuntime.Tensor(
        "float32",
        decoderInput.inputsEmbeds,
        decoderInput.inputsEmbedsShape
      ),
      [DECODER_INPUTS.attentionMask]: new this.onnxRuntime.Tensor(
        "int64",
        createInt64FilledArray(decoderInput.promptTokenCount, 1n),
        [1, decoderInput.promptTokenCount]
      ),
      [DECODER_INPUTS.positionIds]: new this.onnxRuntime.Tensor(
        "int64",
        createPositionIds(decoderInput.promptTokenCount),
        [1, decoderInput.promptTokenCount]
      ),
    };

    for (let layerIndex = 0; layerIndex < DECODER_LAYER_COUNT; layerIndex += 1) {
      feeds[`past_key_values.${layerIndex}.key`] = createEmptyKvCacheTensor(this.onnxRuntime);
      feeds[`past_key_values.${layerIndex}.value`] = createEmptyKvCacheTensor(this.onnxRuntime);
    }

    return feeds;
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

function validateEncodedPrompt(encodedPrompt) {
  if (!encodedPrompt || typeof encodedPrompt !== "object") {
    throw new Error("runEmbedTokens requires an encoded prompt object.");
  }

  if (!Array.isArray(encodedPrompt.inputIds) && !isNumericTypedArray(encodedPrompt.inputIds)) {
    throw new Error("encodedPrompt.inputIds must be an array or numeric typed array.");
  }

  const inputIds = Array.from(encodedPrompt.inputIds);
  if (inputIds.length === 0) {
    throw new Error("encodedPrompt.inputIds must not be empty.");
  }

  for (let index = 0; index < inputIds.length; index += 1) {
    const inputId = inputIds[index];
    if (!Number.isSafeInteger(inputId) || inputId < 0) {
      throw new Error(`encodedPrompt.inputIds[${index}] must be a non-negative safe integer.`);
    }
  }

  return {
    inputIds,
    tokenCount: inputIds.length,
  };
}

function validateEmbeddingMergeInputs({ imageFeatures, textEmbeddings, encodedPrompt }) {
  if (!imageFeatures || typeof imageFeatures !== "object") {
    throw new Error("mergeEmbeddings requires imageFeatures from runVisionEncoder.");
  }

  if (!textEmbeddings || typeof textEmbeddings !== "object") {
    throw new Error("mergeEmbeddings requires textEmbeddings from runEmbedTokens.");
  }

  if (!encodedPrompt || typeof encodedPrompt !== "object") {
    throw new Error("mergeEmbeddings requires encodedPrompt from SmolVLMTokenizer.encode.");
  }

  if (!(imageFeatures.imageFeatures instanceof Float32Array)) {
    throw new Error("imageFeatures.imageFeatures must be a Float32Array.");
  }

  if (!(textEmbeddings.inputsEmbeds instanceof Float32Array)) {
    throw new Error("textEmbeddings.inputsEmbeds must be a Float32Array.");
  }

  const imageFeatureShape = validateShape(imageFeatures.shape, 3, "imageFeatures.shape");
  const textEmbeddingShape = validateShape(textEmbeddings.shape, 3, "textEmbeddings.shape");
  const expansion = validateExpansionMetadata(encodedPrompt.expansion);
  const textTokenCount = textEmbeddingShape[1];
  const imageFeatureBlockCount = expansion.imageFeatureBlockCount;
  const imageSeqLen = expansion.imageSeqLen;
  const imageHiddenSize = imageFeatureShape[2];
  const textHiddenSize = textEmbeddingShape[2];
  const expectedReplacementCount = imageFeatureBlockCount * imageSeqLen;

  if (textEmbeddingShape[0] !== 1) {
    throw new Error("textEmbeddings.shape batch size must be 1.");
  }

  if (imageFeatureShape[0] !== imageFeatureBlockCount) {
    throw new Error("imageFeatures.shape does not match tokenizer imageFeatureBlockCount.");
  }

  if (imageFeatureShape[1] !== imageSeqLen) {
    throw new Error("imageFeatures.shape does not match tokenizer imageSeqLen.");
  }

  if (imageHiddenSize !== textHiddenSize) {
    throw new Error(`Image/text hidden size mismatch: ${imageHiddenSize} !== ${textHiddenSize}.`);
  }

  if (textHiddenSize !== EXPECTED_SMOLVLM_HIDDEN_SIZE) {
    throw new Error(`Expected hidden size ${EXPECTED_SMOLVLM_HIDDEN_SIZE}, received ${textHiddenSize}.`);
  }

  if (expansion.replaceableImageTokenIndices.length !== expectedReplacementCount) {
    throw new Error("Tokenizer replacement index count does not match image feature count.");
  }

  if (imageFeatures.imageFeatures.length !== multiplyShape(imageFeatureShape)) {
    throw new Error("imageFeatures.imageFeatures length does not match imageFeatures.shape.");
  }

  if (textEmbeddings.inputsEmbeds.length !== multiplyShape(textEmbeddingShape)) {
    throw new Error("textEmbeddings.inputsEmbeds length does not match textEmbeddings.shape.");
  }

  if (Number.isSafeInteger(encodedPrompt.tokenCount) && encodedPrompt.tokenCount !== textTokenCount) {
    throw new Error("encodedPrompt.tokenCount does not match textEmbeddings token count.");
  }

  for (let index = 0; index < expansion.replaceableImageTokenIndices.length; index += 1) {
    const tokenIndex = expansion.replaceableImageTokenIndices[index];
    if (!Number.isSafeInteger(tokenIndex) || tokenIndex < 0 || tokenIndex >= textTokenCount) {
      throw new Error(`replaceableImageTokenIndices[${index}] is outside the text embedding range.`);
    }
  }

  return {
    imageFeatureData: imageFeatures.imageFeatures,
    imageFeatureShape,
    textEmbeddingData: textEmbeddings.inputsEmbeds,
    textEmbeddingShape,
    textTokenCount,
    hiddenSize: textHiddenSize,
    imageSeqLen,
    imageFeatureBlockCount,
    replaceableImageTokenIndices: expansion.replaceableImageTokenIndices,
  };
}

function validateDecoderOnceInput({ mergedEmbeddings, encodedPrompt }) {
  if (!mergedEmbeddings || typeof mergedEmbeddings !== "object") {
    throw new Error("runDecoderOnce requires mergedEmbeddings from mergeEmbeddings.");
  }

  if (!encodedPrompt || typeof encodedPrompt !== "object") {
    throw new Error("runDecoderOnce requires encodedPrompt from SmolVLMTokenizer.encode.");
  }

  if (!(mergedEmbeddings.inputsEmbeds instanceof Float32Array)) {
    throw new Error("mergedEmbeddings.inputsEmbeds must be a Float32Array.");
  }

  const inputsEmbedsShape = validateShape(mergedEmbeddings.shape, 3, "mergedEmbeddings.shape");
  const promptTokenCount = inputsEmbedsShape[1];
  const hiddenSize = inputsEmbedsShape[2];

  if (inputsEmbedsShape[0] !== 1) {
    throw new Error("mergedEmbeddings.shape batch size must be 1.");
  }

  if (hiddenSize !== EXPECTED_SMOLVLM_HIDDEN_SIZE) {
    throw new Error(`Expected decoder hidden size ${EXPECTED_SMOLVLM_HIDDEN_SIZE}, received ${hiddenSize}.`);
  }

  if (mergedEmbeddings.inputsEmbeds.length !== multiplyShape(inputsEmbedsShape)) {
    throw new Error("mergedEmbeddings.inputsEmbeds length does not match mergedEmbeddings.shape.");
  }

  if (Number.isSafeInteger(encodedPrompt.tokenCount) && encodedPrompt.tokenCount !== promptTokenCount) {
    throw new Error("encodedPrompt.tokenCount does not match mergedEmbeddings prompt length.");
  }

  return {
    inputsEmbeds: mergedEmbeddings.inputsEmbeds,
    inputsEmbedsShape,
    promptTokenCount,
  };
}

function validateExpansionMetadata(expansion) {
  if (!expansion || typeof expansion !== "object") {
    throw new Error("encodedPrompt.expansion metadata is required for mergeEmbeddings.");
  }

  if (expansion.expanded !== true) {
    throw new Error("encodedPrompt must be expanded before merging embeddings.");
  }

  const imageSeqLen = readPositiveInteger(expansion.imageSeqLen, "encodedPrompt.expansion.imageSeqLen");
  const imageFeatureBlockCount = readPositiveInteger(
    expansion.imageFeatureBlockCount,
    "encodedPrompt.expansion.imageFeatureBlockCount"
  );
  const replaceableImageTokenCount = readPositiveInteger(
    expansion.replaceableImageTokenCount,
    "encodedPrompt.expansion.replaceableImageTokenCount"
  );

  if (!Array.isArray(expansion.replaceableImageTokenIndices)) {
    throw new Error("encodedPrompt.expansion.replaceableImageTokenIndices must be an array.");
  }

  if (expansion.replaceableImageTokenIndices.length !== replaceableImageTokenCount) {
    throw new Error("replaceableImageTokenIndices length does not match replaceableImageTokenCount.");
  }

  return {
    imageSeqLen,
    imageFeatureBlockCount,
    replaceableImageTokenCount,
    replaceableImageTokenIndices: Array.from(expansion.replaceableImageTokenIndices),
  };
}

function assertDecoderSessionContract(decoderSession) {
  assertSessionHasNames(decoderSession.inputNames, getExpectedDecoderInputNames(), "Decoder input");
  assertSessionHasNames(decoderSession.outputNames, getExpectedDecoderOutputNames(), "Decoder output");
}

function assertSessionHasNames(actualNames, expectedNames, label) {
  if (!Array.isArray(actualNames)) {
    throw new Error(`${label} names are not exposed by ONNX Runtime.`);
  }

  const missingNames = expectedNames.filter((name) => !actualNames.includes(name));
  if (missingNames.length > 0) {
    throw new Error(`${label} contract mismatch. Missing: ${missingNames.join(", ")}.`);
  }
}

function getExpectedDecoderInputNames() {
  const names = [
    DECODER_INPUTS.inputsEmbeds,
    DECODER_INPUTS.attentionMask,
    DECODER_INPUTS.positionIds,
  ];

  for (let layerIndex = 0; layerIndex < DECODER_LAYER_COUNT; layerIndex += 1) {
    names.push(`past_key_values.${layerIndex}.key`);
    names.push(`past_key_values.${layerIndex}.value`);
  }

  return names;
}

function getExpectedDecoderOutputNames() {
  const names = [DECODER_OUTPUTS.logits];

  for (let layerIndex = 0; layerIndex < DECODER_LAYER_COUNT; layerIndex += 1) {
    names.push(`present.${layerIndex}.key`);
    names.push(`present.${layerIndex}.value`);
  }

  return names;
}

function createInt64FilledArray(length, value) {
  const data = new BigInt64Array(length);
  data.fill(value);
  return data;
}

function createPositionIds(length) {
  const data = new BigInt64Array(length);
  for (let index = 0; index < length; index += 1) {
    data[index] = BigInt(index);
  }
  return data;
}

function createEmptyKvCacheTensor(onnxRuntime) {
  return new onnxRuntime.Tensor(
    "float32",
    new Float32Array(0),
    [1, DECODER_KV_HEAD_COUNT, 0, DECODER_HEAD_DIM]
  );
}

function collectPresentCache(outputs, outputNames) {
  const names = Array.isArray(outputNames) ? outputNames : Object.keys(outputs || {});
  return names
    .filter((name) => /^present\.\d+\.(?:key|value)$/.test(name))
    .map((name) => ({
      name,
      tensor: outputs[name],
    }));
}

function validateDecoderOnceOutputs({ logits, logitsShape, presentCache, promptTokenCount }) {
  const deviations = [];

  if (!logits) {
    deviations.push("Decoder output is missing logits.");
  } else {
    const expectedLogitsShape = [1, promptTokenCount, EXPECTED_SMOLVLM_VOCAB_SIZE];
    if (!shapesEqual(logitsShape, expectedLogitsShape)) {
      deviations.push(`Expected logits shape ${JSON.stringify(expectedLogitsShape)}, received ${JSON.stringify(logitsShape)}.`);
    }
    if (logits.type !== "float32") {
      deviations.push(`Expected logits dtype float32, received ${String(logits.type || "")}.`);
    }
  }

  const expectedPresentTensorCount = DECODER_LAYER_COUNT * 2;
  if (presentCache.length !== expectedPresentTensorCount) {
    deviations.push(`Expected ${expectedPresentTensorCount} present cache tensors, received ${presentCache.length}.`);
  }

  const expectedPresentShape = [1, DECODER_KV_HEAD_COUNT, promptTokenCount, DECODER_HEAD_DIM];
  for (const entry of presentCache) {
    const tensor = entry.tensor;
    const shape = normalizeShape(tensor && tensor.dims);
    if (!tensor) {
      deviations.push(`Missing present cache tensor: ${entry.name}.`);
      continue;
    }
    if (tensor.type !== "float32") {
      deviations.push(`Expected ${entry.name} dtype float32, received ${String(tensor.type || "")}.`);
    }
    if (!shapesEqual(shape, expectedPresentShape)) {
      deviations.push(`Expected ${entry.name} shape ${JSON.stringify(expectedPresentShape)}, received ${JSON.stringify(shape)}.`);
    }
  }

  return {
    contractMatched: deviations.length === 0,
    zeroLengthKvCacheAccepted: Boolean(logits) && presentCache.length > 0,
    deviations,
    expectedPresentShape,
  };
}

function shapesEqual(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    return false;
  }

  return actual.every((dimension, index) => dimension === expected[index]);
}

function validateShape(shape, expectedRank, label) {
  if (!Array.isArray(shape) || shape.length !== expectedRank) {
    throw new Error(`${label} must be an array with rank ${expectedRank}.`);
  }

  return shape.map((dimension, index) => {
    const normalized = Number(dimension);
    if (!Number.isSafeInteger(normalized) || normalized <= 0) {
      throw new Error(`${label}[${index}] must be a positive integer.`);
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

function assertEmbedTokensInputContract(embedTokensSession) {
  if (!Array.isArray(embedTokensSession.inputNames)) {
    return;
  }

  if (!embedTokensSession.inputNames.includes(EMBED_TOKENS_INPUT_NAME)) {
    throw new Error(`Embed tokens input contract mismatch. Missing expected input: ${EMBED_TOKENS_INPUT_NAME}.`);
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

function selectEmbedTokensOutputName(outputs) {
  if (!outputs || typeof outputs !== "object") {
    throw new Error("Embed tokens returned no outputs.");
  }

  if (outputs[EMBED_TOKENS_OUTPUT_NAME]) {
    return EMBED_TOKENS_OUTPUT_NAME;
  }

  const outputNames = Object.keys(outputs);
  if (outputNames.length === 0) {
    throw new Error("Embed tokens returned an empty output map.");
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

function isNumericTypedArray(value) {
  return ArrayBuffer.isView(value)
    && !(value instanceof DataView)
    && !(value instanceof BigInt64Array)
    && !(value instanceof BigUint64Array);
}

function readPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return number;
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
