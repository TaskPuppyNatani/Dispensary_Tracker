import {
  AUTO_BACKUP_PROMPT_KEY,
  BACKUP_REMINDER_KEY,
  DENSITY_KEY,
  DEVICE_BACKUP_HANDLE_KEY,
  DISPENSARY_LIST_FALLBACK_PATH,
  DISPENSARY_LIST_PATH,
  DISPENSARY_MATCH_THRESHOLD,
  LAST_BACKUP_KEY,
  RECEIPT_INTELLIGENCE_ENABLED_DEFAULT,
  RECEIPT_INTELLIGENCE_ENABLED_KEY,
  RECEIPT_INTELLIGENCE_LOW_CONFIDENCE_THRESHOLD,
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
import { extractPhoneFromText, parseTextForStore } from "./matcher.js";
import { ReceiptIntelligenceService } from "./services/ReceiptIntelligenceService.js";
import { buildReceiptReviewModel } from "./services/ReceiptReviewModelBuilder.js";
import { NullProvider } from "./services/providers/NullProvider.js";
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

  const receiptIntelligenceService = new ReceiptIntelligenceService({
    provider: new NullProvider(),
    featureEnabled: RECEIPT_INTELLIGENCE_ENABLED_DEFAULT,
    lowConfidenceThreshold: RECEIPT_INTELLIGENCE_LOW_CONFIDENCE_THRESHOLD,
  });

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
    updateLocalAIReviewControls();
    refreshLocalAIReviewAvailability().catch((error) => {
      console.warn("Could not check Local AI review availability:", error);
      state.localAIReviewAvailable = false;
      state.localAIReviewStatus = {
        available: false,
        reason: error && error.message ? error.message : String(error),
      };
      updateLocalAIReviewControls("Local AI unavailable");
    });
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

    // ── Search / sort / group bindings ─────────────────────────────────
    if (elements.receiptSearch) {
      elements.receiptSearch.addEventListener("input", () => {
        state.receiptSearchQuery = elements.receiptSearch.value;
        if (elements.receiptSearchClear) {
          elements.receiptSearchClear.hidden = !state.receiptSearchQuery;
        }
        renderReceipts(state.receiptsCache);
      });
    }

    if (elements.receiptSearchClear) {
      elements.receiptSearchClear.addEventListener("click", () => {
        state.receiptSearchQuery = "";
        if (elements.receiptSearch) {
          elements.receiptSearch.value = "";
        }
        elements.receiptSearchClear.hidden = true;
        renderReceipts(state.receiptsCache);
      });
    }

    if (elements.receiptSort) {
      elements.receiptSort.addEventListener("change", () => {
        state.receiptSortKey = elements.receiptSort.value;
        renderReceipts(state.receiptsCache);
      });
    }

    if (elements.receiptGroupByName) {
      elements.receiptGroupByName.addEventListener("change", () => {
        state.receiptGroupByName = elements.receiptGroupByName.checked;
        renderReceipts(state.receiptsCache);
      });
    }

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

    if (elements.manualModeBtn) {
      elements.manualModeBtn.addEventListener("click", () => {
        state.isManualMode = !state.isManualMode;
        const active = state.isManualMode;

        if (elements.scannerWrap) {
          elements.scannerWrap.hidden = active;
        }
        if (elements.manualInputWrap) {
          elements.manualInputWrap.hidden = !active;
        }
        elements.manualModeBtn.textContent = active ? "Scan Mode" : "Manual Entry";
        if (elements.scanBtn) {
          elements.scanBtn.textContent = active ? "Process Text" : "Scan Receipt";
        }

        if (active) {
          setStatus("Manual mode: paste address text and press Process Text.", "info");
          if (elements.manualTextInput) {
            elements.manualTextInput.focus();
          }
        } else {
          setStatus("Waiting for image...");
        }
      });
    }

    if (elements.scanBtn) {
      elements.scanBtn.addEventListener("click", async () => {
        if (state.isManualMode) {
          await onProcessManualText();
          return;
        }

        const scanTrace = {
          traceId: createTraceId(),
          timestamp: new Date().toISOString(),
          scanMode: "scan",
          rawOcrTextAvailable: false,
          detectedPhysicalAddress: "",
          lookupSource: "",
          ocrConfidence: null,
          ocrInitial: null,
          postAnchor: null,
          postHistory: null,
          finalRendered: null,
        };
        logTraceStage("trace_created", scanTrace, null);

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

        scanTrace.detectedPhysicalAddress = String(state.lastDetectedPhysicalAddress || "");
        scanTrace.lookupSource = String(state.lastDispensaryLookupSource || "");
        scanTrace.rawOcrTextAvailable = String(state.lastOcrText || "").trim().length > 0;
        scanTrace.ocrInitial = readCurrentScanSnapshot();
        scanTrace.ocrConfidence = scanTrace.ocrInitial && Number.isFinite(scanTrace.ocrInitial.confidence)
          ? scanTrace.ocrInitial.confidence
          : null;
        logTraceStage("ocr_initial", scanTrace, scanTrace.ocrInitial);

        // --- STORE ANCHORS ---
        // Hard-coded overrides for stores whose OCR text is reliably identifiable
        // but whose address/name may still be mis-read. Runs before any fuzzy
        // matching so these stores are always filled in correctly.
        const ocrText = String(state.lastOcrText || "").toUpperCase();
        const ocrMatchScore = Number.parseFloat(elements.matchConfidence?.dataset.score || "");
        const hasResolvedLocation = Boolean(scanTrace.ocrInitial && String(scanTrace.ocrInitial.location || "").trim());
        const shouldRunStoreAnchors = !hasResolvedLocation && (!Number.isFinite(ocrMatchScore) || ocrMatchScore < 0.50);
        const STORE_ANCHORS = [
          {
            test: (t) => t.includes("LA MOTA") || t.includes("1670315") || t.includes("1670316"),
            locationName: "La Mota",
            licenseNumber: "050-10007012B21",
          },
        ];
        if (shouldRunStoreAnchors) {
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
        }
        scanTrace.postAnchor = readCurrentScanSnapshot();
        logTraceStage("post_anchor", scanTrace, scanTrace.postAnchor);
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

        scanTrace.postHistory = readCurrentScanSnapshot();
        logTraceStage("post_history", scanTrace, scanTrace.postHistory);
        scanTrace.detectedPhysicalAddress = String(state.lastDetectedPhysicalAddress || "");
        scanTrace.lookupSource = String(state.lastDispensaryLookupSource || "");
        scanTrace.finalRendered = readCurrentScanSnapshot();
        logTraceStage("final_rendered", scanTrace, scanTrace.finalRendered);
        state.lastReceiptDecisionTrace = scanTrace;

        const receiptIntelligenceEnabled = isReceiptIntelligenceEnabled();
        const intelligenceResult = await receiptIntelligenceService.analyze(scanTrace, {
          featureEnabled: receiptIntelligenceEnabled,
          confidence: scanTrace.ocrConfidence,
        });
        state.lastReceiptIntelligenceResult = intelligenceResult;
        state.receiptReviewModel = buildReceiptReviewModel({
          ...intelligenceResult,
          trace: scanTrace,
        });
        renderReceiptReviewModel(state.receiptReviewModel);
        await refreshLocalAIReviewAvailability();
        console.info("receipt_intelligence.result", {
          traceId: scanTrace.traceId,
          enabled: receiptIntelligenceEnabled,
          status: intelligenceResult.status,
          reason: intelligenceResult.reason,
          eligible: intelligenceResult.eligible,
        });

        console.debug("receipt_intelligence.trace_captured", {
          traceId: scanTrace.traceId,
          stage: "all",
          scanMode: scanTrace.scanMode,
          rawOcrTextAvailable: scanTrace.rawOcrTextAvailable,
        });

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

    if (elements.localAIReviewBtn) {
      elements.localAIReviewBtn.addEventListener("click", onRunLocalAIReview);
    }

    if (elements.applyAISuggestionsBtn) {
      elements.applyAISuggestionsBtn.addEventListener("click", onApplyAISuggestions);
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
    state.lastReceiptDecisionTrace = null;
    state.lastReceiptIntelligenceResult = null;
    clearReceiptReviewModel();

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

  function createTraceId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `trace-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  }

  function isReceiptIntelligenceEnabled() {
    const raw = localStorage.getItem(RECEIPT_INTELLIGENCE_ENABLED_KEY);
    if (raw === null) {
      return RECEIPT_INTELLIGENCE_ENABLED_DEFAULT;
    }
    return raw === "1" || raw.toLowerCase() === "true";
  }

  function readCurrentScanSnapshot() {
    const confidenceValue = Number.parseFloat(elements.matchConfidence?.dataset.score || "");
    return {
      location: elements.locationInput ? elements.locationInput.value.trim() : "",
      license: elements.licenseInput ? elements.licenseInput.value.trim() : "",
      date: elements.dateInput ? elements.dateInput.value.trim() : "",
      time: elements.timeInput ? elements.timeInput.value.trim() : "",
      amount: elements.amountInput ? elements.amountInput.value.trim() : "",
      confidence: Number.isFinite(confidenceValue) ? confidenceValue : null,
    };
  }

  function logTraceStage(stage, trace, snapshot = null) {
    if (!trace || typeof trace !== "object") {
      return;
    }

    const payload = {
      traceId: String(trace.traceId || ""),
      stage,
      scanMode: String(trace.scanMode || "scan"),
      rawOcrTextAvailable: Boolean(trace.rawOcrTextAvailable),
      confidence: snapshot && Object.prototype.hasOwnProperty.call(snapshot, "confidence") ? snapshot.confidence : null,
      location: snapshot && Object.prototype.hasOwnProperty.call(snapshot, "location") ? snapshot.location : "",
      license: snapshot && Object.prototype.hasOwnProperty.call(snapshot, "license") ? snapshot.license : "",
      lookupSource: String(trace.lookupSource || ""),
      detectedPhysicalAddress: String(trace.detectedPhysicalAddress || ""),
    };

    console.info("receipt_intelligence.trace_captured", payload);
  }

  function clearReceiptReviewModel() {
    state.receiptReviewModel = null;
    renderReceiptReviewModel(null);
    updateLocalAIReviewControls();
  }

  function renderReceiptReviewModel(reviewModel = state.receiptReviewModel) {
    if (!elements.receiptReviewPanel || !elements.receiptReviewFields) {
      return;
    }

    clearElement(elements.receiptReviewFields);
    renderReviewSection(elements.receiptReviewProducts, "", null);
    renderReviewSection(elements.receiptReviewDiscounts, "", null);
    renderReviewSection(elements.receiptReviewLoyalty, "", null);
    renderReviewDebug(null);

    if (!reviewModel || typeof reviewModel !== "object") {
      elements.receiptReviewPanel.hidden = true;
      return;
    }

    const fields = reviewModel.fields && typeof reviewModel.fields === "object"
      ? reviewModel.fields
      : {};
    const fieldRows = [
      ["dispensary", "Dispensary"],
      ["licenseNumber", "License"],
      ["receiptNumber", "Receipt #"],
      ["purchaseDate", "Date"],
      ["purchaseTime", "Time"],
      ["subtotal", "Subtotal"],
      ["tax", "Tax"],
      ["total", "Total"],
      ["paymentMethod", "Payment"],
      ["budtender", "Budtender"],
    ];

    for (const [key, label] of fieldRows) {
      elements.receiptReviewFields.appendChild(createReviewFieldRow(label, fields[key]));
    }

    renderReviewSection(elements.receiptReviewProducts, "Products", reviewModel.products);
    renderReviewSection(elements.receiptReviewDiscounts, "Discounts", reviewModel.discounts);
    renderReviewSection(elements.receiptReviewLoyalty, "Loyalty", reviewModel.loyalty);
    renderReviewDebug(reviewModel);
    elements.receiptReviewPanel.hidden = false;
    updateLocalAIReviewControls();
  }

  function createReviewFieldRow(label, field) {
    const normalizedField = field && typeof field === "object" ? field : {};
    const current = normalizedField.current;
    const suggestion = normalizedField.suggestion;
    const status = getReviewFieldStatus(normalizedField);
    const row = document.createElement("div");
    row.className = `receipt-review-row is-${status}`;

    const labelEl = document.createElement("div");
    labelEl.className = "receipt-review-label";
    labelEl.textContent = label;

    const currentEl = document.createElement("div");
    currentEl.className = "receipt-review-value";
    const currentCaption = document.createElement("span");
    currentCaption.textContent = "Current";
    const currentText = document.createElement("strong");
    currentText.textContent = formatReviewValue(current);
    currentEl.append(currentCaption, currentText);

    const suggestionEl = document.createElement("div");
    suggestionEl.className = "receipt-review-value";
    const suggestionCaption = document.createElement("span");
    suggestionCaption.textContent = "AI";
    const suggestionText = document.createElement("strong");
    suggestionText.textContent = formatReviewValue(suggestion);
    suggestionEl.append(suggestionCaption, suggestionText);

    const statusEl = document.createElement("span");
    statusEl.className = `receipt-review-status is-${status}`;
    statusEl.textContent = status;

    row.append(labelEl, currentEl, suggestionEl, statusEl);
    return row;
  }

  function getReviewFieldStatus(field) {
    const currentPresent = hasReviewValue(field.current);
    const suggestionPresent = hasReviewValue(field.suggestion);

    if (!suggestionPresent) {
      return "unavailable";
    }

    if (!currentPresent) {
      return "suggested";
    }

    return field.changed ? "different" : "same";
  }

  function renderReviewSection(container, title, value) {
    if (!container) {
      return;
    }

    clearElement(container);

    const hasContent = Array.isArray(value)
      ? value.length > 0
      : value !== null && value !== undefined && value !== "";

    if (!hasContent) {
      container.hidden = true;
      return;
    }

    const heading = document.createElement("h4");
    heading.textContent = title;
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(value, null, 2);
    container.append(heading, pre);
    container.hidden = false;
  }

  function renderReviewDebug(reviewModel) {
    if (!elements.receiptReviewDebug || !elements.receiptReviewDebugText) {
      return;
    }

    elements.receiptReviewDebugText.textContent = "";
    elements.receiptReviewDebug.hidden = true;

    if (!reviewModel || typeof reviewModel !== "object") {
      return;
    }

    const advisory = reviewModel.advisory && typeof reviewModel.advisory === "object"
      ? reviewModel.advisory
      : null;
    const debugPayload = {
      text: advisory ? advisory.text : null,
      pipeline: advisory ? advisory.pipeline : null,
      metadata: advisory ? advisory.metadata : null,
    };
    const hasDebugContent = Object.values(debugPayload).some((value) => value !== null && value !== undefined);

    if (!hasDebugContent) {
      return;
    }

    elements.receiptReviewDebugText.textContent = JSON.stringify(debugPayload, null, 2);
    elements.receiptReviewDebug.hidden = false;
  }

  function clearElement(element) {
    if (!element) {
      return;
    }

    element.textContent = "";
  }

  function formatReviewValue(value) {
    return hasReviewValue(value) ? String(value) : "-";
  }

  function hasReviewValue(value) {
    return value !== null && value !== undefined && String(value).trim() !== "";
  }

  function hasLocalAIReviewBridge() {
    return !!(
      window.localAI
      && typeof window.localAI.getReceiptReviewStatus === "function"
      && typeof window.localAI.analyzeReceipt === "function"
    );
  }

  async function refreshLocalAIReviewAvailability() {
    if (!hasLocalAIReviewBridge()) {
      state.localAIReviewAvailable = false;
      state.localAIReviewStatus = {
        available: false,
        reason: "Local AI bridge unavailable",
      };
      updateLocalAIReviewControls("Local AI unavailable");
      return state.localAIReviewStatus;
    }

    try {
      const status = await window.localAI.getReceiptReviewStatus();
      state.localAIReviewStatus = status && typeof status === "object"
        ? status
        : { available: false, reason: "Local AI status unavailable" };
      state.localAIReviewAvailable = Boolean(state.localAIReviewStatus.available);
    } catch (error) {
      state.localAIReviewAvailable = false;
      state.localAIReviewStatus = {
        available: false,
        reason: error && error.message ? error.message : String(error),
      };
    }

    updateLocalAIReviewControls();
    return state.localAIReviewStatus;
  }

  function updateLocalAIReviewControls(message = "") {
    if (!elements.localAIReviewBtn && !elements.applyAISuggestionsBtn && !elements.localAIReviewStatus) {
      return;
    }

    const hasProcessedReceipt = !!(state.lastReceiptDecisionTrace && state.receiptReviewModel);
    const hasImage = !!state.currentFile;
    const bridgeAvailable = hasLocalAIReviewBridge();
    const localAIAvailable = bridgeAvailable && Boolean(state.localAIReviewAvailable);
    const running = Boolean(state.localAIReviewRunning);
    const disabled = running || !hasProcessedReceipt || !hasImage || !localAIAvailable;

    if (elements.localAIReviewBtn) {
      elements.localAIReviewBtn.disabled = disabled;
    }

    if (elements.applyAISuggestionsBtn) {
      elements.applyAISuggestionsBtn.disabled = !hasApplicableAISuggestions(state.receiptReviewModel);
    }

    if (!elements.localAIReviewStatus) {
      return;
    }

    if (message) {
      elements.localAIReviewStatus.textContent = message;
      return;
    }

    if (running) {
      elements.localAIReviewStatus.textContent = "Running Local AI review...";
      return;
    }

    if (!hasProcessedReceipt) {
      elements.localAIReviewStatus.textContent = "Scan receipt first";
      return;
    }

    if (!hasImage) {
      elements.localAIReviewStatus.textContent = "Receipt image required";
      return;
    }

    if (!bridgeAvailable || !localAIAvailable) {
      elements.localAIReviewStatus.textContent = "Local AI unavailable";
      return;
    }

    elements.localAIReviewStatus.textContent = "Local AI ready";
  }

  function hasApplicableAISuggestions(reviewModel = state.receiptReviewModel) {
    const receipt = getMappedAIReceipt(reviewModel);
    if (!receipt) {
      return false;
    }

    return Boolean(
      (elements.locationInput && hasReviewValue(receipt.dispensary))
      || (elements.licenseInput && hasReviewValue(receipt.licenseNumber))
      || (elements.dateInput && normalizeDateInputValue(receipt.purchaseDate))
      || (elements.timeInput && normalizeTimeInputValue(receipt.purchaseTime))
      || (elements.amountInput && normalizeAmountInputValue(receipt.total))
    );
  }

  function getMappedAIReceipt(reviewModel = state.receiptReviewModel) {
    const advisory = reviewModel && typeof reviewModel === "object" && reviewModel.advisory && typeof reviewModel.advisory === "object"
      ? reviewModel.advisory
      : null;
    const receipt = advisory && advisory.receipt && typeof advisory.receipt === "object" && !Array.isArray(advisory.receipt)
      ? advisory.receipt
      : null;

    return receipt;
  }

  function onApplyAISuggestions() {
    const receipt = getMappedAIReceipt();
    if (!receipt) {
      setStatus("No mapped AI receipt is available to apply.", "warn");
      updateLocalAIReviewControls();
      return;
    }

    const applied = [];
    const skipped = [];

    applyTextSuggestion({
      input: elements.locationInput,
      label: "dispensary",
      value: receipt.dispensary,
      applied,
    });
    applyTextSuggestion({
      input: elements.licenseInput,
      label: "license",
      value: receipt.licenseNumber,
      applied,
    });
    applyNormalizedSuggestion({
      input: elements.dateInput,
      label: "date",
      value: receipt.purchaseDate,
      normalize: normalizeDateInputValue,
      applied,
      skipped,
    });
    applyNormalizedSuggestion({
      input: elements.timeInput,
      label: "time",
      value: receipt.purchaseTime,
      normalize: normalizeTimeInputValue,
      applied,
      skipped,
    });
    applyNormalizedSuggestion({
      input: elements.amountInput,
      label: "amount",
      value: receipt.total,
      normalize: normalizeAmountInputValue,
      applied,
      skipped,
    });

    updateLocalAIReviewControls();

    if (applied.length === 0) {
      const skippedSuffix = skipped.length > 0 ? ` Skipped ${skipped.join(", ")}.` : "";
      setStatus(`No editable AI suggestions were applied.${skippedSuffix}`, "warn");
      return;
    }

    const skippedSuffix = skipped.length > 0 ? ` Skipped ${skipped.join(", ")}.` : "";
    setStatus(
      `Applied ${applied.length} AI suggestion${applied.length === 1 ? "" : "s"}: ${applied.join(", ")}. Review before saving.${skippedSuffix}`,
      "success"
    );
  }

  function applyTextSuggestion({ input, label, value, applied }) {
    if (!input || !hasReviewValue(value)) {
      return;
    }

    input.value = String(value).trim();
    applied.push(label);
  }

  function applyNormalizedSuggestion({ input, label, value, normalize, applied, skipped }) {
    if (!input || !hasReviewValue(value)) {
      return;
    }

    const normalized = normalize(value);
    if (!normalized) {
      skipped.push(label);
      return;
    }

    input.value = normalized;
    applied.push(label);
  }

  function normalizeDateInputValue(value) {
    if (!hasReviewValue(value)) {
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

    return "";
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

  function normalizeTimeInputValue(value) {
    if (!hasReviewValue(value)) {
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

  function isValidTimeParts(hour, minute) {
    return Number.isSafeInteger(hour)
      && Number.isSafeInteger(minute)
      && hour >= 0
      && hour <= 23
      && minute >= 0
      && minute <= 59;
  }

  function normalizeAmountInputValue(value) {
    if (!hasReviewValue(value)) {
      return "";
    }

    const normalized = Number.parseFloat(String(value).replace(/[$,]/g, "").trim());
    return Number.isFinite(normalized) && normalized >= 0
      ? normalized.toFixed(2)
      : "";
  }

  async function onRunLocalAIReview() {
    if (state.localAIReviewRunning) {
      return;
    }

    if (!state.lastReceiptDecisionTrace || !state.currentFile) {
      updateLocalAIReviewControls();
      return;
    }

    state.localAIReviewRunning = true;
    updateLocalAIReviewControls("Checking Local AI availability...");

    try {
      const status = await refreshLocalAIReviewAvailability();
      if (!status || !status.available) {
        updateLocalAIReviewControls("Local AI unavailable");
        return;
      }

      updateLocalAIReviewControls("Running Local AI review...");
      const imageBuffer = await state.currentFile.arrayBuffer();
      const localAIProvider = {
        analyzeReceipt: async (input = {}) => {
          return await window.localAI.analyzeReceipt({
            imageBuffer: input.imageBuffer,
            maxNewTokens: input.maxNewTokens,
            stopTokenIds: input.stopTokenIds,
            imageLayouts: input.imageLayouts,
            deterministicContext: input.deterministicContext,
            ocrContext: input.ocrContext,
          });
        },
      };

      const intelligenceResult = await receiptIntelligenceService.analyze(state.lastReceiptDecisionTrace, {
        featureEnabled: true,
        forceLocalAIReview: true,
        localAIProvider,
        imageBuffer,
        rawOcrText: state.lastOcrText,
      });
      state.lastReceiptIntelligenceResult = intelligenceResult;
      state.receiptReviewModel = buildReceiptReviewModel({
        ...intelligenceResult,
        trace: state.lastReceiptDecisionTrace,
      });
      renderReceiptReviewModel(state.receiptReviewModel);

      const advisory = intelligenceResult && intelligenceResult.advisory;
      updateLocalAIReviewControls(
        advisory && advisory.succeeded
          ? "Local AI review complete"
          : "Local AI review failed"
      );
    } catch (error) {
      console.warn("Local AI review failed:", error);
      const previousResult = state.lastReceiptIntelligenceResult && typeof state.lastReceiptIntelligenceResult === "object"
        ? state.lastReceiptIntelligenceResult
        : {
            status: "skipped",
            reason: "local_ai_error",
            eligible: false,
            suggestions: [],
            metadata: {},
          };
      const advisory = {
        available: Boolean(state.localAIReviewAvailable),
        attempted: true,
        succeeded: false,
        source: "local-ai",
        receipt: null,
        text: null,
        pipeline: null,
        metadata: null,
        error: error && error.message ? error.message : String(error),
      };

      state.lastReceiptIntelligenceResult = {
        ...previousResult,
        advisory,
        metadata: {
          ...(previousResult.metadata && typeof previousResult.metadata === "object" ? previousResult.metadata : {}),
          localAIAdvisory: advisory,
        },
      };
      state.receiptReviewModel = buildReceiptReviewModel({
        ...state.lastReceiptIntelligenceResult,
        trace: state.lastReceiptDecisionTrace,
      });
      renderReceiptReviewModel(state.receiptReviewModel);
      updateLocalAIReviewControls("Local AI review failed. Try again.");
    } finally {
      state.localAIReviewRunning = false;
      if (elements.localAIReviewStatus && elements.localAIReviewStatus.textContent === "Running Local AI review...") {
        updateLocalAIReviewControls();
      } else if (elements.localAIReviewBtn) {
        elements.localAIReviewBtn.disabled = !(
          state.lastReceiptDecisionTrace
          && state.currentFile
          && state.localAIReviewAvailable
        );
      }
    }
  }

  function analyzeLatestReceiptDecisionTrace(trace = state.lastReceiptDecisionTrace) {
    if (!trace || typeof trace !== "object") {
      return {
        ok: false,
        reason: "no_trace_available",
      };
    }

    const stages = [
      { key: "ocrInitial", label: "ocrInitial" },
      { key: "postAnchor", label: "postAnchor" },
      { key: "postHistory", label: "postHistory" },
      { key: "finalRendered", label: "finalRendered" },
    ];

    const stageValues = stages.map(({ key, label }) => {
      const snapshot = trace[key] && typeof trace[key] === "object" ? trace[key] : {};
      return {
        stage: label,
        location: String(snapshot.location || ""),
        license: String(snapshot.license || ""),
      };
    });

    const locationChanges = [];
    const licenseChanges = [];

    for (let index = 1; index < stageValues.length; index += 1) {
      const prev = stageValues[index - 1];
      const curr = stageValues[index];

      if (prev.location !== curr.location) {
        locationChanges.push({
          fromStage: prev.stage,
          toStage: curr.stage,
          from: prev.location,
          to: curr.location,
        });
      }

      if (prev.license !== curr.license) {
        licenseChanges.push({
          fromStage: prev.stage,
          toStage: curr.stage,
          from: prev.license,
          to: curr.license,
        });
      }
    }

    const report = {
      ok: true,
      traceId: String(trace.traceId || ""),
      timestamp: String(trace.timestamp || ""),
      locationChanged: locationChanges.length > 0,
      licenseChanged: licenseChanges.length > 0,
      locationChanges,
      licenseChanges,
      firstLocationChangeStage: locationChanges.length > 0 ? locationChanges[0].toStage : null,
      firstLicenseChangeStage: licenseChanges.length > 0 ? licenseChanges[0].toStage : null,
    };

    console.info("[Trace Analysis]", report);
    return report;
  }

  window.analyzeLatestReceiptDecisionTrace = analyzeLatestReceiptDecisionTrace;

  window.smokeTestLocalAI = async function smokeTestLocalAI() {
    if (!window.localAI || typeof window.localAI.listModels !== "function") {
      console.warn("[LocalAI Smoke] window.localAI is unavailable.");
      return [];
    }

    const models = await window.localAI.listModels();
    console.info("[LocalAI Smoke]", models);
    return models;
  };

  async function onProcessManualText() {
    const text = elements.manualTextInput ? elements.manualTextInput.value.trim() : "";
    if (!text) {
      setStatus("Paste or type receipt text before processing.", "warn");
      return;
    }

    setStatus("Searching dispensary list...");
    clearHistoryHints();
    updateMatchConfidenceIndicator(null);

    try {
      const result = await parseTextForStore(text);
      if (!result) {
        setStatus("No matching dispensary found. Check that the text contains an Oregon address.", "error");
        return;
      }

      fillReceiptForm({
        locationName: result.Name,
        licenseNumber: result.License,
      });
      setStatus("Dispensary matched. Verify the fields and complete the form.", "success");
    } catch (error) {
      console.error(error);
      setStatus("Error during dispensary lookup. Please try again.", "error");
    }
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

    elements.matchConfidence.dataset.score = Number.isFinite(score) ? String(score) : "";

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
    state.lastReceiptDecisionTrace = null;
    state.lastReceiptIntelligenceResult = null;
    clearReceiptReviewModel();
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
    // Default base order: newest first (used as tiebreaker before any sort)
    receipts.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    state.receiptsCache = receipts;
    refreshRunningTotalDisplay(receipts);

    // Settings page does not include receipt table elements.
    if (elements.receiptRows && elements.rowTemplate && elements.recordCount && elements.emptyState) {
      renderReceipts(receipts);
    }

    return receipts;
  }

  // ── Filter / sort helpers ──────────────────────────────────────────────

  function filterReceipts(receipts, query) {
    if (!query) return receipts;
    const q = query.toLowerCase().trim();
    return receipts.filter((r) => {
      return (
        (r.locationName || "").toLowerCase().includes(q) ||
        (r.licenseNumber || "").toLowerCase().includes(q) ||
        (r.purchaseDate || "").includes(q) ||
        (r.notes || "").toLowerCase().includes(q) ||
        String(r.amountSpent || "").includes(q)
      );
    });
  }

  function sortReceipts(receipts, sortKey) {
    const copy = receipts.slice();
    switch (sortKey) {
      case "date-asc":
        copy.sort((a, b) => String(a.purchaseDate || "").localeCompare(String(b.purchaseDate || "")));
        break;
      case "date-desc":
        copy.sort((a, b) => String(b.purchaseDate || "").localeCompare(String(a.purchaseDate || "")));
        break;
      case "name-asc":
        copy.sort((a, b) => String(a.locationName || "").localeCompare(String(b.locationName || ""), undefined, { sensitivity: "base" }));
        break;
      case "name-desc":
        copy.sort((a, b) => String(b.locationName || "").localeCompare(String(a.locationName || ""), undefined, { sensitivity: "base" }));
        break;
      case "amount-asc":
        copy.sort((a, b) => Number.parseFloat(a.amountSpent || 0) - Number.parseFloat(b.amountSpent || 0));
        break;
      case "amount-desc":
        copy.sort((a, b) => Number.parseFloat(b.amountSpent || 0) - Number.parseFloat(a.amountSpent || 0));
        break;
      default:
        break;
    }
    return copy;
  }

  function buildGroupedRows(receipts) {
    // Group by normalized dispensary name (case-insensitive)
    const groups = new Map();
    for (const r of receipts) {
      const key = (r.locationName || "Unknown").trim();
      const normKey = key.toLowerCase();
      if (!groups.has(normKey)) {
        groups.set(normKey, { label: key, receipts: [] });
      }
      groups.get(normKey).receipts.push(r);
    }
    return [...groups.values()].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────

  function renderReceipts(allReceipts) {
    if (!elements.receiptRows || !elements.rowTemplate || !elements.recordCount || !elements.emptyState) {
      return;
    }

    elements.receiptRows.innerHTML = "";
    clearThumbUrls();

    const query = state.receiptSearchQuery;
    const filtered = filterReceipts(allReceipts, query);
    const sorted = sortReceipts(filtered, state.receiptSortKey);
    const groupByName = state.receiptGroupByName;

    const totalCount = allReceipts.length;
    const shownCount = sorted.length;

    if (query) {
      elements.recordCount.textContent = `${shownCount} of ${totalCount} receipt${totalCount === 1 ? "" : "s"} match`;
    } else {
      elements.recordCount.textContent = `${totalCount} receipt${totalCount === 1 ? "" : "s"} saved`;
    }

    elements.emptyState.hidden = totalCount > 0;

    if (totalCount === 0) {
      return;
    }

    if (shownCount === 0) {
      // Show inline no-results row
      const noRow = document.createElement("tr");
      noRow.className = "no-results-row";
      const td = document.createElement("td");
      td.colSpan = 8;
      td.textContent = `No receipts match "${query}"`;
      noRow.appendChild(td);
      elements.receiptRows.appendChild(noRow);
      return;
    }

    if (groupByName) {
      const groups = buildGroupedRows(sorted);
      for (const group of groups) {
        // Group header row
        const headerRow = document.createElement("tr");
        headerRow.className = "group-header-row";
        const headerTd = document.createElement("td");
        headerTd.colSpan = 8;
        const subtotal = group.receipts.reduce((sum, r) => sum + Number.parseFloat(r.amountSpent || 0), 0);
        headerTd.innerHTML = `${escapeHtml(group.label)}<span class="group-subtotal">${group.receipts.length} receipt${group.receipts.length === 1 ? "" : "s"} &mdash; $${subtotal.toFixed(2)}</span>`;
        headerRow.appendChild(headerTd);
        elements.receiptRows.appendChild(headerRow);

        for (const receipt of group.receipts) {
          elements.receiptRows.appendChild(buildReceiptRow(receipt));
        }
      }
    } else {
      for (const receipt of sorted) {
        elements.receiptRows.appendChild(buildReceiptRow(receipt));
      }
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function buildReceiptRow(receipt) {
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

    return row;
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
    state.lastReceiptDecisionTrace = null;
    state.lastReceiptIntelligenceResult = null;
    clearReceiptReviewModel();
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
