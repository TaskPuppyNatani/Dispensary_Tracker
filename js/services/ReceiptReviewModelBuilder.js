const LOCAL_AI_SOURCE = "local-ai";

const FIELD_DEFINITIONS = [
  {
    key: "dispensary",
    currentKey: "location",
    suggestionKey: "dispensary",
  },
  {
    key: "licenseNumber",
    currentKey: "license",
    suggestionKey: "licenseNumber",
  },
  {
    key: "receiptNumber",
    currentKey: null,
    suggestionKey: "receiptNumber",
  },
  {
    key: "purchaseDate",
    currentKey: "date",
    suggestionKey: "purchaseDate",
  },
  {
    key: "purchaseTime",
    currentKey: "time",
    suggestionKey: "purchaseTime",
  },
  {
    key: "subtotal",
    currentKey: null,
    suggestionKey: "subtotal",
  },
  {
    key: "tax",
    currentKey: null,
    suggestionKey: "tax",
  },
  {
    key: "total",
    currentKey: "amount",
    suggestionKey: "total",
  },
  {
    key: "paymentMethod",
    currentKey: null,
    suggestionKey: "paymentMethod",
  },
  {
    key: "budtender",
    currentKey: null,
    suggestionKey: "budtender",
  },
];

export function buildReceiptReviewModel(analysisResult) {
  const analysis = isRecord(analysisResult) ? analysisResult : {};
  const deterministicSnapshot = getDeterministicSnapshot(analysis);
  const advisory = isRecord(analysis.advisory) ? analysis.advisory : null;
  const advisoryReceipt = advisory && isRecord(advisory.receipt) ? advisory.receipt : null;

  const fields = {};
  for (const definition of FIELD_DEFINITIONS) {
    const current = definition.currentKey
      ? readNullableValue(deterministicSnapshot, definition.currentKey)
      : null;
    const suggestion = definition.suggestionKey
      ? readNullableValue(advisoryReceipt, definition.suggestionKey)
      : null;

    fields[definition.key] = {
      current,
      suggestion,
      source: hasPresentValue(suggestion) ? LOCAL_AI_SOURCE : null,
      changed: valuesDiffer(current, suggestion),
    };
  }

  return {
    fields,
    products: Array.isArray(advisoryReceipt && advisoryReceipt.products)
      ? deepCopy(advisoryReceipt.products)
      : [],
    discounts: Array.isArray(advisoryReceipt && advisoryReceipt.discounts)
      ? deepCopy(advisoryReceipt.discounts)
      : [],
    loyalty: advisoryReceipt && Object.prototype.hasOwnProperty.call(advisoryReceipt, "loyalty")
      ? deepCopy(advisoryReceipt.loyalty)
      : null,
    advisory: analysis.advisory || null,
    metadata: analysis.metadata || null,
  };
}

function getDeterministicSnapshot(analysis) {
  const metadataTrace = analysis.metadata && isRecord(analysis.metadata.trace)
    ? analysis.metadata.trace
    : null;

  if (metadataTrace && isRecord(metadataTrace.finalRendered)) {
    return metadataTrace.finalRendered;
  }

  if (isRecord(analysis.trace) && isRecord(analysis.trace.finalRendered)) {
    return analysis.trace.finalRendered;
  }

  if (isRecord(analysis.finalRendered)) {
    return analysis.finalRendered;
  }

  return {};
}

function readNullableValue(source, key) {
  if (!source || !Object.prototype.hasOwnProperty.call(source, key)) {
    return null;
  }

  return source[key] === undefined ? null : source[key];
}

function valuesDiffer(current, suggestion) {
  if (!hasPresentValue(current) || !hasPresentValue(suggestion)) {
    return false;
  }

  return normalizeForComparison(current) !== normalizeForComparison(suggestion);
}

function hasPresentValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function normalizeForComparison(value) {
  return String(value).trim();
}

function deepCopy(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
