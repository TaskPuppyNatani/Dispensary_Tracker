"use strict";

const path = require("path");

const DEFAULT_LOCAL_AI_SETTINGS = Object.freeze({
  aiEnabled: false,
  modelDirectory: "models",
  selectedModel: "",
  autoReviewEnabled: false,
});

function createLocalAISettings(overrides = {}) {
  return {
    ...DEFAULT_LOCAL_AI_SETTINGS,
    ...(overrides && typeof overrides === "object" ? overrides : {}),
  };
}

function resolveModelDirectory(settings = {}, baseDirectory = process.cwd()) {
  const configuredDirectory = settings && typeof settings.modelDirectory === "string"
    ? settings.modelDirectory.trim()
    : "";
  const modelDirectory = configuredDirectory || DEFAULT_LOCAL_AI_SETTINGS.modelDirectory;

  if (path.isAbsolute(modelDirectory)) {
    return path.normalize(modelDirectory);
  }

  return path.resolve(baseDirectory, modelDirectory);
}

module.exports = {
  DEFAULT_LOCAL_AI_SETTINGS,
  createLocalAISettings,
  resolveModelDirectory,
};
