export function buildLocalAIStatusDisplay(statusPayload = {}) {
  const normalized = statusPayload && typeof statusPayload === "object"
    ? statusPayload
    : {};
  const managedRuntimeStatus = normalized.managedRuntimeStatus && typeof normalized.managedRuntimeStatus === "object"
    ? normalized.managedRuntimeStatus
    : null;
  const health = readHealth(normalized, managedRuntimeStatus);
  const rows = [];

  pushRow(rows, "Provider Mode", formatProviderMode(normalized));
  pushRow(rows, "Status", formatStatus(normalized, managedRuntimeStatus));
  pushRow(rows, "Runtime", formatRuntime(normalized, managedRuntimeStatus));
  pushRow(rows, "Model", readString(normalized.displayName) || readString(normalized.modelId));
  pushRow(rows, "Model ID", readString(normalized.modelId));
  pushRow(
    rows,
    "Endpoint",
    readString(normalized.endpointUrl) || readString(managedRuntimeStatus && managedRuntimeStatus.chatCompletionsUrl)
  );
  pushRow(rows, "Health", health.label);

  const reason = readString(normalized.reason) || readString(managedRuntimeStatus && managedRuntimeStatus.lastError);
  const warnings = Array.isArray(normalized.warnings)
    ? normalized.warnings.map((warning) => readString(warning)).filter(Boolean)
    : [];
  const recentLogs = readRecentLogs(Array.isArray(normalized.runtimeLogs) ? normalized.runtimeLogs : []);

  return {
    rows,
    reason,
    warnings,
    recentLogs,
    showReason: Boolean(reason),
    showWarnings: warnings.length > 0,
    showLogs: recentLogs.length > 0,
  };
}

function pushRow(rows, label, value) {
  rows.push({
    label,
    value: readString(value) || "-",
  });
}

function formatProviderMode(statusPayload) {
  const providerMode = readString(statusPayload.providerMode).toLowerCase();
  if (providerMode === "managed-openai-compatible") {
    return "Managed Runtime";
  }

  if (providerMode === "external-openai-compatible") {
    return "External LM Studio";
  }

  const backend = readString(statusPayload.backend).toLowerCase();
  if (backend === "managed-openai-compatible") {
    return "Managed Runtime";
  }

  if (backend === "openai-compatible") {
    return "External LM Studio";
  }

  return "Unknown";
}

function formatStatus(statusPayload, managedRuntimeStatus) {
  const runtimeStatus = readString(managedRuntimeStatus && managedRuntimeStatus.status).toLowerCase();

  if (runtimeStatus === "starting") {
    return "Starting";
  }

  if (runtimeStatus === "error") {
    return "Failed";
  }

  if (statusPayload.available) {
    return "Ready";
  }

  return "Unavailable";
}

function formatRuntime(statusPayload, managedRuntimeStatus) {
  const providerMode = readString(statusPayload.providerMode).toLowerCase();
  if (providerMode === "managed-openai-compatible" || managedRuntimeStatus) {
    return "llama-server";
  }

  if (readString(statusPayload.backend).toLowerCase() === "openai-compatible") {
    return "External OpenAI-compatible server";
  }

  return readString(statusPayload.backend) || "Unknown";
}

function readHealth(statusPayload, managedRuntimeStatus) {
  const managedHealth = managedRuntimeStatus && managedRuntimeStatus.health && typeof managedRuntimeStatus.health === "object"
    ? managedRuntimeStatus.health
    : null;
  const providerHealth = statusPayload.healthStatus && typeof statusPayload.healthStatus === "object"
    ? statusPayload.healthStatus
    : null;

  if ((managedHealth && managedHealth.available === true) || (providerHealth && providerHealth.available === true)) {
    return { label: "Healthy" };
  }

  if ((managedHealth && managedHealth.available === false) || (providerHealth && providerHealth.available === false)) {
    return { label: "Unavailable" };
  }

  if (statusPayload.available) {
    return { label: "Healthy" };
  }

  return { label: "Unavailable" };
}

function readRecentLogs(runtimeLogs) {
  return runtimeLogs
    .slice(-20)
    .map((entry) => formatLogEntry(entry))
    .filter(Boolean);
}

function formatLogEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }

  const at = readString(entry.at);
  const stream = readString(entry.stream);
  const message = readString(entry.message);
  if (!message) {
    return "";
  }

  const prefix = [at, stream].filter(Boolean).join(" ");
  return prefix ? `${prefix} ${message}` : message;
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
