const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function loadSummary() {
  return await import("./js/services/ReceiptReviewSummary.js");
}

function field(current, suggestion, changed = false) {
  return {
    current,
    suggestion,
    source: suggestion === null || suggestion === undefined || String(suggestion).trim() === "" ? null : "local-ai",
    changed,
  };
}

async function run() {
  const { buildReceiptReviewSummary } = await loadSummary();
  const summaries = [];

  function test(name, fn) {
    fn();
    summaries.push(name);
  }

  test("mixed review", function() {
    const summary = buildReceiptReviewSummary({
      fields: {
        dispensary: field("Green Valley", "Green Valley"),
        receiptNumber: field(null, "R-100"),
        total: field("46.70", "50.00", true),
        tax: field(null, null),
      },
    });

    assert.deepStrictEqual(summary, {
      same: 1,
      suggested: 1,
      different: 1,
      hasConflicts: true,
      message: "Review the highlighted differences before applying suggestions.",
    });
  });

  test("all same", function() {
    const summary = buildReceiptReviewSummary({
      fields: {
        dispensary: field("Green Valley", "Green Valley"),
        total: field("46.70", "46.70"),
      },
    });

    assert.deepStrictEqual(summary, {
      same: 2,
      suggested: 0,
      different: 0,
      hasConflicts: false,
      message: "No conflicts were found.",
    });
  });

  test("suggestions only", function() {
    const summary = buildReceiptReviewSummary({
      fields: {
        receiptNumber: field(null, "R-100"),
        budtender: field("", "Alex"),
      },
    });

    assert.deepStrictEqual(summary, {
      same: 0,
      suggested: 2,
      different: 0,
      hasConflicts: false,
      message: "AI found additional information that can be applied.",
    });
  });

  test("differences only", function() {
    const summary = buildReceiptReviewSummary({
      fields: {
        dispensary: field("Green Valley", "Green Valley East", true),
        total: field("46.70", "50.00", true),
      },
    });

    assert.deepStrictEqual(summary, {
      same: 0,
      suggested: 0,
      different: 2,
      hasConflicts: true,
      message: "Review the highlighted differences before applying suggestions.",
    });
  });

  test("empty review", function() {
    const summary = buildReceiptReviewSummary({ fields: {} });

    assert.deepStrictEqual(summary, {
      same: 0,
      suggested: 0,
      different: 0,
      hasConflicts: false,
      message: "No conflicts were found.",
    });
  });

  test("static no side-effect imports or calls", function() {
    const source = fs.readFileSync(
      path.join(__dirname, "js", "services", "ReceiptReviewSummary.js"),
      "utf8"
    );
    const forbidden = [
      "ReceiptVisionProvider",
      "ReceiptProcessingPipeline",
      "ReceiptIntelligenceService",
      "OnnxVisionRuntime",
      "ocr",
      "matcher",
      "database",
      "document.",
      "window.",
      "localStorage",
      "analyzeReceipt",
      "saveReceipt",
      "updateReceipt",
    ];

    assert.strictEqual(source.includes("import "), false);
    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `summary helper should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Review summary summaries:");
  for (const summary of summaries) {
    console.log(`- ${summary}`);
  }
}

run().catch((error) => {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
