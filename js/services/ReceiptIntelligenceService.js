import { assertReceiptAIProvider } from "./ReceiptAIProvider.js";
import { NullProvider } from "./providers/NullProvider.js";

/**
 * Phase 1 service scaffold.
 *
 * Responsibilities:
 * - Accept a trace object.
 * - Evaluate eligibility using feature flag and confidence gate.
 * - Invoke provider when eligible.
 * - Return structured result objects.
 */
export class ReceiptIntelligenceService {
  constructor(options = {}) {
    const provider = options.provider || new NullProvider();
    assertReceiptAIProvider(provider);

    this.provider = provider;
    this.featureEnabled = Boolean(options.featureEnabled);
    this.lowConfidenceThreshold = Number.isFinite(options.lowConfidenceThreshold)
      ? Number(options.lowConfidenceThreshold)
      : 0.5;
    this.logger = options.logger && typeof options.logger.log === "function"
      ? options.logger
      : console;
  }

  evaluateEligibility(trace, options = {}) {
    const traceObj = trace && typeof trace === "object" ? trace : {};
    const gate = traceObj.gate && typeof traceObj.gate === "object" ? traceObj.gate : {};

    const featureEnabled = options.featureEnabled !== undefined
      ? Boolean(options.featureEnabled)
      : gate.featureEnabled !== undefined
        ? Boolean(gate.featureEnabled)
        : this.featureEnabled;

    const threshold = Number.isFinite(options.lowConfidenceThreshold)
      ? Number(options.lowConfidenceThreshold)
      : this.lowConfidenceThreshold;

    const rawConfidence = options.confidence !== undefined
      ? options.confidence
      : traceObj.ocrConfidence;
    const confidence = Number.parseFloat(rawConfidence);
    const hasConfidence = Number.isFinite(confidence);
    const isLowConfidence = !hasConfidence || confidence < threshold;

    let reason = "eligible";
    if (!featureEnabled) {
      reason = "feature_disabled";
    } else if (!isLowConfidence) {
      reason = "high_confidence";
    }

    return {
      eligible: featureEnabled && isLowConfidence,
      reason,
      featureEnabled,
      confidence: hasConfidence ? confidence : null,
      lowConfidenceThreshold: threshold,
      isLowConfidence,
    };
  }

  async analyze(trace, options = {}) {
    const startedAt = Date.now();

    if (!trace || typeof trace !== "object") {
      return {
        status: "error",
        reason: "invalid_trace",
        eligible: false,
        suggestions: [],
        metadata: {
          providerName: this.provider.name,
          elapsedMs: Date.now() - startedAt,
        },
      };
    }

    const eligibility = this.evaluateEligibility(trace, options);
    if (!eligibility.eligible) {
      return {
        status: "skipped",
        reason: eligibility.reason,
        eligible: false,
        suggestions: [],
        metadata: {
          providerName: this.provider.name,
          elapsedMs: Date.now() - startedAt,
          gate: eligibility,
        },
      };
    }

    try {
      const providerResult = await this.provider.analyze(trace, {
        gate: eligibility,
      });

      const suggestions = Array.isArray(providerResult && providerResult.suggestions)
        ? providerResult.suggestions
        : [];

      return {
        status: providerResult && providerResult.status ? providerResult.status : "noop",
        reason: providerResult && providerResult.reason ? providerResult.reason : "provider_noop",
        eligible: true,
        suggestions,
        metadata: {
          providerName: this.provider.name,
          elapsedMs: Date.now() - startedAt,
          gate: eligibility,
          providerMetadata: providerResult && providerResult.metadata ? providerResult.metadata : {},
        },
      };
    } catch (error) {
      if (this.logger && typeof this.logger.warn === "function") {
        this.logger.warn("[ReceiptIntelligenceService] Provider analyze failed:", error);
      }

      return {
        status: "error",
        reason: "provider_error",
        eligible: true,
        suggestions: [],
        metadata: {
          providerName: this.provider.name,
          elapsedMs: Date.now() - startedAt,
          gate: eligibility,
          errorMessage: error && error.message ? error.message : String(error),
        },
      };
    }
  }
}
