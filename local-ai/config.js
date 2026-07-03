"use strict";

const path = require("path");

const DEFAULT_LOCAL_AI_SETTINGS = Object.freeze({
  aiEnabled: false,
  modelDirectory: "models",
  selectedModel: "",
  autoReviewEnabled: false,
  receiptVisionProvider: "openai-compatible",
  openAICompatibleBaseUrl: "http://localhost:1234/v1/chat/completions",
  openAICompatibleModel: "",
  openAICompatibleTimeoutMs: 120000,
  openAICompatibleTemperature: 0,
  openAICompatibleMaxNewTokens: 2048,
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
