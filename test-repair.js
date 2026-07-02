const assert = require('assert');
const { repair } = require('./local-ai/ReceiptJsonRepair');

function run() {
  // Helper to build extraction object
  function ex(text, diagnostics) {
    return { extractedText: text, diagnostics: diagnostics || {} };
  }

  // 1) Complete valid JSON - should be byte-identical and parseSucceeded true
  (function() {
    const t = '{"a":1, "b":"x"}';
    const r = repair(ex(t, { braceDepthAtEnd: 0, foundCompleteObject: true }));
    assert.strictEqual(r.repairedText, t, 'valid JSON should be byte-identical');
    assert.strictEqual(r.repair.repaired, false);
    assert.strictEqual(r.repair.parseSucceeded, true);
  })();

  // 2) Missing final brace
  (function() {
    const t = '{"a":1';
    const r = repair(ex(t, { braceDepthAtEnd: 1 }));
    assert.strictEqual(r.repair.repaired, true);
    assert.ok(r.repair.repairsApplied.includes('closedBrace'));
    assert.strictEqual(r.repair.parseSucceeded, true);
    assert.ok(r.repairedText.endsWith('}'));
  })();

  // 3) Missing multiple braces
  (function() {
    const t = '{{"a":1';
    const r = repair(ex(t, { braceDepthAtEnd: 2 }));
    assert.strictEqual(r.repair.repaired, true);
    assert.ok(r.repair.repairsApplied.includes('closedBrace'));
    // Parsing may still fail for this case (we cannot invent keys). Ensure deterministic repair only.
    assert.ok(r.repairedText.endsWith('}}'));
  })();

  // 4a) Unterminated string when diagnostics indicate termination inside string
  (function() {
    const t = '{"a":"value';
    const r = repair(ex(t, { terminatedInsideString: true, braceDepthAtEnd: 1 }));
    assert.strictEqual(r.repair.repaired, true);
    assert.ok(r.repair.repairsApplied.includes('closedString'));
    assert.ok(r.repair.repairsApplied.includes('closedBrace'));
    assert.strictEqual(r.repair.parseSucceeded, true);
  })();

  // 4b) Unterminated string when no diagnostic - no string repair attempted
  (function() {
    const t = '{"a":"value';
    const r = repair(ex(t, { braceDepthAtEnd: 0 }));
    // There may be no repair applied (or only trimmedWhitespace). Ensure no closedString.
    assert.ok(!r.repair.repairsApplied.includes('closedString'));
    assert.strictEqual(r.repair.parseSucceeded, false);
  })();

  // 5) Trailing comma before }
  (function() {
    const t = '{"a":1,}';
    const r = repair(ex(t, { foundCompleteObject: true }));
    assert.ok(r.repair.repairsApplied.includes('removedTrailingComma'));
    assert.strictEqual(r.repair.parseSucceeded, true);
  })();

  // 6) Trailing comma before ]
  (function() {
    const t = '{"arr": [1,], "b":2}';
    const r = repair(ex(t, { foundCompleteObject: true }));
    assert.ok(r.repair.repairsApplied.includes('removedTrailingComma'));
    assert.strictEqual(r.repair.parseSucceeded, true);
  })();

  // 7) JSON followed by <end_of_utterance>
  (function() {
    const t = '{"a":1} <end_of_utterance>';
    const r = repair(ex(t, { trailingTextLength: 19, foundCompleteObject: true }));
    assert.ok(r.repair.repairsApplied.includes('trimmedTrailingText'));
    assert.strictEqual(r.repair.parseSucceeded, true);
  })();

  // 8) Already-valid JSON remains byte-identical (repeat to be sure)
  (function() {
    const t = '{"x": 2}';
    const r = repair(ex(t, { foundCompleteObject: true }));
    assert.strictEqual(r.repairedText, t);
    assert.strictEqual(r.repair.repaired, false);
    assert.strictEqual(r.repair.parseSucceeded, true);
  })();

  // 9) Invalid JSON that cannot be repaired
  (function() {
    const t = 'not json at all';
    const r = repair(ex(t, {}));
    assert.strictEqual(r.repair.parseSucceeded, false);
  })();

  console.log('ALL TESTS PASSED');
}

try {
  run();
} catch (e) {
  console.error('TESTS FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
}
