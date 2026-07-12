"use strict";

const PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE = "external-openai-compatible";
const PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE = "managed-openai-compatible";

async function resolveLocalAIProviderSelection(options = {}) {
  const env = readPlainObject(options.env);
  const rawProviderMode = readString(env.LOCAL_AI_PROVIDER_MODE).toLowerCase();
  const directModelDirectory = readString(env.LOCAL_AI_MODEL_DIR);
  const requestedMode = readRequestedMode(rawProviderMode);

  if (rawProviderMode && !requestedMode) {
    return createSelectionResult({
      requestedMode: null,
      resolvedMode: PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
      selectionSource: "invalid-provider-mode",
      reasonCode: "invalid-provider-mode",
      reason: `Unsupported LOCAL_AI_PROVIDER_MODE: ${rawProviderMode}`,
      warnings: ["Managed runtime inspection was skipped because the provider-mode override is invalid."],
    });
  }

  if (requestedMode === PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE) {
    return createSelectionResult({
      requestedMode,
      resolvedMode: PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
      selectionSource: "explicit-external-mode",
      reasonCode: "explicit-external-mode",
      reason: "External OpenAI-compatible mode was explicitly requested.",
    });
  }

  const runtimeInspection = await inspectRuntime(options, env);
  const modelResolution = directModelDirectory
    ? await inspectDirectModel(options, directModelDirectory)
    : await inspectAutomaticModels(options);
  const warnings = [...runtimeInspection.warnings, ...modelResolution.warnings];

  if (requestedMode === PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE) {
    return createExplicitManagedResult({
      requestedMode,
      runtimeInspection,
      modelResolution,
      warnings,
    });
  }

  return createAutomaticResult({
    directModelDirectory,
    runtimeInspection,
    modelResolution,
    warnings,
  });
}

async function inspectRuntime(options, env) {
  if (typeof options.resolveExecutablePath !== "function" || typeof options.validateExecutable !== "function") {
    throw new Error("resolveExecutablePath and validateExecutable functions are required.");
  }

  let resolution;
  try {
    resolution = await options.resolveExecutablePath({
      env,
      platform: readString(options.platform),
      arch: readString(options.arch),
      resourcesPath: readString(options.resourcesPath),
      baseDirectory: readString(options.baseDirectory),
    });
  } catch (error) {
    return {
      available: false,
      reasonCode: "managed-runtime-missing",
      reason: `Could not resolve managed runtime: ${getErrorMessage(error)}`,
      resolution: null,
      validation: null,
      warnings: [],
    };
  }

  const normalizedResolution = normalizeRuntimeResolution(resolution);
  if (!normalizedResolution.found || !normalizedResolution.executablePath) {
    return {
      available: false,
      reasonCode: "managed-runtime-missing",
      reason: normalizedResolution.reason || "No managed llama-server executable path could be resolved.",
      resolution: normalizedResolution,
      validation: null,
      warnings: [],
    };
  }

  let validation;
  try {
    validation = await options.validateExecutable(normalizedResolution.executablePath, {
      platform: readString(options.platform),
    });
  } catch (error) {
    validation = {
      valid: false,
      executablePath: normalizedResolution.executablePath,
      platform: readString(options.platform),
      exists: false,
      executable: false,
      reason: `Could not validate managed runtime: ${getErrorMessage(error)}`,
      warnings: [],
    };
  }

  const normalizedValidation = normalizeRuntimeValidation(validation);
  return {
    available: normalizedValidation.valid,
    reasonCode: normalizedValidation.valid ? null : "managed-runtime-invalid",
    reason: normalizedValidation.valid ? null : normalizedValidation.reason || "Managed runtime executable is invalid.",
    resolution: normalizedResolution,
    validation: normalizedValidation,
    warnings: normalizedValidation.warnings,
  };
}

async function inspectDirectModel(options, modelDirectory) {
  if (typeof options.inspectModel !== "function") {
    throw new Error("inspectModel is required when LOCAL_AI_MODEL_DIR is supplied.");
  }

  try {
    const inspection = await options.inspectModel(modelDirectory);
    const normalizedModel = normalizeInspectedModel(inspection, modelDirectory, "explicit-model-directory");
    return normalizedModel
      ? {
        available: true,
        reasonCode: null,
        reason: null,
        selectedModel: normalizedModel,
        validModelCandidates: [normalizedModel],
        invalidCandidates: [],
        warnings: normalizeWarnings(inspection && inspection.warnings),
      }
      : {
        available: false,
        reasonCode: "direct-model-invalid",
        reason: readFirstError(inspection) || "The explicitly configured managed model is invalid.",
        selectedModel: null,
        validModelCandidates: [],
        invalidCandidates: [{ modelDirectory, errors: normalizeErrors(inspection && inspection.errors) }],
        warnings: normalizeWarnings(inspection && inspection.warnings),
      };
  } catch (error) {
    return {
      available: false,
      reasonCode: "direct-model-invalid",
      reason: `Could not inspect the explicitly configured managed model: ${getErrorMessage(error)}`,
      selectedModel: null,
      validModelCandidates: [],
      invalidCandidates: [{ modelDirectory, errors: [getErrorMessage(error)] }],
      warnings: [],
    };
  }
}

async function inspectAutomaticModels(options) {
  if (typeof options.discoverModels !== "function" || typeof options.selectRegisteredModel !== "function") {
    throw new Error("discoverModels and selectRegisteredModel are required for automatic managed selection.");
  }

  let discovery;
  try {
    discovery = await options.discoverModels({
      modelRoots: Array.isArray(options.automaticModelRoots) ? Array.from(options.automaticModelRoots) : [],
    });
  } catch (error) {
    return {
      available: false,
      reasonCode: "no-valid-managed-models",
      reason: `Could not discover managed models: ${getErrorMessage(error)}`,
      selectedModel: null,
      validModelCandidates: [],
      invalidCandidates: [],
      warnings: [],
    };
  }

  const validModelCandidates = Array.isArray(discovery && discovery.models)
    ? discovery.models.map((model) => normalizeRegistryModel(model, "single-managed-model")).filter(Boolean)
    : [];
  const invalidCandidates = normalizeInvalidCandidates(discovery && discovery.invalidCandidates);
  const warnings = normalizeWarnings(discovery && discovery.warnings);

  if (validModelCandidates.length === 0) {
    return {
      available: false,
      reasonCode: "no-valid-managed-models",
      reason: "No valid managed GGUF vision models were discovered.",
      selectedModel: null,
      validModelCandidates,
      invalidCandidates,
      warnings,
    };
  }

  if (validModelCandidates.length > 1) {
    return {
      available: false,
      reasonCode: "multiple-managed-models",
      reason: "Multiple valid managed GGUF vision models were discovered; automatic selection is ambiguous.",
      selectedModel: null,
      validModelCandidates,
      invalidCandidates,
      warnings,
    };
  }

  const candidate = validModelCandidates[0];
  const selection = options.selectRegisteredModel([candidate], candidate.modelId);
  if (!selection || selection.available !== true || !selection.model) {
    return {
      available: false,
      reasonCode: "no-valid-managed-models",
      reason: readString(selection && selection.reason) || "The discovered managed model could not be selected.",
      selectedModel: null,
      validModelCandidates,
      invalidCandidates,
      warnings,
    };
  }

  return {
    available: true,
    reasonCode: null,
    reason: null,
    selectedModel: normalizeRegistryModel(selection.model, "single-managed-model"),
    validModelCandidates,
    invalidCandidates,
    warnings,
  };
}

function createExplicitManagedResult({ requestedMode, runtimeInspection, modelResolution, warnings }) {
  const failure = !runtimeInspection.available ? runtimeInspection : !modelResolution.available ? modelResolution : null;
  return createSelectionResult({
    requestedMode,
    resolvedMode: PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
    selectionSource: "explicit-managed-mode",
    reasonCode: failure ? failure.reasonCode : "explicit-managed-mode",
    reason: failure ? failure.reason : "Managed OpenAI-compatible mode was explicitly requested.",
    runtimeInspection: toSerializableRuntimeInspection(runtimeInspection),
    selectedModel: modelResolution.selectedModel,
    validModelCandidates: modelResolution.validModelCandidates,
    invalidCandidates: modelResolution.invalidCandidates,
    warnings,
  });
}

function createAutomaticResult({ directModelDirectory, runtimeInspection, modelResolution, warnings }) {
  if (!runtimeInspection.available) {
    return createSelectionResult({
      requestedMode: null,
      resolvedMode: PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
      selectionSource: "external-fallback",
      reasonCode: runtimeInspection.reasonCode,
      reason: runtimeInspection.reason,
      runtimeInspection: toSerializableRuntimeInspection(runtimeInspection),
      selectedModel: null,
      validModelCandidates: modelResolution.validModelCandidates,
      invalidCandidates: modelResolution.invalidCandidates,
      warnings,
    });
  }

  if (!modelResolution.available) {
    return createSelectionResult({
      requestedMode: null,
      resolvedMode: PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
      selectionSource: "external-fallback",
      reasonCode: modelResolution.reasonCode,
      reason: modelResolution.reason,
      runtimeInspection: toSerializableRuntimeInspection(runtimeInspection),
      selectedModel: null,
      validModelCandidates: modelResolution.validModelCandidates,
      invalidCandidates: modelResolution.invalidCandidates,
      warnings,
    });
  }

  return createSelectionResult({
    requestedMode: null,
    resolvedMode: PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
    selectionSource: directModelDirectory ? "explicit-model-directory" : "single-managed-model",
    reasonCode: directModelDirectory ? "explicit-model-directory" : "single-managed-model",
    reason: directModelDirectory
      ? "The explicitly configured managed model and runtime are valid."
      : "One valid managed GGUF vision model was discovered with a valid runtime.",
    runtimeInspection: toSerializableRuntimeInspection(runtimeInspection),
    selectedModel: modelResolution.selectedModel,
    validModelCandidates: modelResolution.validModelCandidates,
    invalidCandidates: modelResolution.invalidCandidates,
    warnings,
  });
}

function createSelectionResult(options = {}) {
  return {
    requestedMode: options.requestedMode || null,
    resolvedMode: options.resolvedMode || PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
    selectionSource: options.selectionSource || "external-fallback",
    reasonCode: options.reasonCode || "external-fallback",
    reason: options.reason || null,
    runtimeInspection: options.runtimeInspection || null,
    selectedModel: options.selectedModel || null,
    validModelCandidates: Array.isArray(options.validModelCandidates) ? options.validModelCandidates : [],
    invalidCandidates: Array.isArray(options.invalidCandidates) ? options.invalidCandidates : [],
    warnings: Array.isArray(options.warnings) ? options.warnings : [],
  };
}

function normalizeInspectedModel(inspection, modelDirectory, selectionSource) {
  if (!inspection || inspection.supported !== true) {
    return null;
  }
  return {
    supported: true,
    modelId: readString(inspection.modelId),
    modelDirectory: readString(inspection.modelRoot) || modelDirectory,
    manifestPath: readString(inspection.manifestPath),
    modelPath: readString(inspection.modelPath),
    mmprojPath: readString(inspection.mmprojPath),
    displayName: readString(inspection.displayName),
    selectionSource,
  };
}

function normalizeRegistryModel(model, selectionSource) {
  if (!model || model.supported !== true) {
    return null;
  }
  return {
    supported: true,
    modelId: readString(model.modelId),
    modelDirectory: readString(model.modelDirectory),
    manifestPath: readString(model.manifestPath),
    modelPath: readString(model.modelPath),
    mmprojPath: readString(model.mmprojPath),
    displayName: readString(model.displayName),
    selectionSource,
  };
}

function normalizeRuntimeResolution(resolution) {
  const source = readPlainObject(resolution);
  return {
    found: source.found === true,
    source: readString(source.source),
    executablePath: readString(source.executablePath),
    reason: readString(source.reason) || null,
    platform: readString(source.platform),
    arch: readString(source.arch),
  };
}

function normalizeRuntimeValidation(validation) {
  const source = readPlainObject(validation);
  return {
    valid: source.valid === true,
    executablePath: readString(source.executablePath),
    platform: readString(source.platform),
    exists: source.exists === true,
    executable: source.executable === true,
    reason: readString(source.reason) || null,
    warnings: normalizeWarnings(source.warnings),
  };
}

function toSerializableRuntimeInspection(runtimeInspection) {
  return {
    available: runtimeInspection.available === true,
    reasonCode: runtimeInspection.reasonCode || null,
    reason: runtimeInspection.reason || null,
    resolution: runtimeInspection.resolution || null,
    validation: runtimeInspection.validation || null,
  };
}

function normalizeInvalidCandidates(candidates) {
  return Array.isArray(candidates)
    ? candidates.map((candidate) => ({
      modelDirectory: readString(candidate && candidate.modelDirectory),
      errors: normalizeErrors(candidate && candidate.errors),
    }))
    : [];
}

function normalizeWarnings(warnings) {
  return Array.isArray(warnings) ? warnings.map(readString).filter(Boolean) : [];
}

function normalizeErrors(errors) {
  return Array.isArray(errors) ? errors.map(readString).filter(Boolean) : [];
}

function readFirstError(inspection) {
  return normalizeErrors(inspection && inspection.errors)[0] || "";
}

function readRequestedMode(rawMode) {
  if (rawMode === PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE || rawMode === PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE) {
    return rawMode;
  }
  return null;
}

function readPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function getErrorMessage(error) {
  return error && error.message ? String(error.message) : String(error);
}

module.exports = {
  PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
  PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
  resolveLocalAIProviderSelection,
};
