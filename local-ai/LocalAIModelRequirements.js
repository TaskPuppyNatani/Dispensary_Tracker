"use strict";

const {
  resolveRegisteredModelCatalogEntry,
} = require("./LocalAIModelCatalog.js");

function calculateModelStorageRequirements(catalogModel) {
  const download = readPlainObject(catalogModel && catalogModel.download);
  const storage = readPlainObject(catalogModel && catalogModel.storage);
  const modelDownloadBytes = readRequiredBytes(download.modelBytes, "download.modelBytes");
  const mmprojDownloadBytes = readRequiredBytes(download.mmprojBytes, "download.mmprojBytes");
  const installedBytes = readRequiredBytes(storage.installedBytes, "storage.installedBytes");
  const temporaryDownloadBytes = readRequiredBytes(
    storage.temporaryDownloadBytes,
    "storage.temporaryDownloadBytes"
  );
  const safetyBufferBytes = readRequiredBytes(storage.safetyBufferBytes, "storage.safetyBufferBytes");

  return {
    modelDownloadBytes,
    mmprojDownloadBytes,
    totalDownloadBytes: modelDownloadBytes + mmprojDownloadBytes,
    installedBytes,
    temporaryDownloadBytes,
    safetyBufferBytes,
    requiredFreeDiskBytes: installedBytes + temporaryDownloadBytes + safetyBufferBytes,
  };
}

function evaluateModelCompatibility(catalogModel, systemProfile = {}) {
  const storage = calculateModelStorageRequirements(catalogModel);
  const memory = readPlainObject(catalogModel && catalogModel.memory);
  const minimumRamBytes = readRequiredBytes(memory.minimumRamBytes, "memory.minimumRamBytes");
  const recommendedRamBytes = readRequiredBytes(memory.recommendedRamBytes, "memory.recommendedRamBytes");
  const minimumVramBytes = readRequiredBytes(memory.minimumVramBytes, "memory.minimumVramBytes");
  const recommendedVramBytes = readRequiredBytes(memory.recommendedVramBytes, "memory.recommendedVramBytes");
  const cpuSupported = catalogModel && catalogModel.cpuSupported === true;
  const warnings = [];
  const blockers = [];
  const diskAvailableBytes = readOptionalBytes(systemProfile.freeDiskBytes);
  const availableRamBytes = readOptionalBytes(systemProfile.availableRamBytes);
  const totalRamBytes = readOptionalBytes(systemProfile.totalRamBytes);
  const detectedRamBytes = availableRamBytes === null ? totalRamBytes : availableRamBytes;
  const detectedVramBytes = readOptionalBytes(systemProfile.vramBytes);
  const gpuDetected = systemProfile.gpuDetected === true;
  const gpuRuntimeCompatible = systemProfile.gpuRuntimeCompatible === true;

  if (availableRamBytes === null && totalRamBytes !== null) {
    warnings.push("Available RAM was not supplied; total RAM was used as an estimate.");
  }

  const disk = createCapacityStatus(storage.requiredFreeDiskBytes, diskAvailableBytes);
  const ram = createCapacityStatus(minimumRamBytes, detectedRamBytes, recommendedRamBytes);
  const vram = createCapacityStatus(minimumVramBytes, detectedVramBytes, recommendedVramBytes);

  if (disk.status !== "sufficient") {
    blockers.push(disk.status === "unknown"
      ? "Free disk space is unavailable."
      : "Insufficient free disk space for this model.");
  }
  if (ram.status !== "sufficient" && ram.status !== "recommended") {
    blockers.push(ram.status === "unknown"
      ? "Available memory is unavailable."
      : "Insufficient RAM for this model.");
  }

  const gpuCanRun = gpuDetected && gpuRuntimeCompatible && vram.status !== "unknown" && vram.status !== "insufficient";
  const gpuMeetsRecommended = gpuDetected && gpuRuntimeCompatible && vram.status === "recommended";
  let suggestedMode = "unsupported";

  if (gpuCanRun) {
    suggestedMode = gpuMeetsRecommended ? "gpu" : "partial-gpu";
  } else if (cpuSupported && ram.status !== "unknown" && ram.status !== "insufficient") {
    suggestedMode = "cpu";
    if (gpuDetected && !gpuRuntimeCompatible) {
      warnings.push("A GPU was detected, but no compatible runtime backend was supplied.");
    } else if (gpuDetected && vram.status === "insufficient") {
      warnings.push("GPU VRAM is insufficient; CPU execution is recommended.");
    }
  } else if (!cpuSupported && !gpuCanRun) {
    blockers.push("This model requires a compatible GPU runtime and sufficient VRAM.");
  }

  const canRunMinimum = suggestedMode !== "unsupported" && ram.status !== "unknown" && ram.status !== "insufficient";
  const compatible = canRunMinimum && disk.status === "sufficient";
  const meetsRecommended = compatible
    && ram.status === "recommended"
    && (suggestedMode === "cpu" || gpuMeetsRecommended);

  return {
    compatible,
    canRunMinimum,
    meetsRecommended,
    disk: {
      requiredBytes: storage.requiredFreeDiskBytes,
      availableBytes: diskAvailableBytes,
      status: disk.status,
    },
    ram: {
      minimumBytes: minimumRamBytes,
      recommendedBytes: recommendedRamBytes,
      detectedBytes: detectedRamBytes,
      status: ram.status,
    },
    vram: {
      minimumBytes: minimumVramBytes,
      recommendedBytes: recommendedVramBytes,
      detectedBytes: detectedVramBytes,
      status: vram.status,
    },
    suggestedMode,
    warnings,
    blockers,
  };
}

function evaluateRegisteredModelCompatibility(registeredModel, systemProfile = {}, catalogModels) {
  const catalogResolution = resolveRegisteredModelCatalogEntry(registeredModel, catalogModels);
  if (catalogResolution.kind === "custom") {
    return {
      kind: "custom",
      registeredModel: catalogResolution.registeredModel,
      catalogModel: null,
      compatibility: null,
      warnings: [catalogResolution.warning],
    };
  }

  return {
    kind: "catalog",
    registeredModel: catalogResolution.registeredModel,
    catalogModel: catalogResolution.catalogModel,
    compatibility: evaluateModelCompatibility(catalogResolution.catalogModel, systemProfile),
    warnings: [],
  };
}

function createCapacityStatus(minimumBytes, detectedBytes, recommendedBytes = null) {
  if (detectedBytes === null) {
    return { status: "unknown" };
  }
  if (detectedBytes < minimumBytes) {
    return { status: "insufficient" };
  }
  if (recommendedBytes !== null && detectedBytes >= recommendedBytes) {
    return { status: "recommended" };
  }
  return { status: "sufficient" };
}

function readRequiredBytes(value, label) {
  const bytes = readOptionalBytes(value);
  if (bytes === null) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return bytes;
}

function readOptionalBytes(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

module.exports = {
  calculateModelStorageRequirements,
  evaluateModelCompatibility,
  evaluateRegisteredModelCompatibility,
};
