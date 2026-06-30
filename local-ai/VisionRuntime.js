"use strict";

/**
 * Contract for future vision inference runtime integrations.
 *
 * Receipt-domain providers should depend on this kind of abstraction instead of
 * importing a concrete runtime package directly. The base class intentionally
 * stores no model/session/runtime state and performs no inference work.
 */
class VisionRuntime {
  constructor(options = {}) {
    this.name = String(options.name || "VisionRuntime");
  }

  async initialize(options = {}) {
    void options;
    throwNotImplemented("initialize");
  }

  async shutdown() {
    throwNotImplemented("shutdown");
  }

  getStatus() {
    throwNotImplemented("getStatus");
  }

  isInitialized() {
    throwNotImplemented("isInitialized");
  }

  supportsModel(modelMetadata) {
    void modelMetadata;
    throwNotImplemented("supportsModel");
  }

  async loadModel(modelMetadata) {
    void modelMetadata;
    throwNotImplemented("loadModel");
  }

  async run(input) {
    void input;
    throwNotImplemented("run");
  }
}

function assertVisionRuntime(runtime) {
  const hasName = !!runtime && typeof runtime.name === "string" && runtime.name.trim().length > 0;
  const hasInitialize = !!runtime && typeof runtime.initialize === "function";
  const hasShutdown = !!runtime && typeof runtime.shutdown === "function";
  const hasGetStatus = !!runtime && typeof runtime.getStatus === "function";
  const hasIsInitialized = !!runtime && typeof runtime.isInitialized === "function";
  const hasSupportsModel = !!runtime && typeof runtime.supportsModel === "function";
  const hasLoadModel = !!runtime && typeof runtime.loadModel === "function";
  const hasRun = !!runtime && typeof runtime.run === "function";

  if (
    !hasName
    || !hasInitialize
    || !hasShutdown
    || !hasGetStatus
    || !hasIsInitialized
    || !hasSupportsModel
    || !hasLoadModel
    || !hasRun
  ) {
    throw new Error(
      "Invalid VisionRuntime: runtimes must expose name, initialize(options), shutdown(), getStatus(), isInitialized(), supportsModel(modelMetadata), loadModel(modelMetadata), and run(input)."
    );
  }
}

function throwNotImplemented(methodName) {
  throw new Error(`Not Implemented: VisionRuntime.${methodName} must be implemented by a concrete runtime.`);
}

module.exports = {
  VisionRuntime,
  assertVisionRuntime,
};
