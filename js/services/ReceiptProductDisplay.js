export function buildReceiptProductDisplay(products) {
  if (!Array.isArray(products) || products.length === 0) {
    return {
      items: [],
      emptyMessage: "No AI products found.",
    };
  }

  const items = products
    .filter((product) => isRecord(product) && hasDisplayValue(product.name))
    .map((product) => ({
      name: String(product.name).trim(),
      details: buildProductDetails(product),
    }));

  return {
    items,
    emptyMessage: items.length > 0 ? "" : "No readable AI products found.",
  };
}

function buildProductDetails(product) {
  const details = [];

  addDetail(details, "Brand", product.brand);
  addDetail(details, "Quantity", product.quantity);
  addDetail(details, "Price", readProductPrice(product), formatPrice);
  addDetail(details, "Category", product.category);
  addDetail(details, "THC", readFirstPresent(product, ["thc", "THC", "thc_percent", "thcPercent", "thcPercentage"]));
  addDetail(details, "CBD", readFirstPresent(product, ["cbd", "CBD", "cbd_percent", "cbdPercent", "cbdPercentage"]));

  return details;
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

function readProductPrice(product) {
  if (hasDisplayValue(product.total_price)) {
    return product.total_price;
  }

  if (hasDisplayValue(product.unit_price)) {
    return product.unit_price;
  }

  return null;
}

function readFirstPresent(source, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && hasDisplayValue(source[key])) {
      return source[key];
    }
  }

  return null;
}

function formatPrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `$${value.toFixed(2)}`;
  }

  return formatDisplayValue(value);
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
