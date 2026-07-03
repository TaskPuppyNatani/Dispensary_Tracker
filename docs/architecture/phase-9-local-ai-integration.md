# Phase 9 Local AI Integration Design

## Summary

This document defines how the completed Local AI receipt pipeline should integrate
with Dispensary Tracker. It is documentation only and does not change runtime,
provider, pipeline, database, UI, OCR, matcher, or receipt workflow behavior.

The integration goal is to let Local AI provide advisory receipt suggestions while
the existing deterministic OCR, matcher, history, user mapping, review, and save
flows continue to work as they do today.

## Design Principles

- AI is advisory, not authoritative.
- Existing deterministic receipt processing remains the primary path.
- AI failures must fail open and must not block receipt scanning or saving.
- AI output may suggest or enrich data, but must not silently mutate saved records.
- User review is required before AI-derived data changes any persisted receipt.
- AI output should be stored or surfaced with provenance: `source = "local-ai"`,
  `modelId`, generation metadata, pipeline validation status, and raw generated
  text when available.

## Ownership Boundaries

### ReceiptIntelligenceService

`ReceiptIntelligenceService` owns the optional advisory integration boundary. It
should decide whether Local AI is eligible for a receipt, invoke a configured
provider when eligible, shape advisory results for the app, and log structured
diagnostics.

It should own:

- feature flag and eligibility checks;
- low-confidence gating policy;
- provider invocation;
- fail-open error handling;
- advisory result shape;
- service-level logging and timing metadata.

It should not own:

- OCR execution;
- dispensary matching;
- history or user mapping decisions;
- Local AI runtime initialization details;
- JSON extraction, repair, validation, or mapping;
- form mutation;
- database writes.

### ReceiptVisionProvider

`ReceiptVisionProvider` owns Local AI model execution and provider-specific
metadata. The main-process provider initializes the local runtime, image
processor, tokenizer, and model sessions, then calls `runtime.generate()` for a
receipt image.

After generation, it forwards the raw generated text into
`ReceiptProcessingPipeline` and returns the pipeline result with provider-owned
metadata.

It should own:

- Local AI runtime/model initialization;
- prompt construction;
- generation controls;
- generation diagnostics;
- model/provider metadata;
- forwarding generated text to the processing pipeline.

It should not own:

- receipt workflow control;
- OCR comparison logic;
- database persistence;
- UI review behavior;
- extraction, repair, validation, or mapping internals.

### ReceiptProcessingPipeline

`ReceiptProcessingPipeline` owns post-generation receipt text processing only. It
orchestrates:

1. JSON extraction;
2. structural repair;
3. schema validation;
4. object mapping.

It should always pass each stage result to the next stage and preserve stage
diagnostics. It should not perform inference, compare against OCR, choose final
receipt values, write to the database, or know about provider/runtime details.

### OCR, Matcher, History, And User Mapping Flow

The existing OCR and matcher flow remains deterministic and primary. OCR extracts
baseline receipt text and fields. The matcher resolves dispensary candidates and
confidence. History and user mappings continue to restore known dispensary
details where applicable.

Local AI should be layered after this deterministic flow, not before it and not
in place of it.

### Database Persistence

Database writes remain tied to explicit user save actions. AI output must not
write records, update learned mappings, create product rows, or alter duplicate
state without a later reviewed save path.

### UI Review Flow

The UI should show deterministic fields as the current values and AI output as
reviewable suggestions or enrichment. The user must be able to accept, edit, or
ignore AI-derived values before save.

## Intended Integration Sequence

1. User scans a receipt through the existing OCR flow.
2. OCR, matcher, store-anchor logic, history lookup, and user mappings run in the
   current order.
3. The app captures a decision trace from deterministic processing.
4. `ReceiptIntelligenceService` evaluates whether Local AI is eligible.
5. If eligible, `ReceiptIntelligenceService` calls `ReceiptVisionProvider`.
6. `ReceiptVisionProvider` runs Local AI generation and processing.
7. `ReceiptIntelligenceService` returns advisory suggestions and metadata.
8. The UI presents suggestions next to deterministic values for user review.
9. The user accepts, edits, or ignores suggestions.
10. Only reviewed values are written during the normal save flow.

## Architecture Questions

### What does ReceiptIntelligenceService own?

It owns advisory orchestration: feature gating, eligibility, provider invocation,
result shaping, logging, timeout/error policy, and fail-open behavior. It is the
boundary between the deterministic receipt workflow and optional AI providers.

### When is ReceiptVisionProvider called?

It should be called only after OCR, matcher, store-anchor logic, history lookup,
and user mappings have completed and a decision trace is available. The provider
should run only when `ReceiptIntelligenceService` determines that AI is enabled
and eligible, such as for low-confidence or incomplete deterministic results.

### How are OCR results and AI results compared?

Comparison belongs above the provider, most naturally in
`ReceiptIntelligenceService` or a later suggestion-merging layer. OCR and matcher
results should remain the baseline. AI output should be compared field by field
as suggestions:

- matching values can increase review confidence;
- conflicting values should be surfaced for user review;
- missing deterministic values may be filled from AI suggestions only after user
  acceptance;
- invalid or low-confidence AI pipeline output should remain diagnostic only.

The provider and pipeline should not decide final field precedence.

### Where does duplicate detection happen?

Duplicate detection remains part of the existing receipt persistence/import/save
logic. Local AI may provide advisory fields that could help a future duplicate
review experience, but it should not decide duplicates or suppress saves by
itself.

### Where does dispensary matching happen?

Dispensary matching remains in the existing matcher and history/user mapping
flow. AI may suggest `dispensary` or `license_number`, but those values should
be treated as reviewable suggestions. AI must not replace matcher confidence,
learned mappings, or training behavior silently.

### Where are products stored or attached?

In this phase, products extracted by AI are advisory enrichment attached to the
AI result or review model. They should not be persisted automatically. A later
product persistence design should define whether products become part of the
receipt record, a related object store, or review-only metadata.

### What gets written to the database, and when?

Only user-reviewed receipt values are written, and only through the existing save
flow. AI provenance may be stored later if a persistence phase explicitly adds
that behavior. Until then, AI output should be surfaced for review and kept in
diagnostics, not silently saved.

If AI-derived data is persisted in a future phase, it should include provenance:

- `source = "local-ai"`;
- provider name;
- `modelId`;
- generation settings and stop diagnostics;
- pipeline validation status;
- raw generated text when available;
- timestamp of analysis.

### What does the UI show before save?

The UI should show current deterministic values as editable receipt fields. AI
suggestions should be displayed separately or as non-destructive hints with clear
provenance and validation state.

Before save, the user should be able to see:

- current OCR/matcher-derived fields;
- AI-suggested fields that differ from current values;
- AI-extracted product suggestions;
- pipeline validation status;
- raw AI text or diagnostics in a development/debug view;
- controls to accept, edit, or ignore AI suggestions.

## Non-Goals For This Phase

- No provider/service wiring changes.
- No UI changes.
- No database schema changes.
- No OCR or matcher changes.
- No receipt workflow changes.
- No automatic field mutation.
- No product persistence design.

## Future Integration Notes

The safest future implementation path is incremental:

1. adapt `ReceiptIntelligenceService` to call the main-process provider behind a
   feature flag;
2. return AI output as suggestions without changing rendered form values;
3. add a review surface that clearly separates deterministic values from AI
   suggestions;
4. persist only values the user accepts through the existing save path;
5. consider provenance storage only after the review and persistence contracts
   are explicit.
