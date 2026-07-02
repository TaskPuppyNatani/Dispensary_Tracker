'use strict';

/**
 * ReceiptJsonExtractor — Extracts the first top-level JSON object (or partial JSON)
 * from raw AI-generated text. Used by the JSON repair phase to recover incomplete output.
 *
 * This module is a standalone utility. It imports no runtime, provider, tokenizer,
 * ONNX Runtime, image, OCR, matcher, or database modules.
 *
 * @module local-ai/ReceiptJsonExtractor
 */

/**
 * Extracts the first top-level JSON object (or partial JSON) from a string.
 *
 * The extractor:
 * - Locates the first `{` in the input.
 * - Tracks brace depth while correctly ignoring braces inside quoted strings.
 * - Returns the extracted substring (complete or partial) with diagnostics.
 *
 * It does **not**:
 * - Repair malformed JSON.
 * - Validate schema.
 * - Infer missing braces.
 * - Modify the input string.
 *
 * @param {string} text - The raw text to process.
 * @returns {{
 *   extractedText: string | null,
 *   diagnostics: {
 *     foundObjectStart: number,
 *     foundCompleteObject: boolean,
 *     startIndex: number,
 *     endIndex: number,
 *     extractedCharacterCount: number,
 *     trailingTextLength: number,
 *     braceDepthAtEnd: number
 *   }
 * }}
 * @throws {TypeError} if text is not a string.
 */
function extract(text) {
  if (typeof text !== 'string') {
    throw new TypeError('ReceiptJsonExtractor.extract() expects a string.');
  }

  // Locate the first opening brace
  const startIndex = text.indexOf('{');
  if (startIndex === -1) {
    return {
      extractedText: null,
      diagnostics: {
        foundObjectStart: -1,
        foundCompleteObject: false,
        startIndex: -1,
        endIndex: -1,
        extractedCharacterCount: 0,
        trailingTextLength: text.length,
        braceDepthAtEnd: 0
      }
    };
  }

  // State machine: parse from the first `{` to find a matching `}`
  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIndex = -1;

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];

    // Handle escape sequences inside strings
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    // Track string boundaries
    if (char === '"') {
      inString = !inString;
      continue;
    }

    // Skip braces inside strings
    if (inString) {
      continue;
    }

    // Track brace depth
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        endIndex = i + 1; // slice is exclusive
        break;
      }
    }
  }

  const foundCompleteObject = endIndex !== -1;

  let extractedText;
  let extractedCharacterCount;
  let trailingTextLength;
  let braceDepthAtEnd;

  if (foundCompleteObject) {
    // Complete object found — extract it
    extractedText = text.slice(startIndex, endIndex);
    extractedCharacterCount = endIndex - startIndex;
    trailingTextLength = text.length - endIndex;
    braceDepthAtEnd = 0;
  } else {
    // Incomplete object — preserve partial JSON for the repair phase
    extractedText = text.slice(startIndex);
    extractedCharacterCount = text.length - startIndex;
    trailingTextLength = 0;
    braceDepthAtEnd = depth;
  }

  return {
    extractedText,
    diagnostics: {
      foundObjectStart: startIndex,
      foundCompleteObject,
      startIndex,
      endIndex: foundCompleteObject ? endIndex : -1,
      extractedCharacterCount,
      trailingTextLength,
      braceDepthAtEnd
    }
  };
}

module.exports = { extract };
