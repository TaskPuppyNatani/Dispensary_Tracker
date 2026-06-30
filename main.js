const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { createLocalAISettings, resolveModelDirectory } = require("./local-ai/config.js");
const { ModelManager } = require("./local-ai/ModelManager.js");

let modelManager = null;

function getModelManager() {
  if (!modelManager) {
    const localAISettings = createLocalAISettings();
    const modelRootPath = resolveModelDirectory(localAISettings, __dirname);
    modelManager = new ModelManager({ modelRootPath });
  }

  return modelManager;
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
