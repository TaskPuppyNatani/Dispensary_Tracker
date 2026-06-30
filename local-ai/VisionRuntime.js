"use strict";

/**
 * Future boundary for inference runtime integrations.
 *
 * Receipt-domain providers should depend on this kind of abstraction instead of
 * importing a concrete runtime package directly. Phase 1 intentionally does not
 * add ONNX Runtime, model sessions, tensor handling, or execution code.
 */
class VisionRuntime {
  constructor(options = {}) {
    this.name = String(options.name || "VisionRuntime");
  }

  async initialize(modelMetadata) {
    void modelMetadata;
    throw new Error("Not Implemented: VisionRuntime.initialize is reserved for future inference integration.");
  }

  async run(input) {
    void input;
    throw new Error("Not Implemented: VisionRuntime.run is reserved for future inference integration.");
  }

  async dispose() {
    return undefined;
  }
}

function assertVisionRuntime(runtime) {
  const hasName = !!runtime && typeof runtime.name === "string" && runtime.name.trim().length > 0;
  const hasInitialize = !!runtime && typeof runtime.initialize === "function";
  const hasRun = !!runtime && typeof runtime.run === "function";
  const hasDispose = !!runtime && typeof runtime.dispose === "function";

  if (!hasName || !hasInitialize || !hasRun || !hasDispose) {
    throw new Error(
      "Invalid VisionRuntime: runtimes must expose name, initialize(modelMetadata), run(input), and dispose()."
    );
  }
}

module.exports = {
  VisionRuntime,
  assertVisionRuntime,
};
