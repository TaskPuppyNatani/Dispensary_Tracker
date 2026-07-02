"use strict";

const EXPECTED_RECEIPT_TOP_LEVEL_KEYS = Object.freeze([
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
  "products",
]);

function evaluate(analysis) {
  const text = readAnalysisText(analysis);
  const metadata = analysis && typeof analysis === "object" ? analysis.metadata : undefined;
  const trimmedText = text.trim();
  const parsedObject = parseGeneratedObject(trimmedText);
  const topLevelKeysFound = parsedObject
    ? EXPECTED_RECEIPT_TOP_LEVEL_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(parsedObject, key))
    : [];

  return {
    text,
    evaluation: {
      parsesAsJson: Boolean(parsedObject),
      beginsWithObject: trimmedText.startsWith("{"),
      endsWithObject: trimmedText.endsWith("}"),
      topLevelKeysFound,
      missingTopLevelKeys: EXPECTED_RECEIPT_TOP_LEVEL_KEYS.filter((key) => !topLevelKeysFound.includes(key)),
      generatedCharacterCount: text.length,
      generatedTokenCount: readGeneratedTokenCount(metadata),
    },
    metadata,
  };
}

function readAnalysisText(analysis) {
  if (!analysis || typeof analysis !== "object" || typeof analysis.text !== "string") {
    return "";
  }

  return analysis.text;
}

function parseGeneratedObject(trimmedText) {
  try {
    const parsed = JSON.parse(trimmedText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch (error) {
    return null;
  }
}

function readGeneratedTokenCount(metadata) {
  const tokenCount = metadata
    && metadata.generation
    && metadata.generation.generatedTokenCount;

  return Number.isSafeInteger(tokenCount) && tokenCount >= 0 ? tokenCount : 0;
}

module.exports = {
  EXPECTED_RECEIPT_TOP_LEVEL_KEYS,
  evaluate,
};
