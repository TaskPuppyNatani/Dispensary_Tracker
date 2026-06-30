/**
 * Receipt-domain provider contract for future local vision analysis.
 *
 * Providers should translate receipt-specific inputs into advisory suggestions.
 * Runtime concerns such as model sessions and tensor execution belong behind a
 * lower-level VisionRuntime abstraction, not in this provider interface.
 */
export class ReceiptVisionProvider {
  constructor(name = "ReceiptVisionProvider") {
    this.name = String(name || "ReceiptVisionProvider");
  }

  /**
   * @param {object} input
   * @returns {Promise<{status:string, suggestions:Array, metadata:object}>}
   */
  async analyzeReceipt(input) {
    void input;
    throw new Error("ReceiptVisionProvider.analyzeReceipt must be implemented by subclasses.");
  }
}

export function assertReceiptVisionProvider(provider) {
  const hasName = !!provider && typeof provider.name === "string" && provider.name.trim().length > 0;
  const hasAnalyzeReceipt = !!provider && typeof provider.analyzeReceipt === "function";

  if (!hasName || !hasAnalyzeReceipt) {
    throw new Error(
      "Invalid ReceiptVisionProvider: providers must expose a non-empty name and analyzeReceipt(input)."
    );
  }
}
