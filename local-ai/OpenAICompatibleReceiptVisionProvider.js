"use strict";

const ReceiptProcessingPipeline = require("./ReceiptProcessingPipeline.js");
const { RECEIPT_EXTRACTION_PROMPT } = require("./ReceiptExtractionPrompt.js");

const DEFAULT_BASE_URL = "http://localhost:1234/v1/chat/completions";
const DEFAULT_PROVIDER_NAME = "OpenAICompatibleReceiptVisionProvider";
const DEFAULT_MAX_NEW_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_TEMPERATURE = 0;
const FALLBACK_MODEL_ID = "local-model";

class OpenAICompatibleReceiptVisionProvider {
  constructor(options = {}) {
    this.name = String(options.name || options.providerName || DEFAULT_PROVIDER_NAME);
    this.baseUrl = normalizeUrl(options.baseUrl || DEFAULT_BASE_URL);
    this.model = normalizeOptionalString(options.model);
    this.timeoutMs = readNonNegativeInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.temperature = readFiniteNumber(options.temperature, DEFAULT_TEMPERATURE, "temperature");
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.initialized = false;
    this.initializationPromise = null;
    this.initializationTimeMs = 0;
    this.healthStatus = null;
    this.resolvedModel = this.model;
  }

  async initialize(options = {}) {
    this._applyOptions(options);

    if (this.initialized) {
      return this.getStatus();
    }

    if (this.initializationPromise) {
      return await this.initializationPromise;
    }

    this.initializationPromise = this._initialize();

    try {
      return await this.initializationPromise;
    } catch (error) {
      this.initializationPromise = null;
      throw error;
    }
  }

  async analyzeReceipt(input = {}) {
    if (!this.initialized) {
      throw new Error("OpenAI-compatible receipt vision provider must be initialized before analyzing receipts.");
    }

    const imageBuffer = readImageBuffer(input);
    const generationSettings = resolveGenerationSettings(input);
    const requestBody = this._createRequestBody({
      imageBuffer,
      maxTokens: generationSettings.maxNewTokens,
    });
    const startedAt = Date.now();
    const response = await fetchJsonWithTimeout(this.fetchImpl, this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    }, this.timeoutMs);
    const generationTimeMs = Date.now() - startedAt;
    const text = extractResponseText(response.body);
    const metadata = {
      providerName: this.name,
      source: "local-ai",
      backend: "openai-compatible",
      modelId: requestBody.model,
      baseUrl: this.baseUrl,
      initializationTimeMs: this.initializationTimeMs,
      generationTimeMs,
      httpStatus: response.status,
      usage: response.body && response.body.usage ? response.body.usage : null,
      generation: {
        generatedTokenCount: readGeneratedTokenCount(response.body),
        stoppedBy: readFinishReason(response.body),
      },
      generationSettings,
      request: {
        temperature: this.temperature,
        maxTokens: generationSettings.maxNewTokens,
        stopTokenIdsApplied: false,
      },
      healthStatus: this.healthStatus,
    };
    const pipelineResult = ReceiptProcessingPipeline.process({
      text,
      metadata,
    });

    return {
      ...pipelineResult,
      metadata,
    };
  }

  getStatus() {
    return {
      providerName: this.name,
      initialized: this.initialized,
      available: this.initialized,
      backend: "openai-compatible",
      baseUrl: this.baseUrl,
      modelsUrl: deriveModelsUrl(this.baseUrl),
      modelId: this.resolvedModel || this.model || "",
      initializationTimeMs: this.initializationTimeMs,
      healthStatus: this.healthStatus,
    };
  }

  async getHealthStatus(options = {}) {
    this._applyOptions(options);
    return await this._checkHealth();
  }

  _applyOptions(options = {}) {
    if (!options || typeof options !== "object") {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(options, "baseUrl")) {
      this.baseUrl = normalizeUrl(options.baseUrl || DEFAULT_BASE_URL);
    }

    if (Object.prototype.hasOwnProperty.call(options, "model")) {
      this.model = normalizeOptionalString(options.model);
      this.resolvedModel = this.model;
    }

    if (Object.prototype.hasOwnProperty.call(options, "timeoutMs")) {
      this.timeoutMs = readNonNegativeInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    }

    if (Object.prototype.hasOwnProperty.call(options, "temperature")) {
      this.temperature = readFiniteNumber(options.temperature, DEFAULT_TEMPERATURE, "temperature");
    }
  }

  async _initialize() {
    const startedAt = Date.now();
    const health = await this._checkHealth();

    if (!health.available) {
      throw new Error(health.reason || "OpenAI-compatible receipt provider is unavailable.");
    }

    this.healthStatus = health;
    this.resolvedModel = health.modelId || this.model || FALLBACK_MODEL_ID;
    this.initialized = true;
    this.initializationTimeMs = Date.now() - startedAt;
    return this.getStatus();
  }

  async _checkHealth() {
    const modelsUrl = deriveModelsUrl(this.baseUrl);

    try {
      const response = await fetchJsonWithTimeout(this.fetchImpl, modelsUrl, {
        method: "GET",
      }, this.timeoutMs);
      const models = readModelIds(response.body);
      const warnings = [];
      let modelId = this.model;

      if (this.model) {
        if (!models.includes(this.model)) {
          return {
            available: false,
            initialized: this.initialized,
            providerName: this.name,
            backend: "openai-compatible",
            baseUrl: this.baseUrl,
            modelsUrl,
            modelId: this.model,
            reason: "configured_model_not_reported_by_server",
            models,
            warnings,
          };
        }
      } else if (models.length > 0) {
        modelId = models[0];
        warnings.push("No OpenAI-compatible model was configured; using the first model reported by the server.");
      } else {
        modelId = FALLBACK_MODEL_ID;
        warnings.push("No OpenAI-compatible model was configured and /v1/models returned no model IDs; using local-model in requests.");
      }

      return {
        available: true,
        initialized: this.initialized,
        providerName: this.name,
        backend: "openai-compatible",
        baseUrl: this.baseUrl,
        modelsUrl,
        modelId,
        reason: null,
        models,
        warnings,
      };
    } catch (error) {
      return {
        available: false,
        initialized: this.initialized,
        providerName: this.name,
        backend: "openai-compatible",
        baseUrl: this.baseUrl,
        modelsUrl,
        modelId: this.model || "",
        reason: error && error.message ? error.message : String(error),
        models: [],
        warnings: [],
      };
    }
  }

  _createRequestBody({ imageBuffer, maxTokens }) {
    const dataUrl = createImageDataUrl(imageBuffer);
    const model = this.resolvedModel || this.model || FALLBACK_MODEL_ID;

    return {
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: RECEIPT_EXTRACTION_PROMPT,
            },
            {
              type: "image_url",
              image_url: {
                url: dataUrl,
              },
            },
          ],
        },
      ],
      max_tokens: maxTokens,
      temperature: this.temperature,
    };
  }
}

function normalizeUrl(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return DEFAULT_BASE_URL;
  }

  return normalized;
}

function normalizeOptionalString(value) {
  return String(value || "").trim();
}

function deriveModelsUrl(chatCompletionsUrl) {
  const url = new URL(chatCompletionsUrl);
  const pathname = url.pathname.replace(/\/+$/, "");

  if (pathname.endsWith("/chat/completions")) {
    url.pathname = `${pathname.slice(0, -"/chat/completions".length)}/models`;
    return url.toString();
  }

  url.pathname = "/v1/models";
  return url.toString();
}

function readImageBuffer(input = {}) {
  const imageBuffer = input && input.imageBuffer;

  if (Buffer.isBuffer(imageBuffer)) {
    return imageBuffer;
  }

  if (imageBuffer instanceof ArrayBuffer) {
    return Buffer.from(imageBuffer);
  }

  if (ArrayBuffer.isView(imageBuffer)) {
    return Buffer.from(imageBuffer.buffer, imageBuffer.byteOffset, imageBuffer.byteLength);
  }

  throw new Error("OpenAI-compatible receipt analysis requires imageBuffer.");
}

function createImageDataUrl(imageBuffer) {
  return `data:image/jpeg;base64,${Buffer.from(imageBuffer).toString("base64")}`;
}

function resolveGenerationSettings(input = {}) {
  return {
    maxNewTokens: readNonNegativeInteger(input.maxNewTokens, DEFAULT_MAX_NEW_TOKENS, "maxNewTokens"),
    stopTokenIds: Object.prototype.hasOwnProperty.call(input, "stopTokenIds")
      ? readStopTokenIds(input.stopTokenIds)
      : [],
  };
}

function readStopTokenIds(value) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
    throw new Error("stopTokenIds must be an array or typed array.");
  }

  return Array.from(value).map((tokenId, index) => {
    const normalized = Number(tokenId);
    if (!Number.isSafeInteger(normalized) || normalized < 0) {
      throw new Error(`stopTokenIds[${index}] must be a non-negative safe integer.`);
    }
    return normalized;
  });
}

function readNonNegativeInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }

  return normalized;
}

function readFiniteNumber(value, fallback, label) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    throw new Error(`${label} must be a finite number.`);
  }

  return normalized;
}

async function fetchJsonWithTimeout(fetchImpl, url, options, timeoutMs) {
  if (typeof fetchImpl !== "function") {
    throw new Error("OpenAI-compatible provider requires a fetch implementation.");
  }

  const controller = typeof AbortController === "function"
    ? new AbortController()
    : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller ? controller.signal : undefined,
    });

    if (!response || typeof response.ok !== "boolean") {
      throw new Error("OpenAI-compatible server returned an invalid fetch response.");
    }

    let body = null;
    try {
      body = typeof response.json === "function" ? await response.json() : null;
    } catch (error) {
      throw new Error(`OpenAI-compatible server returned invalid JSON: ${error.message || error}`);
    }

    if (!response.ok) {
      throw new Error(`OpenAI-compatible server returned HTTP ${response.status}: ${JSON.stringify(body)}`);
    }

    return {
      status: response.status,
      body,
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function readModelIds(body) {
  const data = body && Array.isArray(body.data) ? body.data : [];
  return data
    .map((entry) => entry && typeof entry.id === "string" ? entry.id : "")
    .filter(Boolean);
}

function extractResponseText(body) {
  const choice = body
    && Array.isArray(body.choices)
    && body.choices.length > 0
    ? body.choices[0]
    : null;
  const content = choice && choice.message ? choice.message.content : null;

  if (typeof content === "string" && content.length > 0) {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");

    if (text.length > 0) {
      return text;
    }
  }

  throw new Error("OpenAI-compatible server response did not include assistant text.");
}

function readGeneratedTokenCount(body) {
  const completionTokens = body
    && body.usage
    && Number(body.usage.completion_tokens);

  return Number.isSafeInteger(completionTokens) && completionTokens >= 0
    ? completionTokens
    : 0;
}

function readFinishReason(body) {
  const choice = body
    && Array.isArray(body.choices)
    && body.choices.length > 0
    ? body.choices[0]
    : null;
  return choice && typeof choice.finish_reason === "string"
    ? choice.finish_reason
    : null;
}

module.exports = {
  OpenAICompatibleReceiptVisionProvider,
  RECEIPT_EXTRACTION_PROMPT,
  deriveModelsUrl,
};
