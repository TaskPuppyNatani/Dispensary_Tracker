"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  validateManagedRuntimeExecutable,
} = require("./local-ai/LocalAIRuntimeValidation.js");

function makeFs(statsByPath = {}) {
  return {
    statSync(filePath) {
      const stats = statsByPath[filePath];
      if (!stats) {
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      return stats;
    },
  };
}

function makeStats({ file = true, mode = 0o755 } = {}) {
  return {
    mode,
    isFile: () => file,
  };
}

function run() {
  const summaries = [];
  const test = (name, fn) => {
    fn();
    summaries.push(name);
  };

  test("valid POSIX executable returns usable validation", () => {
    const result = validateManagedRuntimeExecutable("/opt/llama-server", {
      process: { platform: "linux" },
      fs: makeFs({ "/opt/llama-server": makeStats() }),
    });
    assert.deepStrictEqual(result, {
      valid: true,
      executablePath: "/opt/llama-server",
      platform: "linux",
      exists: true,
      executable: true,
      reason: null,
      warnings: [],
    });
  });

  test("missing executable returns a structured reason", () => {
    const result = validateManagedRuntimeExecutable("/missing/llama-server", {
      process: { platform: "linux" },
      fs: makeFs(),
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.exists, false);
    assert.strictEqual(result.executable, false);
    assert.strictEqual(result.reason, "Managed llama-server executable does not exist: /missing/llama-server");
  });

  test("directory is rejected as a non-regular file", () => {
    const result = validateManagedRuntimeExecutable("/opt/runtime", {
      process: { platform: "linux" },
      fs: makeFs({ "/opt/runtime": makeStats({ file: false }) }),
    });
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.valid, false);
    assert.match(result.reason, /not a regular file/);
  });

  test("POSIX executable without execute permission is rejected", () => {
    const result = validateManagedRuntimeExecutable("/opt/llama-server", {
      process: { platform: "darwin" },
      fs: makeFs({ "/opt/llama-server": makeStats({ mode: 0o644 }) }),
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.executable, false);
    assert.match(result.reason, /missing execute permission/);
  });

  test("Windows regular executable does not require POSIX execute bits", () => {
    const result = validateManagedRuntimeExecutable("C:/tools/llama-server.exe", {
      process: { platform: "win32" },
      fs: makeFs({ "C:/tools/llama-server.exe": makeStats({ mode: 0o644 }) }),
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.executable, true);
    assert.strictEqual(result.platform, "win32");
  });

  test("static helper remains isolated from app and inference modules", () => {
    const source = fs.readFileSync(path.join(__dirname, "local-ai", "LocalAIRuntimeValidation.js"), "utf8");
    const forbidden = [
      "ReceiptVisionProvider",
      "OpenAICompatibleReceiptVisionProvider",
      "LocalAIRuntimeManager",
      "ReceiptIntelligenceService",
      "OnnxVisionRuntime",
      "document.",
      "window.",
      "ipcRenderer",
      "addReceipt",
      "updateReceiptRecord",
      "parseTextForStore",
    ];
    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `validation helper should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Local AI runtime validation summaries:");
  for (const summary of summaries) {
    console.log(`- ${summary}`);
  }
}

try {
  run();
} catch (error) {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
}
