# Local AI Provider Design

## Goals

* Run entirely on the user's machine.
* No cloud APIs.
* No recurring cost.
* Optional feature.
* Disabled by default.
* Fail-open behavior.

## Non-Goals

* Replace OCR.
* Replace matcher scoring.
* Replace history lookup.
* Replace user mappings.
* Modify receipt records automatically.

## Integration Point

ReceiptIntelligenceService invokes a provider after OCR, anchor processing, and history processing complete.

Input:

* OCR text
* Decision trace
* Match confidence
* Detected address
* Current location/license values

Output:

* Suggested dispensary name
* Suggested license
* Confidence score
* Reasoning metadata

## Candidate Technologies

### Option A: Transformers.js

Pros:

* Runs in browser.
* No server required.
* Easy deployment.

Cons:

* Large model downloads.
* Memory usage.

### Option B: ONNX Runtime

Pros:

* Fast local inference.
* Good Electron compatibility.

Cons:

* More setup complexity.

### Option C: Rule-Based + AI Hybrid

Pros:

* Smallest footprint.
* Uses existing matcher strengths.

Cons:

* Less flexible.

## Initial Recommendation

Phase 1:

* Keep matcher as primary system.
* AI only runs on low-confidence scans.
* AI provides suggestions only.
* No automatic field modification.

## Safety Requirements

* Never overwrite high-confidence matches.
* Never bypass existing OCR flow.
* Never bypass history or user mappings.
* Continue normal behavior if AI fails.

## Success Criteria

* Improve dispensary identification on low-quality receipts.
* Reduce manual corrections.
* Maintain current behavior when disabled.
