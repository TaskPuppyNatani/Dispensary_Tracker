"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { process: processReceipt } = require("./local-ai/ReceiptProcessingPipeline");

function makeReceipt(overrides) {
  return Object.assign({
    dispensary: "Green Valley",
    license_number: "LIC-123",
    receipt_number: "R-100",
    purchase_date: "2026-07-02",
    purchase_time: "10:30 AM",
    subtotal: 42.5,
    tax: 4.2,
    total: 46.7,
    payment_method: "cash",
    budtender: "Alex",
    discounts: [
      {
        description: "Loyalty",
        amount: 2
      }
    ],
    loyalty: {
      earned: 10,
      redeemed: null,
      balance: 50
    },
    products: [
      {
        name: "Blue Dream",
        brand: "Acme",
        category: "flower",
        quantity: 1,
        unit_price: 40,
        total_price: 40
      }
    ]
  }, overrides || {});
}

function makeAnalysis(text, metadata) {
  return {
    text,
    metadata: metadata || {
      providerName: "test",
      generation: {
        generatedTokenCount: 12
      }
    }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function run() {
  const summaries = [];

  function test(name, fn) {
    fn();
    summaries.push(name);
  }

  test("successful full pipeline", function() {
    const receipt = makeReceipt();
    const analysis = makeAnalysis(`Generated receipt:\n${JSON.stringify(receipt)}\nDone.`);
    const result = processReceipt(analysis);

    assert.strictEqual(result.text, analysis.text);
    assert.strictEqual(result.metadata, analysis.metadata);
    assert.strictEqual(result.pipeline.extraction.diagnostics.foundCompleteObject, true);
    assert.strictEqual(result.pipeline.repair.repair.parseSucceeded, true);
    assert.strictEqual(result.pipeline.validation.validation.valid, true);
    assert.strictEqual(result.pipeline.mapping.mapping.mapped, true);
    assert.deepStrictEqual(result.receipt, {
      dispensary: "Green Valley",
      licenseNumber: "LIC-123",
      receiptNumber: "R-100",
      purchaseDate: "2026-07-02",
      purchaseTime: "10:30 AM",
      subtotal: 42.5,
      tax: 4.2,
      total: 46.7,
      paymentMethod: "cash",
      budtender: "Alex",
      discounts: [
        {
          description: "Loyalty",
          amount: 2
        }
      ],
      loyalty: {
        earned: 10,
        redeemed: null,
        balance: 50
      },
      products: [
        {
          name: "Blue Dream",
          brand: "Acme",
          category: "flower",
          quantity: 1,
          unit_price: 40,
          total_price: 40
        }
      ]
    });
  });

  test("extraction with no JSON still runs all stages", function() {
    const analysis = makeAnalysis("No JSON object was returned.");
    const result = processReceipt(analysis);

    assert.strictEqual(result.pipeline.extraction.extractedText, null);
    assert.strictEqual(result.pipeline.repair.repairedText, null);
    assert.strictEqual(result.pipeline.validation.validation.valid, false);
    assert.strictEqual(result.pipeline.mapping.mapping.mapped, false);
    assert.strictEqual(result.receipt, null);
  });

  test("truncated JSON repaired successfully", function() {
    const truncated = JSON.stringify(makeReceipt()).slice(0, -1);
    const result = processReceipt(makeAnalysis(truncated));

    assert.strictEqual(result.pipeline.extraction.diagnostics.foundCompleteObject, false);
    assert.ok(result.pipeline.repair.repair.repairsApplied.includes("closedBrace"));
    assert.strictEqual(result.pipeline.validation.validation.valid, true);
    assert.strictEqual(result.pipeline.mapping.mapping.mapped, true);
    assert.strictEqual(result.receipt.total, 46.7);
  });

  test("validation failure", function() {
    const result = processReceipt(makeAnalysis(JSON.stringify(makeReceipt({ subtotal: "42.50" }))));

    assert.strictEqual(result.pipeline.validation.validation.valid, false);
    assert.deepStrictEqual(result.pipeline.validation.validation.typeErrors, [
      { field: "subtotal", expected: "number|null", actual: "string" }
    ]);
  });

  test("mapper receives invalid validation output", function() {
    const result = processReceipt(makeAnalysis(JSON.stringify(makeReceipt({ total: "46.70" }))));

    assert.strictEqual(result.pipeline.validation.validation.valid, false);
    assert.strictEqual(result.pipeline.mapping.mapping.sourceValid, false);
    assert.strictEqual(result.pipeline.mapping.mapping.mapped, false);
    assert.strictEqual(result.pipeline.mapping.receipt, null);
    assert.strictEqual(result.receipt, null);
  });

  test("deterministic repeated processing", function() {
    const analysis = makeAnalysis(JSON.stringify(makeReceipt()));

    assert.deepStrictEqual(processReceipt(analysis), processReceipt(analysis));
  });

  test("input immutability", function() {
    const analysis = makeAnalysis(JSON.stringify(makeReceipt()));
    const before = clone(analysis);

    processReceipt(analysis);
    assert.deepStrictEqual(analysis, before);
  });

  test("metadata preservation", function() {
    const metadata = {
      providerName: "test-provider",
      generation: {
        generatedTokenCount: 4,
        stoppedBy: "maxNewTokens"
      }
    };
    const analysis = makeAnalysis(JSON.stringify(makeReceipt()), metadata);
    const result = processReceipt(analysis);

    assert.strictEqual(result.metadata, metadata);
    assert.deepStrictEqual(result.metadata, metadata);
  });

  test("static import check", function() {
    const pipelinePath = path.join(__dirname, "local-ai", "ReceiptProcessingPipeline.js");
    const source = fs.readFileSync(pipelinePath, "utf8");
    const requires = Array.from(source.matchAll(/require\("([^"]+)"\)/g)).map((match) => match[1]).sort();

    assert.deepStrictEqual(requires, [
      "./ReceiptJsonExtractor",
      "./ReceiptJsonRepair",
      "./ReceiptJsonValidator",
      "./ReceiptObjectMapper"
    ].sort());

    const forbidden = [
      "OnnxVisionRuntime",
      "InferenceSession",
      "SmolVLMTokenizer",
      "SmolVLMImageProcessor",
      "ReceiptVisionProvider",
      "runtime.generate"
    ];

    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `pipeline should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Pipeline summaries:");
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
