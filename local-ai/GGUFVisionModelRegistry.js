"use strict";

const fs = require("fs/promises");
const path = require("path");
const {
  GGUF_VISION_MANIFEST_FILENAMES,
  inspectGGUFVisionModel,
} = require("./GGUFVisionModelManifest.js");

async function discoverGGUFVisionModels(options = {}) {
  return await inspectManagedModelRoots(options.modelRoots, options);
}

async function inspectManagedModelRoots(modelRoots, options = {}) {
  const fsImpl = options.fs || fs;
  const pathImpl = options.path || path;
  const inspectModel = options.inspectModel || inspectGGUFVisionModel;
  const result = {
    models: [],
    invalidCandidates: [],
    scannedRoots: [],
    warnings: [],
  };
  const seenRoots = new Set();

  for (const modelRoot of normalizeModelRoots(modelRoots)) {
    const resolvedRoot = pathImpl.resolve(modelRoot);
    const canonicalRoot = await safeRealpath(fsImpl, resolvedRoot);
    if (!canonicalRoot) {
      result.warnings.push(`Model root does not exist or is unreadable: ${resolvedRoot}`);
      continue;
    }

    const rootStat = await safeStat(fsImpl, canonicalRoot);
    if (!rootStat || !rootStat.isDirectory()) {
      result.warnings.push(`Model root is not a directory: ${resolvedRoot}`);
      continue;
    }

    if (seenRoots.has(canonicalRoot)) {
      continue;
    }
    seenRoots.add(canonicalRoot);
    result.scannedRoots.push(canonicalRoot);

    await inspectCandidate(canonicalRoot, canonicalRoot, {
      fsImpl,
      pathImpl,
      inspectModel,
      result,
    });

    let entries;
    try {
      entries = await fsImpl.readdir(canonicalRoot, { withFileTypes: true });
    } catch (error) {
      result.warnings.push(`Could not read model root: ${canonicalRoot}`);
      continue;
    }

    for (const entry of entries) {
      if (!entry || typeof entry.name !== "string" || !entry.name || (!entry.isDirectory() && !entry.isSymbolicLink())) {
        continue;
      }

      const candidatePath = pathImpl.resolve(canonicalRoot, entry.name);
      if (!isPathInside(canonicalRoot, candidatePath, pathImpl)) {
        result.warnings.push(`Skipped candidate outside model root: ${candidatePath}`);
        continue;
      }

      const canonicalCandidate = await safeRealpath(fsImpl, candidatePath);
      if (!canonicalCandidate) {
        result.warnings.push(`Could not resolve model candidate: ${candidatePath}`);
        continue;
      }

      if (!isPathInside(canonicalRoot, canonicalCandidate, pathImpl)) {
        result.warnings.push(`Skipped symlinked model candidate outside model root: ${candidatePath}`);
        continue;
      }

      const candidateStat = await safeStat(fsImpl, canonicalCandidate);
      if (!candidateStat || !candidateStat.isDirectory()) {
        result.warnings.push(`Model candidate is not a readable directory: ${candidatePath}`);
        continue;
      }

      await inspectCandidate(canonicalCandidate, canonicalRoot, {
        fsImpl,
        pathImpl,
        inspectModel,
        result,
      });
    }
  }

  appendDuplicateModelWarnings(result);
  return result;
}

function selectRegisteredModel(models, selectedModelId) {
  const modelId = readString(selectedModelId);
  const matchingModels = Array.isArray(models)
    ? models.filter((model) => model && model.supported === true && model.modelId === modelId)
    : [];

  if (!modelId) {
    return createSelectionResult({ reason: "A model ID is required." });
  }

  if (matchingModels.length === 0) {
    return createSelectionResult({
      modelId,
      reason: `No registered model was found for ID: ${modelId}`,
    });
  }

  if (matchingModels.length > 1) {
    return createSelectionResult({
      modelId,
      duplicateModelId: modelId,
      conflictingDirectories: matchingModels.map((model) => model.modelDirectory),
      reason: `Multiple registered models use ID: ${modelId}`,
    });
  }

  return createSelectionResult({
    available: true,
    modelId,
    model: matchingModels[0],
  });
}

async function inspectCandidate(modelDirectory, modelRoot, options) {
  const { fsImpl, pathImpl, inspectModel, result } = options;
  let inspection;
  try {
    inspection = await inspectModel(modelDirectory);
  } catch (error) {
    result.invalidCandidates.push({
      modelDirectory,
      errors: [`Could not inspect model candidate: ${getErrorMessage(error)}`],
    });
    return;
  }

  if (inspection && inspection.supported === true) {
    result.models.push(mapInspectionToModel(inspection, modelDirectory));
    return;
  }

  if (await hasManifest(modelDirectory, fsImpl, pathImpl)) {
    result.invalidCandidates.push({
      modelDirectory,
      errors: Array.isArray(inspection && inspection.errors) && inspection.errors.length > 0
        ? Array.from(inspection.errors)
        : ["Model candidate is invalid."],
    });
  }
}

async function hasManifest(modelDirectory, fsImpl, pathImpl) {
  for (const fileName of GGUF_VISION_MANIFEST_FILENAMES) {
    const manifestStat = await safeStat(fsImpl, pathImpl.join(modelDirectory, fileName));
    if (manifestStat && manifestStat.isFile()) {
      return true;
    }
  }
  return false;
}

function mapInspectionToModel(inspection, modelDirectory) {
  return {
    supported: true,
    modelId: inspection.modelId,
    displayName: inspection.displayName,
    modelDirectory,
    manifestPath: inspection.manifestPath,
    modelPath: inspection.modelPath,
    mmprojPath: inspection.mmprojPath,
    contextSize: inspection.contextSize,
    recommendedMaxTokens: inspection.recommendedMaxTokens,
    capabilities: Array.isArray(inspection.capabilities) ? Array.from(inspection.capabilities) : [],
    provider: inspection.provider,
    modelFamily: inspection.modelFamily,
    runtimeArgs: Array.isArray(inspection.runtimeArgs) ? Array.from(inspection.runtimeArgs) : [],
    warnings: Array.isArray(inspection.warnings) ? Array.from(inspection.warnings) : [],
  };
}

function appendDuplicateModelWarnings(result) {
  const directoriesByModelId = new Map();
  for (const model of result.models) {
    const directories = directoriesByModelId.get(model.modelId) || [];
    directories.push(model.modelDirectory);
    directoriesByModelId.set(model.modelId, directories);
  }

  for (const [modelId, directories] of directoriesByModelId) {
    if (directories.length > 1) {
      result.warnings.push(`Duplicate registered model ID "${modelId}": ${directories.join(", ")}`);
    }
  }
}

function createSelectionResult(options = {}) {
  return {
    available: Boolean(options.available),
    modelId: options.modelId || "",
    model: options.model || null,
    duplicateModelId: options.duplicateModelId || null,
    conflictingDirectories: Array.isArray(options.conflictingDirectories)
      ? Array.from(options.conflictingDirectories)
      : [],
    reason: options.reason || null,
  };
}

function normalizeModelRoots(modelRoots) {
  const roots = Array.isArray(modelRoots) ? modelRoots : [modelRoots];
  return roots.map(readString).filter(Boolean);
}

function isPathInside(rootPath, targetPath, pathImpl) {
  const relativePath = pathImpl.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !pathImpl.isAbsolute(relativePath));
}

async function safeStat(fsImpl, targetPath) {
  try {
    return await fsImpl.stat(targetPath);
  } catch (error) {
    return null;
  }
}

async function safeRealpath(fsImpl, targetPath) {
  try {
    return await fsImpl.realpath(targetPath);
  } catch (error) {
    return "";
  }
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function getErrorMessage(error) {
  return error && error.message ? String(error.message) : String(error);
}

module.exports = {
  discoverGGUFVisionModels,
  inspectManagedModelRoots,
  selectRegisteredModel,
};
