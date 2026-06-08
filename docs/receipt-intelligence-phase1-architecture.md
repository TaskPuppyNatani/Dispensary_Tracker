# Receipt Intelligence Phase 1 Architecture

## Scope and Constraints

This document defines Phase 1 infrastructure only.

Hard constraints:
- No runtime behavior changes to existing receipt scanning flow.
- No modifications to existing OCR logic.
- No modifications to existing matcher logic.
- No modifications to existing history matching logic.
- No modifications to existing user mapping or training behavior.
- No database schema or migration changes.
- No model integration.
- No embeddings.
- No AI decision making in Phase 1.

Phase 1 objective:
- Introduce a safe, optional integration surface for future AI experimentation while preserving identical behavior when disabled.

## Current Receipt Processing Architecture

Current high-level flow:
1. User selects receipt image and triggers Scan Receipt.
2. OCR pipeline processes image text and extracts baseline fields.
3. Existing dispensary matcher provides baseline dispensary candidate and confidence.
4. Store anchor override logic may adjust dispensary fields (for known edge cases).
5. History matching attempts restoration by address and then by name fallback.
6. Final values are rendered into the form for user review and save.

Current ownership by concern:
- Scan orchestration and post-processing sequencing: app layer.
- OCR execution and baseline extraction: OCR module.
- Dispensary matching and confidence scoring: matcher module.
- Historical lookup and user mapping/training data access: DB module.

## Four-Stage Decision Trace

Phase 1 introduces a trace model that captures how final fields were reached, without changing any existing decisions.

The trace must capture these stage snapshots in order:

1. OCR initial state
- Snapshot immediately after existing OCR and baseline matcher complete.
- Includes:
  - Baseline rendered form fields (location, license, date, time, amount).
  - OCR confidence value.
  - Physical address and lookup-source context already available in app state.
  - Raw OCR text availability marker.

2. Post-anchor state
- Snapshot after existing anchor override logic runs.
- Includes:
  - Rendered form fields after anchor pass.
  - Whether anchor phase changed location or license compared with OCR initial state.

3. Post-history state
- Snapshot after existing history passes complete (address-based plus name fallback).
- Includes:
  - Rendered form fields after history pass.
  - Whether history phase changed location or license compared with post-anchor state.

4. Final rendered state
- Snapshot at end of current scan handler after all existing logic and status updates.
- Includes:
  - Final user-visible form values.
  - Final confidence value currently shown.
  - Final status message category if available.

Trace design rules:
- Read-only collection only.
- No control-flow branching based on trace in Phase 1.
- No field mutation by trace collector.

## ReceiptIntelligenceService

Purpose:
- Provide a single abstraction boundary for optional AI-related processing.

Phase 1 responsibilities:
- Accept a complete decision-trace object.
- Evaluate eligibility based on feature flag and confidence gate.
- Invoke a configured provider abstraction.
- Return a structured, non-mutating result.
- Emit structured logs.

Phase 1 non-responsibilities:
- No field writes to form.
- No replacement of matcher decisions.
- No replacement of history decisions.
- No replacement of OCR or training behavior.

Proposed input contract (Phase 1):
- traceId
- timestamp
- stage snapshots (ocrInitial, postAnchor, postHistory, finalRendered)
- gate context (featureEnabled, confidenceValue)
- scan mode context (manual mode vs scan mode)

Proposed output contract (Phase 1):
- status: skipped | noop | error
- reason: feature_disabled | high_confidence | no_confidence | low_confidence_path | provider_noop | provider_error
- provider metadata:
  - providerName
  - elapsedMs
- suggestions: always empty in Phase 1

## ReceiptAIProvider Interface

Purpose:
- Define a provider-neutral contract for future AI backends.

Phase 1 behavior:
- Interface exists only as an abstraction boundary.
- Must support deterministic no-op execution path.

Proposed interface shape:
- name: string
- analyze(trace): Promise<ProviderResult>

ProviderResult (Phase 1):
- status: noop | error
- metadata: object
- suggestions: []

Contract guarantees:
- Provider must never mutate app state directly.
- Provider output must be treated as advisory only.

## NullProvider

Purpose:
- Safe default provider used in Phase 1.

Behavior:
- Always returns a no-op result with empty suggestions.
- Performs no external calls.
- Introduces no behavior changes.

Rationale:
- Enables integration plumbing, tracing, and logging without any AI decision making.

## Feature Flag Behavior

Feature flag requirements:
- Default disabled.
- Optional opt-in only.

When disabled:
- ReceiptIntelligenceService call path is skipped or returns early as skipped.
- Existing scan pipeline behavior remains identical.
- Trace logging may still run in debug mode if desired, but must not alter state.

When enabled (Phase 1):
- Service can run eligibility checks and invoke NullProvider.
- No field changes occur because provider is no-op.

## Low-Confidence Gating

Gate requirement:
- AI path should run only when existing matching confidence is low.

Phase 1 gate policy:
- Eligible only when:
  - feature flag is enabled, and
  - confidence is missing or below configured low-confidence threshold.

Non-eligible conditions:
- Feature disabled.
- Confidence present and at or above threshold.

Phase 1 threshold guidance:
- Initial gate threshold: 0.50.
- Threshold remains configuration-level policy and does not change matcher behavior.

## Safety Guarantees

Phase 1 safety guarantees:
1. Existing OCR behavior unchanged.
2. Existing matcher behavior unchanged.
3. Existing history behavior unchanged.
4. Existing user mapping and training behavior unchanged.
5. No database schema changes.
6. No replacement of existing decision order.
7. No field mutation by AI layer in Phase 1.
8. Feature disabled path preserves current behavior.

Operational guarantees:
- Fail-open: provider errors must not block scan completion.
- Timeout-safe: service failures degrade to no-op.
- Logging-safe: logs must not include sensitive expansion beyond current app diagnostics.

## Structured Logging Plan

Phase 1 logging events:
- receipt_intelligence.trace_captured
- receipt_intelligence.gate_evaluated
- receipt_intelligence.provider_invoked
- receipt_intelligence.result

Recommended event fields:
- traceId
- stage
- featureEnabled
- confidence
- gateDecision
- providerName
- status
- reason
- elapsedMs

Logging constraints:
- Logging must be observational only.
- No logging side effects on app behavior.

## Rollout Plan

Commit 1 (this document)
- Add architecture document only.
- No runtime code changes.

Commit 2
- Add abstraction files:
  - ReceiptAIProvider interface
  - NullProvider
  - ReceiptIntelligenceService scaffold
- No runtime behavior changes.

Commit 3
- Integrate trace capture and service invocation in scan orchestration with feature flag default disabled.
- Keep provider as NullProvider.
- Preserve all existing decision logic unchanged.

Commit 4
- Add tests and validation for:
  - disabled flag parity
  - low-confidence gating behavior
  - fail-open provider handling
  - no field mutation guarantee in Phase 1

Exit criteria for Phase 1:
- Service layer exists.
- Decision trace captured through all four stages.
- Feature-flagged, low-confidence-gated, no-op execution path available.
- Current app behavior unchanged when flag is disabled.
