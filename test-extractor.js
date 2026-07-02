'use strict';

const { extract } = require('./local-ai/ReceiptJsonExtractor.js');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

// Test 1: Complete JSON object
console.log('\n--- Test 1: Complete JSON object ---');
const r1 = extract('{"name": "Receipt", "total": 12.50}');
assert(r1.extractedText === '{"name": "Receipt", "total": 12.50}', 'extractedText matches');
assert(r1.diagnostics.foundObjectStart === 0, 'foundObjectStart is 0');
assert(r1.diagnostics.foundCompleteObject === true, 'foundCompleteObject is true');
assert(r1.diagnostics.startIndex === 0, 'startIndex is 0');
assert(r1.diagnostics.endIndex === 35, 'endIndex is 35');
assert(r1.diagnostics.extractedCharacterCount === 35, 'extractedCharacterCount is 35');
assert(r1.diagnostics.trailingTextLength === 0, 'trailingTextLength is 0');
assert(r1.diagnostics.braceDepthAtEnd === 0, 'braceDepthAtEnd is 0');

// Test 2: JSON followed by <end_of_utterance>
console.log('\n--- Test 2: JSON followed by <end_of_utterance> ---');
const r2 = extract('{"a": 1} <end_of_utterance>');
assert(r2.extractedText === '{"a": 1}', 'extractedText matches');
assert(r2.diagnostics.foundCompleteObject === true, 'foundCompleteObject is true');
assert(r2.diagnostics.trailingTextLength === 19, 'trailingTextLength is 19');

// Test 3: JSON followed by whitespace
console.log('\n--- Test 3: JSON followed by whitespace ---');
const r3 = extract('{"a": 1}   ');
assert(r3.extractedText === '{"a": 1}', 'extractedText matches');
assert(r3.diagnostics.foundCompleteObject === true, 'foundCompleteObject is true');
assert(r3.diagnostics.trailingTextLength === 3, 'trailingTextLength is 3');

// Test 4: Truncated JSON
console.log('\n--- Test 4: Truncated JSON ---');
const r4 = extract('{"a": 1');
assert(r4.extractedText === '{"a": 1', 'extractedText matches');
assert(r4.diagnostics.foundCompleteObject === false, 'foundCompleteObject is false');
assert(r4.diagnostics.endIndex === -1, 'endIndex is -1');
assert(r4.diagnostics.trailingTextLength === 0, 'trailingTextLength is 0');
assert(r4.diagnostics.braceDepthAtEnd === 1, 'braceDepthAtEnd is 1');

// Test 5: Nested JSON objects
console.log('\n--- Test 5: Nested JSON objects ---');
const r5 = extract('{"outer": {"inner": {"deep": true}}}');
assert(r5.extractedText === '{"outer": {"inner": {"deep": true}}}', 'extractedText matches');
assert(r5.diagnostics.foundCompleteObject === true, 'foundCompleteObject is true');
assert(r5.diagnostics.trailingTextLength === 0, 'trailingTextLength is 0');

// Test 6: Braces inside quoted strings
console.log('\n--- Test 6: Braces inside quoted strings ---');
const r6 = extract('{"text": "brace { inside } string"}');
assert(r6.extractedText === '{"text": "brace { inside } string"}', 'extractedText matches');
assert(r6.diagnostics.foundCompleteObject === true, 'foundCompleteObject is true');

// Test 7: Multiple JSON objects (extract only the first)
console.log('\n--- Test 7: Multiple JSON objects ---');
const r7 = extract('{"a": 1} {"b": 2}');
assert(r7.extractedText === '{"a": 1}', 'extractedText matches first object');
assert(r7.diagnostics.foundCompleteObject === true, 'foundCompleteObject is true');
assert(r7.diagnostics.trailingTextLength === 9, 'trailingTextLength is 9');

// Test 8: No JSON present
console.log('\n--- Test 8: No JSON present ---');
const r8 = extract('no json here');
assert(r8.extractedText === null, 'extractedText is null');
assert(r8.diagnostics.foundObjectStart === -1, 'foundObjectStart is -1');
assert(r8.diagnostics.foundCompleteObject === false, 'foundCompleteObject is false');
assert(r8.diagnostics.startIndex === -1, 'startIndex is -1');
assert(r8.diagnostics.endIndex === -1, 'endIndex is -1');
assert(r8.diagnostics.extractedCharacterCount === 0, 'extractedCharacterCount is 0');
assert(r8.diagnostics.trailingTextLength === 12, 'trailingTextLength is 12');

// Test 9: Input not mutated
console.log('\n--- Test 9: Input not mutated ---');
const input = '{"a": 1} trailing';
const original = input;
extract(input);
assert(input === original, 'input was not mutated');

// Test 10: Determinism
console.log('\n--- Test 10: Determinism ---');
const r10a = extract('{"x": {"y": "z"}} extra');
const r10b = extract('{"x": {"y": "z"}} extra');
assert(JSON.stringify(r10a) === JSON.stringify(r10b), 'results are deterministic');

// Test 11: Empty string
console.log('\n--- Test 11: Empty string ---');
const r11 = extract('');
assert(r11.extractedText === null, 'extractedText is null');
assert(r11.diagnostics.foundObjectStart === -1, 'foundObjectStart is -1');

// Test 12: Escaped quotes inside strings
console.log('\n--- Test 12: Escaped quotes inside strings ---');
const r12 = extract('{"text": "he said \\"hello\\""}');
assert(r12.extractedText === '{"text": "he said \\"hello\\""}', 'extractedText matches');
assert(r12.diagnostics.foundCompleteObject === true, 'foundCompleteObject is true');

// Test 13: TypeError on non-string
console.log('\n--- Test 13: TypeError on non-string ---');
try {
  extract(null);
  assert(false, 'should have thrown TypeError');
} catch (e) {
  assert(e instanceof TypeError, 'throws TypeError');
}

// Summary
console.log('\n=============================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('=============================\n');

process.exit(failed > 0 ? 1 : 0);
