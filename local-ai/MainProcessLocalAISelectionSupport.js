"use strict";

const {
  PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
  PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
  resolveLocalAIProviderSelection,
} = require("./LocalAIProviderModeResolver.js");

async function resolveMainProcessLocalAISelection(options = {}) {
  return await resolveLocalAIProviderSelection(options);
}

function isManagedSelectionStartupReady(selection) {
  return Boolean(
    selection
    && selection.resolvedMode === PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE
    && selection.runtimeInspection
    && selection.runtimeInspection.available === true
    && selection.selectedModel
    && readString(selection.selectedModel.modelDirectory)
  );
}

function getSelectedManagedModelDirectory(selection) {
  return isManagedSelectionStartupReady(selection)
    ? readString(selection.selectedModel.modelDirectory)
    : "";
}

function createReceiptVisionProviderCacheKey({ providerType, selection, externalOptions = {} } = {}) {
  const normalizedType = readString(providerType);
  if (normalizedType !== "openai-compatible") {
    return normalizedType || "unknown";
  }

  if (selection && selection.resolvedMode === PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE) {
    const model = selection.selectedModel || {};
    return [
      normalizedType,
      PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
      readString(model.modelId),
      readString(model.modelDirectory),
    ].join(":");
  }

  return [
    normalizedType,
    PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
    readString(externalOptions.baseUrl),
    readString(externalOptions.model),
  ].join(":");
}

function createProviderSelectionDiagnostics(selection) {
  if (!selection || typeof selection !== "object") {
    return null;
  }

  const selectedModel = selection.selectedModel && typeof selection.selectedModel === "object"
    ? {
      modelId: readString(selection.selectedModel.modelId),
      displayName: readString(selection.selectedModel.displayName),
      modelDirectory: readString(selection.selectedModel.modelDirectory),
      selectionSource: readString(selection.selectedModel.selectionSource),
    }
    : null;
  const invalidCandidates = Array.isArray(selection.invalidCandidates)
    ? selection.invalidCandidates.map((candidate) => ({
      modelDirectory: readString(candidate && candidate.modelDirectory),
      errors: Array.isArray(candidate && candidate.errors)
        ? candidate.errors.map(readString).filter(Boolean)
        : [],
    }))
    : [];

  return {
    requestedMode: readNullableString(selection.requestedMode),
    resolvedMode: readString(selection.resolvedMode),
    selectionSource: readString(selection.selectionSource),
    reasonCode: readString(selection.reasonCode),
    reason: readNullableString(selection.reason),
    selectedModel,
    validModelCandidateCount: Array.isArray(selection.validModelCandidates)
      ? selection.validModelCandidates.length
      : 0,
    invalidCandidates,
    warnings: Array.isArray(selection.warnings) ? selection.warnings.map(readString).filter(Boolean) : [],
  };
}

function readNullableString(value) {
  const normalized = readString(value);
  return normalized || null;
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
  PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
  resolveMainProcessLocalAISelection,
  isManagedSelectionStartupReady,
  getSelectedManagedModelDirectory,
  createReceiptVisionProviderCacheKey,
  createProviderSelectionDiagnostics,
};
