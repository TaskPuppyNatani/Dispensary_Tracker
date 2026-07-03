// CommonJS utility to validate repaired receipt JSON against the expected schema.
// Exports: validate(repairResult), EXPECTED_RECEIPT_TOP_LEVEL_KEYS

"use strict";

const EXPECTED_RECEIPT_TOP_LEVEL_KEYS = [
  "dispensary",
  "license_number",
  "receipt_number",
  "purchase_date",
  "purchase_time",
  "subtotal",
  "tax",
  "total",
  "payment_method",
  "budtender",
  "discounts",
  "loyalty",
  "products"
];

const REQUIRED_RECEIPT_TOP_LEVEL_KEYS = EXPECTED_RECEIPT_TOP_LEVEL_KEYS.filter((key) => key !== "loyalty");

const STRING_OR_NULL_FIELDS = [
  "dispensary",
  "license_number",
  "receipt_number",
  "purchase_date",
  "purchase_time",
  "payment_method",
  "budtender"
];

const NUMBER_OR_NULL_FIELDS = ["subtotal", "tax", "total"];

const PRODUCT_SCHEMA = {
  name: "string",
  brand: "string|null",
  category: "string|null",
  quantity: "number|null",
  unit_price: "number|null",
  total_price: "number|null"
};

const DISCOUNT_SCHEMA = {
  description: "string|null",
  amount: "number|null"
};

const LOYALTY_SCHEMA = {
  earned: "number|null",
  redeemed: "number|null",
  balance: "number|null"
};

function validate(repairResult) {
  const repairedText = repairResult && typeof repairResult === "object"
    ? repairResult.repairedText
    : undefined;

  let receipt = null;
  let parseSucceeded = false;

  try {
    receipt = JSON.parse(repairedText);
    parseSucceeded = true;
  } catch (error) {
    return {
      receipt: null,
      validation: {
        valid: false,
        parseSucceeded: false,
        missingFields: REQUIRED_RECEIPT_TOP_LEVEL_KEYS.slice(),
        unexpectedFields: [],
        typeErrors: []
      }
    };
  }

  const missingFields = [];
  const unexpectedFields = [];
  const typeErrors = [];

  if (!isPlainObject(receipt)) {
    return {
      receipt,
      validation: {
        valid: false,
        parseSucceeded,
        missingFields: REQUIRED_RECEIPT_TOP_LEVEL_KEYS.slice(),
        unexpectedFields,
        typeErrors: [
          {
            field: "$",
            expected: "object",
            actual: getActualType(receipt)
          }
        ]
      }
    };
  }

  const receiptKeys = Object.keys(receipt);
  for (const key of REQUIRED_RECEIPT_TOP_LEVEL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(receipt, key)) {
      missingFields.push(key);
    }
  }

  for (const key of receiptKeys) {
    if (!EXPECTED_RECEIPT_TOP_LEVEL_KEYS.includes(key)) {
      unexpectedFields.push(key);
    }
  }

  for (const field of STRING_OR_NULL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(receipt, field)) {
      validateValueType(receipt[field], field, "string|null", typeErrors);
    }
  }

  for (const field of NUMBER_OR_NULL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(receipt, field)) {
      validateValueType(receipt[field], field, "number|null", typeErrors);
    }
  }

  if (Object.prototype.hasOwnProperty.call(receipt, "discounts")) {
    validateArray(receipt.discounts, "discounts", DISCOUNT_SCHEMA, typeErrors);
  }

  if (Object.prototype.hasOwnProperty.call(receipt, "products")) {
    validateArray(receipt.products, "products", PRODUCT_SCHEMA, typeErrors);
  }

  if (Object.prototype.hasOwnProperty.call(receipt, "loyalty")) {
    validateLoyalty(receipt.loyalty, typeErrors);
  }

  return {
    receipt,
    validation: {
      valid: parseSucceeded && missingFields.length === 0 && typeErrors.length === 0,
      parseSucceeded,
      missingFields,
      unexpectedFields,
      typeErrors
    }
  };
}

function validateArray(value, field, schema, typeErrors) {
  if (!Array.isArray(value)) {
    addTypeError(typeErrors, field, "array", value);
    return;
  }

  value.forEach((item, index) => {
    const itemPath = `${field}[${index}]`;
    if (!isPlainObject(item)) {
      addTypeError(typeErrors, itemPath, "object", item);
      return;
    }

    validateObjectFields(item, itemPath, schema, typeErrors);
  });
}

function validateLoyalty(value, typeErrors) {
  if (value === null) {
    return;
  }

  if (!isPlainObject(value)) {
    addTypeError(typeErrors, "loyalty", "object|null", value);
    return;
  }

  validateObjectFields(value, "loyalty", LOYALTY_SCHEMA, typeErrors);
}

function validateObjectFields(value, basePath, schema, typeErrors) {
  for (const [field, expected] of Object.entries(schema)) {
    const path = `${basePath}.${field}`;
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      typeErrors.push({
        field: path,
        expected,
        actual: "missing"
      });
      continue;
    }

    validateValueType(value[field], path, expected, typeErrors);
  }
}

function validateValueType(value, field, expected, typeErrors) {
  if (matchesExpectedType(value, expected)) {
    return;
  }

  addTypeError(typeErrors, field, expected, value);
}

function addTypeError(typeErrors, field, expected, value) {
  typeErrors.push({
    field,
    expected,
    actual: getActualType(value)
  });
}

function matchesExpectedType(value, expected) {
  if (expected === "string") {
    return typeof value === "string";
  }

  if (expected === "number") {
    return typeof value === "number";
  }

  if (expected === "string|null") {
    return value === null || typeof value === "string";
  }

  if (expected === "number|null") {
    return value === null || typeof value === "number";
  }

  return false;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getActualType(value) {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}

module.exports = {
  EXPECTED_RECEIPT_TOP_LEVEL_KEYS,
  REQUIRED_RECEIPT_TOP_LEVEL_KEYS,
  validate
};
