import { assertReceiptAIProvider } from "./ReceiptAIProvider.js";
import { NullProvider } from "./providers/NullProvider.js";

const SERVICE_STATUSES = new Set(["skipped", "noop", "error"]);
const SERVICE_REASONS = new Set([
  "feature_disabled",
  "high_confidence",
  "no_confidence",
  "low_confidence_path",
  "provider_noop",
  "provider_error",
  "invalid_trace",
]);
const LOCAL_AI_SOURCE = "local-ai";

function normalizeServiceStatus(status, fallback = "noop") {
  const normalized = String(status || "").trim();
  return SERVICE_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeServiceReason(reason, fallback = "provider_noop") {
  const normalized = String(reason || "").trim();
  return SERVICE_REASONS.has(normalized) ? normalized : fallback;
}

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
    this.localAIProvider = options.localAIProvider || null;
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

    let reason = "low_confidence_path";
    if (!featureEnabled) {
      reason = "feature_disabled";
    } else if (!hasConfidence) {
      reason = "no_confidence";
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

  logEvent(eventName, payload = {}) {
    const logger = this.logger;
    if (!logger) {
      return;
    }

    if (typeof logger.info === "function") {
      logger.info(eventName, payload);
      return;
    }

    if (typeof logger.log === "function") {
      logger.log(eventName, payload);
    }
  }

  async analyze(trace, options = {}) {
    const startedAt = Date.now();

    if (!trace || typeof trace !== "object") {
      const advisory = createLocalAIAdvisory({
        available: hasLocalAIProvider(getLocalAIProvider(this, options)),
      });

      this.logEvent("receipt_intelligence.result", {
        status: "error",
        reason: "invalid_trace",
        providerName: this.provider.name,
      });
      return {
        status: "error",
        reason: "invalid_trace",
        eligible: false,
        suggestions: [],
        advisory,
        metadata: {
          providerName: this.provider.name,
          elapsedMs: Date.now() - startedAt,
          localAIAdvisory: advisory,
        },
      };
    }

    const eligibility = this.evaluateEligibility(trace, options);
    const forceLocalAIReview = Boolean(options && options.forceLocalAIReview);
    this.logEvent("receipt_intelligence.gate_evaluated", {
      traceId: String(trace.traceId || ""),
      featureEnabled: eligibility.featureEnabled,
      confidence: eligibility.confidence,
      threshold: eligibility.lowConfidenceThreshold,
      eligible: eligibility.eligible,
      reason: eligibility.reason,
    });

    if (!eligibility.eligible) {
      const advisory = forceLocalAIReview
        ? await runLocalAIAdvisory({
            trace,
            options,
            service: this,
          })
        : createLocalAIAdvisory({
            available: hasLocalAIProvider(getLocalAIProvider(this, options)),
          });

      this.logEvent("receipt_intelligence.result", {
        traceId: String(trace.traceId || ""),
        status: "skipped",
        reason: eligibility.reason,
        providerName: this.provider.name,
      });
      return {
        status: "skipped",
        reason: eligibility.reason,
        eligible: false,
        suggestions: [],
        advisory,
        metadata: {
          providerName: this.provider.name,
          elapsedMs: Date.now() - startedAt,
          gate: eligibility,
          localAIAdvisory: advisory,
        },
      };
    }

    try {
      this.logEvent("receipt_intelligence.provider_invoked", {
        traceId: String(trace.traceId || ""),
        providerName: this.provider.name,
      });

      const providerResult = await this.provider.analyze(trace, {
        gate: eligibility,
      });

      const status = normalizeServiceStatus(providerResult && providerResult.status, "noop");
      const reason = normalizeServiceReason(
        providerResult && providerResult.reason,
        status === "error" ? "provider_error" : "provider_noop"
      );
      const suggestions = Array.isArray(providerResult && providerResult.suggestions)
        ? providerResult.suggestions
        : [];
      const advisory = await runLocalAIAdvisory({
        trace,
        options,
        service: this,
      });

      this.logEvent("receipt_intelligence.result", {
        traceId: String(trace.traceId || ""),
        status,
        reason,
        providerName: this.provider.name,
      });

      return {
        status,
        reason,
        eligible: true,
        suggestions,
        advisory,
        metadata: {
          providerName: this.provider.name,
          elapsedMs: Date.now() - startedAt,
          gate: eligibility,
          providerMetadata: providerResult && providerResult.metadata ? providerResult.metadata : {},
          localAIAdvisory: advisory,
        },
      };
    } catch (error) {
      if (this.logger && typeof this.logger.warn === "function") {
        this.logger.warn("[ReceiptIntelligenceService] Provider analyze failed:", error);
      }

      this.logEvent("receipt_intelligence.result", {
        traceId: String(trace.traceId || ""),
        status: "error",
        reason: "provider_error",
        providerName: this.provider.name,
      });

      const advisory = createLocalAIAdvisory({
        available: hasLocalAIProvider(getLocalAIProvider(this, options)),
      });

      return {
        status: "error",
        reason: "provider_error",
        eligible: true,
        suggestions: [],
        advisory,
        metadata: {
          providerName: this.provider.name,
          elapsedMs: Date.now() - startedAt,
          gate: eligibility,
          errorMessage: error && error.message ? error.message : String(error),
          localAIAdvisory: advisory,
        },
      };
    }
  }
}

function getLocalAIProvider(service, options = {}) {
  if (options && Object.prototype.hasOwnProperty.call(options, "localAIProvider")) {
    return options.localAIProvider;
  }

  return service.localAIProvider;
}

function hasLocalAIProvider(provider) {
  return !!provider && typeof provider.analyzeReceipt === "function";
}

async function runLocalAIAdvisory({ trace, options, service }) {
  const localAIProvider = getLocalAIProvider(service, options);
  const available = hasLocalAIProvider(localAIProvider);

  if (!available) {
    return createLocalAIAdvisory({ available: false });
  }

  const imageInput = resolveLocalAIImageInput(trace, options);
  if (!imageInput) {
    return createLocalAIAdvisory({ available: true });
  }

  const providerInput = {
    ...imageInput,
    ...readLocalAIGenerationOptions(options),
  };

  try {
    const providerResult = await localAIProvider.analyzeReceipt(providerInput);
    return normalizeLocalAIProviderResult(providerResult);
  } catch (error) {
    return createLocalAIAdvisory({
      available: true,
      attempted: true,
      error: error && error.message ? error.message : String(error),
    });
  }
}

function normalizeLocalAIProviderResult(providerResult) {
  if (!isRecord(providerResult)) {
    return createMalformedLocalAIAdvisory("Local AI provider returned a non-object result.");
  }

  const receipt = providerResult.receipt === undefined || providerResult.receipt === null
    ? null
    : providerResult.receipt;
  const text = providerResult.text === undefined || providerResult.text === null
    ? null
    : providerResult.text;
  const pipeline = providerResult.pipeline === undefined || providerResult.pipeline === null
    ? null
    : providerResult.pipeline;
  const metadata = providerResult.metadata === undefined || providerResult.metadata === null
    ? null
    : providerResult.metadata;

  if (receipt !== null && !isRecord(receipt)) {
    return createMalformedLocalAIAdvisory("Local AI provider returned malformed receipt data.");
  }

  if (text !== null && typeof text !== "string") {
    return createMalformedLocalAIAdvisory("Local AI provider returned malformed text data.");
  }

  if (pipeline !== null && !isRecord(pipeline)) {
    return createMalformedLocalAIAdvisory("Local AI provider returned malformed pipeline data.");
  }

  if (metadata !== null && !isRecord(metadata)) {
    return createMalformedLocalAIAdvisory("Local AI provider returned malformed metadata.");
  }

  return createLocalAIAdvisory({
    available: true,
    attempted: true,
    succeeded: true,
    receipt,
    text,
    pipeline,
    metadata,
  });
}

function createMalformedLocalAIAdvisory(error) {
  return createLocalAIAdvisory({
    available: true,
    attempted: true,
    error,
  });
}

function resolveLocalAIImageInput(trace, options = {}) {
  return readImageInput(options) || readImageInput(trace);
}

function readImageInput(source) {
  if (!source || typeof source !== "object") {
    return null;
  }

  for (const field of ["image", "imageBuffer", "imagePath"]) {
    if (Object.prototype.hasOwnProperty.call(source, field) && hasUsableImageValue(source[field])) {
      return {
        [field]: source[field],
      };
    }
  }

  return null;
}

function hasUsableImageValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function readLocalAIGenerationOptions(options = {}) {
  const generationOptions = {};

  for (const field of ["maxNewTokens", "stopTokenIds", "imageLayouts"]) {
    if (options && Object.prototype.hasOwnProperty.call(options, field)) {
      generationOptions[field] = options[field];
    }
  }

  return generationOptions;
}

function createLocalAIAdvisory({
  available = false,
  attempted = false,
  succeeded = false,
  receipt = null,
  text = null,
  pipeline = null,
  metadata = null,
  error = null,
} = {}) {
  return {
    available: Boolean(available),
    attempted: Boolean(attempted),
    succeeded: Boolean(succeeded),
    source: LOCAL_AI_SOURCE,
    receipt,
    text,
    pipeline,
    metadata,
    error,
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
