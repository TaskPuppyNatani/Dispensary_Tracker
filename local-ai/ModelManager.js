"use strict";

const fs = require("fs/promises");
const path = require("path");
const { DEFAULT_LOCAL_AI_SETTINGS, resolveModelDirectory } = require("./config.js");

require("./modelTypes.js");

const DEFAULT_METADATA_FILENAMES = Object.freeze([
  "local-ai.json",
  "model.json",
  "metadata.json",
  "manifest.json",
]);

const STATUS = Object.freeze({
  INSTALLED: "installed",
  MISSING: "missing",
  INVALID: "invalid",
});

class ModelManager {
  constructor(options = {}) {
    this.baseDirectory = options.baseDirectory || process.cwd();
    this.modelDirectory = options.modelDirectory || DEFAULT_LOCAL_AI_SETTINGS.modelDirectory;
    this.metadataFileNames = Array.isArray(options.metadataFileNames) && options.metadataFileNames.length > 0
      ? options.metadataFileNames.map((name) => String(name)).filter(Boolean)
      : Array.from(DEFAULT_METADATA_FILENAMES);
  }

  getModelRoot() {
    return resolveModelDirectory({ modelDirectory: this.modelDirectory }, this.baseDirectory);
  }

  async listModels() {
    const rootPath = this.getModelRoot();
    const rootStat = await safeStat(rootPath);

    if (!rootStat || !rootStat.isDirectory()) {
      return [];
    }

    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    const candidateDirectories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootPath, entry.name));

    const models = await Promise.all(
      candidateDirectories.map(async (candidatePath) => {
        const validation = await this.validateModelDirectory(candidatePath);
        return this.createModelMetadata(candidatePath, validation);
      })
    );

    return models.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async getModelMetadata(modelId) {
    const modelPath = this.resolveCandidatePath(modelId);
    if (!modelPath) {
      return null;
    }

    const validation = await this.validateModelDirectory(modelPath);
    if (validation.status === STATUS.MISSING) {
      return null;
    }

    return this.createModelMetadata(modelPath, validation);
  }

  async getInstallationStatus(modelId) {
    const modelPath = this.resolveCandidatePath(modelId);
    const validation = modelPath
      ? await this.validateModelDirectory(modelPath)
      : createValidationResult({
        valid: false,
        status: STATUS.MISSING,
        reason: "missing_model_id",
        errors: ["A model id is required."],
      });

    return {
      modelId: String(modelId || ""),
      modelPath: modelPath || "",
      status: validation.status,
      reason: validation.reason,
      validation,
    };
  }

  async validateModelDirectory(modelPath) {
    const resolvedPath = path.resolve(String(modelPath || ""));
    const stat = await safeStat(resolvedPath);

    if (!stat) {
      return createValidationResult({
        valid: false,
        status: STATUS.MISSING,
        reason: "directory_missing",
        errors: ["Model directory does not exist."],
      });
    }

    if (!stat.isDirectory()) {
      return createValidationResult({
        valid: false,
        status: STATUS.INVALID,
        reason: "not_a_directory",
        errors: ["Model path exists but is not a directory."],
      });
    }

    let entries;
    try {
      entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    } catch (error) {
      return createValidationResult({
        valid: false,
        status: STATUS.INVALID,
        reason: "directory_unreadable",
        errors: [getErrorMessage(error, "Model directory is not readable.")],
      });
    }

    const artifactSummary = await summarizeArtifacts(resolvedPath, entries);
    const metadataRead = await readDeclarativeMetadata(resolvedPath, this.metadataFileNames);
    const errors = [];
    const warnings = [];

    if (artifactSummary.fileCount === 0 && artifactSummary.directoryCount === 0) {
      errors.push("Model directory is empty.");
    }

    if (!metadataRead.metadata) {
      warnings.push(metadataRead.reason || "No declarative model metadata found; metadata will be inferred.");
    }

    return createValidationResult({
      valid: errors.length === 0,
      status: errors.length === 0 ? STATUS.INSTALLED : STATUS.INVALID,
      reason: errors.length === 0 ? "directory_valid" : "directory_invalid",
      errors,
      warnings,
      artifactSummary,
      metadata: metadataRead.metadata,
      metadataSource: metadataRead.source,
    });
  }

  createModelMetadata(modelPath, validation) {
    const directoryName = path.basename(modelPath);
    const declarativeMetadata = validation.metadata && typeof validation.metadata === "object"
      ? validation.metadata
      : {};
    const id = readString(declarativeMetadata.id) || directoryName;
    const displayName = readString(declarativeMetadata.displayName)
      || readString(declarativeMetadata.name)
      || readString(declarativeMetadata.title)
      || directoryName;

    return {
      id,
      displayName,
      directoryName,
      modelPath,
      status: validation.status,
      reason: validation.reason,
      capabilities: readStringArray(declarativeMetadata.capabilities),
      runtimeHints: readPlainObject(declarativeMetadata.runtimeHints),
      artifactSummary: validation.artifactSummary,
      validation,
    };
  }

  resolveCandidatePath(modelId) {
    const normalizedId = String(modelId || "").trim();
    if (!normalizedId) {
      return null;
    }

    const rootPath = this.getModelRoot();
    const candidatePath = path.resolve(rootPath, normalizedId);
    const relativePath = path.relative(rootPath, candidatePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return null;
    }

    return candidatePath;
  }
}

async function safeStat(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function summarizeArtifacts(modelPath, entries) {
  const extensionSet = new Set();
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      directoryCount += 1;
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    fileCount += 1;
    const extension = path.extname(entry.name).toLowerCase();
    if (extension) {
      extensionSet.add(extension);
    }

    const fileStat = await safeStat(path.join(modelPath, entry.name));
    if (fileStat && Number.isFinite(fileStat.size)) {
      totalBytes += fileStat.size;
    }
  }

  return {
    fileCount,
    directoryCount,
    totalBytes,
    extensions: Array.from(extensionSet).sort(),
  };
}

async function readDeclarativeMetadata(modelPath, metadataFileNames) {
  for (const metadataFileName of metadataFileNames) {
    const metadataPath = path.join(modelPath, metadataFileName);
    const stat = await safeStat(metadataPath);

    if (!stat || !stat.isFile()) {
      continue;
    }

    try {
      const raw = await fs.readFile(metadataPath, "utf8");
      const metadata = JSON.parse(raw);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        return {
          metadata: null,
          source: metadataPath,
          reason: "Declarative model metadata must be a JSON object.",
        };
      }

      return {
        metadata,
        source: metadataPath,
        reason: "",
      };
    } catch (error) {
      return {
        metadata: null,
        source: metadataPath,
        reason: getErrorMessage(error, "Could not read declarative model metadata."),
      };
    }
  }

  return {
    metadata: null,
    source: null,
    reason: "No declarative model metadata found.",
  };
}

function createValidationResult(options = {}) {
  return {
    valid: Boolean(options.valid),
    status: options.status || STATUS.INVALID,
    reason: options.reason || "unknown",
    errors: Array.isArray(options.errors) ? options.errors : [],
    warnings: Array.isArray(options.warnings) ? options.warnings : [],
    artifactSummary: options.artifactSummary || {
      fileCount: 0,
      directoryCount: 0,
      totalBytes: 0,
      extensions: [],
    },
    metadata: options.metadata || null,
    metadataSource: options.metadataSource || null,
  };
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => readString(item)).filter(Boolean)
    : [];
}

function readPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function getErrorMessage(error, fallback) {
  return error && error.message ? String(error.message) : fallback;
}

module.exports = {
  ModelManager,
  DEFAULT_METADATA_FILENAMES,
  STATUS,
};
