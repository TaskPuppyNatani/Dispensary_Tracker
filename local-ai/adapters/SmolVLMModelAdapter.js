"use strict";

const fs = require("fs/promises");
const path = require("path");

const MODEL_FAMILY = "SmolVLM2";
const UNKNOWN = "unknown";

const ONNX_PATTERNS = Object.freeze({
  visionEncoder: /^vision_encoder_(.+)\.onnx$/i,
  embedTokens: /^embed_tokens_(.+)\.onnx$/i,
  decoder: /^decoder_model_merged_(.+)\.onnx$/i,
});

const TOKENIZER_FILES = Object.freeze([
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "added_tokens.json",
  "vocab.json",
  "merges.txt",
]);

const PROCESSOR_FILES = Object.freeze([
  "preprocessor_config.json",
  "processor_config.json",
]);

const CONFIG_FILES = Object.freeze([
  "config.json",
  "generation_config.json",
  "chat_template.json",
]);

const JSON_METADATA_FILES = Object.freeze([
  "config.json",
  "preprocessor_config.json",
  "processor_config.json",
]);

const CAPABILITIES = Object.freeze([
  "vision-language",
  "image-to-text",
  "text-generation",
]);

class SmolVLMModelAdapter {
  constructor(options = {}) {
    this.modelFamily = String(options.modelFamily || MODEL_FAMILY);
  }

  async inspectModel(modelPath) {
    const resolvedModelPath = path.resolve(String(modelPath || ""));
    const missingFiles = [];
    const invalidFiles = [];
    const warnings = [];
    const requiredFiles = createEmptyRequiredFiles();
    const metadata = createEmptyMetadata();

    const modelStat = await safeStat(resolvedModelPath);
    if (!modelStat) {
      return createResult({
        supported: false,
        modelPath: resolvedModelPath,
        modelFamily: this.modelFamily,
        variant: inferVariantFromDirectory(resolvedModelPath),
        precision: UNKNOWN,
        requiredFiles,
        metadata,
        missingFiles: ["."],
        invalidFiles,
        warnings: ["Model directory does not exist."],
      });
    }

    if (!modelStat.isDirectory()) {
      return createResult({
        supported: false,
        modelPath: resolvedModelPath,
        modelFamily: this.modelFamily,
        variant: inferVariantFromDirectory(resolvedModelPath),
        precision: UNKNOWN,
        requiredFiles,
        metadata,
        missingFiles,
        invalidFiles: ["."],
        warnings: ["Model path is not a directory."],
      });
    }

    let rootEntries;
    try {
      rootEntries = await fs.readdir(resolvedModelPath, { withFileTypes: true });
    } catch (error) {
      return createResult({
        supported: false,
        modelPath: resolvedModelPath,
        modelFamily: this.modelFamily,
        variant: inferVariantFromDirectory(resolvedModelPath),
        precision: UNKNOWN,
        requiredFiles,
        metadata,
        missingFiles,
        invalidFiles: ["."],
        warnings: [getErrorMessage(error, "Model directory is not readable.")],
      });
    }

    const rootFileNames = rootEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    const rootDirectoryNames = rootEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const rootFileSet = new Set(rootFileNames);
    const hasOnnxDirectory = rootDirectoryNames.includes("onnx");
    let onnxFileNames = [];

    if (hasOnnxDirectory) {
      try {
        const onnxEntries = await fs.readdir(path.join(resolvedModelPath, "onnx"), { withFileTypes: true });
        onnxFileNames = onnxEntries
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name);
      } catch (error) {
        invalidFiles.push("onnx/");
        warnings.push(getErrorMessage(error, "ONNX directory is not readable."));
      }
    } else {
      missingFiles.push("onnx/");
    }

    const matchedOnnx = matchOnnxFiles(onnxFileNames);
    requiredFiles.onnx = matchedOnnx.requiredFiles;
    missingFiles.push(...matchedOnnx.missingFiles);

    collectRequiredRootFiles(rootFileSet, TOKENIZER_FILES, requiredFiles.tokenizer, missingFiles);
    collectRequiredRootFiles(rootFileSet, PROCESSOR_FILES, requiredFiles.processor, missingFiles);
    collectRequiredRootFiles(rootFileSet, CONFIG_FILES, requiredFiles.config, missingFiles);

    const metadataRead = await readMetadataFiles(resolvedModelPath, rootFileSet);
    invalidFiles.push(...metadataRead.invalidFiles);
    warnings.push(...metadataRead.warnings);
    Object.assign(metadata, createMetadata(metadataRead.files));

    const metadataSignals = evaluateMetadataSignals(metadataRead.files);
    warnings.push(...metadataSignals.warnings);

    const variant = inferVariantFromDirectory(resolvedModelPath);
    const precision = inferPrecision(matchedOnnx.precisions);
    const modelFamily = inferModelFamily(resolvedModelPath, metadataSignals.isSmolVLM);
    const supported = missingFiles.length === 0
      && invalidFiles.length === 0
      && metadataSignals.isSmolVLM;

    return createResult({
      supported,
      modelPath: resolvedModelPath,
      modelFamily,
      variant,
      precision,
      requiredFiles,
      metadata,
      missingFiles,
      invalidFiles,
      warnings,
    });
  }

  async supportsModel(modelPath) {
    const result = await this.inspectModel(modelPath);
    return result.supported;
  }

  async validateModel(modelPath) {
    return await this.inspectModel(modelPath);
  }
}

function createResult(options) {
  const modelFamily = options.modelFamily || MODEL_FAMILY;
  const variant = options.variant || UNKNOWN;
  const precision = options.precision || UNKNOWN;

  return {
    supported: Boolean(options.supported),
    modelId: createModelId(modelFamily, variant, precision),
    modelFamily,
    variant,
    precision,
    modelPath: options.modelPath,
    requiredFiles: options.requiredFiles || createEmptyRequiredFiles(),
    capabilities: Array.from(CAPABILITIES),
    metadata: options.metadata || createEmptyMetadata(),
    missingFiles: uniqueSorted(options.missingFiles),
    invalidFiles: uniqueSorted(options.invalidFiles),
    warnings: uniqueSorted(options.warnings),
  };
}

function createEmptyRequiredFiles() {
  return {
    onnx: {
      visionEncoder: "",
      embedTokens: "",
      decoder: "",
    },
    tokenizer: [],
    processor: [],
    config: [],
  };
}

function createEmptyMetadata() {
  return {
    modelType: "",
    architecture: "",
    processorClass: "",
    imageProcessorType: "",
    imageSeqLen: null,
    imageTokenId: null,
    vocabSize: null,
  };
}

function matchOnnxFiles(onnxFileNames) {
  const matched = {
    visionEncoder: matchSingleOnnxFile(onnxFileNames, ONNX_PATTERNS.visionEncoder),
    embedTokens: matchSingleOnnxFile(onnxFileNames, ONNX_PATTERNS.embedTokens),
    decoder: matchSingleOnnxFile(onnxFileNames, ONNX_PATTERNS.decoder),
  };
  const missingFiles = [];
  const precisions = [];

  for (const [key, match] of Object.entries(matched)) {
    if (!match.fileName) {
      missingFiles.push(getOnnxMissingPattern(key));
      continue;
    }

    precisions.push(match.precision);
  }

  return {
    requiredFiles: {
      visionEncoder: matched.visionEncoder.fileName ? `onnx/${matched.visionEncoder.fileName}` : "",
      embedTokens: matched.embedTokens.fileName ? `onnx/${matched.embedTokens.fileName}` : "",
      decoder: matched.decoder.fileName ? `onnx/${matched.decoder.fileName}` : "",
    },
    missingFiles,
    precisions,
  };
}

function matchSingleOnnxFile(fileNames, pattern) {
  const sortedFileNames = Array.from(fileNames).sort((a, b) => a.localeCompare(b));

  for (const fileName of sortedFileNames) {
    const match = fileName.match(pattern);
    if (match) {
      return {
        fileName,
        precision: normalizePrecision(match[1]),
      };
    }
  }

  return {
    fileName: "",
    precision: UNKNOWN,
  };
}

function getOnnxMissingPattern(key) {
  if (key === "visionEncoder") {
    return "onnx/vision_encoder_*.onnx";
  }
  if (key === "embedTokens") {
    return "onnx/embed_tokens_*.onnx";
  }
  return "onnx/decoder_model_merged_*.onnx";
}

function collectRequiredRootFiles(rootFileSet, fileNames, output, missingFiles) {
  for (const fileName of fileNames) {
    if (rootFileSet.has(fileName)) {
      output.push(fileName);
    } else {
      missingFiles.push(fileName);
    }
  }
}

async function readMetadataFiles(modelPath, rootFileSet) {
  const files = {};
  const invalidFiles = [];
  const warnings = [];

  for (const fileName of JSON_METADATA_FILES) {
    if (!rootFileSet.has(fileName)) {
      continue;
    }

    try {
      const raw = await fs.readFile(path.join(modelPath, fileName), "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        invalidFiles.push(fileName);
        warnings.push(`${fileName} must contain a JSON object.`);
        continue;
      }

      files[fileName] = parsed;
    } catch (error) {
      invalidFiles.push(fileName);
      warnings.push(getErrorMessage(error, `Could not read ${fileName}.`));
    }
  }

  return {
    files,
    invalidFiles,
    warnings,
  };
}

function createMetadata(files) {
  const config = files["config.json"] || {};
  const preprocessorConfig = files["preprocessor_config.json"] || {};
  const processorConfig = files["processor_config.json"] || {};
  const architectures = Array.isArray(config.architectures) ? config.architectures : [];

  return {
    modelType: readString(config.model_type),
    architecture: readString(architectures[0]),
    processorClass: readString(processorConfig.processor_class || preprocessorConfig.processor_class),
    imageProcessorType: readString(preprocessorConfig.image_processor_type),
    imageSeqLen: readFiniteNumber(processorConfig.image_seq_len),
    imageTokenId: readFiniteNumber(config.image_token_id),
    vocabSize: readFiniteNumber(config.vocab_size),
  };
}

function evaluateMetadataSignals(files) {
  const warnings = [];
  const config = files["config.json"] || {};
  const preprocessorConfig = files["preprocessor_config.json"] || {};
  const processorConfig = files["processor_config.json"] || {};
  const architectures = Array.isArray(config.architectures) ? config.architectures : [];
  const hasSmolVLMModelType = config.model_type === "smolvlm";
  const hasSmolVLMArchitecture = architectures.includes("SmolVLMForConditionalGeneration");
  const hasSmolVLMProcessor = processorConfig.processor_class === "SmolVLMProcessor"
    || preprocessorConfig.processor_class === "SmolVLMProcessor";
  const hasSmolVLMImageProcessor = preprocessorConfig.image_processor_type === "SmolVLMImageProcessor";

  if (!hasSmolVLMModelType) {
    warnings.push("config.json does not identify model_type as smolvlm.");
  }
  if (!hasSmolVLMArchitecture) {
    warnings.push("config.json does not include SmolVLMForConditionalGeneration.");
  }
  if (!hasSmolVLMProcessor) {
    warnings.push("Processor config does not identify SmolVLMProcessor.");
  }
  if (!hasSmolVLMImageProcessor) {
    warnings.push("Preprocessor config does not identify SmolVLMImageProcessor.");
  }

  return {
    isSmolVLM: hasSmolVLMModelType
      && hasSmolVLMArchitecture
      && hasSmolVLMProcessor
      && hasSmolVLMImageProcessor,
    warnings,
  };
}

function inferModelFamily(modelPath, isSmolVLM) {
  const directoryName = path.basename(modelPath);
  if (/smolvlm2/i.test(directoryName)) {
    return MODEL_FAMILY;
  }
  return isSmolVLM ? "SmolVLM" : UNKNOWN;
}

function inferVariantFromDirectory(modelPath) {
  const directoryName = path.basename(modelPath);
  const match = directoryName.match(/(?:^|[-_])(\d+(?:\.\d+)?[bBmM])(?:$|[-_])/);
  return match ? match[1].toUpperCase() : UNKNOWN;
}

function inferPrecision(precisions) {
  const normalized = uniqueSorted(precisions.map(normalizePrecision).filter((precision) => precision !== UNKNOWN));
  return normalized.length === 1 ? normalized[0] : UNKNOWN;
}

function normalizePrecision(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || UNKNOWN;
}

function createModelId(modelFamily, variant, precision) {
  return [modelFamily, variant, precision]
    .map((part) => String(part || UNKNOWN).trim() || UNKNOWN)
    .join("-");
}

function readString(value) {
  return typeof value === "string" ? value : "";
}

function readFiniteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function uniqueSorted(values) {
  return Array.from(new Set((values || []).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

async function safeStat(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function getErrorMessage(error, fallback) {
  return error && error.message ? String(error.message) : fallback;
}

module.exports = {
  SmolVLMModelAdapter,
};
