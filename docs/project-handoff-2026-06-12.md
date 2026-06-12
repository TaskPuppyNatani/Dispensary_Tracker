# Dispensary Tracker Project Handoff (2026-06-12)

## Current Branch

* ai-experiment

## Recent Git History

* Prevent store anchors from overwriting resolved dispensary matches
* Harden Oregon address candidate validation
* Add receipt intelligence service scaffolding
* Add receipt decision trace diagnostics
* Add receipt decision trace capture

## Current Architecture

Receipt Flow:

OCR
→ Matcher
→ Store Anchors
→ History/User Mappings
→ Final Render

Future Flow:

OCR
→ Matcher
→ Store Anchors
→ History/User Mappings
→ ReceiptIntelligenceService
→ Advisory Provider(s)

## Receipt Intelligence Status

Implemented:

* ReceiptIntelligenceService
* Provider interface
* NullProvider
* Feature flag (default disabled)
* Decision trace capture
* Trace diagnostics
* Runtime integration

Not Implemented:

* LocalHybridAdvisoryProvider
* ONNX provider
* Transformers.js provider
* Any AI model integration

## Important Findings

### Green Front Investigation

Original issue:

* Some Green Front receipts became La Mota.

Root cause:

* Store-anchor logic could overwrite already-resolved dispensary matches.

Fix:

* Anchors now only run when ocrInitial.location is blank.

### Current Green Front Behavior

Observed trace:

lookupSource = user_mappings

ocrInitial:

* location = "Green Front"
* license = ""

postHistory:

* location = "GREENFRONT"
* license = "050-10167774072"

Conclusion:

* User mappings are significantly improving recognition consistency.
* Saving one correctly identified Green Front receipt appears to improve future Green Front recognition.

### La Mota Verification

Verified:

* Real La Mota receipts still resolve correctly.
* Anchor guard did not break legitimate La Mota recognition.

## Matcher Diagnostics Added

Current diagnostics log:

* Candidate generation (pre-filter)
* Candidate filtering results
* Passed candidates
* Rejected candidates
* Matcher diagnostics
* Trace snapshots

## Next Recommended Work

1. Document user-mapping findings in local-ai-provider-design.md
2. Verify matcher diagnostics on additional failed receipts
3. Design LocalHybridAdvisoryProvider
4. Keep feature flag disabled
5. No model integration yet

## Constraints

Do not:

* Modify OCR behavior
* Modify DB schema
* Introduce AI providers yet
* Change matcher thresholds without evidence

Current goal:

* Implement first advisory-only LocalHybridAdvisoryProvider behind existing feature flag.
