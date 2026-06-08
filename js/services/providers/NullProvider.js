import { ReceiptAIProvider } from "../ReceiptAIProvider.js";

/**
 * Default no-op provider for Phase 1.
 * Performs no network calls and returns no suggestions.
 */
export class NullProvider extends ReceiptAIProvider {
  constructor() {
    super("NullProvider");
  }

  async analyze(trace, context = {}) {
    void trace;
    void context;

    return {
      status: "noop",
      reason: "null_provider",
      suggestions: [],
      metadata: {
        providerName: this.name,
      },
    };
  }
}
