const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function loadEnrichmentDisplay() {
  return await import("./js/services/ReceiptEnrichmentDisplay.js");
}

async function run() {
  const {
    buildReceiptDiscountDisplay,
    buildReceiptLoyaltyDisplay,
  } = await loadEnrichmentDisplay();
  const summaries = [];

  function test(name, fn) {
    fn();
    summaries.push(name);
  }

  test("discount with description and amount", function() {
    const display = buildReceiptDiscountDisplay([
      {
        description: "DISCOUNT",
        amount: -2.52,
      },
    ]);

    assert.deepStrictEqual(display, {
      items: [
        {
          description: "DISCOUNT",
          details: [{ label: "Amount", value: "-$2.52" }],
        },
      ],
      emptyMessage: "",
    });
  });

  test("discount missing description", function() {
    const display = buildReceiptDiscountDisplay([{ amount: "$1.25" }]);

    assert.deepStrictEqual(display.items[0], {
      description: "Discount",
      details: [{ label: "Amount", value: "$1.25" }],
    });
  });

  test("multiple discounts", function() {
    const display = buildReceiptDiscountDisplay([
      { description: "Loyalty", amount: -5 },
      { description: "Promo", amount: "2.50" },
    ]);

    assert.strictEqual(display.items.length, 2);
    assert.deepStrictEqual(display.items[0], {
      description: "Loyalty",
      details: [{ label: "Amount", value: "-$5.00" }],
    });
    assert.deepStrictEqual(display.items[1], {
      description: "Promo",
      details: [{ label: "Amount", value: "$2.50" }],
    });
  });

  test("empty discounts array", function() {
    const display = buildReceiptDiscountDisplay([]);

    assert.deepStrictEqual(display, {
      items: [],
      emptyMessage: "No discounts detected.",
    });
  });

  test("loyalty with earned redeemed and balance", function() {
    const display = buildReceiptLoyaltyDisplay({
      earned: 10,
      redeemed: 0,
      balance: 120,
    });

    assert.deepStrictEqual(display, {
      items: [
        { label: "Earned", value: "10" },
        { label: "Redeemed", value: "0" },
        { label: "Balance", value: "120" },
      ],
      emptyMessage: "",
    });
  });

  test("loyalty all null", function() {
    const display = buildReceiptLoyaltyDisplay({
      earned: null,
      redeemed: null,
      balance: null,
    });

    assert.deepStrictEqual(display, {
      items: [],
      emptyMessage: "No loyalty information detected.",
    });
  });

  test("missing loyalty", function() {
    const display = buildReceiptLoyaltyDisplay(undefined);

    assert.deepStrictEqual(display, {
      items: [],
      emptyMessage: "No loyalty information detected.",
    });
  });

  test("static no side-effect imports or calls", function() {
    const source = fs.readFileSync(
      path.join(__dirname, "js", "services", "ReceiptEnrichmentDisplay.js"),
      "utf8"
    );
    const forbidden = [
      "ReceiptVisionProvider",
      "OpenAICompatibleReceiptVisionProvider",
      "OnnxVisionRuntime",
      "ReceiptProcessingPipeline",
      "ReceiptIntelligenceService",
      "addReceipt",
      "updateReceiptRecord",
      "saveUserMapping",
      "onScanReceipt",
      "parseTextForStore",
      "document.",
      "window.",
      "localStorage",
      "analyzeReceipt",
    ];

    assert.strictEqual(source.includes("import "), false);
    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `enrichment display helper should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Enrichment display summaries:");
  for (const summary of summaries) {
    console.log(`- ${summary}`);
  }
}

run().catch((error) => {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
