import {
	findDispensaryMatchFromOcrText,
	getPrimaryPhysicalAddressFromOcrText,
	normalizeAddressForLookup,
} from "./matcher.js";
import { toTitleCase } from "./utils.js";

const trainingNameSubmitBoundForms = new WeakSet();

function normalizeTrainingNameForSubmit(elements) {
	const input = elements && elements.locationInput;
	if (!input) {
		return;
	}

	const normalized = toTitleCase(input.value).slice(0, 120);
	if (normalized) {
		input.value = normalized;
	}
}

function bindTrainingNameNormalization(elements) {
	if (!elements || !elements.receiptForm || !elements.locationInput) {
		return;
	}

	const form = elements.receiptForm;
	if (trainingNameSubmitBoundForms.has(form)) {
		return;
	}

	form.addEventListener("submit", () => {
		const trainingModeActive =
			form.dataset.trainingMode === "on" || elements.locationInput.dataset.trainingMode === "on";
		if (!trainingModeActive) {
			return;
		}

		normalizeTrainingNameForSubmit(elements);
	});

	trainingNameSubmitBoundForms.add(form);
}

function getOcrErrorMessage(error) {
	if (typeof error === "string") {
		return error;
	}
	if (error && typeof error.message === "string") {
		return error.message;
	}
	return String(error || "");
}

function isBenignOcrWarning(message) {
	const text = String(message || "").toLowerCase();
	return text.includes("image too small to scale") || text.includes("line cannot be recognized");
}

function getLuma(red, green, blue) {
	return 0.299 * red + 0.587 * green + 0.114 * blue;
}

function applyAdaptiveThreshold(imageData, blockSize = 20, thresholdOffset = 12) {
	const { data, width, height } = imageData;
	const luminance = new Float32Array(width * height);

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const pixelIndex = y * width + x;
			const rgbaOffset = pixelIndex * 4;
			luminance[pixelIndex] = getLuma(data[rgbaOffset], data[rgbaOffset + 1], data[rgbaOffset + 2]);
		}
	}

	for (let blockY = 0; blockY < height; blockY += blockSize) {
		const blockEndY = Math.min(blockY + blockSize, height);

		for (let blockX = 0; blockX < width; blockX += blockSize) {
			const blockEndX = Math.min(blockX + blockSize, width);
			let sum = 0;
			let count = 0;

			for (let y = blockY; y < blockEndY; y += 1) {
				const rowOffset = y * width;
				for (let x = blockX; x < blockEndX; x += 1) {
					sum += luminance[rowOffset + x];
					count += 1;
				}
			}

			const localThreshold = Math.max(0, sum / Math.max(1, count) - thresholdOffset);

			for (let y = blockY; y < blockEndY; y += 1) {
				const rowOffset = y * width;
				for (let x = blockX; x < blockEndX; x += 1) {
					const pixelIndex = rowOffset + x;
					const rgbaOffset = pixelIndex * 4;
					const value = luminance[pixelIndex] >= localThreshold ? 255 : 0;
					data[rgbaOffset] = value;
					data[rgbaOffset + 1] = value;
					data[rgbaOffset + 2] = value;
				}
			}
		}
	}

	return imageData;
}

async function loadImageSource(file) {
	if (typeof createImageBitmap === "function") {
		const bitmap = await createImageBitmap(file);
		return {
			image: bitmap,
			cleanup: () => {
				if (bitmap && typeof bitmap.close === "function") {
					bitmap.close();
				}
			},
		};
	}

	const objectUrl = URL.createObjectURL(file);
	try {
		const image = await new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error("Unable to load image for OCR preprocessing."));
			img.src = objectUrl;
		});

		return {
			image,
			cleanup: () => URL.revokeObjectURL(objectUrl),
		};
	} catch (error) {
		URL.revokeObjectURL(objectUrl);
		throw error;
	}
}

async function preprocessReceiptImage(file) {
	if (!(file instanceof Blob)) {
		return file;
	}

	const { image, cleanup } = await loadImageSource(file);
	try {
		const width = image.width || image.naturalWidth;
		const height = image.height || image.naturalHeight;

		if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
			return file;
		}

		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;

		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) {
			return file;
		}

		context.drawImage(image, 0, 0, width, height);
		const imageData = context.getImageData(0, 0, width, height);
		const processedImageData = applyAdaptiveThreshold(imageData, 20);
		context.putImageData(processedImageData, 0, 0);

		return canvas;
	} finally {
		cleanup();
	}
}

export async function onScanReceipt(context = {}) {
	const {
		state,
		elements,
		setStatus,
		clearTrainingLookupState,
		fillReceiptForm,
		getDispensaryName,
		setMatchConfidence,
	} = context;

	if (!state || !elements || typeof setStatus !== "function") {
		throw new Error("onScanReceipt requires state, elements, and setStatus.");
	}

	bindTrainingNameNormalization(elements);

	if (!state.currentFile) {
		setStatus("Select a receipt image first.", "warn");
		return;
	}

	// Access Tesseract from the browser global loaded by vendor/tesseract.min.js.
	const tesseractApi = globalThis.Tesseract;
	if (!tesseractApi || typeof tesseractApi.recognize !== "function") {
		setStatus("OCR library failed to load. Check connection and retry.", "error");
		return;
	}

	if (elements.scanBtn) {
		elements.scanBtn.disabled = true;
	}
	if (typeof setMatchConfidence === "function") {
		setMatchConfidence(null);
	}
	setStatus("Starting OCR scan...");

	try {
		if (typeof clearTrainingLookupState === "function") {
			clearTrainingLookupState(true);
		}

		setStatus("Preparing image for OCR...");
		let ocrInput = state.currentFile;
		try {
			ocrInput = await preprocessReceiptImage(state.currentFile);
		} catch (preprocessError) {
			console.warn("OCR preprocessing failed; continuing with original image.", preprocessError);
			ocrInput = state.currentFile;
		}

		const workerPath = new URL("./vendor/worker.min.js", document.baseURI).href;
		const corePath = new URL("./vendor/tesseract-core.wasm.js", document.baseURI).href;
		const langPath = new URL("./assets/tessdata", document.baseURI).href;

		const result = await tesseractApi.recognize(ocrInput, "eng", {
			workerPath,
			corePath,
			langPath,
			logger: (message) => {
				if (message.status === "recognizing text") {
					const progress = Math.round((message.progress || 0) * 100);
					setStatus(`Scanning text... ${progress}%`);
				}
			},
			errorHandler: (error) => {
				const message = getOcrErrorMessage(error);
				if (isBenignOcrWarning(message)) {
					console.debug("[OCR] Ignored non-fatal engine warning:", message);
					return;
				}
				console.warn("[OCR] Engine warning:", error);
			},
		});

		const text = (result && result.data && result.data.text) || "";
		state.lastOcrText = text;

		const extracted = await extractReceiptData(text);
		let dispensaryMatch = null;
		try {
			dispensaryMatch = await findDispensaryMatchFromOcrText(text);
		} catch (lookupError) {
			console.warn("Dispensary lookup failed:", lookupError);
		}

		if (dispensaryMatch && dispensaryMatch.name) {
			extracted.locationName = dispensaryMatch.name;
			if (elements.locationInput) {
				elements.locationInput.value = dispensaryMatch.name;
			}
		}

		if (typeof setMatchConfidence === "function") {
			const score = dispensaryMatch && Number.isFinite(dispensaryMatch.score) ? dispensaryMatch.score : null;
			setMatchConfidence(score);
		}

		const detectedPhysicalAddress = normalizeAddressForLookup(
			dispensaryMatch && dispensaryMatch.matchedAddress
				? dispensaryMatch.matchedAddress
				: getPrimaryPhysicalAddressFromOcrText(text)
		);

		state.lastDetectedPhysicalAddress = detectedPhysicalAddress;

		let resolvedDispensaryName = null;
		if (typeof getDispensaryName === "function") {
			try {
				resolvedDispensaryName = await getDispensaryName(detectedPhysicalAddress);
			} catch (nameLookupError) {
				console.warn("Training mode lookup failed:", nameLookupError);
			}
		}

		if (resolvedDispensaryName) {
			extracted.locationName = resolvedDispensaryName;
		}

		if (dispensaryMatch) {
			extracted.licenseNumber = dispensaryMatch.licenseNumber || "";
		}

		if (state.lastDispensaryLookupSource === "manual" && !dispensaryMatch) {
			extracted.locationName = "";
		}

		if (typeof fillReceiptForm === "function") {
			await fillReceiptForm(extracted);
		}

		if (state.lastDispensaryLookupSource === "user_mappings") {
			setStatus("Scan complete. Training Mode mapping found in IndexedDB. Verify fields and save your record.", "success");
		} else if (dispensaryMatch && resolvedDispensaryName) {
			const confidence = Math.round((dispensaryMatch.score || 0) * 100);
			setStatus(`Scan complete. Matched ${resolvedDispensaryName} (${confidence}%). Verify fields and save your record.`, "success");
		} else if (dispensaryMatch) {
			const confidence = Math.round((dispensaryMatch.score || 0) * 100);
			setStatus(`Scan complete. Matched ${dispensaryMatch.name} (${confidence}%). Verify fields and save your record.`, "success");
		} else if (state.lastDispensaryLookupSource === "manual") {
			setStatus("Scan complete. No dispensary match found. Enter the dispensary name manually to train this address.", "warn");
		} else {
			setStatus("Scan complete. Verify fields and save your record.", "success");
		}
	} catch (error) {
		console.error(error);
		if (typeof setMatchConfidence === "function") {
			setMatchConfidence(null);
		}
		setStatus("OCR failed. You can still fill fields manually.", "error");
	} finally {
		if (elements.scanBtn) {
			elements.scanBtn.disabled = false;
		}
	}
}

export async function extractReceiptData(text) {
	const lines = String(text || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	return {
		locationName: await findLocation(lines),
		purchaseDate: await findDate(text),
		purchaseTime: await findTime(text),
		amountSpent: await findAmount(lines, text),
	};
}

export async function findLocation(lines) {
	if (!Array.isArray(lines) || lines.length === 0) {
		return "";
	}

	const dispensaryHint = /(dispensary|cannabis|collective|club|wellness|care|pharmacy)/i;
	const ignorePattern = /(receipt|invoice|order|subtotal|total|tax|change|thank|qty|item|price|transaction|date|time)/i;

	const candidates = lines.slice(0, 10).filter((line) => {
		if (!/[a-z]/i.test(line)) {
			return false;
		}
		if (ignorePattern.test(line)) {
			return false;
		}
		if (/^\d[\d\s\-/:.]*$/.test(line)) {
			return false;
		}
		return line.length >= 3;
	});

	const preferred = candidates.find((line) => dispensaryHint.test(line));
	return (preferred || candidates[0] || lines[0] || "").slice(0, 120);
}

export async function findDate(text) {
	const patterns = [
		/\b(\d{4}[/-]\d{1,2}[/-]\d{1,2})\b/g,
		/\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/g,
		/\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{2,4})\b/gi,
	];

	for (const pattern of patterns) {
		let match = pattern.exec(text);
		while (match) {
			const iso = await toIsoDate(match[1]);
			if (iso) {
				return iso;
			}
			match = pattern.exec(text);
		}
	}

	return "";
}

export async function toIsoDate(value) {
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

export async function safeIsoDate(year, month, day) {
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

export async function findTime(text) {
	const match = String(text || "").match(/\b(\d{1,2}:\d{2}\s?(?:AM|PM|am|pm)?)\b/);
	if (!match) {
		return "";
	}

	return normalizeTime(match[1]);
}

export async function normalizeTime(raw) {
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

export async function findAmount(lines, text) {
	const keyLinePattern = /(grand total|total|amount due|amount paid|balance due|payment)/i;

	for (const line of Array.isArray(lines) ? lines : []) {
		if (!keyLinePattern.test(line)) {
			continue;
		}

		const values = await getCurrencyValues(line);
		if (values.length > 0) {
			return values[values.length - 1].toFixed(2);
		}
	}

	const allValues = await getCurrencyValues(text);
	if (allValues.length === 0) {
		return "";
	}

	const largestValue = Math.max(...allValues);
	return largestValue.toFixed(2);
}

export async function getCurrencyValues(text) {
	const regex = /(?:\$|USD\s*)?(\d{1,3}(?:,\d{3})*(?:\.\d{2}))/gi;
	const values = [];

	let match = regex.exec(String(text || ""));
	while (match) {
		const parsed = Number.parseFloat(match[1].replace(/,/g, ""));
		if (Number.isFinite(parsed)) {
			values.push(parsed);
		}
		match = regex.exec(String(text || ""));
	}

	return values;
}
