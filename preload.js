"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function createReceiptAnalysisPayload(input = {}) {
  const payload = {
    imageBuffer: input.imageBuffer,
  };

  for (const field of ["maxNewTokens", "stopTokenIds", "imageLayouts", "deterministicContext", "ocrContext"]) {
    if (Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined) {
      payload[field] = input[field];
    }
  }

  return payload;
}

contextBridge.exposeInMainWorld("localAI", {
  listModels: () => ipcRenderer.invoke("localAI:listModels"),
  getModelMetadata: (modelId) => ipcRenderer.invoke("localAI:getModelMetadata", String(modelId || "")),
  getInstallationStatus: (modelId) => ipcRenderer.invoke("localAI:getInstallationStatus", String(modelId || "")),
  getReceiptReviewStatus: () => ipcRenderer.invoke("localAI:getReceiptReviewStatus"),
  analyzeReceipt: (input = {}) => ipcRenderer.invoke("localAI:analyzeReceipt", createReceiptAnalysisPayload(input)),
});
