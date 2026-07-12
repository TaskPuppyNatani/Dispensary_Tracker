"use strict";

// Production entries remain empty until every downloadable artifact field is
// verified from an authoritative release source.
const OFFICIAL_LOCAL_AI_MODELS = Object.freeze([]);

function listOfficialLocalAIModels() {
  return OFFICIAL_LOCAL_AI_MODELS.map(cloneCatalogModel);
}

function getOfficialLocalAIModel(modelId) {
  return findCatalogModel(OFFICIAL_LOCAL_AI_MODELS, modelId);
}

function findCatalogModel(catalogModels, modelId) {
  const normalizedId = readString(modelId);
  if (!normalizedId || !Array.isArray(catalogModels)) {
    return null;
  }

  const match = catalogModels.find((model) => model && model.modelId === normalizedId);
  return match ? cloneCatalogModel(match) : null;
}

function resolveRegisteredModelCatalogEntry(registeredModel, catalogModels = OFFICIAL_LOCAL_AI_MODELS) {
  const modelId = readString(registeredModel && registeredModel.modelId);
  const catalogModel = findCatalogModel(catalogModels, modelId);

  if (catalogModel) {
    return {
      kind: "catalog",
      modelId,
      registeredModel: registeredModel || null,
      catalogModel,
      warning: null,
    };
  }

  return {
    kind: "custom",
    modelId,
    registeredModel: registeredModel || null,
    catalogModel: null,
    warning: modelId
      ? `Registered model is not in the official Local AI catalog: ${modelId}`
      : "Registered model does not provide a canonical model ID.",
  };
}

function cloneCatalogModel(model) {
  return {
    ...model,
    download: clonePlainObject(model.download),
    storage: clonePlainObject(model.storage),
    memory: clonePlainObject(model.memory),
    capabilities: Array.isArray(model.capabilities) ? Array.from(model.capabilities) : [],
  };
}

function clonePlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  OFFICIAL_LOCAL_AI_MODELS,
  listOfficialLocalAIModels,
  getOfficialLocalAIModel,
  findCatalogModel,
  resolveRegisteredModelCatalogEntry,
};
