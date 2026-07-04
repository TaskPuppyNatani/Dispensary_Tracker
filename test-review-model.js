const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function loadBuilder() {
  return await import("./js/services/ReceiptReviewModelBuilder.js");
}

function makeAnalysis(overrides) {
  return Object.assign({
    status: "noop",
    reason: "provider_noop",
    eligible: true,
    trace: {
      finalRendered: {
        location: "Green Valley",
        license: "LIC-123",
        date: "2026-07-02",
        time: "10:30 AM",
        amount: "46.70",
      },
    },
    advisory: {
      available: true,
      attempted: true,
      succeeded: true,
      source: "local-ai",
      receipt: {
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
            amount: 2,
          },
        ],
        loyalty: {
          earned: 10,
          redeemed: null,
          balance: 50,
        },
        products: [
          {
            name: "Blue Dream",
            brand: "Acme",
            category: "flower",
            quantity: 1,
            unit_price: 40,
            total_price: 40,
          },
        ],
      },
      text: "{}",
      pipeline: {},
      metadata: {},
      error: null,
    },
    metadata: {
      providerName: "NullProvider",
    },
  }, overrides || {});
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function run() {
  const { buildReceiptReviewModel } = await loadBuilder();
  const summaries = [];

  function test(name, fn) {
    fn();
    summaries.push(name);
  }

  test("no advisory result", function() {
    const analysis = {
      trace: {
        finalRendered: {
          location: "Green Valley",
          license: "LIC-123",
          date: "2026-07-02",
          time: "10:30 AM",
          amount: "46.70",
        },
      },
      metadata: { providerName: "NullProvider" },
    };
    const model = buildReceiptReviewModel(analysis);

    assert.strictEqual(model.fields.dispensary.current, "Green Valley");
    assert.strictEqual(model.fields.dispensary.suggestion, null);
    assert.strictEqual(model.fields.dispensary.source, null);
    assert.strictEqual(model.fields.dispensary.changed, false);
    assert.deepStrictEqual(model.products, []);
    assert.deepStrictEqual(model.discounts, []);
    assert.strictEqual(model.loyalty, null);
  });

  test("advisory result with matching values", function() {
    const model = buildReceiptReviewModel(makeAnalysis({
      trace: {
        finalRendered: {
          location: "Green Valley",
          license: "LIC-123",
          date: "2026-07-02",
          time: "10:30 AM",
          amount: "46.7",
        },
      },
    }));

    assert.deepStrictEqual(model.fields.dispensary, {
      current: "Green Valley",
      suggestion: "Green Valley",
      source: "local-ai",
      changed: false,
    });
    assert.deepStrictEqual(model.fields.licenseNumber, {
      current: "LIC-123",
      suggestion: "LIC-123",
      source: "local-ai",
      changed: false,
    });
    assert.strictEqual(model.fields.total.changed, false);
  });

  test("advisory result with differing values", function() {
    const analysis = makeAnalysis({
      advisory: {
        ...makeAnalysis().advisory,
        receipt: {
          ...makeAnalysis().advisory.receipt,
          dispensary: "Green Valley East",
          licenseNumber: "LIC-999",
          total: 50,
        },
      },
    });
    const model = buildReceiptReviewModel(analysis);

    assert.strictEqual(model.fields.dispensary.changed, true);
    assert.strictEqual(model.fields.licenseNumber.changed, true);
    assert.strictEqual(model.fields.total.changed, true);
  });

  test("comparison normalization for currency text date and time", function() {
    const analysis = makeAnalysis({
      trace: {
        finalRendered: {
          location: "Cash",
          license: "LIC-123",
          date: "May 14, 2026",
          time: "13:28",
          amount: 10,
        },
      },
      advisory: {
        ...makeAnalysis().advisory,
        receipt: {
          ...makeAnalysis().advisory.receipt,
          dispensary: "cash",
          purchaseDate: "2026-05-14",
          purchaseTime: "1:28 PM",
          total: "$10.00",
        },
      },
    });
    const model = buildReceiptReviewModel(analysis);

    assert.deepStrictEqual(model.fields.dispensary, {
      current: "Cash",
      suggestion: "cash",
      source: "local-ai",
      changed: false,
    });
    assert.strictEqual(model.fields.total.current, 10);
    assert.strictEqual(model.fields.total.suggestion, "$10.00");
    assert.strictEqual(model.fields.total.changed, false);
    assert.strictEqual(model.fields.purchaseDate.current, "May 14, 2026");
    assert.strictEqual(model.fields.purchaseDate.suggestion, "2026-05-14");
    assert.strictEqual(model.fields.purchaseDate.changed, false);
    assert.strictEqual(model.fields.purchaseTime.current, "13:28");
    assert.strictEqual(model.fields.purchaseTime.suggestion, "1:28 PM");
    assert.strictEqual(model.fields.purchaseTime.changed, false);
  });

  test("truly different values still compare as different", function() {
    const analysis = makeAnalysis({
      trace: {
        finalRendered: {
          amount: 10,
        },
      },
      advisory: {
        ...makeAnalysis().advisory,
        receipt: {
          ...makeAnalysis().advisory.receipt,
          total: 11,
        },
      },
    });
    const model = buildReceiptReviewModel(analysis);

    assert.strictEqual(model.fields.total.current, 10);
    assert.strictEqual(model.fields.total.suggestion, 11);
    assert.strictEqual(model.fields.total.changed, true);
  });

  test("advisory products discounts loyalty", function() {
    const model = buildReceiptReviewModel(makeAnalysis());

    assert.deepStrictEqual(model.products, makeAnalysis().advisory.receipt.products);
    assert.deepStrictEqual(model.discounts, makeAnalysis().advisory.receipt.discounts);
    assert.deepStrictEqual(model.loyalty, makeAnalysis().advisory.receipt.loyalty);
  });

  test("returned enrichment does not mutate advisory receipt", function() {
    const analysis = makeAnalysis();
    const model = buildReceiptReviewModel(analysis);

    model.products[0].name = "Changed Product";
    model.discounts[0].description = "Changed Discount";
    model.loyalty.balance = 999;

    assert.strictEqual(analysis.advisory.receipt.products[0].name, "Blue Dream");
    assert.strictEqual(analysis.advisory.receipt.discounts[0].description, "Loyalty");
    assert.strictEqual(analysis.advisory.receipt.loyalty.balance, 50);
  });

  test("null and empty values", function() {
    const analysis = makeAnalysis({
      trace: {
        finalRendered: {
          location: "",
          license: null,
          date: "2026-07-02",
          time: "",
          amount: "",
        },
      },
      advisory: {
        ...makeAnalysis().advisory,
        receipt: {
          ...makeAnalysis().advisory.receipt,
          dispensary: "Green Valley",
          licenseNumber: null,
          purchaseTime: "",
          total: null,
        },
      },
    });
    const model = buildReceiptReviewModel(analysis);

    assert.strictEqual(model.fields.dispensary.current, "");
    assert.strictEqual(model.fields.dispensary.suggestion, "Green Valley");
    assert.strictEqual(model.fields.dispensary.changed, false);
    assert.strictEqual(model.fields.licenseNumber.current, null);
    assert.strictEqual(model.fields.licenseNumber.suggestion, null);
    assert.strictEqual(model.fields.purchaseTime.suggestion, "");
    assert.strictEqual(model.fields.purchaseTime.source, null);
    assert.strictEqual(model.fields.total.changed, false);
  });

  test("metadata trace precedence", function() {
    const analysis = makeAnalysis({
      trace: {
        finalRendered: {
          location: "Trace Value",
        },
      },
      metadata: {
        trace: {
          finalRendered: {
            location: "Metadata Trace Value",
          },
        },
      },
    });
    const model = buildReceiptReviewModel(analysis);

    assert.strictEqual(model.fields.dispensary.current, "Metadata Trace Value");
  });

  test("deterministic repeated builds", function() {
    const analysis = makeAnalysis();

    assert.deepStrictEqual(
      buildReceiptReviewModel(analysis),
      buildReceiptReviewModel(analysis)
    );
  });

  test("input immutability", function() {
    const analysis = makeAnalysis();
    const before = clone(analysis);

    buildReceiptReviewModel(analysis);
    assert.deepStrictEqual(analysis, before);
  });

  test("advisory and metadata preserved by reference", function() {
    const analysis = makeAnalysis();
    const model = buildReceiptReviewModel(analysis);

    assert.strictEqual(model.advisory, analysis.advisory);
    assert.strictEqual(model.metadata, analysis.metadata);
  });

  test("static no side-effect imports or calls", function() {
    const source = fs.readFileSync(
      path.join(__dirname, "js", "services", "ReceiptReviewModelBuilder.js"),
      "utf8"
    );
    const forbidden = [
      "analyzeReceipt",
      "ReceiptIntelligenceService",
      "ReceiptVisionProvider",
      "ReceiptProcessingPipeline",
      "ReceiptJsonExtractor",
      "ReceiptJsonRepair",
      "ReceiptJsonValidator",
      "ReceiptObjectMapper",
      "OnnxVisionRuntime",
      "ocr",
      "matcher",
      "addReceipt",
      "updateReceipt",
      "deleteReceipt",
      "document.",
      "window.",
    ];

    assert.strictEqual(source.includes("ReceiptComparisonNormalizer"), true);
    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `builder should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Review model summaries:");
  for (const summary of summaries) {
    console.log(`- ${summary}`);
  }
}

run().catch((error) => {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
