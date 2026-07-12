"use strict";

const fs = require("fs");

function validateManagedRuntimeExecutable(executablePath, options = {}) {
  const fsImpl = options.fs || fs;
  const platform = readPlatform(options.process);
  const normalizedPath = readString(executablePath);
  const result = {
    valid: false,
    executablePath: normalizedPath,
    platform,
    exists: false,
    executable: false,
    reason: null,
    warnings: [],
  };

  if (!normalizedPath) {
    result.reason = "No managed llama-server executable path was resolved.";
    return result;
  }

  let stats;
  try {
    stats = fsImpl.statSync(normalizedPath);
  } catch (error) {
    result.reason = `Managed llama-server executable does not exist: ${normalizedPath}`;
    return result;
  }

  result.exists = true;
  if (!stats || typeof stats.isFile !== "function" || !stats.isFile()) {
    result.reason = `Managed llama-server executable is not a regular file: ${normalizedPath}`;
    return result;
  }

  if (platform !== "win32") {
    const mode = Number(stats.mode);
    if (!Number.isFinite(mode) || (mode & 0o111) === 0) {
      result.reason = `Managed llama-server executable is missing execute permission: ${normalizedPath}`;
      return result;
    }
  }

  result.valid = true;
  result.executable = true;
  return result;
}

function readPlatform(processObject) {
  return readString(processObject && processObject.platform) || process.platform;
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  validateManagedRuntimeExecutable,
};
