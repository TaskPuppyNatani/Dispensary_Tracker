// CommonJS utility to perform conservative structural repairs on extracted JSON text.
// Exports: repair(extraction)

"use strict";

function repair(extraction) {
  if (!extraction || typeof extraction !== 'object') {
    return {
      repairedText: null,
      repair: { repaired: false, repairsApplied: [], parseSucceeded: false }
    };
  }

  const originalText = extraction.extractedText;
  if (originalText == null) {
    return {
      repairedText: null,
      repair: { repaired: false, repairsApplied: [], parseSucceeded: false }
    };
  }

  const diagnostics = extraction.diagnostics || {};

  // Work on a copy
  let text = String(originalText);
  const repairsApplied = [];

  // Helper: scan text while tracking string state to find first top-level closing brace index
  function findFirstTopLevelEnd(s) {
    let inString = false;
    let escape = false;
    let depth = 0;
    let foundStart = -1;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else {
        if (ch === '"') {
          inString = true;
        } else if (ch === '{') {
          if (foundStart === -1) foundStart = i;
          depth++;
        } else if (ch === '}') {
          if (depth > 0) depth--;
          if (foundStart !== -1 && depth === 0) return i;
        }
      }
    }
    return -1;
  }

  // 1) Trim trailing whitespace
  const trimmed = text.replace(/[\s\u00A0]+$/u, '');
  if (trimmed.length !== text.length) {
    text = trimmed;
    repairsApplied.push("trimmedTrailingWhitespace");
  }

  // 2) Remove trailing commas immediately before } or ] (but only when not inside strings)
  function removeTrailingCommas(s) {
    let out = '';
    let inString = false;
    let escape = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        out += ch;
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else {
        if (ch === '"') {
          inString = true;
          out += ch;
        } else if (ch === ',') {
          // lookahead to see if the next non-space char is } or ]
          let j = i + 1;
          while (j < s.length && /[\s]/.test(s[j])) j++;
          if (j < s.length && (s[j] === '}' || s[j] === ']')) {
            // drop the comma (skip adding it)
            // continue without advancing i (for-loop will advance)
            continue;
          } else {
            out += ch;
          }
        } else {
          out += ch;
        }
      }
    }
    return out;
  }

  const withoutTrailingCommas = removeTrailingCommas(text);
  if (withoutTrailingCommas !== text) {
    text = withoutTrailingCommas;
    repairsApplied.push('removedTrailingComma');
  }

  // 3) Close unterminated string only when diagnostics indicate it ended inside a string
  if (diagnostics.terminatedInsideString === true) {
    // Follow the directive: trust extractor diagnostics and append a closing quote.
    text = text + '"';
    repairsApplied.push('closedString');
  }

  // 4) Close unmatched object braces using diagnostics.braceDepthAtEnd when > 0
  if (typeof diagnostics.braceDepthAtEnd === 'number' && diagnostics.braceDepthAtEnd > 0) {
    const toAdd = '}'.repeat(diagnostics.braceDepthAtEnd);
    text = text + toAdd;
    repairsApplied.push('closedBrace');
  }

  // 5) Ensure repaired output ends at the completed top-level object (strip trailing tokens after top-level end)
  const topEnd = findFirstTopLevelEnd(text);
  if (topEnd !== -1 && topEnd + 1 < text.length) {
    // If diagnostics indicate trailing text, or there is non-whitespace after the topEnd, trim it.
    const after = text.slice(topEnd + 1);
    if (/\S/.test(after)) {
      text = text.slice(0, topEnd + 1);
      repairsApplied.push('trimmedTrailingText');
    } else if (after.length > 0) {
      // only whitespace, we can trim
      text = text.slice(0, topEnd + 1);
      repairsApplied.push('trimmedTrailingText');
    }
  }

  // Final invariant: if no repairs applied, repairedText must be byte-identical to original
  let repairedText = text;
  const repairedFlag = repairsApplied.length > 0;
  if (!repairedFlag) {
    repairedText = originalText;
  }

  // Attempt single JSON.parse
  let parseSucceeded = false;
  try {
    JSON.parse(repairedText);
    parseSucceeded = true;
  } catch (e) {
    parseSucceeded = false;
  }

  return {
    repairedText: repairedText,
    repair: {
      repaired: repairedFlag,
      repairsApplied: repairsApplied,
      parseSucceeded: parseSucceeded
    }
  };
}

module.exports = { repair };
