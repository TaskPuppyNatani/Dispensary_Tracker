"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { map } = require("./local-ai/ReceiptObjectMapper");

function makeValidationResult(overrides) {
  const baseReceipt = {
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
  };

  return Object.assign(
    {
      receipt: baseReceipt,
      validation: {
        valid: true,
        parseSucceeded: true,
        missingFields: [],
        unexpectedFields: [],
        typeErrors: []
      }
    },
    overrides || {}
  );
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
    const result = map(makeValidationResult());

    assert.strictEqual(result.mapping.mapped, true);
    assert.strictEqual(result.mapping.sourceValid, true);
    assert.deepStrictEqual(result.mapping.warnings, []);
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

  test("invalid validation result", function() {
    const result = map({
      receipt: makeValidationResult().receipt,
      validation: {
        valid: false
      }
    });

    assert.strictEqual(result.receipt, null);
    assert.strictEqual(result.mapping.mapped, false);
    assert.strictEqual(result.mapping.sourceValid, false);
    assert.deepStrictEqual(result.mapping.warnings, []);
  });

  test("null values", function() {
    const result = map(makeValidationResult({
      receipt: {
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
        discounts: [
          {
            description: "Promo",
            amount: null
          }
        ],
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
        ]
      }
    }));

    assert.deepStrictEqual(result.receipt, {
      dispensary: null,
      licenseNumber: null,
      receiptNumber: null,
      purchaseDate: null,
      purchaseTime: null,
      subtotal: null,
      tax: null,
      total: null,
      paymentMethod: null,
      budtender: null,
      discounts: [
        {
          description: "Promo",
          amount: null
        }
      ],
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
      ]
    });
  });

  test("missing optional loyalty maps to null", function() {
    const validationResult = makeValidationResult();
    delete validationResult.receipt.loyalty;

    const result = map(validationResult);

    assert.strictEqual(result.mapping.mapped, true);
    assert.strictEqual(result.mapping.sourceValid, true);
    assert.strictEqual(result.receipt.loyalty, null);
  });

  test("empty arrays", function() {
    const result = map(makeValidationResult({
      receipt: {
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
        discounts: [],
        loyalty: {
          earned: 10,
          redeemed: null,
          balance: 50
        },
        products: []
      }
    }));

    assert.deepStrictEqual(result.receipt.discounts, []);
    assert.deepStrictEqual(result.receipt.products, []);
    assert.deepStrictEqual(result.mapping.warnings, []);
  });

  test("multiple products", function() {
    const result = map(makeValidationResult({
      receipt: {
        dispensary: "Green Valley",
        license_number: "LIC-123",
        receipt_number: "R-100",
        purchase_date: "2026-07-02",
        purchase_time: "10:30 AM",
        subtotal: 100,
        tax: 10,
        total: 110,
        payment_method: "cash",
        budtender: "Alex",
        discounts: [],
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
          },
          {
            name: "Gummies",
            brand: "Acme",
            category: "edible",
            quantity: 2,
            unit_price: 30,
            total_price: 60
          }
        ]
      }
    }));

    assert.strictEqual(result.receipt.products.length, 2);
    assert.deepStrictEqual(result.receipt.products[0], {
      name: "Blue Dream",
      brand: "Acme",
      category: "flower",
      quantity: 1,
      unit_price: 40,
      total_price: 40
    });
    assert.deepStrictEqual(result.receipt.products[1], {
      name: "Gummies",
      brand: "Acme",
      category: "edible",
      quantity: 2,
      unit_price: 30,
      total_price: 60
    });
  });

  test("multiple discounts", function() {
    const result = map(makeValidationResult({
      receipt: {
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
          },
          {
            description: "Promotion",
            amount: 3
          }
        ],
        loyalty: {
          earned: 10,
          redeemed: null,
          balance: 50
        },
        products: []
      }
    }));

    assert.strictEqual(result.receipt.discounts.length, 2);
    assert.deepStrictEqual(result.receipt.discounts[0], {
      description: "Loyalty",
      amount: 2
    });
    assert.deepStrictEqual(result.receipt.discounts[1], {
      description: "Promotion",
      amount: 3
    });
  });

  test("deep copy verification", function() {
    const input = makeValidationResult();
    const result = map(input);

    assert.notStrictEqual(result.receipt, input.receipt);
    assert.notStrictEqual(result.receipt.products, input.receipt.products);
    assert.notStrictEqual(result.receipt.discounts, input.receipt.discounts);
    assert.notStrictEqual(result.receipt.loyalty, input.receipt.loyalty);
    assert.notStrictEqual(result.receipt.products[0], input.receipt.products[0]);
    assert.notStrictEqual(result.receipt.discounts[0], input.receipt.discounts[0]);

    result.receipt.products[0].name = "Changed";
    result.receipt.discounts[0].description = "Changed";
    result.receipt.loyalty.balance = 999;

    assert.strictEqual(input.receipt.products[0].name, "Blue Dream");
    assert.strictEqual(input.receipt.discounts[0].description, "Loyalty");
    assert.strictEqual(input.receipt.loyalty.balance, 50);
  });

  test("deterministic repeated mapping", function() {
    const input = makeValidationResult();
    assert.deepStrictEqual(map(input), map(input));
  });

  test("input immutability", function() {
    const input = makeValidationResult();
    const before = clone(input);

    map(input);

    assert.deepStrictEqual(input, before);
  });

  test("static no inference imports", function() {
    const mapperPath = path.join(__dirname, "local-ai", "ReceiptObjectMapper.js");
    const source = fs.readFileSync(mapperPath, "utf8");
    const forbidden = [
      "runtime.generate",
      "OnnxVisionRuntime",
      "InferenceSession",
      "SmolVLMTokenizer",
      "SmolVLMImageProcessor",
      "ReceiptVisionProvider",
      "ReceiptJsonRepair",
      "ReceiptJsonExtractor",
      "ReceiptJsonValidator"
    ];

    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `mapper should not reference ${term}`);
    }
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
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
