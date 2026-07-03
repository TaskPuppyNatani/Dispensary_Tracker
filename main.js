const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { createLocalAISettings, resolveModelDirectory } = require("./local-ai/config.js");
const { ModelManager } = require("./local-ai/ModelManager.js");
const { MainProcessReceiptVisionProvider } = require("./local-ai/ReceiptVisionProvider.js");
const { OpenAICompatibleReceiptVisionProvider } = require("./local-ai/OpenAICompatibleReceiptVisionProvider.js");
const { SmolVLMModelAdapter } = require("./local-ai/adapters/SmolVLMModelAdapter.js");

let modelManager = null;
let receiptVisionProvider = null;
let receiptVisionProviderType = "";

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

function getReceiptVisionProvider(localAISettings = createLocalAISettings()) {
  const providerType = getConfiguredReceiptProviderType(localAISettings);

  if (!receiptVisionProvider || receiptVisionProviderType !== providerType) {
    receiptVisionProvider = providerType === RECEIPT_PROVIDER_OPENAI_COMPATIBLE
      ? new OpenAICompatibleReceiptVisionProvider(createOpenAICompatibleProviderOptions(localAISettings))
      : new MainProcessReceiptVisionProvider();
    receiptVisionProviderType = providerType;
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
  return {
    baseUrl: localAISettings.openAICompatibleBaseUrl,
    model: localAISettings.openAICompatibleModel,
    timeoutMs: localAISettings.openAICompatibleTimeoutMs,
    temperature: localAISettings.openAICompatibleTemperature,
  };
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

async function getReceiptReviewStatus() {
  const localAISettings = createLocalAISettings();
  const providerType = getConfiguredReceiptProviderType(localAISettings);

  if (receiptVisionProvider && receiptVisionProvider.initialized) {
    const status = receiptVisionProvider.getStatus();
    return {
      available: true,
      initialized: true,
      modelId: status.modelId || "",
      providerType,
      backend: status.backend || providerType,
      reason: null,
      missingFiles: [],
      warnings: status.healthStatus && Array.isArray(status.healthStatus.warnings)
        ? status.healthStatus.warnings
        : [],
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
        providerType,
        backend: health.backend || "openai-compatible",
        reason: health.available ? null : health.reason || "openai_compatible_provider_unavailable",
        missingFiles: [],
        warnings: Array.isArray(health.warnings) ? health.warnings : [],
      };
    } catch (error) {
      return {
        available: false,
        initialized: false,
        modelId: "",
        providerType,
        backend: "openai-compatible",
        reason: error && error.message ? error.message : String(error),
        missingFiles: [],
        warnings: [],
      };
    }
  }

  try {
    const inspection = await inspectConfiguredReceiptModel();
    return {
      available: Boolean(inspection.supported),
      initialized: false,
      modelId: inspection.modelId || "",
      providerType,
      backend: "onnx",
      reason: inspection.supported ? null : "configured_model_unavailable",
      missingFiles: Array.isArray(inspection.missingFiles) ? inspection.missingFiles : [],
      warnings: Array.isArray(inspection.warnings) ? inspection.warnings : [],
    };
  } catch (error) {
    return {
      available: false,
      initialized: false,
      modelId: "",
      providerType,
      backend: "onnx",
      reason: error && error.message ? error.message : String(error),
      missingFiles: [],
      warnings: [],
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
    if (!provider.initialized) {
      if (providerType === RECEIPT_PROVIDER_OPENAI_COMPATIBLE) {
        await provider.initialize(createOpenAICompatibleProviderOptions(localAISettings));
      } else {
        await provider.initialize({ modelPath: resolveConfiguredReceiptModelPath() });
      }
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
