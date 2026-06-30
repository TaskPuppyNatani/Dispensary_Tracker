# Local AI Platform Phase 1 Architecture

## Scope

Phase 1 adds architecture-only scaffolding for future local AI features. It does
not change OCR, matcher behavior, receipt processing, settings UI, IPC, model
loading, ONNX Runtime integration, downloads, or inference execution.

## Folder Structure

- `local-ai/config.js`
  - Static default Local AI settings.
  - AI is disabled by default.
  - The default model directory is `models`.
- `local-ai/ModelManager.js`
  - Main-process-safe, read-only model discovery and validation.
  - Treats every child directory under the configured model root as a generic
    candidate model.
- `local-ai/modelTypes.js`
  - JSDoc typedefs for model metadata, validation, artifact summaries, and
    installation status results.
- `local-ai/VisionRuntime.js`
  - Minimal contract for future inference runtime integrations.
  - Does not import ONNX Runtime or execute models.
- `local-ai/OnnxVisionRuntime.js`
  - Inert concrete runtime foundation for a future ONNX implementation.
  - Tracks only `initialized` and `status`; it does not load models or run inference.
- `js/services/vision/ReceiptVisionProvider.js`
  - Receipt-domain provider contract for future vision analysis.
- `js/services/vision/PlaceholderReceiptVisionProvider.js`
  - No-op placeholder provider that returns no suggestions.

## ModelManager Design

`ModelManager` is runtime-agnostic. It validates generic directory structure and
metadata only. It does not know about specific model families and does not
require model-specific files.

Validation checks:

- the model path exists,
- the model path is a readable directory,
- the directory is not empty,
- optional declarative metadata can be read when present.

If declarative metadata is not present, metadata is inferred from the directory
name and a shallow artifact inventory. The inventory records generic facts such
as file count, directory count, total bytes, and file extensions. It does not
load artifacts or inspect model internals.

## Runtime Boundary

`ReceiptVisionProvider` is the receipt-domain interface. It should turn receipt
inputs into advisory receipt suggestions.

Future inference concerns belong behind `VisionRuntime`. The base
`VisionRuntime` is a contract, not a concrete runtime. It defines lifecycle
methods for initialization, shutdown, status reporting, model support checks,
model loading, and execution, but it does not implement those behaviors.

Concrete runtimes own implementation-specific state such as initialization
flags, model sessions, loaded model references, tensor creation, execution, and
cleanup. A future `OnnxVisionRuntime` can implement this contract without
changing receipt-domain provider APIs.

In Phase 3, `VisionRuntime` only reserves this boundary and throws
`Not Implemented` from lifecycle methods.

Phase 4 adds `OnnxVisionRuntime` as the first concrete runtime implementation.
It satisfies the `VisionRuntime` contract and maintains only a minimal status
model: `initialized` and `status`, with status values of `uninitialized` and
`ready`. It does not import ONNX Runtime, inspect model files, load models,
create sessions, or perform inference.

## Behavior Guarantees

- Existing receipt workflows are unchanged.
- No model is loaded.
- No inference runtime is imported.
- No IPC is added.
- No settings UI is added.
- No provider is connected to OCR, matcher, receipt intelligence, or save flow.
