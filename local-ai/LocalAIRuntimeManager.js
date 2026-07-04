"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 500;
const DEFAULT_STOP_TIMEOUT_MS = 5000;
const DEFAULT_LOG_LIMIT = 200;

const STATUS = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  READY: "ready",
  STOPPING: "stopping",
  STOPPED: "stopped",
  ERROR: "error",
});

class LocalAIRuntimeManager {
  constructor(options = {}) {
    this.name = String(options.name || "LocalAIRuntimeManager");
    this.spawnImpl = options.spawn || childProcess.spawn;
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.netImpl = options.net || net;
    this.fsImpl = options.fs || fs;
    this.validatePaths = options.validatePaths !== false;

    this.executablePath = "";
    this.modelPath = "";
    this.mmprojPath = "";
    this.host = DEFAULT_HOST;
    this.port = 0;
    this.ctxSize = null;
    this.gpuLayers = null;
    this.extraArgs = [];
    this.startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS;
    this.healthCheckIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS;
    this.logLimit = DEFAULT_LOG_LIMIT;

    this.child = null;
    this.status = STATUS.IDLE;
    this.health = null;
    this.lastError = null;
    this.lastExit = null;
    this.startedAt = null;
    this.readyAt = null;
    this.logs = [];
    this.startPromise = null;
    this.stopPromise = null;
    this.stopRequested = false;

    this._applyOptions(options);
  }

  async start(options = {}) {
    this._applyOptions(options);

    if (this.startPromise) {
      return await this.startPromise;
    }

    if (this.isRunning() && this.status === STATUS.READY) {
      return this.getStatus();
    }

    this.startPromise = this._start();

    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(options = {}) {
    if (this.stopPromise) {
      return await this.stopPromise;
    }

    this.stopPromise = this._stop(options);

    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async restart(options = {}) {
    await this.stop();
    return await this.start(options);
  }

  isRunning() {
    return Boolean(this.child && !this.lastExit);
  }

  getChatCompletionsUrl() {
    return this.port
      ? `http://${this.host}:${this.port}/v1/chat/completions`
      : "";
  }

  getModelsUrl() {
    return this.port
      ? `http://${this.host}:${this.port}/v1/models`
      : "";
  }

  getStatus() {
    return {
      name: this.name,
      status: this.status,
      running: this.isRunning(),
      ready: this.status === STATUS.READY,
      pid: this.child && this.child.pid ? this.child.pid : null,
      executablePath: this.executablePath,
      modelPath: this.modelPath,
      mmprojPath: this.mmprojPath,
      host: this.host,
      port: this.port,
      chatCompletionsUrl: this.getChatCompletionsUrl(),
      modelsUrl: this.getModelsUrl(),
      ctxSize: this.ctxSize,
      gpuLayers: this.gpuLayers,
      extraArgs: Array.from(this.extraArgs),
      health: this.health,
      lastError: this.lastError,
      lastExit: this.lastExit,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      logs: this.getLogs(),
    };
  }

  getLogs() {
    return this.logs.map((entry) => ({ ...entry }));
  }

  _applyOptions(options = {}) {
    if (!options || typeof options !== "object") {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(options, "executablePath")) {
      this.executablePath = normalizePath(options.executablePath);
    }

    if (Object.prototype.hasOwnProperty.call(options, "modelPath")) {
      this.modelPath = normalizePath(options.modelPath);
    }

    if (Object.prototype.hasOwnProperty.call(options, "mmprojPath")) {
      this.mmprojPath = normalizePath(options.mmprojPath);
    }

    if (Object.prototype.hasOwnProperty.call(options, "host")) {
      this.host = normalizeHost(options.host);
    }

    if (Object.prototype.hasOwnProperty.call(options, "port")) {
      this.port = readPort(options.port);
    }

    if (Object.prototype.hasOwnProperty.call(options, "ctxSize")) {
      this.ctxSize = readOptionalPositiveInteger(options.ctxSize, "ctxSize");
    }

    if (Object.prototype.hasOwnProperty.call(options, "gpuLayers")) {
      this.gpuLayers = readOptionalNonNegativeInteger(options.gpuLayers, "gpuLayers");
    }

    if (Object.prototype.hasOwnProperty.call(options, "extraArgs")) {
      this.extraArgs = readStringArray(options.extraArgs, "extraArgs");
    }

    if (Object.prototype.hasOwnProperty.call(options, "startupTimeoutMs")) {
      this.startupTimeoutMs = readPositiveInteger(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, "startupTimeoutMs");
    }

    if (Object.prototype.hasOwnProperty.call(options, "healthCheckIntervalMs")) {
      this.healthCheckIntervalMs = readPositiveInteger(options.healthCheckIntervalMs, DEFAULT_HEALTH_CHECK_INTERVAL_MS, "healthCheckIntervalMs");
    }

    if (Object.prototype.hasOwnProperty.call(options, "stopTimeoutMs")) {
      this.stopTimeoutMs = readPositiveInteger(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, "stopTimeoutMs");
    }

    if (Object.prototype.hasOwnProperty.call(options, "logLimit")) {
      this.logLimit = readPositiveInteger(options.logLimit, DEFAULT_LOG_LIMIT, "logLimit");
      this._trimLogs();
    }
  }

  async _start() {
    if (this.isRunning()) {
      throw new Error("Local AI runtime is already running.");
    }

    this._validateConfiguration();

    if (!this.port) {
      this.port = await findFreePort(this.netImpl, this.host);
    }

    this.status = STATUS.STARTING;
    this.health = null;
    this.lastError = null;
    this.lastExit = null;
    this.startedAt = new Date().toISOString();
    this.readyAt = null;
    this.stopRequested = false;

    const args = this._createServerArgs();
    const child = this.spawnImpl(this.executablePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child = child;
    this._attachChildHandlers(child);

    try {
      this.health = await this._waitForHealth();
      this.status = STATUS.READY;
      this.readyAt = new Date().toISOString();
      return this.getStatus();
    } catch (error) {
      this.lastError = getErrorMessage(error);
      await this.stop().catch(() => {});
      this.status = STATUS.ERROR;
      throw error;
    }
  }

  async _stop(options = {}) {
    const child = this.child;

    if (!child) {
      this.status = this.status === STATUS.ERROR ? STATUS.ERROR : STATUS.STOPPED;
      return this.getStatus();
    }

    this.status = STATUS.STOPPING;
    this.stopRequested = true;

    if (this.lastExit) {
      this.child = null;
      this.status = STATUS.STOPPED;
      return this.getStatus();
    }

    const timeoutMs = readPositiveInteger(options.timeoutMs, this.stopTimeoutMs, "timeoutMs");
    await terminateChildProcess(child, timeoutMs);

    this.child = null;
    this.status = STATUS.STOPPED;
    return this.getStatus();
  }

  _validateConfiguration() {
    const requiredPaths = [
      ["executablePath", this.executablePath],
      ["modelPath", this.modelPath],
      ["mmprojPath", this.mmprojPath],
    ];

    for (const [label, value] of requiredPaths) {
      if (!value) {
        throw new Error(`${label} is required to start the Local AI runtime.`);
      }

      if (this.validatePaths && !this.fsImpl.existsSync(value)) {
        throw new Error(`${label} does not exist: ${value}`);
      }
    }
  }

  _createServerArgs() {
    const args = [
      "-m",
      this.modelPath,
      "--mmproj",
      this.mmprojPath,
      "--host",
      this.host,
      "--port",
      String(this.port),
    ];

    if (this.ctxSize) {
      args.push("--ctx-size", String(this.ctxSize));
    }

    if (this.gpuLayers !== null && this.gpuLayers !== undefined) {
      args.push("--gpu-layers", String(this.gpuLayers));
    }

    return args.concat(this.extraArgs);
  }

  _attachChildHandlers(child) {
    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => {
        this._appendLog("stdout", chunk);
      });
    }

    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => {
        this._appendLog("stderr", chunk);
      });
    }

    if (typeof child.on === "function") {
      child.on("error", (error) => {
        this.lastError = getErrorMessage(error);
        this.status = STATUS.ERROR;
      });

      child.on("exit", (code, signal) => {
        this.lastExit = {
          code: code === undefined ? null : code,
          signal: signal || null,
          at: new Date().toISOString(),
        };

        if (!this.stopRequested) {
          this.status = code === 0 ? STATUS.STOPPED : STATUS.ERROR;
          if (code !== 0 && !this.lastError) {
            this.lastError = `Local AI runtime exited with code ${code}${signal ? ` and signal ${signal}` : ""}.`;
          }
        }
      });
    }
  }

  _appendLog(stream, chunk) {
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : String(chunk || "");
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);

    for (const line of lines) {
      this.logs.push({
        stream,
        message: line,
        at: new Date().toISOString(),
      });
    }

    this._trimLogs();
  }

  _trimLogs() {
    if (this.logs.length > this.logLimit) {
      this.logs.splice(0, this.logs.length - this.logLimit);
    }
  }

  async _waitForHealth() {
    const startedAt = Date.now();
    let lastError = null;

    while (Date.now() - startedAt <= this.startupTimeoutMs) {
      if (this.lastExit && !this.stopRequested) {
        throw new Error(this.lastError || "Local AI runtime exited before becoming healthy.");
      }

      try {
        const health = await this._checkHealth();
        if (health.available) {
          return health;
        }
        lastError = health.reason || "runtime_not_ready";
      } catch (error) {
        lastError = getErrorMessage(error);
      }

      await delay(this.healthCheckIntervalMs);
    }

    throw new Error(`Local AI runtime health check timed out: ${lastError || "no response"}`);
  }

  async _checkHealth() {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("A fetch implementation is required for runtime health checks.");
    }

    const response = await this.fetchImpl(this.getModelsUrl(), { method: "GET" });
    const ok = typeof response.ok === "boolean"
      ? response.ok
      : response.status >= 200 && response.status < 300;

    if (!ok) {
      return {
        available: false,
        reason: `models endpoint returned HTTP ${response.status || "error"}`,
        status: response.status || null,
        models: [],
      };
    }

    const body = typeof response.json === "function" ? await response.json() : null;
    return {
      available: true,
      reason: null,
      status: response.status || 200,
      models: readModelIds(body),
    };
  }
}

function normalizePath(value) {
  const normalized = String(value || "").trim();
  return normalized ? path.resolve(normalized) : "";
}

function normalizeHost(value) {
  const normalized = String(value || "").trim();
  return normalized || DEFAULT_HOST;
}

function readPort(value) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("port must be a safe integer between 0 and 65535.");
  }

  return port;
}

function readOptionalPositiveInteger(value, label) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }

  return normalized;
}

function readOptionalNonNegativeInteger(value, label) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }

  return normalized;
}

function readPositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }

  return normalized;
}

function readStringArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }

  return value.map((item, index) => {
    const normalized = String(item || "").trim();
    if (!normalized) {
      throw new Error(`${label}[${index}] must be a non-empty string.`);
    }
    return normalized;
  });
}

function readModelIds(body) {
  const data = body && Array.isArray(body.data) ? body.data : [];
  return data
    .map((model) => model && typeof model === "object" ? String(model.id || "").trim() : "")
    .filter(Boolean);
}

function findFreePort(netImpl, host) {
  return new Promise((resolve, reject) => {
    const server = netImpl.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function terminateChildProcess(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve();
    };
    timer = setTimeout(() => {
      if (typeof child.kill === "function") {
        child.kill("SIGKILL");
      }
      finish();
    }, timeoutMs);

    if (typeof child.once === "function") {
      child.once("exit", finish);
    }

    if (typeof child.kill === "function") {
      child.kill("SIGTERM");
    } else {
      finish();
    }
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

module.exports = {
  LocalAIRuntimeManager,
  LOCAL_AI_RUNTIME_STATUS: STATUS,
};
