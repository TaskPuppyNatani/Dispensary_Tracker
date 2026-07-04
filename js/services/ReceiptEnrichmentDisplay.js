export function buildReceiptDiscountDisplay(discounts) {
  if (!Array.isArray(discounts) || discounts.length === 0) {
    return {
      items: [],
      emptyMessage: "No discounts detected.",
    };
  }

  const items = discounts
    .filter((discount) => discount !== null && discount !== undefined)
    .map((discount) => {
      const source = isRecord(discount) ? discount : {};
      const description = hasDisplayValue(source.description)
        ? String(source.description).trim()
        : "Discount";
      const details = [];

      addDetail(details, "Amount", source.amount, formatCurrency);

      return {
        description,
        details,
      };
    });

  return {
    items,
    emptyMessage: items.length > 0 ? "" : "No readable discounts detected.",
  };
}

export function buildReceiptLoyaltyDisplay(loyalty) {
  if (!isRecord(loyalty)) {
    return {
      items: [],
      emptyMessage: "No loyalty information detected.",
    };
  }

  const items = [];
  addDetail(items, "Earned", loyalty.earned);
  addDetail(items, "Redeemed", loyalty.redeemed);
  addDetail(items, "Balance", loyalty.balance);

  return {
    items,
    emptyMessage: items.length > 0 ? "" : "No loyalty information detected.",
  };
}

function addDetail(details, label, value, formatter = formatDisplayValue) {
  if (!hasDisplayValue(value)) {
    return;
  }

  const formatted = formatter(value);
  if (!hasDisplayValue(formatted)) {
    return;
  }

  details.push({ label, value: formatted });
}

function formatCurrency(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatCurrencyNumber(value);
  }

  const text = formatDisplayValue(value);
  const normalized = text.replace(/[$,]/g, "");
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    return formatCurrencyNumber(Number(normalized));
  }

  return text;
}

function formatCurrencyNumber(value) {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatDisplayValue(value) {
  return hasDisplayValue(value) ? String(value).trim() : "";
}

function hasDisplayValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
