"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PACKAGED_RUNTIME_DIRECTORY,
  SUPPORTED_ARCH_BY_PLATFORM,
} = require("./local-ai/LocalAIRuntimePaths.js");

function readPackageJson() {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, "package.json"), "utf8")
  );
}

function normalizeResourcePairs(extraResources = []) {
  return extraResources.map((entry) => ({
    from: String(entry.from || "").replace(/\\/g, "/"),
    to: String(entry.to || "").replace(/\\/g, "/"),
  }));
}

function run() {
  const summaries = [];
  const packageJson = readPackageJson();
  const build = packageJson.build || {};
  const extraResources = normalizeResourcePairs(build.extraResources);

  function test(name, fn) {
    fn();
    summaries.push(name);
  }

  test("extraResources exists", function() {
    assert.ok(Array.isArray(build.extraResources));
    assert.ok(build.extraResources.length >= 3);
  });

  test("windows runtime target exists", function() {
    assert.ok(extraResources.some((entry) =>
      entry.from === "resources/local-ai-runtime/win32/x64"
      && entry.to === `${PACKAGED_RUNTIME_DIRECTORY}/win32/${SUPPORTED_ARCH_BY_PLATFORM.win32}`
    ));
  });

  test("macos runtime target exists", function() {
    assert.ok(extraResources.some((entry) =>
      entry.from === "resources/local-ai-runtime/darwin/universal"
      && entry.to === `${PACKAGED_RUNTIME_DIRECTORY}/darwin/${SUPPORTED_ARCH_BY_PLATFORM.darwin}`
    ));
  });

  test("linux runtime target exists", function() {
    assert.ok(extraResources.some((entry) =>
      entry.from === "resources/local-ai-runtime/linux/x64"
      && entry.to === `${PACKAGED_RUNTIME_DIRECTORY}/linux/${SUPPORTED_ARCH_BY_PLATFORM.linux}`
    ));
  });

  test("no model resources are included", function() {
    for (const entry of extraResources) {
      const combined = `${entry.from} ${entry.to}`.toLowerCase();
      assert.strictEqual(combined.includes("models"), false);
      assert.strictEqual(combined.includes(".gguf"), false);
      assert.strictEqual(combined.includes("mmproj"), false);
    }
  });

  test("build.files exclusions remain unchanged", function() {
    assert.deepStrictEqual(build.files, [
      "**/*",
      "!dist/**",
      "!node_modules/**",
      "!*.md",
    ]);
  });

  test("placeholder runtime directories exist", function() {
    const placeholders = [
      path.join(__dirname, "resources", "local-ai-runtime", "win32", "x64", ".gitkeep"),
      path.join(__dirname, "resources", "local-ai-runtime", "darwin", "universal", ".gitkeep"),
      path.join(__dirname, "resources", "local-ai-runtime", "linux", "x64", ".gitkeep"),
    ];

    for (const filePath of placeholders) {
      assert.strictEqual(fs.existsSync(filePath), true, `${filePath} should exist`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Electron builder runtime resource summaries:");
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
