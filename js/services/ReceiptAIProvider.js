/**
 * Provider contract for receipt intelligence analysis.
 *
 * Providers must be side-effect free from the app perspective:
 * - Do not mutate application state.
 * - Do not write form values.
 * - Return advisory data only.
 */
export class ReceiptAIProvider {
  constructor(name = "ReceiptAIProvider") {
    this.name = String(name || "ReceiptAIProvider");
  }

  /**
   * Analyze a decision trace and return advisory output.
   *
   * @param {object} trace - Full decision trace payload.
   * @param {object} context - Additional invocation context.
   * @returns {Promise<{status:string, reason:string, suggestions:Array, metadata:object}>}
   */
  async analyze(trace, context = {}) {
    void trace;
    void context;
    throw new Error("ReceiptAIProvider.analyze must be implemented by subclasses.");
  }
}

/**
 * Runtime guard that ensures a provider implements the expected contract.
 *
 * @param {any} provider
 */
export function assertReceiptAIProvider(provider) {
  if (!provider || typeof provider.analyze !== "function") {
    throw new Error("Invalid ReceiptAIProvider: missing analyze(trace, context) method.");
  }
}
