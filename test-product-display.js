const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function loadProductDisplay() {
  return await import("./js/services/ReceiptProductDisplay.js");
}

async function run() {
  const { buildReceiptProductDisplay } = await loadProductDisplay();
  const summaries = [];

  function test(name, fn) {
    fn();
    summaries.push(name);
  }

  test("product with only name", function() {
    const display = buildReceiptProductDisplay([{ name: "Blue Dream" }]);

    assert.deepStrictEqual(display, {
      items: [
        {
          name: "Blue Dream",
          details: [],
        },
      ],
      emptyMessage: "",
    });
  });

  test("product with name and brand", function() {
    const display = buildReceiptProductDisplay([
      {
        name: "White Fla 24.58%",
        brand: "La Mota",
      },
    ]);

    assert.deepStrictEqual(display.items[0], {
      name: "White Fla 24.58%",
      details: [{ label: "Brand", value: "La Mota" }],
    });
  });

  test("product with quantity price category and cannabinoids", function() {
    const display = buildReceiptProductDisplay([
      {
        name: "In House Preroll",
        quantity: 1,
        total_price: 3.34,
        category: "Preroll",
        thc: "24.58%",
        cbd: "0.2%",
      },
    ]);

    assert.deepStrictEqual(display.items[0], {
      name: "In House Preroll",
      details: [
        { label: "Quantity", value: "1" },
        { label: "Price", value: "$3.34" },
        { label: "Category", value: "Preroll" },
        { label: "THC", value: "24.58%" },
        { label: "CBD", value: "0.2%" },
      ],
    });
  });

  test("multiple products", function() {
    const display = buildReceiptProductDisplay([
      { name: "Product A", quantity: 1 },
      { name: "Product B", quantity: 2, unit_price: "$5.00" },
    ]);

    assert.strictEqual(display.items.length, 2);
    assert.strictEqual(display.items[0].name, "Product A");
    assert.strictEqual(display.items[1].name, "Product B");
    assert.deepStrictEqual(display.items[1].details, [
      { label: "Quantity", value: "2" },
      { label: "Price", value: "$5.00" },
    ]);
  });

  test("empty products array", function() {
    const display = buildReceiptProductDisplay([]);

    assert.deepStrictEqual(display, {
      items: [],
      emptyMessage: "No AI products found.",
    });
  });

  test("missing products field", function() {
    const display = buildReceiptProductDisplay(undefined);

    assert.deepStrictEqual(display, {
      items: [],
      emptyMessage: "No AI products found.",
    });
  });

  test("products without readable names show empty state", function() {
    const display = buildReceiptProductDisplay([
      { brand: "No Name" },
      { name: "   " },
    ]);

    assert.deepStrictEqual(display, {
      items: [],
      emptyMessage: "No readable AI products found.",
    });
  });

  test("static no side-effect imports or calls", function() {
    const source = fs.readFileSync(
      path.join(__dirname, "js", "services", "ReceiptProductDisplay.js"),
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
      assert.strictEqual(source.includes(term), false, `product display helper should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Product display summaries:");
  for (const summary of summaries) {
    console.log(`- ${summary}`);
  }
}

run().catch((error) => {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
