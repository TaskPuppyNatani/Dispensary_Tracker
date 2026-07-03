"use strict";

function map(validationResult) {
  const sourceReceipt = validationResult && typeof validationResult === "object"
    ? validationResult.receipt
    : null;
  const sourceValidation = validationResult && typeof validationResult === "object"
    ? validationResult.validation
    : null;
  const sourceValid = Boolean(sourceValidation && sourceValidation.valid);

  if (!sourceValid) {
    return {
      receipt: null,
      mapping: {
        mapped: false,
        sourceValid: false,
        warnings: []
      }
    };
  }

  const receipt = {
    dispensary: sourceReceipt ? sourceReceipt.dispensary : null,
    licenseNumber: sourceReceipt ? sourceReceipt.license_number : null,
    receiptNumber: sourceReceipt ? sourceReceipt.receipt_number : null,
    purchaseDate: sourceReceipt ? sourceReceipt.purchase_date : null,
    purchaseTime: sourceReceipt ? sourceReceipt.purchase_time : null,
    subtotal: sourceReceipt ? sourceReceipt.subtotal : null,
    tax: sourceReceipt ? sourceReceipt.tax : null,
    total: sourceReceipt ? sourceReceipt.total : null,
    paymentMethod: sourceReceipt ? sourceReceipt.payment_method : null,
    budtender: sourceReceipt ? sourceReceipt.budtender : null,
    discounts: mapDiscounts(sourceReceipt ? sourceReceipt.discounts : []),
    loyalty: mapLoyalty(sourceReceipt ? sourceReceipt.loyalty : null),
    products: mapProducts(sourceReceipt ? sourceReceipt.products : [])
  };

  return {
    receipt,
    mapping: {
      mapped: true,
      sourceValid: true,
      warnings: []
    }
  };
}

function mapDiscounts(discounts) {
  if (!Array.isArray(discounts)) {
    return [];
  }

  return discounts.map((discount) => ({
    description: discount ? discount.description : null,
    amount: discount ? discount.amount : null
  }));
}

function mapLoyalty(loyalty) {
  if (loyalty === null) {
    return null;
  }

  if (!loyalty || typeof loyalty !== "object" || Array.isArray(loyalty)) {
    return null;
  }

  return {
    earned: loyalty.earned,
    redeemed: loyalty.redeemed,
    balance: loyalty.balance
  };
}

function mapProducts(products) {
  if (!Array.isArray(products)) {
    return [];
  }

  return products.map((product) => ({
    name: product ? product.name : null,
    brand: product ? product.brand : null,
    category: product ? product.category : null,
    quantity: product ? product.quantity : null,
    unit_price: product ? product.unit_price : null,
    total_price: product ? product.total_price : null
  }));
}

module.exports = {
  map
};