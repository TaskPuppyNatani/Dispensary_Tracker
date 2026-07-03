const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { createLocalAISettings, resolveModelDirectory } = require("./local-ai/config.js");
const { ModelManager } = require("./local-ai/ModelManager.js");
const { MainProcessReceiptVisionProvider } = require("./local-ai/ReceiptVisionProvider.js");
const { SmolVLMModelAdapter } = require("./local-ai/adapters/SmolVLMModelAdapter.js");

let modelManager = null;
let receiptVisionProvider = null;

const DEFAULT_RECEIPT_MODEL_DIRECTORY_NAME = "SmolVLM2-500M";

function getModelManager() {
  if (!modelManager) {
    const localAISettings = createLocalAISettings();
    const modelRootPath = resolveModelDirectory(localAISettings, __dirname);
    modelManager = new ModelManager({ modelRootPath });
  }

  return modelManager;
}

function getReceiptVisionProvider() {
  if (!receiptVisionProvider) {
    receiptVisionProvider = new MainProcessReceiptVisionProvider();
  }

  return receiptVisionProvider;
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
  if (receiptVisionProvider && receiptVisionProvider.initialized) {
    const status = receiptVisionProvider.getStatus();
    return {
      available: true,
      initialized: true,
      modelId: status.modelId || "",
      reason: null,
      missingFiles: [],
      warnings: [],
    };
  }

  try {
    const inspection = await inspectConfiguredReceiptModel();
    return {
      available: Boolean(inspection.supported),
      initialized: false,
      modelId: inspection.modelId || "",
      reason: inspection.supported ? null : "configured_model_unavailable",
      missingFiles: Array.isArray(inspection.missingFiles) ? inspection.missingFiles : [],
      warnings: Array.isArray(inspection.warnings) ? inspection.warnings : [],
    };
  } catch (error) {
    return {
      available: false,
      initialized: false,
      modelId: "",
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

  for (const field of ["maxNewTokens", "stopTokenIds", "imageLayouts"]) {
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

    const modelPath = resolveConfiguredReceiptModelPath();
    const provider = getReceiptVisionProvider();
    if (!provider.initialized) {
      await provider.initialize({ modelPath });
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
