const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { createLocalAISettings, resolveModelDirectory } = require("./local-ai/config.js");
const {
  PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
  PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE,
  resolveLocalAIProviderMode,
  buildOpenAICompatibleProviderOptions,
  ensureManagedOpenAICompatibleRuntime,
  stopManagedRuntime,
} = require("./local-ai/ManagedOpenAICompatibleSupport.js");
const { ModelManager } = require("./local-ai/ModelManager.js");
const { inspectGGUFVisionModel } = require("./local-ai/GGUFVisionModelManifest.js");
const { LocalAIRuntimeManager } = require("./local-ai/LocalAIRuntimeManager.js");
const { MainProcessReceiptVisionProvider } = require("./local-ai/ReceiptVisionProvider.js");
const { OpenAICompatibleReceiptVisionProvider } = require("./local-ai/OpenAICompatibleReceiptVisionProvider.js");
const { SmolVLMModelAdapter } = require("./local-ai/adapters/SmolVLMModelAdapter.js");

let modelManager = null;
let receiptVisionProvider = null;
let receiptVisionProviderType = "";
let localAIRuntimeManager = null;

const DEFAULT_RECEIPT_MODEL_DIRECTORY_NAME = "SmolVLM2-500M";
const RECEIPT_PROVIDER_OPENAI_COMPATIBLE = "openai-compatible";
const RECEIPT_PROVIDER_SMOLVLM = "smolvlm";

function getModelManager() {
  if (!modelManager) {
    const localAISettings = createLocalAISettings();
    const modelRootPath = resolveModelDirectory(localAISettings, __dirname);
    modelManager = new ModelManager({ modelRootPath });
  }

  return modelManager;
}

function getLocalAIRuntimeManager(options = {}) {
  if (!localAIRuntimeManager) {
    localAIRuntimeManager = new LocalAIRuntimeManager(options);
  }

  return localAIRuntimeManager;
}

function stopLocalAIRuntimeManager() {
  stopManagedRuntime(localAIRuntimeManager).catch((error) => {
    console.warn(
      "Failed to stop Local AI runtime:",
      error && error.message ? error.message : error
    );
  });
}

function getReceiptVisionProvider(localAISettings = createLocalAISettings()) {
  const providerType = getConfiguredReceiptProviderType(localAISettings);
  const providerMode = providerType === RECEIPT_PROVIDER_OPENAI_COMPATIBLE
    ? resolveLocalAIProviderMode(process.env)
    : providerType;
  const providerKey = `${providerType}:${providerMode}`;

  if (!receiptVisionProvider || receiptVisionProviderType !== providerKey) {
    receiptVisionProvider = providerType === RECEIPT_PROVIDER_OPENAI_COMPATIBLE
      ? new OpenAICompatibleReceiptVisionProvider(createOpenAICompatibleProviderOptions(localAISettings))
      : new MainProcessReceiptVisionProvider();
    receiptVisionProviderType = providerKey;
  }

  return receiptVisionProvider;
}

function getConfiguredReceiptProviderType(localAISettings = createLocalAISettings()) {
  const providerType = String(localAISettings.receiptVisionProvider || "").trim().toLowerCase();
  return providerType === RECEIPT_PROVIDER_SMOLVLM
    ? RECEIPT_PROVIDER_SMOLVLM
    : RECEIPT_PROVIDER_OPENAI_COMPATIBLE;
}

function createOpenAICompatibleProviderOptions(localAISettings = createLocalAISettings()) {
  return buildOpenAICompatibleProviderOptions(localAISettings);
}

function resolveConfiguredReceiptModelPath() {
  const localAISettings = createLocalAISettings();
  const modelRootPath = resolveModelDirectory(localAISettings, __dirname);
  const selectedModel = String(localAISettings.selectedModel || "").trim()
    || DEFAULT_RECEIPT_MODEL_DIRECTORY_NAME;

  return path.isAbsolute(selectedModel)
    ? path.normalize(selectedModel)
    : path.resolve(modelRootPath, selectedModel);
}

async function inspectConfiguredReceiptModel() {
  const modelPath = resolveConfiguredReceiptModelPath();
  const adapter = new SmolVLMModelAdapter();
  return await adapter.inspectModel(modelPath);
}

async function ensureManagedOpenAICompatibleState(localAISettings = createLocalAISettings()) {
  return await ensureManagedOpenAICompatibleRuntime({
    env: process.env,
    localAISettings,
    runtimeManager: getLocalAIRuntimeManager(),
    inspectModel: inspectGGUFVisionModel,
    app,
    process,
    path,
    baseDirectory: __dirname,
  });
}

async function getReceiptReviewStatus() {
  const localAISettings = createLocalAISettings();
  const providerType = getConfiguredReceiptProviderType(localAISettings);
  const providerMode = providerType === RECEIPT_PROVIDER_OPENAI_COMPATIBLE
    ? resolveLocalAIProviderMode(process.env)
    : null;

  if (
    providerType === RECEIPT_PROVIDER_OPENAI_COMPATIBLE
    && providerMode === PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE
  ) {
    const managed = await ensureManagedOpenAICompatibleState(localAISettings);
    const provider = getReceiptVisionProvider(localAISettings);
    const providerStatus = provider.initialized ? provider.getStatus() : null;

    return {
      available: Boolean(managed.available),
      initialized: Boolean(provider.initialized && managed.available),
      modelId: managed.inspection && managed.inspection.modelId ? managed.inspection.modelId : "",
      displayName: managed.inspection && managed.inspection.displayName ? managed.inspection.displayName : "",
      providerType,
      providerMode,
      backend: "managed-openai-compatible",
      endpointUrl: managed.runtimeStatus && managed.runtimeStatus.chatCompletionsUrl
        ? managed.runtimeStatus.chatCompletionsUrl
        : "",
      reason: managed.available ? null : managed.reason || "managed_openai_compatible_provider_unavailable",
      missingFiles: [],
      warnings: Array.isArray(managed.warnings) ? managed.warnings : [],
      managedRuntimeStatus: managed.runtimeStatus,
      runtimeLogs: managed.runtimeStatus && Array.isArray(managed.runtimeStatus.logs)
        ? managed.runtimeStatus.logs
        : [],
      healthStatus: providerStatus && providerStatus.healthStatus ? providerStatus.healthStatus : null,
    };
  }

  if (receiptVisionProvider && receiptVisionProvider.initialized) {
    const status = receiptVisionProvider.getStatus();
    return {
      available: true,
      initialized: true,
      modelId: status.modelId || "",
      displayName: "",
      providerType,
      providerMode: providerMode || PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
      backend: status.backend || providerType,
      endpointUrl: status.baseUrl || "",
      reason: null,
      missingFiles: [],
      warnings: status.healthStatus && Array.isArray(status.healthStatus.warnings)
        ? status.healthStatus.warnings
        : [],
      managedRuntimeStatus: null,
      runtimeLogs: [],
    };
  }

  if (providerType === RECEIPT_PROVIDER_OPENAI_COMPATIBLE) {
    try {
      const provider = getReceiptVisionProvider(localAISettings);
      const health = await provider.getHealthStatus(createOpenAICompatibleProviderOptions(localAISettings));
      return {
        available: Boolean(health.available),
        initialized: false,
        modelId: health.modelId || "",
        displayName: "",
        providerType,
        providerMode: PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
        backend: health.backend || "openai-compatible",
        endpointUrl: health.baseUrl || "",
        reason: health.available ? null : health.reason || "openai_compatible_provider_unavailable",
        missingFiles: [],
        warnings: Array.isArray(health.warnings) ? health.warnings : [],
        managedRuntimeStatus: null,
        runtimeLogs: [],
      };
    } catch (error) {
      return {
        available: false,
        initialized: false,
        modelId: "",
        displayName: "",
        providerType,
        providerMode: PROVIDER_MODE_EXTERNAL_OPENAI_COMPATIBLE,
        backend: "openai-compatible",
        endpointUrl: "",
        reason: error && error.message ? error.message : String(error),
        missingFiles: [],
        warnings: [],
        managedRuntimeStatus: null,
        runtimeLogs: [],
      };
    }
  }

  try {
    const inspection = await inspectConfiguredReceiptModel();
    return {
      available: Boolean(inspection.supported),
      initialized: false,
      modelId: inspection.modelId || "",
      displayName: "",
      providerType,
      providerMode: null,
      backend: "onnx",
      endpointUrl: "",
      reason: inspection.supported ? null : "configured_model_unavailable",
      missingFiles: Array.isArray(inspection.missingFiles) ? inspection.missingFiles : [],
      warnings: Array.isArray(inspection.warnings) ? inspection.warnings : [],
      managedRuntimeStatus: null,
      runtimeLogs: [],
    };
  } catch (error) {
    return {
      available: false,
      initialized: false,
      modelId: "",
      displayName: "",
      providerType,
      providerMode: null,
      backend: "onnx",
      endpointUrl: "",
      reason: error && error.message ? error.message : String(error),
      missingFiles: [],
      warnings: [],
      managedRuntimeStatus: null,
      runtimeLogs: [],
    };
  }
}

function readImageBufferFromPayload(payload = {}) {
  const imageBuffer = payload && payload.imageBuffer;

  if (Buffer.isBuffer(imageBuffer)) {
    return imageBuffer;
  }

  if (imageBuffer instanceof ArrayBuffer) {
    return Buffer.from(imageBuffer);
  }

  if (ArrayBuffer.isView(imageBuffer)) {
    return Buffer.from(imageBuffer.buffer, imageBuffer.byteOffset, imageBuffer.byteLength);
  }

  throw new Error("localAI:analyzeReceipt requires imageBuffer as an ArrayBuffer or typed array.");
}

function readReceiptAnalysisPayload(payload = {}) {
  const providerInput = {
    imageBuffer: readImageBufferFromPayload(payload),
  };

  for (const field of ["maxNewTokens", "stopTokenIds", "imageLayouts", "deterministicContext", "ocrContext"]) {
    if (
      payload
      && Object.prototype.hasOwnProperty.call(payload, field)
      && payload[field] !== undefined
    ) {
      providerInput[field] = payload[field];
    }
  }

  return providerInput;
}

function registerLocalAIHandlers() {
  ipcMain.handle("localAI:listModels", async () => {
    return await getModelManager().listModels();
  });

  ipcMain.handle("localAI:getModelMetadata", async (_event, modelId) => {
    return await getModelManager().getModelMetadata(String(modelId || ""));
  });

  ipcMain.handle("localAI:getInstallationStatus", async (_event, modelId) => {
    return await getModelManager().getInstallationStatus(String(modelId || ""));
  });

  ipcMain.handle("localAI:getReceiptReviewStatus", async () => {
    return await getReceiptReviewStatus();
  });

  ipcMain.handle("localAI:analyzeReceipt", async (_event, payload = {}) => {
    const status = await getReceiptReviewStatus();
    if (!status.available) {
      throw new Error(status.reason || "Local AI receipt review is unavailable.");
    }

    const localAISettings = createLocalAISettings();
    const providerType = getConfiguredReceiptProviderType(localAISettings);
    const provider = getReceiptVisionProvider(localAISettings);
    if (
      providerType === RECEIPT_PROVIDER_OPENAI_COMPATIBLE
      && resolveLocalAIProviderMode(process.env) === PROVIDER_MODE_MANAGED_OPENAI_COMPATIBLE
    ) {
      const managed = await ensureManagedOpenAICompatibleState(localAISettings);
      if (!managed.available || !managed.providerOptions) {
        throw new Error(managed.reason || "Managed Local AI runtime is unavailable.");
      }
      await provider.initialize(managed.providerOptions);
    } else if (providerType === RECEIPT_PROVIDER_OPENAI_COMPATIBLE) {
      if (!provider.initialized) {
        await provider.initialize(createOpenAICompatibleProviderOptions(localAISettings));
      }
    } else if (!provider.initialized) {
      await provider.initialize({ modelPath: resolveConfiguredReceiptModelPath() });
    }

    return await provider.analyzeReceipt(readReceiptAnalysisPayload(payload));
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    icon: path.join(__dirname, "assets", "icon.ico"),
    webPreferences: {
      // contextIsolation: true and nodeIntegration: false are the correct
      // defaults for this app. The renderer is a pure web app — it uses
      // IndexedDB, fetch(), and Web Workers (for Tesseract OCR), none of
      // which require Node.js APIs in the renderer.
      //
      // Enabling nodeIntegration would inject Node's `module` and `exports`
      // globals, causing the Tesseract UMD bundle to export to module.exports
      // instead of window.Tesseract, which would silently break OCR.
      contextIsolation: true,
      nodeIntegration: false,

      // Allow Web Workers to be created from file:// URLs (needed for Tesseract).
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadFile("index.html");
}

app.whenReady().then(() => {
  registerLocalAIHandlers();
  createWindow();

  app.on("before-quit", stopLocalAIRuntimeManager);
  app.on("will-quit", stopLocalAIRuntimeManager);

  // On macOS re-create the window when the dock icon is clicked and no
  // other windows are open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS where it is conventional
// to keep the app running until the user explicitly quits.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
