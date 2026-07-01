# First Successful SmolVLM Decoder Forward Pass

Date:
2026-30-06

Model:
SmolVLM2-500M (int8 ONNX)

Result:
✅ Decoder executed successfully.

Validation:
- Zero-length KV cache accepted.
- Logits shape: [1, 350, 49280]
- Present cache tensors: 64
- Present cache shape: [1, 5, 350, 64]
- Runtime remained model-loaded.
- Contract deviations: none.

Performance:
- Decoder execution: 116 ms
- Memory delta: 245,874,688 bytes

Notes:
This is the first successful end-to-end execution of the local multimodal inference pipeline through the decoder.