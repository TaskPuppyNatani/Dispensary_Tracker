const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function loadApplyHelper() {
  return await import("./js/services/ReceiptSuggestionApply.js");
}

function fieldMap(plan) {
  return Object.fromEntries(plan.fields.map((field) => [field.field, field.value]));
}

async function run() {
  const {
    buildReceiptFormApplyPlan,
    normalizeDateInputValue,
    normalizeTimeInputValue,
    normalizeAmountInputValue,
  } = await loadApplyHelper();
  const summaries = [];

  function test(name, fn) {
    fn();
    summaries.push(name);
  }

  test("AI time present is eligible when current OCR time is missing", function() {
    const plan = buildReceiptFormApplyPlan({ purchaseTime: "1:28 PM" });
    assert.deepStrictEqual(fieldMap(plan), { time: "13:28" });
    assert.deepStrictEqual(plan.skipped, []);
  });

  test("AI date present is eligible when current OCR date is missing", function() {
    const plan = buildReceiptFormApplyPlan({ purchaseDate: "February 7, 2026" });
    assert.deepStrictEqual(fieldMap(plan), { date: "2026-02-07" });
    assert.strictEqual(normalizeDateInputValue("Feb 7, 2026"), "2026-02-07");
  });

  test("AI total present is eligible when current OCR total is missing", function() {
    const plan = buildReceiptFormApplyPlan({ total: "$42.50" });
    assert.deepStrictEqual(fieldMap(plan), { amount: "42.50" });
    assert.strictEqual(normalizeAmountInputValue("1,234.5"), "1234.50");
  });

  test("different current value does not block applying AI value", function() {
    const plan = buildReceiptFormApplyPlan({
      dispensary: "Green Valley East",
      licenseNumber: "LIC-999",
      purchaseDate: "05/12/2026",
      purchaseTime: "09:05",
      total: 50,
    });

    assert.deepStrictEqual(fieldMap(plan), {
      location: "Green Valley East",
      license: "LIC-999",
      date: "2026-05-12",
      time: "09:05",
      amount: "50.00",
    });
  });

  test("missing null and invalid AI values do not overwrite current values", function() {
    const plan = buildReceiptFormApplyPlan({
      dispensary: "",
      licenseNumber: null,
      purchaseDate: "not a date",
      purchaseTime: "25:99",
      total: -1,
    });

    assert.deepStrictEqual(plan.fields, []);
    assert.deepStrictEqual(plan.skipped, ["date", "time", "amount"]);
  });

  test("non-editable receipt metadata is not part of the form apply plan", function() {
    const plan = buildReceiptFormApplyPlan({
      receiptNumber: "R-100",
      paymentMethod: "Cash",
      subtotal: 10,
      tax: 1,
      discounts: [{ description: "Promo", amount: 2 }],
    });

    assert.deepStrictEqual(plan.fields, []);
    assert.deepStrictEqual(plan.skipped, []);
  });

  test("available fields filter limits application to existing controls", function() {
    const plan = buildReceiptFormApplyPlan(
      {
        dispensary: "Green Valley",
        licenseNumber: "LIC-123",
        purchaseDate: "2026-02-07",
        purchaseTime: "1:28 PM",
        total: 20,
      },
      {
        availableFields: {
          location: true,
          license: false,
          date: true,
          time: false,
          amount: true,
        },
      }
    );

    assert.deepStrictEqual(fieldMap(plan), {
      location: "Green Valley",
      date: "2026-02-07",
      amount: "20.00",
    });
  });

  test("normalizers reject unsafe ambiguous values", function() {
    assert.strictEqual(normalizeDateInputValue("13/07/2026"), "");
    assert.strictEqual(normalizeTimeInputValue("7:61 PM"), "");
    assert.strictEqual(normalizeAmountInputValue("free"), "");
  });

  test("static no side-effect imports or calls", function() {
    const source = fs.readFileSync(
      path.join(__dirname, "js", "services", "ReceiptSuggestionApply.js"),
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
      assert.strictEqual(source.includes(term), false, `apply helper should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Receipt suggestion apply summaries:");
  for (const summary of summaries) {
    console.log(`- ${summary}`);
  }
}

run().catch((error) => {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
