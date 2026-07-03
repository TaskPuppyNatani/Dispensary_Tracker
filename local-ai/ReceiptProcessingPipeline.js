// CommonJS utility to orchestrate receipt JSON processing stages.
// Exports: process(analysis)

"use strict";

const ReceiptJsonExtractor = require("./ReceiptJsonExtractor");
const ReceiptJsonRepair = require("./ReceiptJsonRepair");
const ReceiptJsonValidator = require("./ReceiptJsonValidator");
const ReceiptObjectMapper = require("./ReceiptObjectMapper");

function process(analysis) {
  const text = analysis && typeof analysis === "object"
    ? analysis.text
    : undefined;
  const metadata = analysis && typeof analysis === "object"
    ? analysis.metadata
    : undefined;

  const extraction = ReceiptJsonExtractor.extract(text);
  const repair = ReceiptJsonRepair.repair(extraction);
  const validation = ReceiptJsonValidator.validate(repair);
  const mapping = ReceiptObjectMapper.map(validation);

  return {
    text,
    receipt: mapping.receipt,
    pipeline: {
      extraction,
      repair,
      validation,
      mapping
    },
    metadata
  };
}

module.exports = {
  process
};
