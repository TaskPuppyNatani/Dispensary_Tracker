import {
  AUTO_BACKUP_PROMPT_KEY,
  BACKUP_REMINDER_KEY,
  DENSITY_KEY,
  DEVICE_BACKUP_HANDLE_KEY,
  DISPENSARY_LIST_FALLBACK_PATH,
  DISPENSARY_LIST_PATH,
  DISPENSARY_MATCH_THRESHOLD,
  LAST_BACKUP_KEY,
  REMINDER_DAYS,
  THEME_KEY,
} from "./constants.js";
import {
  addReceipt,
  clearAllReceiptsFromDb,
  countMatchingReceipts,
  deleteReceipt,
  getAllReceipts,
  getAppSetting,
  getBestMatchFromHistory,
  getHistoryByName,
  getUserMappedDispensaryName,
  saveUserMapping,
  updateMatchingReceipts,
  updateReceiptRecord,
} from "./db.js";
import { onScanReceipt } from "./ocr.js";
import { extractPhoneFromText } from "./matcher.js";
import { elements, state } from "./state.js";
import {
  getClearAllErrorMessage,
  getEditErrorMessage,
  getErrorDetailSuffix,
  onChooseAutoBackupFile,
  onClearAutoBackupFile,
  onExportCsv,
  onExportZip,
  onImportBackupSelected,
  toTitleCase,
  tryWriteAutoFileBackup,
} from "./utils.js";

(() => {
  "use strict";

  console.log('🚀 App.js script loaded and executing!');

  console.log('Elements loaded:', elements);

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    if (elements.locationInput) {
      state.defaultLocationPlaceholder = elements.locationInput.getAttribute("placeholder") || "Dispensary name";
    }

    refreshRunningTotalDisplay(state.receiptsCache);

    bindEvents();
    applySavedTheme();
    applySavedDensity();
    applyAutoBackupPromptPreference();
    applyBackupReminderPreference();
    registerServiceWorker();
    attachInstallHandlers();
    ensureDispensaryLookupLoaded().catch((error) => {
      console.warn("Could not preload dispensary list:", error);
    });

    loadReceipts()
      .then(async (receipts) => {
        // Auto-request storage protection if we have data and haven't checked recently
        if (receipts.length > 0) {
          const lastProtectionCheck = localStorage.getItem('storage_protection_last_check');
          const shouldCheckProtection = !lastProtectionCheck || 
            (Date.now() - parseInt(lastProtectionCheck)) > (7 * 24 * 60 * 60 * 1000); // Check weekly

          if (shouldCheckProtection) {
            try {
              await ensureStorageProtection();
            } catch (error) {
              console.warn('Could not check storage protection:', error);
            }
            localStorage.setItem('storage_protection_last_check', Date.now().toString());
          }
        }

        if (shouldShowBackupReminder(receipts.length)) {
          setStatus("Reminder: create a backup ZIP from the gear menu this week.", "warn");
          return;
        }

        setStatus("Waiting for image...");
      })
      .catch((error) => {
        console.error(error);
        setStatus("Unable to load saved receipts.", "error");
      });
  }

  function bindEvents() {
    console.log('Binding events...');

    // ── Zoom View Modal ───────────────────────────────────────────────────
    const imageModal = document.getElementById("imageModal");
    const imageModalImg = document.getElementById("imageModalImg");
    const imageModalClose = document.getElementById("imageModalClose");

    // Zoom / pan state
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartPanX = 0;
    let dragStartPanY = 0;
    let didDrag = false; // suppress backdrop-click after a drag gesture

    const MIN_ZOOM = 1;
    const MAX_ZOOM = 8;

    function applyTransform() {
      imageModalImg.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
      if (isDragging) {
        imageModalImg.style.cursor = "grabbing";
      } else if (zoom > 1) {
        imageModalImg.style.cursor = "grab";
      } else {
        imageModalImg.style.cursor = "zoom-in";
      }
    }

    function resetZoomPan() {
      zoom = 1;
      panX = 0;
      panY = 0;
      isDragging = false;
      didDrag = false;
      imageModalImg.style.transform = "";
      imageModalImg.style.cursor = "zoom-in";
    }

    function openImageModal(src) {
      if (!imageModal || !imageModalImg) return;
      imageModalImg.src = src;
      resetZoomPan();
      imageModal.hidden = false;
      imageModalClose.focus();
    }

    function closeImageModal() {
      if (!imageModal) return;
      imageModal.hidden = true;
      imageModalImg.src = "";
      resetZoomPan();
    }

    // Close button
    if (imageModalClose) {
      imageModalClose.addEventListener("click", closeImageModal);
    }

    // Backdrop click closes (but not after a drag)
    if (imageModal) {
      imageModal.addEventListener("click", (e) => {
        if (didDrag) {
          didDrag = false;
          return;
        }
        if (e.target === imageModal) {
          closeImageModal();
        }
      });
    }

    // Escape key closes
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && imageModal && !imageModal.hidden) {
        closeImageModal();
      }
    });

    // Mouse-wheel zoom (centred on cursor position)
    if (imageModalImg) {
      imageModalImg.addEventListener("wheel", (e) => {
        e.preventDefault();
        const STEP = 0.12;
        const direction = e.deltaY < 0 ? 1 : -1;
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * (1 + direction * STEP)));

        // Zoom toward the mouse cursor
        const rect = imageModalImg.getBoundingClientRect();
        const originX = e.clientX - (rect.left + rect.width / 2);
        const originY = e.clientY - (rect.top + rect.height / 2);
        panX = originX - (originX - panX) * (newZoom / zoom);
        panY = originY - (originY - panY) * (newZoom / zoom);

        zoom = newZoom;
        if (zoom <= MIN_ZOOM) {
          panX = 0;
          panY = 0;
        }
        applyTransform();
      }, { passive: false });

      // Double-click resets zoom
      imageModalImg.addEventListener("dblclick", () => {
        resetZoomPan();
      });

      // Drag to pan
      imageModalImg.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        isDragging = true;
        didDrag = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragStartPanX = panX;
        dragStartPanY = panY;
        applyTransform();
      });

      // Prevent native image drag
      imageModalImg.addEventListener("dragstart", (e) => e.preventDefault());
    }

    // Track mouse move and release at modal level so fast moves don't escape
    if (imageModal) {
      imageModal.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          didDrag = true;
        }
        panX = dragStartPanX + dx;
        panY = dragStartPanY + dy;
        applyTransform();
      });

      imageModal.addEventListener("mouseup", () => {
        if (!isDragging) return;
        isDragging = false;
        applyTransform();
      });

      imageModal.addEventListener("mouseleave", () => {
        if (!isDragging) return;
        isDragging = false;
        applyTransform();
      });
    }

    // Click on the scan-preview image to zoom it
    if (elements.receiptPreview) {
      elements.receiptPreview.style.cursor = "zoom-in";
      elements.receiptPreview.addEventListener("click", () => {
        if (elements.receiptPreview.src) {
          openImageModal(elements.receiptPreview.src);
        }
      });
    }

    // Expose opener so renderReceipts can attach thumbnail click handlers
    state.openImageModal = openImageModal;

    // Main page events
    if (elements.settingsToggle) {
      console.log('settingsToggle element:', elements.settingsToggle);
      elements.settingsToggle.addEventListener("click", () => {
        console.log('Settings toggle clicked - navigating to settings page');
        window.location.href = 'settings.html';
      });
    }

    if (elements.receiptInput) {
      elements.receiptInput.addEventListener("change", onReceiptSelected);
    }

    if (elements.scanBtn) {
      elements.scanBtn.addEventListener("click", async () => {
        clearHistoryHints();
        await onScanReceipt({
          state,
          elements,
          setStatus,
          clearTrainingLookupState,
          fillReceiptForm,
          getDispensaryName,
          setMatchConfidence: updateMatchConfidenceIndicator,
        });

        // --- STORE ANCHORS ---
        // Hard-coded overrides for stores whose OCR text is reliably identifiable
        // but whose address/name may still be mis-read. Runs before any fuzzy
        // matching so these stores are always filled in correctly.
        const ocrText = String(state.lastOcrText || "").toUpperCase();
        const STORE_ANCHORS = [
          {
            test: (t) => t.includes("LA MOTA") || t.includes("1670315") || t.includes("1670316"),
            locationName: "La Mota",
            licenseNumber: "050-10007012B21",
          },
        ];
        for (const anchor of STORE_ANCHORS) {
          if (anchor.test(ocrText)) {
            console.log("[Store Anchor] Matched:", anchor.locationName);
            if (elements.locationInput) {
              elements.locationInput.value = anchor.locationName;
            }
            if (elements.licenseInput) {
              elements.licenseInput.value = anchor.licenseNumber;
            }
            break;
          }
        }
        // --- END STORE ANCHORS ---

        const detectedAddress = state.lastDetectedPhysicalAddress;
        const detectedName = elements.locationInput ? elements.locationInput.value.trim() : "";

        // --- SMART MEMORY DEBUG ---
        console.log("--- STARTING SMART MEMORY CHECK ---");
        console.log("OCR Detected Name:", detectedName || "(none)");
        console.log("OCR Detected Address:", detectedAddress || "(none)");

        // If OCR didn't resolve a physical address but the dispensary matcher
        // found a license number, use it to look up the canonical address so
        // history matching has something to work with.
        let resolvedAddressForHistory = detectedAddress;
        if (!resolvedAddressForHistory) {
          const currentLicense = elements.licenseInput ? elements.licenseInput.value.trim() : "";
          if (currentLicense) {
            resolvedAddressForHistory = await findAddressByLicense(currentLicense).catch(() => "");
          }
        }
        console.log("Resolved Address for History:", resolvedAddressForHistory || "(none)");

        // Always run institutional memory lookup against the full raw OCR text.
        // Phone and name fingerprints work on the whole text; the extracted
        // address is passed as a secondary hint for token/similarity methods.
        let historyRestored = false;
        try {
          const historyMatch = await getBestMatchFromHistory(state.lastOcrText, resolvedAddressForHistory || "");
          console.log("Address History Match:", historyMatch ? `FOUND: ${historyMatch.locationName} / ${historyMatch.licenseNumber}` : "NOT FOUND");
          if (historyMatch) {
            console.log("Institutional Memory: Found match for", historyMatch.locationName);
            let restored = false;
            if (historyMatch.locationName) {
              elements.locationInput.value = historyMatch.locationName;
              showHistoryHint(elements.locationInput);
              restored = true;
            }
            if (elements.licenseInput && historyMatch.licenseNumber) {
              elements.licenseInput.value = historyMatch.licenseNumber;
              showHistoryHint(elements.licenseInput);
              restored = true;
            }
            if (restored) {
              historyRestored = true;
              setStatus("Scan complete. Name and License restored from a previous visit. Verify and save.", "success");
            }
          }
        } catch (historyError) {
          console.warn("History lookup failed:", historyError);
        }

        // If address-based lookup found nothing, fall back to matching by store name.
        // This handles messy OCR addresses (e.g. '9046 NE 5ANDY') where the store
        // name was still recognised but the address score fell below threshold.
        if (!historyRestored) {
          const currentName = elements.locationInput ? elements.locationInput.value.trim() : "";
          console.log("Address lookup failed — trying name fallback with:", currentName || "(none)");
          if (currentName) {
            try {
              const nameMatch = await getHistoryByName(currentName);
              console.log("Name History Match:", nameMatch ? `FOUND: ${nameMatch.locationName} / ${nameMatch.licenseNumber}` : "NOT FOUND");
              if (nameMatch) {
                let restored = false;
                if (nameMatch.locationName && elements.locationInput) {
                  elements.locationInput.value = nameMatch.locationName;
                  showHistoryHint(elements.locationInput);
                  restored = true;
                }
                if (nameMatch.licenseNumber && elements.licenseInput && !elements.licenseInput.value.trim()) {
                  elements.licenseInput.value = nameMatch.licenseNumber;
                  showHistoryHint(elements.licenseInput);
                  restored = true;
                }
                if (restored) {
                  setStatus("Scan complete. Matched by store name. Verify and save.", "success");
                }
              }
            } catch (nameHistoryError) {
              console.warn("Name-based history lookup failed:", nameHistoryError);
            }
          }
        }

        // Snapshot the final auto-filled name so onSaveReceipt can detect
        // whether the user manually edited it before saving.
        state.lastAutoFilledName = elements.locationInput ? elements.locationInput.value.trim() : "";
        console.log("Final auto-filled name snapshot:", state.lastAutoFilledName || "(none)");
        console.log("--- END SMART MEMORY CHECK ---");

        // Recompute from the in-memory receipt list whenever scan UI updates.
        refreshRunningTotalDisplay(state.receiptsCache);
      });
    }

    if (elements.receiptForm) {
      elements.receiptForm.addEventListener("submit", onSaveReceipt);
    }

    if (elements.cancelEditBtn) {
      elements.cancelEditBtn.addEventListener("click", onCancelEdit);
    }

    // Settings page events
    if (elements.backBtn) {
      elements.backBtn.addEventListener("click", () => {
        window.location.href = 'index.html';
      });
    }

    if (elements.exportCsvBtn) {
      elements.exportCsvBtn.addEventListener("click", async () => {
        await onExportCsv({ setStatus });
      });
    }

    if (elements.exportZipBtn) {
      elements.exportZipBtn.addEventListener("click", async () => {
        await onExportZip({ setStatus, markBackupExported });
      });
    }

    if (elements.storageProtectBtn) {
      elements.storageProtectBtn.addEventListener("click", async () => {
        await requestPersistentStorage();
      });
    }

    if (elements.chooseBackupFileBtn) {
      elements.chooseBackupFileBtn.addEventListener("click", async () => {
        await onChooseAutoBackupFile({ setStatus, markBackupExported });
      });
    }

    if (elements.clearBackupFileBtn) {
      elements.clearBackupFileBtn.addEventListener("click", async () => {
        await onClearAutoBackupFile({ setStatus });
      });
    }

    if (elements.importBackupBtn && elements.importBackupInput) {
      elements.importBackupBtn.addEventListener("click", () => {
        elements.importBackupInput.click();
      });
      elements.importBackupInput.addEventListener("change", async (event) => {
        await onImportBackupSelected({ setStatus, loadReceipts }, event);
      });
    }

    if (elements.clearAllReceiptsBtn) {
      elements.clearAllReceiptsBtn.addEventListener("click", onClearAllReceipts);
    }

    if (elements.themeSwitch) {
      elements.themeSwitch.addEventListener("change", () => {
        const nextTheme = elements.themeSwitch.checked ? "light" : "dark";
        applyTheme(nextTheme);
        localStorage.setItem(THEME_KEY, nextTheme);
      });
    }

    if (elements.compactSwitch) {
      elements.compactSwitch.addEventListener("change", () => {
        const nextDensity = elements.compactSwitch.checked ? "compact" : "roomy";
        applyDensity(nextDensity);
        localStorage.setItem(DENSITY_KEY, nextDensity);
        setStatus(nextDensity === "compact" ? "Compact layout enabled." : "Compact layout disabled.");
      });
    }

    if (elements.backupReminderSwitch) {
      elements.backupReminderSwitch.addEventListener("change", () => {
        const enabled = elements.backupReminderSwitch.checked;
        localStorage.setItem(BACKUP_REMINDER_KEY, enabled ? "1" : "0");
        setStatus(enabled ? "Weekly backup reminder enabled." : "Weekly backup reminder disabled.");
      });
    }

    if (elements.autoBackupPromptSwitch) {
      elements.autoBackupPromptSwitch.addEventListener("change", () => {
        const enabled = elements.autoBackupPromptSwitch.checked;
        localStorage.setItem(AUTO_BACKUP_PROMPT_KEY, enabled ? "1" : "0");
        setStatus(enabled ? "Backup prompt after save enabled." : "Backup prompt after save disabled.");
      });
    }

    window.addEventListener("beforeunload", () => {
      clearPreviewUrl();
      clearThumbUrls();
    });
  }

  function setStatus(message, type = "info") {
    if (!elements.scanStatus) {
      console.log('Status:', message, type);
      return; // No status element on this page
    }

    elements.scanStatus.textContent = message;

    if (type === "error") {
      elements.scanStatus.style.color = "var(--danger)";
      return;
    }

    if (type === "success") {
      elements.scanStatus.style.color = "var(--accent)";
      return;
    }

    if (type === "warn") {
      elements.scanStatus.style.color = "var(--accent-2)";
      return;
    }

    elements.scanStatus.style.color = "var(--muted)";
  }

  function clearPreviewUrl() {
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = "";
    }
  }

  function clearThumbUrls() {
    for (const url of state.thumbUrls) {
      URL.revokeObjectURL(url);
    }
    state.thumbUrls = [];
  }

  function onReceiptSelected(event) {
    const [file] = event.target.files || [];
    if (!file) {
      return;
    }

    if (state.editingReceipt) {
      clearEditModeState();
      setStatus("Edit mode canceled. Ready to save a new receipt.", "warn");
    }

    clearTrainingLookupState(true);
    updateMatchConfidenceIndicator(null);

    if (!file.type.startsWith("image/")) {
      setStatus("Please select a valid image file.", "error");
      return;
    }

    state.currentFile = file;
    state.lastOcrText = "";

    clearPreviewUrl();
    state.previewUrl = URL.createObjectURL(file);
    elements.receiptPreview.src = state.previewUrl;
    elements.previewWrap.hidden = false;

    setStatus("Image loaded. Press Scan Receipt to extract fields.", "success");
  }

  function showHistoryHint(inputEl) {
    if (!inputEl || inputEl.nextElementSibling?.classList.contains("history-hint")) {
      return;
    }
    const hint = document.createElement("small");
    hint.className = "history-hint";
    hint.textContent = "\u21BA Restored from history";
    hint.style.cssText = "display:block;color:var(--accent-2);font-size:0.75em;margin-top:2px;";
    inputEl.insertAdjacentElement("afterend", hint);
  }

  function clearHistoryHints() {
    document.querySelectorAll(".history-hint").forEach((el) => el.remove());
  }

  function fillReceiptForm(data) {
    if (data.locationName) {
      elements.locationInput.value = data.locationName;
    }

    if (elements.licenseInput) {
      elements.licenseInput.value = data.licenseNumber || "";
    }

    if (data.purchaseDate) {
      elements.dateInput.value = data.purchaseDate;
    }

    if (data.purchaseTime) {
      elements.timeInput.value = data.purchaseTime;
    }

    if (data.amountSpent) {
      elements.amountInput.value = data.amountSpent;
    }
  }

  function updateMatchConfidenceIndicator(score) {
    if (!elements.matchConfidence) {
      return;
    }

    if (!Number.isFinite(score)) {
      elements.matchConfidence.textContent = "";
      elements.matchConfidence.style.color = "var(--muted)";
      return;
    }

    const percent = Math.round(score * 100);
    elements.matchConfidence.textContent = `${percent}% Match`;

    if (score > 0.9) {
      elements.matchConfidence.style.color = "var(--accent)";
      return;
    }

    if (score >= 0.85) {
      elements.matchConfidence.style.color = "var(--accent-2)";
      return;
    }

    elements.matchConfidence.style.color = "var(--muted)";
  }

  function updateRunningTotal(database) {
    let runningTotal = 0;
    const records = Array.isArray(database) ? database : [];

    for (const record of records) {
      if (!record || typeof record !== "object") {
        continue;
      }

      const rawAmount =
        record.amountSpent !== undefined
          ? record.amountSpent
          : record.amount !== undefined
            ? record.amount
            : record.price;

      const parsedAmount = Number.parseFloat(String(rawAmount ?? "").replace(/[$,]/g, ""));
      if (Number.isNaN(parsedAmount)) {
        continue;
      }

      runningTotal += parsedAmount;
    }

    return Number.parseFloat(runningTotal.toFixed(2));
  }

  function refreshRunningTotalDisplay(database = state.receiptsCache) {
    if (!elements.runningTotalLabel) {
      return;
    }

    const total = updateRunningTotal(database);
    elements.runningTotalLabel.textContent = `Running Total: $${total.toFixed(2)}`;
  }

  async function onSaveReceipt(event) {
    event.preventDefault();

    if (state.editingReceipt) {
      await onUpdateReceiptFromForm();
      return;
    }

    if (!state.currentFile) {
      setStatus("Add a receipt image before saving.", "warn");
      return;
    }

    const locationName = elements.locationInput.value.trim();
    const licenseNumber = elements.licenseInput ? elements.licenseInput.value.trim().slice(0, 40) : "";
    const purchaseDate = elements.dateInput.value;
    const purchaseTime = elements.timeInput.value;
    const amountFloat = Number.parseFloat(elements.amountInput.value);
    const notes = elements.notesInput.value.trim();

    if (!locationName || !purchaseDate || !Number.isFinite(amountFloat)) {
      setStatus("Location, date, and amount are required.", "error");
      return;
    }

    if (amountFloat < 0) {
      setStatus("Amount must be greater than or equal to 0.", "error");
      return;
    }

    try {
      let imageBlob;
      try {
        imageBlob = await createThumbnailBlob(state.currentFile, 1100, 0.78);
      } catch (thumbnailError) {
        console.warn("Falling back to original receipt image after thumbnail generation failed:", thumbnailError);
        imageBlob = state.currentFile;
      }

      const id = createRecordId();
      const nowIso = new Date().toISOString();
      let physicalAddress = state.lastDetectedPhysicalAddress || "";

      // If OCR couldn't determine an address, try to resolve it from the
      // dispensary list using the license number the user entered.
      if (!physicalAddress && licenseNumber) {
        physicalAddress = await findAddressByLicense(licenseNumber);
      }

      const record = {
        id,
        locationName,
        licenseNumber,
        physicalAddress,
        phoneNumber: extractPhoneFromText(state.lastOcrText || ""),
        purchaseDate,
        purchaseTime: purchaseTime || "",
        amountSpent: amountFloat.toFixed(2),
        notes,
        rawText: state.lastOcrText,
        imageFileName: `receipt-${id}.jpg`,
        imageBlob,
        createdAt: nowIso,
      };

      await addReceipt(record);

      try {
        const matchCount = await countMatchingReceipts(record);
        if (matchCount > 0) {
          const shouldUpdate = window.confirm(
            `Update ${matchCount} other receipt${matchCount === 1 ? "" : "s"} at this address to match these new details?`
          );
          if (shouldUpdate) {
            await updateMatchingReceipts(record);
            await loadReceipts();
          }
        }
      } catch (syncError) {
        console.warn("Could not sync matching receipts:", syncError);
      }

      let trainingMappingSaved = false;
      try {
        trainingMappingSaved = await maybePersistTrainingMapping(locationName);
      } catch (trainingError) {
        console.error("Could not persist training mapping:", trainingError);
      }

      // If the user edited the dispensary name after autofill, save the
      // correction as an address→name mapping so future scans at this
      // address auto-correct to the user's preferred name.
      const autoFilledName = String(state.lastAutoFilledName || "").trim();
      if (
        !trainingMappingSaved &&
        physicalAddress &&
        autoFilledName &&
        locationName !== autoFilledName
      ) {
        try {
          await saveUserMapping(physicalAddress, locationName);
          trainingMappingSaved = true;
        } catch (mappingError) {
          console.warn("Could not save name-correction mapping:", mappingError);
        }
      }

      const receipts = await loadReceipts();
      const autoBackupResult = await tryWriteAutoFileBackup({ markBackupExported }, receipts);

      resetCaptureState();

      if (autoBackupResult === "written") {
        if (trainingMappingSaved) {
          setStatus("Receipt saved, training mapping learned, and auto-backup file updated.", "success");
          return;
        }

        setStatus("Receipt saved locally and auto-backup file updated.", "success");
        return;
      }

      if (autoBackupResult === "failed") {
        if (trainingMappingSaved) {
          setStatus("Receipt saved and training mapping learned, but auto-backup file update failed. Please export a ZIP now.", "warn");
        } else {
          setStatus("Receipt saved, but auto-backup file update failed. Please export a ZIP now.", "warn");
        }
      }

      if (shouldPromptBackupAfterSave()) {
        const shouldExportNow = window.confirm("Receipt saved. Download an updated backup ZIP to your device now?");
        if (shouldExportNow) {
          await onExportZip(
            { setStatus, markBackupExported },
            {
              closeMenu: false,
              successMessage: "Receipt saved and backup ZIP downloaded to your device.",
            }
          );
          return;
        }
      }

      if (trainingMappingSaved) {
        setStatus("Receipt saved and training mapping learned. Export from the gear menu anytime.", "success");
      } else {
        setStatus("Receipt saved locally. Export from the gear menu anytime.", "success");
      }
    } catch (error) {
      console.error(error);
      setStatus("Failed to save receipt. Please retry.", "error");
    }
  }

  function resetCaptureState() {
    clearHistoryHints();
    clearEditModeState();
    clearTrainingLookupState(true);
    updateMatchConfidenceIndicator(null);
    state.currentFile = null;
    state.lastOcrText = "";
    state.lastAutoFilledName = "";
    if (elements.receiptInput) {
      elements.receiptInput.value = "";
    }
    if (elements.receiptForm) {
      elements.receiptForm.reset();
    }
    if (elements.previewWrap) {
      elements.previewWrap.hidden = true;
    }
    if (elements.receiptPreview) {
      elements.receiptPreview.removeAttribute("src");
    }
    clearPreviewUrl();
  }

  async function loadReceipts() {
    const receipts = await getAllReceipts();
    receipts.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    state.receiptsCache = receipts;
    refreshRunningTotalDisplay(receipts);

    // Settings page does not include receipt table elements.
    if (elements.receiptRows && elements.rowTemplate && elements.recordCount && elements.emptyState) {
      renderReceipts(receipts);
    }

    return receipts;
  }

  function renderReceipts(receipts) {
    if (!elements.receiptRows || !elements.rowTemplate || !elements.recordCount || !elements.emptyState) {
      return;
    }

    elements.receiptRows.innerHTML = "";
    clearThumbUrls();

    elements.recordCount.textContent = `${receipts.length} receipt${receipts.length === 1 ? "" : "s"} saved`;
    elements.emptyState.hidden = receipts.length > 0;

    for (const receipt of receipts) {
      const row = elements.rowTemplate.content.firstElementChild.cloneNode(true);
      const image = row.querySelector(".thumb");
      const locationCell = row.querySelector('[data-col="location"]');
      const licenseCell = row.querySelector('[data-col="license"]');
      const dateCell = row.querySelector('[data-col="date"]');
      const timeCell = row.querySelector('[data-col="time"]');
      const amountCell = row.querySelector('[data-col="amount"]');
      const savedCell = row.querySelector('[data-col="saved"]');
      const editButton = row.querySelector(".edit-btn");
      const deleteButton = row.querySelector(".delete-btn");

      if (receipt.imageBlob instanceof Blob) {
        const thumbUrl = URL.createObjectURL(receipt.imageBlob);
        state.thumbUrls.push(thumbUrl);
        image.src = thumbUrl;
        image.style.cursor = "zoom-in";
        image.addEventListener("click", () => {
          if (state.openImageModal) {
            state.openImageModal(thumbUrl);
          }
        });
      }

      locationCell.textContent = receipt.locationName || "-";
      if (licenseCell) {
        licenseCell.textContent = receipt.licenseNumber || "-";
      }
      dateCell.textContent = receipt.purchaseDate || "-";
      timeCell.textContent = receipt.purchaseTime || "-";
      amountCell.textContent = `$${formatAmount(receipt.amountSpent)}`;
      savedCell.textContent = formatSavedDate(receipt.createdAt);

      if (editButton) {
        editButton.addEventListener("click", () => {
          onEditReceipt(receipt);
        });
      }

      if (deleteButton) {
        deleteButton.addEventListener("click", async () => {
          const confirmed = window.confirm("Delete this receipt record?");
          if (!confirmed) {
            return;
          }

          await deleteReceipt(receipt._storeKey ?? receipt.id);
          await loadReceipts();
        });
      }

      elements.receiptRows.appendChild(row);
    }
  }

  function onEditReceipt(receipt) {
    state.editingReceipt = {
      ...receipt,
      _storeKey: receipt._storeKey ?? receipt.id ?? null,
    };

    elements.locationInput.value = receipt.locationName || "";
    if (elements.licenseInput) {
      elements.licenseInput.value = receipt.licenseNumber || "";
    }
    elements.dateInput.value = receipt.purchaseDate || "";
    elements.timeInput.value = receipt.purchaseTime || "";
    elements.amountInput.value = formatAmount(receipt.amountSpent);
    elements.notesInput.value = receipt.notes || "";

    if (elements.saveReceiptBtn) {
      elements.saveReceiptBtn.textContent = "Update Receipt Record";
    }

    if (elements.cancelEditBtn) {
      elements.cancelEditBtn.hidden = false;
    }

    state.currentFile = null;
    state.lastOcrText = "";
    if (elements.receiptInput) {
      elements.receiptInput.value = "";
    }
    if (elements.previewWrap) {
      elements.previewWrap.hidden = true;
    }
    if (elements.receiptPreview) {
      elements.receiptPreview.removeAttribute("src");
    }
    clearPreviewUrl();

    setStatus("Editing receipt. Update fields and click Update Receipt Record.", "warn");
  }

  function onCancelEdit() {
    if (!state.editingReceipt) {
      return;
    }

    clearEditModeState();
    resetCaptureState();
    setStatus("Edit canceled.", "warn");
  }

  function clearEditModeState() {
    state.editingReceipt = null;
    if (elements.saveReceiptBtn) {
      elements.saveReceiptBtn.textContent = "Save Receipt Record";
    }
    if (elements.cancelEditBtn) {
      elements.cancelEditBtn.hidden = true;
    }
  }

  async function onUpdateReceiptFromForm() {
    const editingReceipt = state.editingReceipt;
    if (!editingReceipt) {
      setStatus("No receipt is currently being edited.", "warn");
      return;
    }

    const locationName = toTitleCase(elements.locationInput.value);
    if (locationName && elements.locationInput) {
      elements.locationInput.value = locationName;
    }
    const licenseNumber = elements.licenseInput ? elements.licenseInput.value.trim().slice(0, 40) : "";
    const purchaseDate = elements.dateInput.value;
    const purchaseTime = elements.timeInput.value;
    const amountFloat = Number.parseFloat(elements.amountInput.value);
    const notes = elements.notesInput.value.trim();

    if (!locationName || !purchaseDate || !Number.isFinite(amountFloat)) {
      setStatus("Location, date, and amount are required.", "error");
      return;
    }

    if (amountFloat < 0) {
      setStatus("Amount must be greater than or equal to 0.", "error");
      return;
    }

    try {
      const keyForUpdate = editingReceipt._storeKey ?? editingReceipt.id ?? null;
      const safeId = editingReceipt.id ?? createRecordId();

      const updatedRecord = {
        ...editingReceipt,
        id: safeId,
        locationName,
        licenseNumber,
        purchaseDate,
        purchaseTime: purchaseTime || "",
        amountSpent: amountFloat.toFixed(2),
        notes: notes.slice(0, 300),
        updatedAt: new Date().toISOString(),
      };

      // If the stored receipt has no physical address, try to resolve it from
      // the dispensary list via the license number so future history lookups work.
      if (!updatedRecord.physicalAddress && licenseNumber) {
        const resolvedAddress = await findAddressByLicense(licenseNumber);
        if (resolvedAddress) {
          updatedRecord.physicalAddress = resolvedAddress;
        }
      }

      const saveResult = await saveEditedReceipt(updatedRecord, keyForUpdate);

      try {
        const nameChanged = locationName !== (editingReceipt.locationName || "");
        const licenseChanged = licenseNumber !== (editingReceipt.licenseNumber || "");
        if ((nameChanged || licenseChanged) && updatedRecord.physicalAddress) {
          const matchCount = await countMatchingReceipts(updatedRecord);
          if (matchCount > 0) {
            const shouldUpdate = window.confirm(
              `Update ${matchCount} other receipt${matchCount === 1 ? "" : "s"} at this address to match these new details?`
            );
            if (shouldUpdate) {
              await updateMatchingReceipts(updatedRecord);
            }
          }
        }
      } catch (bulkError) {
        console.warn("Could not bulk-update matching receipts:", bulkError);
      }

      const receipts = await loadReceipts();
      const autoBackupResult = await tryWriteAutoFileBackup({ markBackupExported }, receipts);

      clearEditModeState();
      resetCaptureState();

      const warnings = [];
      if (saveResult.savedWithoutImage && saveResult.savedWithoutRawText) {
        warnings.push("Image and OCR text were removed due storage limits.");
      } else if (saveResult.savedWithoutImage) {
        warnings.push("Image was removed because browser storage is full.");
      } else if (saveResult.savedWithoutRawText) {
        warnings.push("OCR text was removed due storage limits.");
      }

      if (saveResult.oldDeleteFailed) {
        warnings.push("A duplicate row may remain; delete the older row manually.");
      }

      if (autoBackupResult === "failed") {
        warnings.push("Auto-backup file update failed.");
      }

      if (warnings.length > 0) {
        setStatus(`Receipt updated. ${warnings.join(" ")}`, "warn");
        return;
      }

      if (autoBackupResult === "written") {
        setStatus("Receipt updated and auto-backup file refreshed.", "success");
        return;
      }

      setStatus("Receipt updated.", "success");
    } catch (error) {
      console.error(error);
      const detailSuffix = getErrorDetailSuffix(error);
      setStatus(`${getEditErrorMessage(error)}${detailSuffix}`, "error");
    }
  }

  async function saveEditedReceipt(record, storeKey) {
    const attempts = [
      {
        nextRecord: record,
        savedWithoutImage: false,
        savedWithoutRawText: false,
      },
    ];

    if (record.imageBlob instanceof Blob) {
      attempts.push({
        nextRecord: {
          ...record,
          imageBlob: null,
          imageFileName: "",
        },
        savedWithoutImage: true,
        savedWithoutRawText: false,
      });
    }

    attempts.push({
      nextRecord: {
        ...record,
        imageBlob: null,
        imageFileName: "",
        rawText: "",
      },
      savedWithoutImage: true,
      savedWithoutRawText: true,
    });

    let lastError = null;

    for (const attempt of attempts) {
      try {
        await updateReceiptRecord(attempt.nextRecord, storeKey);
        return {
          savedWithoutImage: attempt.savedWithoutImage,
          savedWithoutRawText: attempt.savedWithoutRawText,
          oldDeleteFailed: false,
        };
      } catch (updateError) {
        lastError = updateError;
      }

      try {
        const replacementResult = await replaceReceiptRecord(attempt.nextRecord, storeKey);
        return {
          savedWithoutImage: attempt.savedWithoutImage,
          savedWithoutRawText: attempt.savedWithoutRawText,
          oldDeleteFailed: replacementResult.oldDeleteFailed,
        };
      } catch (replaceError) {
        lastError = replaceError;
      }
    }

    throw lastError || new Error("Failed to save receipt.");
  }

  async function replaceReceiptRecord(record, storeKey = null) {
    await addReceipt(record);

    if (storeKey === undefined || storeKey === null || storeKey === "") {
      return { oldDeleteFailed: false };
    }

    const sameKey = areStoreKeysEquivalent(storeKey, record.id);
    if (sameKey) {
      return { oldDeleteFailed: false };
    }

    try {
      await deleteReceipt(storeKey);
      return { oldDeleteFailed: false };
    } catch (error) {
      console.warn("Replacement save succeeded but old receipt could not be deleted:", error);
      return { oldDeleteFailed: true };
    }
  }

  function areStoreKeysEquivalent(left, right) {
    if (left === right) {
      return true;
    }

    if (left instanceof Date && right instanceof Date) {
      return left.getTime() === right.getTime();
    }

    if ((typeof left === "string" || typeof left === "number") && (typeof right === "string" || typeof right === "number")) {
      return String(left) === String(right);
    }

    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch (error) {
      return false;
    }
  }

  function formatAmount(amount) {
    const value = Number.parseFloat(String(amount));
    if (!Number.isFinite(value)) {
      return "0.00";
    }
    return value.toFixed(2);
  }

  function formatSavedDate(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return "-";
    }

    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  async function onClearAllReceipts() {
    try {
      const receipts = await getAllReceipts();
      if (receipts.length === 0) {
        setStatus("There are no receipts to clear.", "warn");
        return;
      }

      const confirmed = window.confirm(
        `Delete all ${receipts.length} saved receipt${receipts.length === 1 ? "" : "s"} from local storage? This cannot be undone.`
      );
      if (!confirmed) {
        return;
      }

      await clearAllReceiptsFromDb();
      await loadReceipts();
      setStatus(`Cleared ${receipts.length} receipts from local storage.`, "success");
    } catch (error) {
      console.error(error);
      setStatus(getClearAllErrorMessage(error), "error");
    }
  }

  function createRecordId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }

    return `r-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  }

  async function createThumbnailBlob(file, maxWidth, quality) {
    const image = await loadImage(file);

    const ratio = image.width > maxWidth ? maxWidth / image.width : 1;
    const targetWidth = Math.max(1, Math.round(image.width * ratio));
    const targetHeight = Math.max(1, Math.round(image.height * ratio));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    return new Promise((resolve) => {
      canvas.toBlob(
        (blob) => {
          resolve(blob || file);
        },
        "image/jpeg",
        quality
      );
    });
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();

      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };

      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not load image."));
      };

      image.src = url;
    });
  }

  function getPrimaryPhysicalAddressFromOcrText(text) {
    const candidates = extractAddressCandidatesFromText(text);
    if (candidates.length === 0) {
      return "";
    }

    const bestCandidate = candidates
      .slice()
      .sort((left, right) => {
        const leftHasZip = /\b\d{5}(?:-\d{4})?\b/.test(left.normalizedAddress) ? 1 : 0;
        const rightHasZip = /\b\d{5}(?:-\d{4})?\b/.test(right.normalizedAddress) ? 1 : 0;

        if (leftHasZip !== rightHasZip) {
          return rightHasZip - leftHasZip;
        }

        return right.normalizedAddress.length - left.normalizedAddress.length;
      })[0];

    return bestCandidate ? bestCandidate.normalizedAddress : "";
  }

  async function getDispensaryName(address) {
    const normalizedAddress = normalizeAddressForLookup(address);
    state.lastDispensaryLookupSource = "";

    if (!normalizedAddress) {
      state.lastDispensaryLookupSource = "manual";
      activateTrainingLookupState("");
      return null;
    }

    let fileMatch = null;
    try {
      fileMatch = await findDispensaryMatchFromOcrText(normalizedAddress);
    } catch (error) {
      console.warn("Could not lookup dispensary in list file:", error);
    }

    if (fileMatch && fileMatch.name) {
      clearTrainingLookupState(false);
      state.lastDispensaryLookupSource = "master";
      return fileMatch.name;
    }

    let mappedName = "";
    try {
      mappedName = await getUserMappedDispensaryName(normalizedAddress);
    } catch (error) {
      console.warn("Could not lookup dispensary in user mappings:", error);
    }

    if (mappedName) {
      clearTrainingLookupState(false);
      state.lastDispensaryLookupSource = "user_mappings";
      return mappedName;
    }

    state.lastDispensaryLookupSource = "manual";
    activateTrainingLookupState(normalizedAddress);
    return null;
  }

  function activateTrainingLookupState(physicalAddress) {
    const normalizedAddress = normalizeAddressForLookup(physicalAddress);
    state.pendingTrainingAddress = normalizedAddress;

    if (elements.receiptForm) {
      elements.receiptForm.dataset.trainingMode = "on";
    }

    if (elements.locationInput) {
      elements.locationInput.value = "";
      elements.locationInput.setAttribute("placeholder", "No match found. Enter dispensary name to train this address");
      elements.locationInput.dataset.trainingMode = "on";
      elements.locationInput.focus();
    }
  }

  function clearTrainingLookupState(clearAddress = false) {
    state.pendingTrainingAddress = "";
    state.lastDispensaryLookupSource = "";
    if (clearAddress) {
      state.lastDetectedPhysicalAddress = "";
    }

    if (elements.receiptForm) {
      delete elements.receiptForm.dataset.trainingMode;
    }

    if (elements.locationInput) {
      elements.locationInput.setAttribute("placeholder", state.defaultLocationPlaceholder || "Dispensary name");
      delete elements.locationInput.dataset.trainingMode;
    }
  }

  // Returns the canonical normalized address for a license number by searching
  // the loaded dispensary list. Returns "" if not found or list unavailable.
  async function findAddressByLicense(licenseNumber) {
    const normalized = String(licenseNumber || "").trim().toUpperCase();
    if (!normalized) {
      return "";
    }
    try {
      const entries = await ensureDispensaryLookupLoaded();
      const entry = entries.find(
        (e) => String(e.licenseNumber || "").trim().toUpperCase() === normalized
      );
      return entry ? entry.normalizedAddress : "";
    } catch {
      return "";
    }
  }

  async function maybePersistTrainingMapping(locationName) {
    const normalizedAddress = String(state.pendingTrainingAddress || "").trim();
    const dispensaryName = String(locationName || "").trim().slice(0, 120);

    if (!normalizedAddress || !dispensaryName) {
      return false;
    }

    await saveUserMapping(normalizedAddress, dispensaryName);
    return true;
  }

  async function ensureDispensaryLookupLoaded() {
    if (Array.isArray(state.dispensaryLookupEntries) && state.dispensaryLookupEntries.length > 0) {
      return state.dispensaryLookupEntries;
    }

    if (state.dispensaryLookupPromise) {
      return state.dispensaryLookupPromise;
    }

    state.dispensaryLookupPromise = (async () => {
      const candidatePaths = [DISPENSARY_LIST_PATH, DISPENSARY_LIST_FALLBACK_PATH];
      let lastError = null;

      for (const path of candidatePaths) {
        try {
          const url = new URL(path, document.baseURI).href;
          const response = await fetch(url, { cache: "no-cache" });
          if (!response.ok) {
            if (response.status === 404) {
              continue;
            }
            throw new Error(`Dispensary list request failed (${response.status}) for ${path}.`);
          }

          const payload = await response.json();
          const entries = buildDispensaryLookupEntries(payload);
          state.dispensaryLookupEntries = entries;
          state.dispensaryLookupPath = path;
          return entries;
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error("No dispensary list file could be loaded.");
    })();

    try {
      return await state.dispensaryLookupPromise;
    } finally {
      state.dispensaryLookupPromise = null;
    }
  }

  function buildDispensaryLookupEntries(payload) {
    if (!payload || typeof payload !== "object") {
      return [];
    }

    const entries = [];
    for (const [address, info] of Object.entries(payload)) {
      const normalizedAddress = normalizeAddressForLookup(address);
      if (!normalizedAddress) {
        continue;
      }

      const normalizedAddressNoZip = stripAddressZip(normalizedAddress);
      entries.push({
        address,
        normalizedAddress,
        normalizedAddressNoZip,
        firstNumber: extractLeadingAddressNumber(normalizedAddress),
        tokens: tokenizeAddress(normalizedAddressNoZip),
        name: String(info && info.name ? info.name : "").trim(),
        licenseNumber: String(info && info.license ? info.license : "").trim(),
      });
    }

    return entries;
  }

  async function findDispensaryMatchFromOcrText(text) {
    const lookupEntries = await ensureDispensaryLookupLoaded();
    if (!Array.isArray(lookupEntries) || lookupEntries.length === 0) {
      return null;
    }

    const candidates = extractAddressCandidatesFromText(text);
    if (candidates.length === 0) {
      return null;
    }

    let bestMatch = null;

    for (const candidate of candidates) {
      let pool = lookupEntries;
      if (candidate.firstNumber) {
        const narrowed = lookupEntries.filter((entry) => entry.firstNumber === candidate.firstNumber);
        if (narrowed.length > 0) {
          pool = narrowed;
        }
      }

      for (const entry of pool) {
        const score = scoreAddressCandidate(candidate, entry);
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = {
            score,
            candidate,
            entry,
          };
        }
      }
    }

    if (!bestMatch || bestMatch.score < DISPENSARY_MATCH_THRESHOLD) {
      return null;
    }

    return {
      name: bestMatch.entry.name,
      licenseNumber: bestMatch.entry.licenseNumber,
      score: bestMatch.score,
      matchedAddress: bestMatch.entry.address,
      matchedCandidate: bestMatch.candidate.raw,
    };
  }

  function extractAddressCandidatesFromText(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const candidates = [];
    const seen = new Set();

    const addCandidate = (rawValue) => {
      const normalizedAddress = normalizeAddressForLookup(rawValue);
      if (!normalizedAddress || seen.has(normalizedAddress)) {
        return;
      }

      if (!looksLikeOregonAddress(normalizedAddress)) {
        return;
      }

      const normalizedAddressNoZip = stripAddressZip(normalizedAddress);
      candidates.push({
        raw: rawValue,
        normalizedAddress,
        normalizedAddressNoZip,
        firstNumber: extractLeadingAddressNumber(normalizedAddress),
        tokens: tokenizeAddress(normalizedAddressNoZip),
      });
      seen.add(normalizedAddress);
    };

    for (let index = 0; index < lines.length; index += 1) {
      addCandidate(lines[index]);

      if (index + 1 < lines.length) {
        addCandidate(`${lines[index]} ${lines[index + 1]}`);
      }

      if (index + 2 < lines.length) {
        addCandidate(`${lines[index]} ${lines[index + 1]} ${lines[index + 2]}`);
      }
    }

    if (candidates.length === 0 && lines.length > 0) {
      addCandidate(lines.join(" "));
    }

    return candidates;
  }

  function looksLikeOregonAddress(value) {
    const hasState = /\bOR\b/.test(value);
    const hasStreetNumber = /\b\d{1,6}[A-Z]?\b/.test(value);
    const hasStreetType = /\b(ST|AVE|BLVD|RD|DR|LN|HWY|PL|CT|PKWY|TER|WAY)\b/.test(value);
    const hasZip = /\b\d{5}(?:-\d{4})?\b/.test(value);
    return hasState && hasStreetNumber && (hasStreetType || hasZip);
  }

  function normalizeAddressForLookup(value) {
    let text = String(value || "").toUpperCase();
    if (!text) {
      return "";
    }

    text = text.replace(/[|]/g, "I");
    text = text.replace(/[#]/g, " STE ");
    text = text.replace(/\b0R\b/g, "OR");
    text = text.replace(/[^A-Z0-9\s-]/g, " ");

    const replacements = [
      [/\bOREGON\b/g, "OR"],
      [/\bNORTHWEST\b/g, "NW"],
      [/\bNORTHEAST\b/g, "NE"],
      [/\bSOUTHWEST\b/g, "SW"],
      [/\bSOUTHEAST\b/g, "SE"],
      [/\bNORTH\b/g, "N"],
      [/\bSOUTH\b/g, "S"],
      [/\bEAST\b/g, "E"],
      [/\bWEST\b/g, "W"],
      [/\bSTREET\b/g, "ST"],
      [/\bSTRT\b/g, "ST"],
      [/\bSTR\b/g, "ST"],
      [/\bAVENUE\b/g, "AVE"],
      [/\bBOULEVARD\b/g, "BLVD"],
      [/\bHIGHWAY\b/g, "HWY"],
      [/\bROAD\b/g, "RD"],
      [/\bDRIVE\b/g, "DR"],
      [/\bLANE\b/g, "LN"],
      [/\bPLACE\b/g, "PL"],
      [/\bCOURT\b/g, "CT"],
      [/\bTERRACE\b/g, "TER"],
      [/\bPARKWAY\b/g, "PKWY"],
      [/\bSUITE\b/g, "STE"],
      [/\bAPARTMENT\b/g, "APT"],
    ];

    for (const [pattern, replacement] of replacements) {
      text = text.replace(pattern, replacement);
    }

    text = text.replace(/\s+/g, " ").trim();
    return text;
  }

  function stripAddressZip(value) {
    return String(value || "")
      .replace(/\b\d{5}(?:-\d{4})?\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractLeadingAddressNumber(value) {
    const match = String(value || "").match(/\b\d{1,6}[A-Z]?\b/);
    return match ? match[0] : "";
  }

  function tokenizeAddress(value) {
    return String(value || "")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2);
  }

  function scoreAddressCandidate(candidate, entry) {
    const withZip = stringSimilarity(candidate.normalizedAddress, entry.normalizedAddress);
    const withoutZip = stringSimilarity(candidate.normalizedAddressNoZip, entry.normalizedAddressNoZip);
    const textScore = Math.max(withZip, withoutZip);
    const tokenScore = tokenSetSimilarity(candidate.tokens, entry.tokens);

    let score = (textScore * 0.72) + (tokenScore * 0.28);

    if (candidate.firstNumber && entry.firstNumber && candidate.firstNumber !== entry.firstNumber) {
      score -= 0.08;
    }

    if (
      candidate.normalizedAddressNoZip &&
      entry.normalizedAddressNoZip &&
      (candidate.normalizedAddressNoZip.includes(entry.normalizedAddressNoZip) ||
        entry.normalizedAddressNoZip.includes(candidate.normalizedAddressNoZip))
    ) {
      score = Math.max(score, (textScore * 0.8) + (tokenScore * 0.2));
    }

    if (candidate.normalizedAddress === entry.normalizedAddress) {
      score = 1;
    }

    return Math.max(0, Math.min(1, score));
  }

  function tokenSetSimilarity(leftTokens, rightTokens) {
    const left = new Set(Array.isArray(leftTokens) ? leftTokens : []);
    const right = new Set(Array.isArray(rightTokens) ? rightTokens : []);

    if (left.size === 0 || right.size === 0) {
      return 0;
    }

    let intersection = 0;
    for (const token of left) {
      if (right.has(token)) {
        intersection += 1;
      }
    }

    const union = left.size + right.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  function stringSimilarity(left, right) {
    const a = String(left || "");
    const b = String(right || "");
    if (!a || !b) {
      return 0;
    }

    if (a === b) {
      return 1;
    }

    const distance = levenshteinDistance(a, b);
    const maxLen = Math.max(a.length, b.length);
    return maxLen > 0 ? 1 - (distance / maxLen) : 0;
  }

  function levenshteinDistance(left, right) {
    const a = String(left || "");
    const b = String(right || "");
    const aLen = a.length;
    const bLen = b.length;

    if (aLen === 0) {
      return bLen;
    }

    if (bLen === 0) {
      return aLen;
    }

    const previous = new Array(bLen + 1);
    const current = new Array(bLen + 1);

    for (let j = 0; j <= bLen; j += 1) {
      previous[j] = j;
    }

    for (let i = 1; i <= aLen; i += 1) {
      current[0] = i;
      const aChar = a.charCodeAt(i - 1);

      for (let j = 1; j <= bLen; j += 1) {
        const bChar = b.charCodeAt(j - 1);
        const cost = aChar === bChar ? 0 : 1;

        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + cost
        );
      }

      for (let j = 0; j <= bLen; j += 1) {
        previous[j] = current[j];
      }
    }

    return previous[bLen];
  }

  function attachInstallHandlers() {
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      state.installPrompt = event;
      if (elements.installBtn) {
        elements.installBtn.hidden = false;
      }
    });

    window.addEventListener("appinstalled", () => {
      state.installPrompt = null;
      if (elements.installBtn) {
        elements.installBtn.hidden = true;
      }
      setStatus("App installed successfully.", "success");
    });

    if (elements.installBtn) {
      elements.installBtn.addEventListener("click", async () => {
        if (!state.installPrompt) {
          setStatus("Install is unavailable in this browser right now.", "warn");
          return;
        }

        await state.installPrompt.prompt();
        await state.installPrompt.userChoice;
        state.installPrompt = null;
        elements.installBtn.hidden = true;
      });
    }
  }

  function applySavedTheme() {
    const savedTheme = localStorage.getItem(THEME_KEY) || "dark";
    applyTheme(savedTheme);
    if (elements.themeSwitch) {
      elements.themeSwitch.checked = savedTheme === "light";
    }
  }

  function applySavedDensity() {
    const savedDensity = localStorage.getItem(DENSITY_KEY) || "roomy";
    applyDensity(savedDensity);
    if (elements.compactSwitch) {
      elements.compactSwitch.checked = savedDensity === "compact";
    }
  }

  function applyBackupReminderPreference() {
    const savedSetting = localStorage.getItem(BACKUP_REMINDER_KEY);
    const reminderEnabled = savedSetting === null ? true : savedSetting === "1";
    if (elements.backupReminderSwitch) {
      elements.backupReminderSwitch.checked = reminderEnabled;
    }
  }

  function applyAutoBackupPromptPreference() {
    const savedSetting = localStorage.getItem(AUTO_BACKUP_PROMPT_KEY);
    const promptEnabled = savedSetting === null ? true : savedSetting === "1";
    if (elements.autoBackupPromptSwitch) {
      elements.autoBackupPromptSwitch.checked = promptEnabled;
    }
  }

  function shouldPromptBackupAfterSave() {
    return Boolean(elements.autoBackupPromptSwitch && elements.autoBackupPromptSwitch.checked);
  }

  function shouldShowBackupReminder(receiptCount) {
    if (!elements.backupReminderSwitch || !elements.backupReminderSwitch.checked || receiptCount === 0) {
      return false;
    }

    const lastBackupRaw = localStorage.getItem(LAST_BACKUP_KEY);
    if (!lastBackupRaw) {
      return true;
    }

    const lastBackupDate = new Date(lastBackupRaw);
    if (Number.isNaN(lastBackupDate.getTime())) {
      return true;
    }

    const elapsedMs = Date.now() - lastBackupDate.getTime();
    const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
    return elapsedDays >= REMINDER_DAYS;
  }

  function markBackupExported() {
    localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
  }

  async function ensureStorageProtection() {
    if (!navigator.storage || typeof navigator.storage.persist !== "function") {
      return; // Silently skip if not supported
    }

    try {
      const alreadyPersistent = typeof navigator.storage.persisted === "function"
        ? await navigator.storage.persisted()
        : false;

      if (!alreadyPersistent) {
        // Try to get permission silently
        await navigator.storage.persist();
      }
    } catch (error) {
      // Silently fail - user can manually request it later
      console.warn('Could not ensure storage protection:', error);
    }
  }

  async function requestPersistentStorage() {
    if (!navigator.storage || typeof navigator.storage.persist !== "function") {
      setStatus("Storage protection request is not supported here. Keep exporting backup ZIP files.", "warn");
      return;
    }

    try {
      const alreadyPersistent = typeof navigator.storage.persisted === "function"
        ? await navigator.storage.persisted()
        : false;

      if (alreadyPersistent) {
        setStatus("Storage protection is already enabled for this app.", "success");
        return;
      }

      const granted = await navigator.storage.persist();
      if (granted) {
        setStatus("Storage protection enabled. Browser is less likely to clear your saved data.", "success");
      } else {
        const backupHandle = await getAppSetting(DEVICE_BACKUP_HANDLE_KEY);
        const hasAutoBackupFile = Boolean(backupHandle && typeof backupHandle.createWritable === "function");

        if (hasAutoBackupFile) {
          setStatus("Storage protection was not granted. Auto-backup file is active and will keep updating on each save.", "warn");
          return;
        }

        if (typeof window.showSaveFilePicker === "function") {
          const shouldEnableAutoBackup = window.confirm(
            "Storage protection couldn't be enabled. Enable Auto-Backup File now so each save is copied to a ZIP on your device?"
          );
          if (shouldEnableAutoBackup) {
            await onChooseAutoBackupFile({ setStatus, markBackupExported });
            return;
          }
        }

        setStatus("Storage protection was not granted. Keep saving backup ZIP files to your device.", "warn");
        const shouldExportNow = window.confirm(
          "Storage protection couldn't be enabled. Would you like to create a backup ZIP now to protect your data?"
        );
        if (shouldExportNow) {
          await onExportZip({ setStatus, markBackupExported });
        }
      }
    } catch (error) {
      console.error(error);
      setStatus("Could not request storage protection right now.", "error");
    }
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const themeColor = theme === "light" ? "#e9f1ee" : "#0f1418";
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      themeMeta.setAttribute("content", themeColor);
    }
  }

  function applyDensity(density) {
    document.documentElement.dataset.density = density === "compact" ? "compact" : "roomy";
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((error) => {
        console.error("Service worker registration failed", error);
      });
    });
  }
})();
