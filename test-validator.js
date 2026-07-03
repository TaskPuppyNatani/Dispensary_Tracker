const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  EXPECTED_RECEIPT_TOP_LEVEL_KEYS,
  REQUIRED_RECEIPT_TOP_LEVEL_KEYS,
  validate
} = require("./local-ai/ReceiptJsonValidator");

function makeValidReceipt(overrides) {
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

function repairResultFrom(value) {
  return { repairedText: JSON.stringify(value), repair: { parseSucceeded: true } };
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

  test("valid receipt", function() {
    const result = validate(repairResultFrom(makeValidReceipt()));
    assert.strictEqual(result.validation.valid, true);
    assert.strictEqual(result.validation.parseSucceeded, true);
    assert.deepStrictEqual(result.validation.missingFields, []);
    assert.deepStrictEqual(result.validation.unexpectedFields, []);
    assert.deepStrictEqual(result.validation.typeErrors, []);
  });

  test("missing required field", function() {
    const receipt = makeValidReceipt();
    delete receipt.total;

    const result = validate(repairResultFrom(receipt));
    assert.strictEqual(result.validation.valid, false);
    assert.deepStrictEqual(result.validation.missingFields, ["total"]);
    assert.deepStrictEqual(result.validation.typeErrors, []);
  });

  test("missing optional loyalty validates", function() {
    const receipt = makeValidReceipt();
    delete receipt.loyalty;

    const result = validate(repairResultFrom(receipt));
    assert.strictEqual(result.validation.valid, true);
    assert.deepStrictEqual(result.validation.missingFields, []);
    assert.deepStrictEqual(result.validation.typeErrors, []);
  });

  test("present valid loyalty validates", function() {
    const result = validate(repairResultFrom(makeValidReceipt({
      loyalty: {
        earned: 5,
        redeemed: null,
        balance: 25
      }
    })));

    assert.strictEqual(result.validation.valid, true);
    assert.deepStrictEqual(result.validation.typeErrors, []);
  });

  test("present invalid loyalty fails", function() {
    const result = validate(repairResultFrom(makeValidReceipt({
      loyalty: {
        earned: "5",
        redeemed: null,
        balance: 25
      }
    })));

    assert.strictEqual(result.validation.valid, false);
    assert.deepStrictEqual(result.validation.missingFields, []);
    assert.ok(result.validation.typeErrors.some((error) => (
      error.field === "loyalty.earned"
      && error.expected === "number|null"
      && error.actual === "string"
    )));
  });

  test("wrong primitive type", function() {
    const result = validate(repairResultFrom(makeValidReceipt({ subtotal: "42.50" })));
    assert.strictEqual(result.validation.valid, false);
    assert.deepStrictEqual(result.validation.typeErrors, [
      { field: "subtotal", expected: "number|null", actual: "string" }
    ]);
  });

  test("wrong nested type", function() {
    const receipt = makeValidReceipt({
      products: [
        {
          name: "Blue Dream",
          brand: "Acme",
          category: "flower",
          quantity: "1",
          unit_price: 40,
          total_price: 40
        }
      ],
      discounts: [
        {
          description: "Loyalty",
          amount: "2"
        }
      ],
      loyalty: {
        earned: 10,
        redeemed: null,
        balance: "50"
      }
    });

    const result = validate(repairResultFrom(receipt));
    assert.strictEqual(result.validation.valid, false);
    assert.deepStrictEqual(result.validation.typeErrors, [
      { field: "discounts[0].amount", expected: "number|null", actual: "string" },
      { field: "products[0].quantity", expected: "number|null", actual: "string" },
      { field: "loyalty.balance", expected: "number|null", actual: "string" }
    ]);
  });

  test("extra field", function() {
    const result = validate(repairResultFrom(makeValidReceipt({ cashier_id: "C-1" })));
    assert.strictEqual(result.validation.valid, true);
    assert.deepStrictEqual(result.validation.unexpectedFields, ["cashier_id"]);
  });

  test("invalid JSON", function() {
    const result = validate({ repairedText: "{\"dispensary\":\"Green\"" });
    assert.strictEqual(result.receipt, null);
    assert.strictEqual(result.validation.valid, false);
    assert.strictEqual(result.validation.parseSucceeded, false);
    assert.deepStrictEqual(result.validation.missingFields, REQUIRED_RECEIPT_TOP_LEVEL_KEYS);
    assert.deepStrictEqual(result.validation.unexpectedFields, []);
    assert.deepStrictEqual(result.validation.typeErrors, []);
  });

  test("null values", function() {
    const result = validate(repairResultFrom(makeValidReceipt({
      dispensary: null,
      license_number: null,
      receipt_number: null,
      purchase_date: null,
      purchase_time: null,
      subtotal: null,
      tax: null,
      total: null,
      payment_method: null,
      budtender: null,
      loyalty: null,
      products: [
        {
          name: "Blue Dream",
          brand: null,
          category: null,
          quantity: null,
          unit_price: null,
          total_price: null
        }
      ],
      discounts: [
        {
          description: "Promo",
          amount: null
        }
      ]
    })));

    assert.strictEqual(result.validation.valid, true);
  });

  test("empty arrays", function() {
    const result = validate(repairResultFrom(makeValidReceipt({
      discounts: [],
      products: []
    })));
    assert.strictEqual(result.validation.valid, true);
  });

  test("missing metadata", function() {
    const result = validate({ repairedText: JSON.stringify(makeValidReceipt()) });
    assert.strictEqual(result.validation.valid, true);
  });

  test("non-object JSON", function() {
    const result = validate({ repairedText: "[]" });
    assert.strictEqual(result.receipt.length, 0);
    assert.strictEqual(result.validation.valid, false);
    assert.strictEqual(result.validation.parseSucceeded, true);
    assert.deepStrictEqual(result.validation.missingFields, REQUIRED_RECEIPT_TOP_LEVEL_KEYS);
    assert.deepStrictEqual(result.validation.typeErrors, [
      { field: "$", expected: "object", actual: "array" }
    ]);
  });

  test("nested missing fields", function() {
    const result = validate(repairResultFrom(makeValidReceipt({
      products: [{ name: "Blue Dream" }],
      discounts: [{}],
      loyalty: {}
    })));

    assert.strictEqual(result.validation.valid, false);
    assert.ok(result.validation.typeErrors.some((error) => error.field === "products[0].brand" && error.actual === "missing"));
    assert.ok(result.validation.typeErrors.some((error) => error.field === "discounts[0].description" && error.actual === "missing"));
    assert.ok(result.validation.typeErrors.some((error) => error.field === "loyalty.earned" && error.actual === "missing"));
  });

  test("determinism", function() {
    const input = repairResultFrom(makeValidReceipt({ subtotal: "42.50" }));
    assert.deepStrictEqual(validate(input), validate(input));
  });

  test("input immutability", function() {
    const input = repairResultFrom(makeValidReceipt());
    const before = clone(input);

    validate(input);
    assert.deepStrictEqual(input, before);
  });

  test("static no inference imports", function() {
    const validatorPath = path.join(__dirname, "local-ai", "ReceiptJsonValidator.js");
    const source = fs.readFileSync(validatorPath, "utf8");
    const forbidden = [
      "runtime.generate",
      "OnnxVisionRuntime",
      "InferenceSession",
      "SmolVLMTokenizer",
      "SmolVLMImageProcessor",
      "ReceiptVisionProvider"
    ];

    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `validator should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("Validation summaries:");
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
