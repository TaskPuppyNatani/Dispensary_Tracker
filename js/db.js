import { addressesLikelySameLocation, extractPhoneFromText, normalizeAddressForLookup, scoreAddressSimilarity, scoreNameSimilarity } from "./matcher.js";
import {
  DB_NAME,
  DB_VERSION,
  SETTINGS_STORE_NAME,
  STORE_NAME,
  USER_MAPPINGS_STORE_NAME,
} from "./constants.js";

const dbPromise = openDatabase();

function createRecordId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `r-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

export function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is unavailable in this browser."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE_NAME)) {
        db.createObjectStore(SETTINGS_STORE_NAME, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(USER_MAPPINGS_STORE_NAME)) {
        db.createObjectStore(USER_MAPPINGS_STORE_NAME, { keyPath: "PhysicalAddress" });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error || new Error("Failed to open database."));
    };
  });
}

export async function addReceipt(record, preferredKey = null) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const recordToSave = record && typeof record === "object" ? { ...record } : {};

    if (Object.prototype.hasOwnProperty.call(recordToSave, "_storeKey")) {
      delete recordToSave._storeKey;
    }

    let externalKey = preferredKey;
    if (externalKey === undefined || externalKey === null || externalKey === "") {
      externalKey = recordToSave.id || null;
    }

    if (!recordToSave.id && externalKey !== null && externalKey !== undefined && externalKey !== "") {
      recordToSave.id = String(externalKey);
    }

    if (!recordToSave.id) {
      recordToSave.id = createRecordId();
      if (externalKey === undefined || externalKey === null || externalKey === "") {
        externalKey = recordToSave.id;
      }
    }

    let request;
    try {
      if (store.keyPath === null) {
        request = store.put(recordToSave, externalKey);
      } else {
        request = store.put(recordToSave);
      }
    } catch (error) {
      reject(error);
      return;
    }

    request.onerror = () => reject(request.error || tx.error || new Error("Failed to save receipt."));

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to save receipt."));
    tx.onabort = () => reject(tx.error || new Error("Receipt save aborted."));
  });
}

export async function getAllReceipts() {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.openCursor();
    const receipts = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(receipts);
        return;
      }

      const value = cursor.value && typeof cursor.value === "object" ? { ...cursor.value } : {};
      value._storeKey = cursor.key;

      if (!value.id && cursor.key !== undefined && cursor.key !== null) {
        value.id = String(cursor.key);
      }

      receipts.push(value);
      cursor.continue();
    };

    request.onerror = () => reject(request.error || new Error("Failed to load receipts."));
  });
}

export async function deleteReceipt(idOrKey) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");

    if (idOrKey === undefined || idOrKey === null || idOrKey === "") {
      resolve();
      return;
    }

    tx.objectStore(STORE_NAME).delete(idOrKey);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to delete receipt."));
    tx.onabort = () => reject(tx.error || new Error("Receipt delete aborted."));
  });
}

export async function clearAllReceiptsFromDb() {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to clear receipts."));
    tx.onabort = () => reject(tx.error || new Error("Receipt clear aborted."));
  });
}

export async function updateReceiptRecord(record, storeKey = null) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    const candidateKeys = [];
    if (store.keyPath === null) {
      if (storeKey !== undefined && storeKey !== null && storeKey !== "") {
        candidateKeys.push(storeKey);
      }
      if (record.id !== undefined && record.id !== null && record.id !== "") {
        candidateKeys.push(record.id);
      }
    } else {
      if (record.id !== undefined && record.id !== null && record.id !== "") {
        candidateKeys.push(record.id);
      }
      if (storeKey !== undefined && storeKey !== null && storeKey !== "") {
        candidateKeys.push(storeKey);
      }
    }

    if (candidateKeys.length === 0) {
      reject(new Error("Missing receipt key for update."));
      return;
    }

    const tryUpdateWithKey = (index) => {
      if (index >= candidateKeys.length) {
        reject(new Error("Receipt not found for update."));
        return;
      }

      const key = candidateKeys[index];
      const getRequest = store.get(key);

      getRequest.onerror = () => {
        reject(getRequest.error || tx.error || new Error("Failed to locate receipt for update."));
      };

      getRequest.onsuccess = () => {
        const existing = getRequest.result;
        if (!existing) {
          tryUpdateWithKey(index + 1);
          return;
        }

        const baseRecord = existing && typeof existing === "object" ? existing : {};
        const nextRecord = { ...baseRecord, ...record };

        if (Object.prototype.hasOwnProperty.call(nextRecord, "_storeKey")) {
          delete nextRecord._storeKey;
        }

        let updateRequest;
        try {
          if (store.keyPath === null) {
            updateRequest = store.put(nextRecord, key);
          } else {
            updateRequest = store.put(nextRecord);
          }
        } catch (error) {
          reject(error);
          return;
        }

        updateRequest.onerror = () => {
          reject(updateRequest.error || tx.error || new Error("Failed to save receipt."));
        };
      };
    };

    tryUpdateWithKey(0);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to save receipt."));
    tx.onabort = () => reject(tx.error || new Error("Receipt save aborted."));
  });
}

export async function getUserMappedDispensaryName(physicalAddress) {
  const normalizedAddress = String(physicalAddress || "").trim();
  if (!normalizedAddress) {
    return "";
  }

  const db = await dbPromise;
  if (!db.objectStoreNames.contains(USER_MAPPINGS_STORE_NAME)) {
    return "";
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(USER_MAPPINGS_STORE_NAME, "readonly");
    const request = tx.objectStore(USER_MAPPINGS_STORE_NAME).getAll();

    request.onsuccess = () => {
      const records = Array.isArray(request.result) ? request.result : [];

      // Prefer an exact match first, then fall back to fuzzy address comparison.
      const exactMatch = records.find(
        (r) => String(r.PhysicalAddress || "").trim() === normalizedAddress
      );
      if (exactMatch) {
        resolve(String(exactMatch.DispensaryName || "").trim());
        return;
      }

      const fuzzyMatch = records.find(
        (r) => addressesLikelySameLocation(String(r.PhysicalAddress || "").trim(), normalizedAddress)
      );
      resolve(fuzzyMatch ? String(fuzzyMatch.DispensaryName || "").trim() : "");
    };

    request.onerror = () => reject(request.error || new Error("Failed to read user mapping."));
  });
}

export async function saveUserMapping(physicalAddress, dispensaryName) {
  const normalizedAddress = String(physicalAddress || "").trim();
  const normalizedName = String(dispensaryName || "").trim().slice(0, 120);

  if (!normalizedAddress || !normalizedName) {
    return;
  }

  const db = await dbPromise;
  if (!db.objectStoreNames.contains(USER_MAPPINGS_STORE_NAME)) {
    return;
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(USER_MAPPINGS_STORE_NAME, "readwrite");
    const store = tx.objectStore(USER_MAPPINGS_STORE_NAME);

    store.put({
      PhysicalAddress: normalizedAddress,
      DispensaryName: normalizedName,
      updatedAt: new Date().toISOString(),
    });

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to save user mapping."));
    tx.onabort = () => reject(tx.error || new Error("User mapping save aborted."));
  });
}

export async function getAppSetting(key) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE_NAME, "readonly");
    const request = tx.objectStore(SETTINGS_STORE_NAME).get(key);

    request.onsuccess = () => {
      const record = request.result;
      resolve(record ? record.value : null);
    };
    request.onerror = () => reject(request.error || new Error("Failed to read app setting."));
  });
}

export async function setAppSetting(key, value) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE_NAME, "readwrite");
    tx.objectStore(SETTINGS_STORE_NAME).put({ key, value, updatedAt: new Date().toISOString() });

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to save app setting."));
    tx.onabort = () => reject(tx.error || new Error("App setting save aborted."));
  });
}

export async function deleteAppSetting(key) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE_NAME, "readwrite");
    tx.objectStore(SETTINGS_STORE_NAME).delete(key);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to delete app setting."));
    tx.onabort = () => reject(tx.error || new Error("App setting delete aborted."));
  });
}

export async function updateMatchingReceipts(updatedReceipt) {
  const targetAddress = String(updatedReceipt.physicalAddress || "").trim();
  if (!targetAddress) {
    return 0;
  }

  const allReceipts = await getAllReceipts();
  let updateCount = 0;

  for (const receipt of allReceipts) {
    if (receipt.id === updatedReceipt.id) {
      continue;
    }

    const receiptAddress = String(receipt.physicalAddress || "").trim();
    if (!addressesLikelySameLocation(receiptAddress, targetAddress)) {
      continue;
    }

    const missingLicense = !receipt.licenseNumber;
    const differentName = receipt.locationName !== updatedReceipt.locationName;

    if (missingLicense || differentName) {
      await updateReceiptRecord(
        { id: receipt.id, licenseNumber: updatedReceipt.licenseNumber, locationName: updatedReceipt.locationName },
        receipt._storeKey || null
      );
      updateCount++;
    }
  }

  return updateCount;
}

export async function countMatchingReceipts(record) {
  const targetAddress = String(record.physicalAddress || "").trim();
  if (!targetAddress) {
    return 0;
  }

  const allReceipts = await getAllReceipts();

  return allReceipts.filter((receipt) => {
    if (receipt.id === record.id) {
      return false;
    }
    const receiptAddress = String(receipt.physicalAddress || "").trim();
    if (!addressesLikelySameLocation(receiptAddress, targetAddress)) {
      return false;
    }
    const missingLicense = !receipt.licenseNumber;
    const differentName = receipt.locationName !== record.locationName;
    return missingLicense || differentName;
  }).length;
}

export async function getBestMatchFromHistory(fullOcrText, extractedAddress = "") {
  const ocrText = String(fullOcrText || "").toUpperCase();
  const targetAddress = String(extractedAddress || "").trim();

  const hasOcrText = ocrText.length > 20;
  const hasUsableAddress = targetAddress.length >= 10;

  if (!hasOcrText && !hasUsableAddress) {
    return null;
  }

  // Digits-only version of the OCR text — used for phone fingerprint matching
  const ocrDigits = ocrText.replace(/\D/g, "");

  const ADDR_THRESHOLD = 0.75;
  const OCR_TOKEN_FRACTION = 0.60;

  const allReceipts = await getAllReceipts();

  // Deduplicate to one representative receipt per unique physical address so
  // each store is scored only once. Prefer the most recent receipt that has
  // both a name and a license.
  const storeMap = new Map();
  for (const receipt of allReceipts) {
    if (!receipt.locationName || !receipt.licenseNumber) {
      continue;
    }
    const addr = String(receipt.physicalAddress || "").trim();
    if (!addr) {
      continue;
    }
    const existing = storeMap.get(addr);
    if (
      !existing ||
      String(receipt.createdAt || "") > String(existing.createdAt || "")
    ) {
      storeMap.set(addr, receipt);
    }
  }

  const scored = [];

  for (const [receiptAddress, receipt] of storeMap) {
    let score = 0;
    let method = "none";

    // ── Primary Anchor: Phone ────────────────────────────────────────────────
    // If the store's saved phone number (10 digits) appears anywhere in the
    // digits-only OCR text, this is a definitive match.
    const storedPhone = String(receipt.phoneNumber || "").replace(/\D/g, "");
    if (storedPhone.length >= 10 && ocrDigits.includes(storedPhone)) {
      score = 1.0;
      method = "phone";
    }

    // ── Secondary Anchor: Name ───────────────────────────────────────────────
    // Check whether every word of the stored store name appears in the OCR
    // text. Works for "La Mota", "Green Front", etc.
    if (score < ADDR_THRESHOLD) {
      const nameWords = receipt.locationName
        .toUpperCase()
        .split(/\s+/)
        .filter((w) => w.length >= 2);
      if (
        nameWords.length > 0 &&
        nameWords.every((word) => ocrText.includes(word))
      ) {
        score = Math.max(score, 0.92);
        method = method === "none" ? "name" : method;
      }
    }

    // ── Method 3: Normalized address string similarity ───────────────────────
    if (hasUsableAddress && score < ADDR_THRESHOLD) {
      const addrScore = scoreAddressSimilarity(receiptAddress, targetAddress);
      if (addrScore > score) {
        score = addrScore;
        method = method === "none" ? "address" : method;
      }
    }

    // ── Method 4: Address token presence in raw OCR text ────────────────────
    // Catches garbled extraction like '4390 NEDIH AWD' still matching
    // '4390 NE 82nd Ave' in history when ≥60% of tokens appear in raw OCR.
    if (hasOcrText && score < ADDR_THRESHOLD) {
      const normalized = normalizeAddressForLookup(receiptAddress);
      const streetNumberMatch = normalized.match(/^\d{1,6}/);
      const streetNumber = streetNumberMatch ? streetNumberMatch[0] : "";
      if (streetNumber && ocrText.includes(streetNumber)) {
        const tokens = normalized.split(/\s+/).filter((t) => t.length >= 2);
        if (tokens.length > 0) {
          const matchedCount = tokens.filter((t) => ocrText.includes(t)).length;
          const tokenFraction = matchedCount / tokens.length;
          if (tokenFraction >= OCR_TOKEN_FRACTION) {
            const tokenScore = 0.75 + tokenFraction * 0.15;
            if (tokenScore > score) {
              score = tokenScore;
              method = method === "none" ? "ocr-tokens" : method;
            }
          }
        }
      }
    }

    if (score >= ADDR_THRESHOLD) {
      scored.push({ receipt, score, method });
    }
  }

  if (scored.length === 0) {
    return null;
  }

  // Sort: highest score first, then most recent as tiebreaker
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return String(b.receipt.createdAt || "").localeCompare(
      String(a.receipt.createdAt || "")
    );
  });

  console.log(
    `[History] Best match: "${scored[0].receipt.locationName}" via ${scored[0].method} (score=${scored[0].score.toFixed(3)})`
  );

  return scored[0].receipt;
}

export async function getBestMatchFromHistoryByName(locationName) {
  const targetName = String(locationName || "").trim().toLowerCase();
  if (!targetName) {
    return null;
  }

  const allReceipts = await getAllReceipts();

  const matches = allReceipts.filter((receipt) => {
    if (!receipt.licenseNumber) {
      return false;
    }
    const name = String(receipt.locationName || "").trim().toLowerCase();
    if (!name) {
      return false;
    }
    // Match if names are equal, or one is a leading substring of the other
    // (e.g. "la mota" matches "la mota northeast portland")
    return name === targetName || name.startsWith(targetName) || targetName.startsWith(name);
  });

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  return matches[0];
}

export async function getHistoryByName(scannedName) {
  const NAME_MATCH_THRESHOLD = 0.80;

  const target = String(scannedName || "").trim();
  if (!target) {
    return null;
  }

  const allReceipts = await getAllReceipts();

  const scored = [];
  for (const receipt of allReceipts) {
    const name = String(receipt.locationName || "").trim();
    if (!name) {
      continue;
    }
    const score = scoreNameSimilarity(target, name);
    if (score >= NAME_MATCH_THRESHOLD) {
      scored.push({ receipt, score });
    }
  }

  if (scored.length === 0) {
    return null;
  }

  // Sort: entries with a license first, then highest score, then most recent
  scored.sort((a, b) => {
    const aHasLicense = a.receipt.licenseNumber ? 1 : 0;
    const bHasLicense = b.receipt.licenseNumber ? 1 : 0;
    if (bHasLicense !== aHasLicense) {
      return bHasLicense - aHasLicense;
    }
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return String(b.receipt.createdAt || "").localeCompare(String(a.receipt.createdAt || ""));
  });

  const best = scored[0].receipt;
  return {
    locationName: best.locationName,
    physicalAddress: best.physicalAddress || "",
    licenseNumber: best.licenseNumber || "",
  };
}
