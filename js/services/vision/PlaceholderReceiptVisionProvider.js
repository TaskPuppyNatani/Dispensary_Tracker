import { ReceiptVisionProvider } from "./ReceiptVisionProvider.js";

/**
 * Phase 1 placeholder provider.
 * It performs no inference, does not inspect images, and returns no suggestions.
 */
export class PlaceholderReceiptVisionProvider extends ReceiptVisionProvider {
  constructor() {
    super("PlaceholderReceiptVisionProvider");
  }

  async analyzeReceipt(input) {
    void input;

    return {
      status: "noop",
      suggestions: [],
      metadata: {
        providerName: this.name,
        reason: "placeholder_provider",
      },
    };
  }
}
