const APPLY_FIELD_DEFINITIONS = [
  {
    field: "location",
    label: "dispensary",
    sourceKey: "dispensary",
    normalize: normalizeTextInputValue,
  },
  {
    field: "license",
    label: "license",
    sourceKey: "licenseNumber",
    normalize: normalizeTextInputValue,
  },
  {
    field: "date",
    label: "date",
    sourceKey: "purchaseDate",
    normalize: normalizeDateInputValue,
  },
  {
    field: "time",
    label: "time",
    sourceKey: "purchaseTime",
    normalize: normalizeTimeInputValue,
  },
  {
    field: "amount",
    label: "amount",
    sourceKey: "total",
    normalize: normalizeAmountInputValue,
  },
];

export function buildReceiptFormApplyPlan(receipt, options = {}) {
  const availableFields = isRecord(options.availableFields) ? options.availableFields : null;
  const fields = [];
  const skipped = [];

  if (!isRecord(receipt)) {
    return { fields, skipped };
  }

  for (const definition of APPLY_FIELD_DEFINITIONS) {
    if (availableFields && availableFields[definition.field] === false) {
      continue;
    }

    const rawValue = receipt[definition.sourceKey];
    if (!hasApplyValue(rawValue)) {
      continue;
    }

    const value = definition.normalize(rawValue);
    if (!value) {
      skipped.push(definition.label);
      continue;
    }

    fields.push({
      field: definition.field,
      label: definition.label,
      sourceKey: definition.sourceKey,
      value,
    });
  }

  return { fields, skipped };
}

export function normalizeTextInputValue(value) {
  return hasApplyValue(value) ? String(value).trim() : "";
}

export function normalizeDateInputValue(value) {
  if (!hasApplyValue(value)) {
    return "";
  }

  const raw = String(value).trim();
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch && isValidDateParts(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]))) {
    return raw;
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const month = Number(slashMatch[1]);
    const day = Number(slashMatch[2]);
    const year = Number(slashMatch[3]);
    if (isValidDateParts(year, month, day)) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  const namedMonthMatch = raw.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (namedMonthMatch) {
    const month = readEnglishMonthNumber(namedMonthMatch[1]);
    const day = Number(namedMonthMatch[2]);
    const year = Number(namedMonthMatch[3]);
    if (month && isValidDateParts(year, month, day)) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  return "";
}

export function normalizeTimeInputValue(value) {
  if (!hasApplyValue(value)) {
    return "";
  }

  const raw = String(value).trim();
  const twentyFourHourMatch = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (twentyFourHourMatch) {
    const hour = Number(twentyFourHourMatch[1]);
    const minute = Number(twentyFourHourMatch[2]);
    return isValidTimeParts(hour, minute)
      ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
      : "";
  }

  const meridiemMatch = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (meridiemMatch) {
    let hour = Number(meridiemMatch[1]);
    const minute = meridiemMatch[2] === undefined ? 0 : Number(meridiemMatch[2]);
    const meridiem = meridiemMatch[3].toUpperCase();

    if (hour < 1 || hour > 12 || !isValidTimeParts(0, minute)) {
      return "";
    }

    if (meridiem === "AM") {
      hour = hour === 12 ? 0 : hour;
    } else {
      hour = hour === 12 ? 12 : hour + 12;
    }

    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  return "";
}

export function normalizeAmountInputValue(value) {
  if (!hasApplyValue(value)) {
    return "";
  }

  const normalized = Number.parseFloat(String(value).replace(/[$,]/g, "").trim());
  return Number.isFinite(normalized) && normalized >= 0
    ? normalized.toFixed(2)
    : "";
}

function hasApplyValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function readEnglishMonthNumber(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  const monthNames = {
    january: 1,
    jan: 1,
    february: 2,
    feb: 2,
    march: 3,
    mar: 3,
    april: 4,
    apr: 4,
    may: 5,
    june: 6,
    jun: 6,
    july: 7,
    jul: 7,
    august: 8,
    aug: 8,
    september: 9,
    sep: 9,
    sept: 9,
    october: 10,
    oct: 10,
    november: 11,
    nov: 11,
    december: 12,
    dec: 12,
  };

  return monthNames[normalized] || 0;
}

function isValidDateParts(year, month, day) {
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || !Number.isSafeInteger(day)) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isValidTimeParts(hour, minute) {
  return Number.isSafeInteger(hour)
    && Number.isSafeInteger(minute)
    && hour >= 0
    && hour <= 23
    && minute >= 0
    && minute <= 59;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
