"use strict";

const path = require("path");
const { OnnxVisionRuntime } = require("./OnnxVisionRuntime.js");
const { SmolVLMModelAdapter } = require("./adapters/SmolVLMModelAdapter.js");
const { SmolVLMImageProcessor } = require("./adapters/SmolVLMImageProcessor.js");
const { SmolVLMTokenizer } = require("./adapters/SmolVLMTokenizer.js");

const DEFAULT_RECEIPT_MAX_NEW_TOKENS = 384;

const RECEIPT_EXTRACTION_PROMPT = `You are an AI specialized in reading cannabis dispensary receipts.

Analyze the attached receipt carefully.

Return ONLY a single valid JSON object.

Use JSON null values, not the string "null".
Use JSON numbers for monetary values when present.
Do not return numeric values as strings unless they appear as non-numeric text on the receipt.

Do not include markdown.
Do not include explanations.
Do not include comments.
Do not wrap the JSON in code fences.

If a value cannot be determined from the receipt, use null.
Do not guess.
Do not infer missing information.
Only extract information visible on the receipt.

Extract:

{
  "dispensary": string|null,
  "license_number": string|null,
  "receipt_number": string|null,
  "purchase_date": string|null,
  "purchase_time": string|null,
  "subtotal": number|null,
  "tax": number|null,
  "total": number|null,
  "payment_method": string|null,
  "budtender": string|null,
  "discounts": [
    {
      "description": string,
      "amount": number|null
    }
  ],
  "loyalty": {
    "earned": number|null,
    "redeemed": number|null,
    "balance": number|null
  },
  "products": [
    {
      "name": string,
      "brand": string|null,
      "category": string|null,
      "quantity": number|null,
      "unit_price": number|null,
      "total_price": number|null
    }
  ]
}

Return nothing except the JSON object.`;

class MainProcessReceiptVisionProvider {
  constructor(options = {}) {
    this.name = String(options.name || "MainProcessReceiptVisionProvider");
    this.runtime = options.runtime || new OnnxVisionRuntime();
    this.modelAdapter = options.modelAdapter || new SmolVLMModelAdapter();
    this.imageProcessor = options.imageProcessor || new SmolVLMImageProcessor();
    this.tokenizer = options.tokenizer || new SmolVLMTokenizer();
    this.initialized = false;
    this.initializationPromise = null;
    this.initializationTimeMs = 0;
    this.modelPath = "";
    this.modelInspection = null;
  }

  async initialize({ modelPath } = {}) {
    if (this.initialized) {
      return this.getStatus();
    }

    if (this.initializationPromise) {
      return await this.initializationPromise;
    }

    this.initializationPromise = this._initialize({ modelPath });

    try {
      return await this.initializationPromise;
    } catch (error) {
      this.initializationPromise = null;
      throw error;
    }
  }

  async analyzeReceipt(input = {}) {
    if (!this.initialized) {
      throw new Error("Receipt vision provider must be initialized before analyzing receipts.");
    }

    const image = resolveReceiptImageInput(input);
    const messages = createReceiptExtractionMessages();
    const generationSettings = resolveGenerationSettings(input, this.tokenizer);
    const generationStartedAt = Date.now();
    const generation = await this.runtime.generate({
      image,
      messages,
      maxNewTokens: generationSettings.maxNewTokens,
      stopTokenIds: generationSettings.stopTokenIds,
      imageLayouts: input.imageLayouts,
    });
    const generationTimeMs = Date.now() - generationStartedAt;

    return {
      status: "generated",
      text: generation.text,
      metadata: {
        providerName: this.name,
        modelId: this.modelInspection ? this.modelInspection.modelId : "",
        initializationTimeMs: this.initializationTimeMs,
        generationTimeMs,
        runtimeStatus: this.runtime.getStatus(),
        generation: generation.metadata,
        generationSettings,
      },
    };
  }

  getStatus() {
    return {
      providerName: this.name,
      initialized: this.initialized,
      modelPath: this.modelPath,
      modelId: this.modelInspection ? this.modelInspection.modelId : "",
      initializationTimeMs: this.initializationTimeMs,
      runtimeStatus: this.runtime.getStatus(),
    };
  }

  async _initialize({ modelPath } = {}) {
    const resolvedModelPath = resolveModelPath(modelPath);
    const startedAt = Date.now();
    const inspection = await this.modelAdapter.inspectModel(resolvedModelPath);

    if (!inspection.supported) {
      throw new Error(createUnsupportedModelMessage(inspection));
    }

    await this.runtime.initialize();
    await this.runtime.loadModel(inspection);
    await this.imageProcessor.loadConfig(resolvedModelPath);
    await this.tokenizer.load(resolvedModelPath);
    this.runtime.setGenerationComponents({
      imageProcessor: this.imageProcessor,
      tokenizer: this.tokenizer,
    });

    this.modelPath = resolvedModelPath;
    this.modelInspection = inspection;
    this.initialized = true;
    this.initializationTimeMs = Date.now() - startedAt;
    return this.getStatus();
  }
}

function createReceiptExtractionMessages() {
  return [
    {
      role: "user",
      content: [
        { type: "image" },
        {
          type: "text",
          text: RECEIPT_EXTRACTION_PROMPT,
        },
      ],
    },
  ];
}

function resolveReceiptImageInput(input) {
  if (input && Object.prototype.hasOwnProperty.call(input, "image")) {
    return input.image;
  }

  if (input && Object.prototype.hasOwnProperty.call(input, "imageBuffer")) {
    return input.imageBuffer;
  }

  if (input && Object.prototype.hasOwnProperty.call(input, "imagePath")) {
    return input.imagePath;
  }

  throw new Error("analyzeReceipt requires image, imageBuffer, or imagePath.");
}

function resolveGenerationSettings(input, tokenizer) {
  const source = input && typeof input === "object" ? input : {};
  return {
    maxNewTokens: readOptionalNonNegativeInteger(
      source.maxNewTokens,
      DEFAULT_RECEIPT_MAX_NEW_TOKENS,
      "maxNewTokens"
    ),
    stopTokenIds: Object.prototype.hasOwnProperty.call(source, "stopTokenIds")
      ? readStopTokenIds(source.stopTokenIds)
      : getDefaultStopTokenIds(tokenizer),
  };
}

function getDefaultStopTokenIds(tokenizer) {
  if (!tokenizer || typeof tokenizer.getSpecialTokens !== "function") {
    return [];
  }

  const specialTokens = tokenizer.getSpecialTokens();
  const eosTokenId = specialTokens
    && specialTokens.eos
    && specialTokens.eos.id;

  return Number.isSafeInteger(eosTokenId) && eosTokenId >= 0
    ? [eosTokenId]
    : [];
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

function resolveModelPath(modelPath) {
  const rawModelPath = String(modelPath || "").trim();
  if (!rawModelPath) {
    throw new Error("Receipt vision provider initialization requires modelPath.");
  }

  return path.resolve(rawModelPath);
}

function createUnsupportedModelMessage(inspection) {
  const missingFiles = Array.isArray(inspection.missingFiles) && inspection.missingFiles.length > 0
    ? ` Missing files: ${inspection.missingFiles.join(", ")}.`
    : "";
  const invalidFiles = Array.isArray(inspection.invalidFiles) && inspection.invalidFiles.length > 0
    ? ` Invalid files: ${inspection.invalidFiles.join(", ")}.`
    : "";

  return `SmolVLM model inspection failed.${missingFiles}${invalidFiles}`;
}

function readOptionalNonNegativeInteger(value, fallback, label) {
  if (value === undefined || value === null) {
    return fallback;
  }

  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }

  return normalized;
}

module.exports = {
  MainProcessReceiptVisionProvider,
  RECEIPT_EXTRACTION_PROMPT,
};
