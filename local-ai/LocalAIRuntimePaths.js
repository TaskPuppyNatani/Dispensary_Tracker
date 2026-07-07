"use strict";

const path = require("path");

const PACKAGED_RUNTIME_DIRECTORY = "local-ai-runtime";
const SUPPORTED_ARCH_BY_PLATFORM = Object.freeze({
  win32: "x64",
  linux: "x64",
  darwin: "universal",
});

function resolvePackagedLlamaServerPath({ app, process: processObject = process, path: pathImpl = path } = {}) {
  const platform = readPlatform(processObject.platform);
  const arch = readRuntimeArch(platform, processObject.arch);
  const resourcesPath = readString(processObject.resourcesPath);

  if (!resourcesPath) {
    return {
      found: false,
      source: "packaged",
      executablePath: "",
      reason: "process.resourcesPath is unavailable.",
      platform,
      arch,
    };
  }

  return {
    found: true,
    source: "packaged",
    executablePath: pathImpl.resolve(
      resourcesPath,
      PACKAGED_RUNTIME_DIRECTORY,
      platform,
      arch,
      getExecutableName(platform)
    ),
    reason: null,
    platform,
    arch,
  };
}

function resolveManagedRuntimeExecutablePath({
  env = process.env,
  app,
  process: processObject = process,
  path: pathImpl = path,
  baseDirectory = process.cwd(),
} = {}) {
  const envPath = readString(env && env.LOCAL_AI_LLAMA_SERVER_PATH);
  if (envPath) {
    return {
      found: true,
      source: "env",
      executablePath: envPath,
      reason: null,
      platform: readPlatform(processObject.platform),
      arch: readRuntimeArch(readPlatform(processObject.platform), processObject.arch),
    };
  }

  const packaged = Boolean(app && app.isPackaged);
  if (packaged) {
    const packagedResult = resolvePackagedLlamaServerPath({
      app,
      process: processObject,
      path: pathImpl,
    });

    return packagedResult.found
      ? packagedResult
      : {
        ...packagedResult,
        reason: packagedResult.reason || "No packaged llama-server runtime path could be resolved.",
      };
  }

  const platform = readPlatform(processObject.platform);
  const arch = readRuntimeArch(platform, processObject.arch);
  return {
    found: true,
    source: "development",
    executablePath: pathImpl.resolve(
      baseDirectory,
      "resources",
      PACKAGED_RUNTIME_DIRECTORY,
      platform,
      arch,
      getExecutableName(platform)
    ),
    reason: null,
    platform,
    arch,
  };
}

function getExecutableName(platform) {
  return platform === "win32" ? "llama-server.exe" : "llama-server";
}

function readRuntimeArch(platform, arch) {
  return SUPPORTED_ARCH_BY_PLATFORM[platform] || readString(arch) || "x64";
}

function readPlatform(platform) {
  return readString(platform) || process.platform || "win32";
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  PACKAGED_RUNTIME_DIRECTORY,
  SUPPORTED_ARCH_BY_PLATFORM,
  resolvePackagedLlamaServerPath,
  resolveManagedRuntimeExecutablePath,
};
