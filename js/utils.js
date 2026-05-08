import { DEVICE_BACKUP_HANDLE_KEY } from "./constants.js";
import {
	addReceipt,
	deleteAppSetting,
	getAllReceipts,
	getAppSetting,
	setAppSetting,
} from "./db.js";

export function normalizeForMatch(str) {
    if (!str) return "";
    return str.toLowerCase()
              .replace(/[^a-z0-9]/g, "") // Remove dots, commas, spaces
              .replace("street", "st")
              .replace("avenue", "ave")
              .replace("boulevard", "blvd");
}

export function getJsZipGlobal() {
	return typeof globalThis !== "undefined" ? globalThis.JSZip : null;
}

export function toTitleCase(str) {
	const text = String(str || "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();

	if (!text) {
		return "";
	}

	return text.replace(/\b([a-z])/g, (_, firstChar) => firstChar.toUpperCase());
}

export async function onExportCsv(context = {}) {
	const setStatus = typeof context.setStatus === "function" ? context.setStatus : () => {};
	const receipts = await getAllReceipts();
	if (receipts.length === 0) {
		setStatus("No receipts to export yet.", "warn");
		return;
	}

	const dateTag = formatDateTag(new Date());
	const csvString = createCsvString(receipts);

	downloadBlob(new Blob([csvString], { type: "text/csv;charset=utf-8" }), `dispensary-receipts-${dateTag}.csv`);
	setStatus("CSV export downloaded.", "success");
}

export async function onExportZip(context = {}, options = {}) {
	const setStatus = typeof context.setStatus === "function" ? context.setStatus : () => {};
	const markBackupExported = typeof context.markBackupExported === "function" ? context.markBackupExported : null;
	const successMessage = options && typeof options === "object" && options.successMessage
		? options.successMessage
		: "ZIP export downloaded (CSV + receipt images).";

	const receipts = await getAllReceipts();
	if (receipts.length === 0) {
		setStatus("No receipts to export yet.", "warn");
		return;
	}

	if (!getJsZipGlobal()) {
		setStatus("ZIP library did not load. Check connection and retry.", "error");
		return;
	}

	const exportTag = formatDateTimeTag(new Date());
	const csvName = `dispensary-receipts-${exportTag}.csv`;

	setStatus("Creating backup ZIP...");

	let zipBlob;
	try {
		zipBlob = await createBackupZipBlob(receipts, csvName);
	} catch (error) {
		console.error(error);
		setStatus("Backup ZIP creation failed. Try exporting CSV first, then retry ZIP export.", "error");
		return;
	}

	downloadBlob(zipBlob, `dispensary-receipts-${exportTag}.zip`);
	if (markBackupExported) {
		markBackupExported();
	}
	setStatus(successMessage, "success");
}

export async function createBackupZipBlob(receipts, csvName) {
	const JSZipApi = getJsZipGlobal();
	if (!JSZipApi) {
		throw new Error("JSZip is unavailable.");
	}

	const csvString = createCsvString(receipts);
	const zip = new JSZipApi();
	zip.file(csvName, csvString);

	const imageFolder = zip.folder("receipt-images");
	for (const receipt of receipts) {
		if (receipt.imageBlob instanceof Blob) {
			const fileName = receipt.imageFileName || `receipt-${receipt.id}.jpg`;
			imageFolder.file(fileName, receipt.imageBlob);
		}
	}

	return zip.generateAsync({
		type: "blob",
		compression: "DEFLATE",
		compressionOptions: { level: 6 },
	});
}

export async function onChooseAutoBackupFile(context = {}) {
	const setStatus = typeof context.setStatus === "function" ? context.setStatus : () => {};
	const markBackupExported = typeof context.markBackupExported === "function" ? context.markBackupExported : null;

	if (typeof globalThis.showSaveFilePicker !== "function") {
		setStatus("Auto-backup file setup is not supported in this browser. Use manual ZIP exports.", "warn");
		return;
	}

	if (!getJsZipGlobal()) {
		setStatus("ZIP library did not load. Reload the page and retry auto-backup setup.", "error");
		return;
	}

	try {
		const suggestedName = `dispensary-receipts-live-${formatDateTag(new Date())}.zip`;
		const handle = await globalThis.showSaveFilePicker({
			suggestedName,
			types: [
				{
					description: "ZIP backup",
					accept: { "application/zip": [".zip"] },
				},
			],
		});

		const granted = await ensureFileHandleWritePermission(handle);
		if (!granted) {
			setStatus("Auto-backup file permission was not granted.", "warn");
			return;
		}

		await setAppSetting(DEVICE_BACKUP_HANDLE_KEY, handle);

		const receipts = await getAllReceipts();
		if (receipts.length > 0) {
			setStatus("Creating initial auto-backup file...");
			const zipBlob = await createBackupZipBlob(receipts, "dispensary-receipts-latest.csv");
			await writeBlobToFileHandle(handle, zipBlob);
			if (markBackupExported) {
				markBackupExported();
			}
		}

		setStatus("Auto-backup file enabled. It will update after each receipt save.", "success");
	} catch (error) {
		if (error && error.name === "AbortError") {
			return;
		}
		console.error(error);
		setStatus("Could not enable auto-backup file. Try again.", "error");
	}
}

export async function onClearAutoBackupFile(context = {}) {
	const setStatus = typeof context.setStatus === "function" ? context.setStatus : () => {};
	try {
		await deleteAppSetting(DEVICE_BACKUP_HANDLE_KEY);
		setStatus("Auto-backup file disabled.", "success");
	} catch (error) {
		console.error(error);
		setStatus("Could not disable auto-backup file right now.", "error");
	}
}

export async function tryWriteAutoFileBackup(context = {}, receipts = []) {
	const markBackupExported = typeof context.markBackupExported === "function" ? context.markBackupExported : null;

	let handle;
	try {
		handle = await getAppSetting(DEVICE_BACKUP_HANDLE_KEY);
	} catch (error) {
		console.error("Could not read auto-backup handle:", error);
		return "disabled";
	}

	if (!handle || typeof handle.createWritable !== "function") {
		return "disabled";
	}

	if (!getJsZipGlobal()) {
		return "failed";
	}

	try {
		const granted = await ensureFileHandleWritePermission(handle);
		if (!granted) {
			return "failed";
		}

		const zipBlob = await createBackupZipBlob(receipts, "dispensary-receipts-latest.csv");
		await writeBlobToFileHandle(handle, zipBlob);
		if (markBackupExported) {
			markBackupExported();
		}
		return "written";
	} catch (error) {
		console.error("Auto-backup file write failed:", error);
		return "failed";
	}
}

export async function ensureFileHandleWritePermission(handle) {
	if (!handle || typeof handle.queryPermission !== "function") {
		return true;
	}

	try {
		const queryResult = await handle.queryPermission({ mode: "readwrite" });
		if (queryResult === "granted") {
			return true;
		}
	} catch (error) {
		console.warn("Could not query file handle permission:", error);
	}

	if (typeof handle.requestPermission !== "function") {
		return false;
	}

	const requestResult = await handle.requestPermission({ mode: "readwrite" });
	return requestResult === "granted";
}

export async function writeBlobToFileHandle(handle, blob) {
	const writable = await handle.createWritable();
	await writable.write(blob);
	await writable.close();
}

export async function onImportBackupSelected(context = {}, event) {
	const setStatus = typeof context.setStatus === "function" ? context.setStatus : () => {};

	const [file] = (event && event.target && event.target.files) || [];
	if (event && event.target) {
		event.target.value = "";
	}

	if (!file) {
		return;
	}

	const fileName = (file.name || "").toLowerCase();
	setStatus(`Importing ${file.name || "backup file"}...`);

	try {
		if (fileName.endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed") {
			await importZipBackup(context, file);
		} else {
			await importCsvBackup(context, file);
		}
	} catch (error) {
		console.error(error);
		setStatus(getImportErrorMessage(error), "error");
	}
}

export async function importCsvBackup(context = {}, file) {
	const setStatus = typeof context.setStatus === "function" ? context.setStatus : () => {};
	const loadReceipts = typeof context.loadReceipts === "function" ? context.loadReceipts : null;

	let text;
	try {
		text = await readBlobAsText(file);
	} catch (error) {
		const wrappedError = new Error("Could not read CSV backup file.");
		wrappedError.code = "CSV_READ_FAILED";
		wrappedError.cause = error;
		throw wrappedError;
	}

	const rows = parseCsvRows(text);

	if (rows.length === 0) {
		setStatus("No valid rows found in this CSV backup.", "warn");
		return;
	}

	const incoming = rows.map((row) => mapRowToReceipt(row, null)).filter(Boolean);
	const summary = await mergeImportedReceipts(incoming);

	if (loadReceipts) {
		await loadReceipts();
	}
	setImportSummaryStatus(context, summary);
}

export async function importZipBackup(context = {}, file) {
	const setStatus = typeof context.setStatus === "function" ? context.setStatus : () => {};
	const loadReceipts = typeof context.loadReceipts === "function" ? context.loadReceipts : null;
	const JSZipApi = getJsZipGlobal();

	if (!JSZipApi) {
		setStatus("ZIP library did not load. Check connection and retry.", "error");
		return;
	}

	let zip;
	try {
		zip = await JSZipApi.loadAsync(file);
	} catch (error) {
		const wrappedError = new Error("Could not open ZIP backup file.");
		wrappedError.code = "ZIP_OPEN_FAILED";
		wrappedError.cause = error;
		throw wrappedError;
	}

	let csvEntry = null;
	const imageEntries = new Map();

	zip.forEach((relativePath, entry) => {
		if (entry.dir) {
			return;
		}

		const lower = relativePath.toLowerCase();
		if (!csvEntry && lower.endsWith(".csv")) {
			csvEntry = entry;
		}

		if (/\.(jpg|jpeg|png|webp)$/i.test(lower)) {
			imageEntries.set(lower, entry);
			imageEntries.set(getBaseName(lower), entry);
		}
	});

	if (!csvEntry) {
		setStatus("ZIP backup is missing a CSV file.", "error");
		return;
	}

	let csvText;
	try {
		csvText = await csvEntry.async("string");
	} catch (error) {
		const wrappedError = new Error("Could not read CSV data from ZIP backup.");
		wrappedError.code = "ZIP_CSV_READ_FAILED";
		wrappedError.cause = error;
		throw wrappedError;
	}

	const rows = parseCsvRows(csvText);
	if (rows.length === 0) {
		setStatus("ZIP backup CSV has no valid rows.", "warn");
		return;
	}

	const incoming = [];
	let imageReadFailures = 0;

	for (const row of rows) {
		const imageName = getFirstRowValue(row, ["image_filename", "image", "receipt_image"]);
		let imageBlob = null;

		if (imageName) {
			const imageKey = imageName.toLowerCase();
			const imageEntry = imageEntries.get(imageKey) || imageEntries.get(getBaseName(imageKey));
			if (imageEntry) {
				try {
					imageBlob = await imageEntry.async("blob");
				} catch (error) {
					imageReadFailures += 1;
					console.warn("Could not read image from ZIP backup, importing row without image:", error);
					imageBlob = null;
				}
			}
		}

		const receipt = mapRowToReceipt(row, imageBlob);
		if (receipt) {
			incoming.push(receipt);
		}
	}

	const summary = await mergeImportedReceipts(incoming);
	summary.imageReadFailures = imageReadFailures;
	if (loadReceipts) {
		await loadReceipts();
	}
	setImportSummaryStatus(context, summary);
}

export async function mergeImportedReceipts(importedRecords) {
	const existing = await getAllReceipts();
	const known = new Set(existing.map(createReceiptFingerprint));

	let added = 0;
	let skipped = 0;
	let failed = 0;
	let savedWithoutImages = 0;
	let quotaLimited = false;

	for (const record of importedRecords) {
		const fingerprint = createReceiptFingerprint(record);
		if (known.has(fingerprint)) {
			skipped += 1;
			continue;
		}

		try {
			await addReceipt(record);
			known.add(fingerprint);
			added += 1;
		} catch (error) {
			if (record.imageBlob instanceof Blob && isQuotaExceededError(error)) {
				try {
					const fallbackRecord = {
						...record,
						imageBlob: null,
						imageFileName: "",
					};
					await addReceipt(fallbackRecord);
					known.add(fingerprint);
					added += 1;
					savedWithoutImages += 1;
					quotaLimited = true;
					continue;
				} catch (fallbackError) {
					error = fallbackError;
				}
			}

			if (isQuotaExceededError(error)) {
				quotaLimited = true;
			}

			failed += 1;
			console.error("Skipping imported receipt after save failure:", error);
		}
	}

	return { added, skipped, failed, savedWithoutImages, quotaLimited };
}

export function setImportSummaryStatus(context = {}, summary = {}) {
	const setStatus = typeof context.setStatus === "function" ? context.setStatus : () => {};

	if (summary.added > 0) {
		let message = `Imported ${summary.added} new receipts (${summary.skipped} duplicates skipped`;
		if (summary.failed > 0) {
			message += `, ${summary.failed} failed`;
		}
		message += ").";

		if (summary.savedWithoutImages > 0) {
			message += ` ${summary.savedWithoutImages} were saved without images due storage limits.`;
		}

		if (summary.imageReadFailures > 0) {
			message += ` ${summary.imageReadFailures} image file(s) in the ZIP could not be read.`;
		}

		setStatus(message, summary.failed > 0 || summary.savedWithoutImages > 0 ? "warn" : "success");
		return;
	}

	if (summary.failed > 0 && summary.quotaLimited) {
		setStatus("Import could not save new receipts because browser storage is full. Enable Auto-Backup File and import CSV-only, or clear old receipts.", "error");
		return;
	}

	if (summary.failed > 0) {
		setStatus(`Import finished, but ${summary.failed} row(s) could not be saved.`, "error");
		return;
	}

	setStatus("Import complete. No new receipts were added.", "warn");
}

export function getImportErrorMessage(error) {
	const code = String(error && error.code ? error.code : "");
	const name = String(error && error.name ? error.name : "");
	const message = String(error && error.message ? error.message : "");
	const combined = `${name} ${message}`.toLowerCase();

	if (code === "ZIP_OPEN_FAILED") {
		return "Backup ZIP could not be opened. Try selecting the file again or re-export a new ZIP backup.";
	}

	if (code === "ZIP_CSV_READ_FAILED") {
		return "Backup ZIP opened, but its CSV data could not be read.";
	}

	if (code === "CSV_READ_FAILED") {
		return "Backup CSV file could not be read. Check that the file is not locked by another app.";
	}

	if (isQuotaExceededError(error)) {
		return "Backup import failed because browser storage is full. Enable Auto-Backup File and retry (CSV-only works best when space is low).";
	}

	if (combined.includes("failed to save receipt") || combined.includes("failed to open database") || combined.includes("failed to load receipts")) {
		return "Backup import failed while saving to local database. This can happen when browser storage is blocked or full.";
	}

	if (combined.includes("zip")) {
		return "Backup ZIP could not be read. Make sure the selected ZIP was created by this app.";
	}

	if (combined.includes("csv")) {
		return "Backup CSV could not be parsed. Check that the file has receipt columns and try again.";
	}

	return "Backup import failed. Please retry with a CSV or ZIP backup exported by this app.";
}

export function isQuotaExceededError(error) {
	const name = String(error && error.name ? error.name : "");
	const message = String(error && error.message ? error.message : "");
	return (
		/quotaexceedederror|ns_error_dom_quota_reached/i.test(name) ||
		/quota|storage|space|full|disk/i.test(message)
	);
}

export function getEditErrorMessage(error) {
	if (isQuotaExceededError(error)) {
		return "Could not update this receipt because browser storage is full.";
	}

	const name = String(error && error.name ? error.name : "").toLowerCase();
	const message = String(error && error.message ? error.message : "").toLowerCase();
	if (message.includes("not found for update") || message.includes("missing receipt key")) {
		return "Could not update this receipt because its local record key was missing. Try re-importing backup and retry.";
	}

	if (name.includes("invalidstateerror") || message.includes("transaction") || message.includes("inactive")) {
		return "Could not update this receipt because local database transaction failed. Retry once after refresh.";
	}

	if (message.includes("failed to save receipt") || message.includes("receipt save aborted")) {
		return "Could not update this receipt in local storage right now.";
	}

	return "Could not update this receipt right now.";
}

export function getErrorDetailSuffix(error) {
	const name = String(error && error.name ? error.name : "").trim();
	const message = String(error && error.message ? error.message : "").trim();

	if (!name && !message) {
		return "";
	}

	const detail = `${name || "Error"}${message ? `: ${message}` : ""}`;
	return ` [${detail.slice(0, 110)}]`;
}

export function getClearAllErrorMessage(error) {
	if (isQuotaExceededError(error)) {
		return "Could not clear receipts because browser storage is currently unstable/full.";
	}

	const message = String(error && error.message ? error.message : "").toLowerCase();
	if (message.includes("failed to open database") || message.includes("failed to load receipts")) {
		return "Could not access local database to clear receipts.";
	}

	if (message.includes("failed to clear receipts") || message.includes("receipt clear aborted")) {
		return "Could not clear all receipts right now.";
	}

	return "Could not clear receipts right now.";
}

export function createReceiptFingerprint(receipt) {
	const location = String(receipt.locationName || "").trim().toLowerCase();
	const license = String(receipt.licenseNumber || "").trim().toLowerCase();
	const date = String(receipt.purchaseDate || "").trim();
	const time = String(receipt.purchaseTime || "").trim();
	const amount = formatAmount(receipt.amountSpent);
	const notes = String(receipt.notes || "").trim().toLowerCase();
	return [location, license, date, time, amount, notes].join("|");
}

export function createRecordId() {
	if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}

	return `r-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

export function mapRowToReceipt(row, imageBlob) {
	const locationName = getFirstRowValue(row, ["location_name", "location", "store", "dispensary"]).slice(0, 120);
	const licenseNumber = getFirstRowValue(row, ["license_number", "license", "license_no", "olcc_license"]).slice(0, 40);
	const purchaseDate = normalizeImportedDate(getFirstRowValue(row, ["purchase_date", "date", "receipt_date"]));
	const purchaseTimeRaw = getFirstRowValue(row, ["purchase_time", "time", "receipt_time"]);
	const amountSpent = normalizeImportedAmount(getFirstRowValue(row, ["amount_spent", "amount", "total", "amount_paid"]));

	if (!locationName || !purchaseDate || !amountSpent) {
		return null;
	}

	const id = createRecordId();
	const normalizedTime = purchaseTimeRaw ? normalizeTime(purchaseTimeRaw) : "";
	const imageFileName = getFirstRowValue(row, ["image_filename", "image", "receipt_image"]) || `receipt-${id}.jpg`;

	return {
		id,
		locationName,
		licenseNumber,
		purchaseDate,
		purchaseTime: normalizedTime || "",
		amountSpent,
		notes: getFirstRowValue(row, ["notes", "note", "memo"]).slice(0, 300),
		rawText: "",
		imageFileName,
		imageBlob: imageBlob instanceof Blob ? imageBlob : null,
		createdAt: normalizeImportedDateTime(getFirstRowValue(row, ["created_at", "saved_at", "created"])) || new Date().toISOString(),
	};
}

export function normalizeImportedDate(value) {
	if (!value) {
		return "";
	}

	const isoDate = toIsoDate(value);
	if (isoDate) {
		return isoDate;
	}

	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return "";
	}

	return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

export function normalizeImportedDateTime(value) {
	if (!value) {
		return "";
	}

	const parsed = new Date(value);
	if (!Number.isNaN(parsed.getTime())) {
		return parsed.toISOString();
	}

	const isoDate = normalizeImportedDate(value);
	return isoDate ? `${isoDate}T00:00:00.000Z` : "";
}

export function normalizeImportedAmount(value) {
	if (!value) {
		return "";
	}

	const parsed = Number.parseFloat(String(value).replace(/[^\d.-]/g, ""));
	if (!Number.isFinite(parsed) || parsed < 0) {
		return "";
	}

	return parsed.toFixed(2);
}

export function normalizeTime(raw) {
	const trimmed = String(raw || "").toLowerCase().replace(/\s+/g, "");
	const am = trimmed.includes("am");
	const pm = trimmed.includes("pm");

	const [hourRaw, minuteRaw] = trimmed.replace(/am|pm/g, "").split(":");
	let hour = Number.parseInt(hourRaw, 10);
	const minute = Number.parseInt(minuteRaw, 10);

	if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) {
		return "";
	}

	if (pm && hour < 12) {
		hour += 12;
	}

	if (am && hour === 12) {
		hour = 0;
	}

	if (hour < 0 || hour > 23) {
		return "";
	}

	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function toIsoDate(value) {
	const normalized = String(value || "").trim().replace(/\./g, "/");

	if (/^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(normalized)) {
		const parts = normalized.split(/[/-]/).map((part) => Number.parseInt(part, 10));
		return safeIsoDate(parts[0], parts[1], parts[2]);
	}

	if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(normalized)) {
		const [monthRaw, dayRaw, yearRaw] = normalized.split(/[/-]/).map((part) => Number.parseInt(part, 10));
		const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
		return safeIsoDate(year, monthRaw, dayRaw);
	}

	const parsed = new Date(normalized);
	if (Number.isNaN(parsed.getTime())) {
		return "";
	}

	return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

export function safeIsoDate(year, month, day) {
	if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
		return "";
	}

	const date = new Date(year, month - 1, day);
	if (Number.isNaN(date.getTime())) {
		return "";
	}

	if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) {
		return "";
	}

	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function getFirstRowValue(row, keys) {
	for (const key of keys) {
		const value = row[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}

	return "";
}

export function parseCsvRows(text) {
	const matrix = parseCsvMatrix(text);
	if (matrix.length <= 1) {
		return [];
	}

	const headers = matrix[0].map((header) => sanitizeHeader(header));
	const rows = [];

	for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
		const matrixRow = matrix[rowIndex];
		if (matrixRow.every((cell) => !String(cell).trim())) {
			continue;
		}

		const rowObject = {};
		for (let colIndex = 0; colIndex < headers.length; colIndex += 1) {
			const header = headers[colIndex] || `column_${colIndex}`;
			rowObject[header] = String(matrixRow[colIndex] || "").trim();
		}

		rows.push(rowObject);
	}

	return rows;
}

export function parseCsvMatrix(text) {
	const rows = [];
	let row = [];
	let cell = "";
	let inQuotes = false;

	const source = String(text || "");
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];

		if (inQuotes) {
			if (char === '"') {
				if (source[index + 1] === '"') {
					cell += '"';
					index += 1;
				} else {
					inQuotes = false;
				}
			} else {
				cell += char;
			}
			continue;
		}

		if (char === '"') {
			inQuotes = true;
			continue;
		}

		if (char === ",") {
			row.push(cell);
			cell = "";
			continue;
		}

		if (char === "\n") {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
			continue;
		}

		if (char === "\r") {
			continue;
		}

		cell += char;
	}

	row.push(cell);
	if (row.length > 1 || row[0] !== "") {
		rows.push(row);
	}

	return rows;
}

export function sanitizeHeader(value) {
	return String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

export function readBlobAsText(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result || ""));
		reader.onerror = () => reject(reader.error || new Error("Failed to read file."));
		reader.readAsText(blob);
	});
}

export function getBaseName(path) {
	const normalized = String(path || "").replace(/\\/g, "/");
	const parts = normalized.split("/");
	return parts[parts.length - 1] || "";
}

export function formatAmount(amount) {
	const value = Number.parseFloat(String(amount));
	if (!Number.isFinite(value)) {
		return "0.00";
	}
	return value.toFixed(2);
}

export function createCsvString(receipts) {
	const headers = [
		"receipt_id",
		"location_name",
		"license_number",
		"purchase_date",
		"purchase_time",
		"amount_spent",
		"image_filename",
		"notes",
		"created_at",
	];

	const rows = receipts
		.map((receipt) => {
			return [
				receipt.id || "",
				receipt.locationName || "",
				receipt.licenseNumber || "",
				receipt.purchaseDate || "",
				receipt.purchaseTime || "",
				formatAmount(receipt.amountSpent),
				receipt.imageFileName || "",
				receipt.notes || "",
				receipt.createdAt || "",
			]
				.map(csvEscape)
				.join(",");
		})
		.join("\n");

	return `${headers.join(",")}\n${rows}`;
}

export function csvEscape(value) {
	const text = String(value ?? "");
	if (!/[",\n]/.test(text)) {
		return text;
	}
	return `"${text.replace(/"/g, '""')}"`;
}

export function downloadBlob(blob, fileName) {
	const link = document.createElement("a");
	const url = URL.createObjectURL(blob);

	link.href = url;
	link.download = fileName;
	document.body.appendChild(link);
	link.click();
	link.remove();

	setTimeout(() => URL.revokeObjectURL(url), 500);
}

export function formatDateTag(date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function formatDateTimeTag(date) {
	const datePart = formatDateTag(date);
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	const second = String(date.getSeconds()).padStart(2, "0");
	return `${datePart}-${hour}${minute}${second}`;
}
