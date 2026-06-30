"use strict";

const { VisionRuntime } = require("./VisionRuntime.js");

const ONNX_RUNTIME_STATUS = Object.freeze({
  UNINITIALIZED: "uninitialized",
  READY: "ready",
});

/**
 * Inert ONNX runtime foundation.
 *
 * This class satisfies the VisionRuntime contract without importing ONNX
 * Runtime, loading models, creating sessions, or performing inference.
 */
class OnnxVisionRuntime extends VisionRuntime {
  constructor(options = {}) {
    super({ name: options.name || "OnnxVisionRuntime" });
    this.initialized = false;
    this.status = ONNX_RUNTIME_STATUS.UNINITIALIZED;
  }

  async initialize(options = {}) {
    void options;
    this.initialized = true;
    this.status = ONNX_RUNTIME_STATUS.READY;
    return this.getStatus();
  }

  async shutdown() {
    this.initialized = false;
    this.status = ONNX_RUNTIME_STATUS.UNINITIALIZED;
    return this.getStatus();
  }

  getStatus() {
    return {
      name: this.name,
      runtimeType: "onnx",
      initialized: this.initialized,
      status: this.status,
    };
  }

  isInitialized() {
    return this.initialized;
  }

  supportsModel(modelMetadata) {
    void modelMetadata;
    return false;
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

function throwNotImplemented(methodName) {
  throw new Error(`Not Implemented: OnnxVisionRuntime.${methodName} is reserved for a future ONNX integration phase.`);
}

module.exports = {
  OnnxVisionRuntime,
  ONNX_RUNTIME_STATUS,
};
