"use strict";

const fs = require("fs/promises");
const path = require("path");

const GGUF_VISION_MANIFEST_FILENAMES = Object.freeze([
  "local-ai.json",
  "manifest.json",
  "model.json",
  "metadata.json",
]);

const REQUIRED_FIELDS = Object.freeze([
  "id",
  "displayName",
  "provider",
  "modelFamily",
  "modelFile",
  "mmprojFile",
  "contextSize",
  "recommendedMaxTokens",
  "capabilities",
]);

const VISION_CAPABILITIES = Object.freeze([
  "vision",
  "image-to-text",
  "image-understanding",
  "multimodal",
  "receipt-extraction",
]);

const CHAT_CAPABILITIES = Object.freeze([
  "chat",
  "conversation",
  "chat-completions",
  "text-generation",
]);

async function inspectGGUFVisionModel(modelDirectory) {
  const modelRoot = path.resolve(String(modelDirectory || ""));
  const errors = [];
  const warnings = [];
  const manifestRead = await readManifest(modelRoot);

  if (!manifestRead.manifest) {
    return createInspectionResult({
      supported: false,
      modelRoot,
      manifestPath: manifestRead.manifestPath,
      warnings,
      errors: [manifestRead.error || "No model manifest found."],
    });
  }

  const manifest = manifestRead.manifest;
  collectRequiredFieldErrors(manifest, errors);

  const modelId = readString(manifest.id);
  const displayName = readString(manifest.displayName);
  const provider = readString(manifest.provider);
  const modelFamily = readString(manifest.modelFamily);
  const capabilities = readStringArray(manifest.capabilities);
  const runtimeArgs = readOptionalRuntimeArgs(manifest.runtimeArgs, errors);
  const contextSize = readPositiveInteger(manifest.contextSize);
  const recommendedMaxTokens = readPositiveInteger(manifest.recommendedMaxTokens);
  const modelFile = readString(manifest.modelFile);
  const mmprojFile = readString(manifest.mmprojFile);

  if (provider && provider !== "llama-server") {
    errors.push("provider must be llama-server.");
  }

  if (manifest.contextSize !== undefined && !contextSize) {
    errors.push("contextSize must be a positive safe integer.");
  }

  if (manifest.recommendedMaxTokens !== undefined && !recommendedMaxTokens) {
    errors.push("recommendedMaxTokens must be a positive safe integer.");
  }

  if (Array.isArray(manifest.capabilities)) {
    if (!hasAnyCapability(capabilities, VISION_CAPABILITIES)) {
      errors.push("capabilities must include vision or an equivalent vision capability.");
    }

    if (!hasAnyCapability(capabilities, CHAT_CAPABILITIES)) {
      errors.push("capabilities must include chat or an equivalent chat capability.");
    }
  } else if (manifest.capabilities !== undefined) {
    errors.push("capabilities must be an array.");
  }

  const modelPathResult = await resolveAndValidateGGUFFile(modelRoot, modelFile, "modelFile");
  const mmprojPathResult = await resolveAndValidateGGUFFile(modelRoot, mmprojFile, "mmprojFile");
  errors.push(...modelPathResult.errors, ...mmprojPathResult.errors);

  return createInspectionResult({
    supported: errors.length === 0,
    modelId,
    displayName,
    provider,
    modelFamily,
    modelRoot,
    manifestPath: manifestRead.manifestPath,
    modelPath: modelPathResult.resolvedPath,
    mmprojPath: mmprojPathResult.resolvedPath,
    contextSize,
    recommendedMaxTokens,
    capabilities,
    runtimeArgs,
    warnings,
    errors,
  });
}

async function validateGGUFVisionModelDirectory(modelDirectory) {
  return await inspectGGUFVisionModel(modelDirectory);
}

async function readManifest(modelRoot) {
  const rootStat = await safeStat(modelRoot);
  if (!rootStat) {
    return {
      manifest: null,
      manifestPath: "",
      error: "Model directory does not exist.",
    };
  }

  if (!rootStat.isDirectory()) {
    return {
      manifest: null,
      manifestPath: "",
      error: "Model path is not a directory.",
    };
  }

  for (const fileName of GGUF_VISION_MANIFEST_FILENAMES) {
    const manifestPath = path.join(modelRoot, fileName);
    const stat = await safeStat(manifestPath);

    if (!stat || !stat.isFile()) {
      continue;
    }

    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw);

      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        return {
          manifest: null,
          manifestPath,
          error: "Model manifest must be a JSON object.",
        };
      }

      return {
        manifest,
        manifestPath,
        error: "",
      };
    } catch (error) {
      return {
        manifest: null,
        manifestPath,
        error: `Could not read model manifest: ${getErrorMessage(error)}`,
      };
    }
  }

  return {
    manifest: null,
    manifestPath: "",
    error: "No model manifest found.",
  };
}

function collectRequiredFieldErrors(manifest, errors) {
  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(manifest, field) || manifest[field] === null || manifest[field] === undefined || manifest[field] === "") {
      errors.push(`Missing required manifest field: ${field}.`);
    }
  }
}

async function resolveAndValidateGGUFFile(modelRoot, relativeFile, label) {
  const errors = [];
  const fileName = readString(relativeFile);

  if (!fileName) {
    return { resolvedPath: "", errors };
  }

  const resolvedPath = path.resolve(modelRoot, fileName);
  const relativePath = path.relative(modelRoot, resolvedPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return {
      resolvedPath,
      errors: [`${label} must resolve inside the model directory.`],
    };
  }

  if (path.extname(resolvedPath).toLowerCase() !== ".gguf") {
    errors.push(`${label} must reference a .gguf file.`);
  }

  const stat = await safeStat(resolvedPath);
  if (!stat || !stat.isFile()) {
    errors.push(`${label} does not exist: ${fileName}.`);
  }

  return { resolvedPath, errors };
}

function createInspectionResult(options = {}) {
  return {
    supported: Boolean(options.supported),
    modelId: options.modelId || "",
    displayName: options.displayName || "",
    modelPath: options.modelPath || "",
    mmprojPath: options.mmprojPath || "",
    contextSize: options.contextSize || null,
    recommendedMaxTokens: options.recommendedMaxTokens || null,
    capabilities: Array.isArray(options.capabilities) ? options.capabilities : [],
    warnings: Array.isArray(options.warnings) ? options.warnings : [],
    errors: Array.isArray(options.errors) ? options.errors : [],
    manifestPath: options.manifestPath || "",
    provider: options.provider || "",
    modelFamily: options.modelFamily || "",
    modelRoot: options.modelRoot || "",
    runtimeArgs: Array.isArray(options.runtimeArgs) ? options.runtimeArgs : [],
  };
}

async function safeStat(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch (error) {
    return null;
  }
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => readString(item)).filter(Boolean)
    : [];
}

function readOptionalRuntimeArgs(value, errors) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    errors.push("runtimeArgs must be an array when present.");
    return [];
  }

  const runtimeArgs = [];
  value.forEach((item, index) => {
    const normalized = readString(item);
    if (!normalized) {
      errors.push(`runtimeArgs[${index}] must be a non-empty string.`);
      return;
    }
    runtimeArgs.push(normalized);
  });

  return runtimeArgs;
}

function readPositiveInteger(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function hasAnyCapability(capabilities, acceptedCapabilities) {
  const capabilitySet = new Set(capabilities.map((capability) => capability.toLowerCase()));
  return acceptedCapabilities.some((capability) => capabilitySet.has(capability));
}

function getErrorMessage(error) {
  return error && error.message ? String(error.message) : String(error);
}

module.exports = {
  GGUF_VISION_MANIFEST_FILENAMES,
  inspectGGUFVisionModel,
  validateGGUFVisionModelDirectory,
};
