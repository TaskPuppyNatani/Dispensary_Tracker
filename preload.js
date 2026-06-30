"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("localAI", {
  listModels: () => ipcRenderer.invoke("localAI:listModels"),
  getModelMetadata: (modelId) => ipcRenderer.invoke("localAI:getModelMetadata", String(modelId || "")),
  getInstallationStatus: (modelId) => ipcRenderer.invoke("localAI:getInstallationStatus", String(modelId || "")),
});
