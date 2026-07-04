const FIELD_COMPARE_TYPES = {
	dispensary: "text",
	licenseNumber: "text",
	receiptNumber: "text",
	purchaseDate: "date",
	purchaseTime: "time",
	subtotal: "currency",
	tax: "currency",
	total: "currency",
	paymentMethod: "text",
	budtender: "text",
};

export const ReceiptComparisonNormalizer = {
	normalize(fieldKey, value) {
		const compareType = FIELD_COMPARE_TYPES[fieldKey] || "text";

		switch (compareType) {
			case "currency":
				return normalizeCurrency(value);
			case "date":
				return normalizeDate(value);
			case "time":
				return normalizeTime(value);
			default:
				return normalizeText(value);
		}
	},

	valuesDiffer(fieldKey, current, suggestion) {
		return this.normalize(fieldKey, current) !== this.normalize(fieldKey, suggestion);
	},
};

function normalizeCurrency(value) {
	const amount = parseCurrencyValue(value);
	if (amount === null) {
		return normalizeText(value);
	}

	return `currency:${amount}`;
}

function parseCurrencyValue(value) {
	if (typeof value === "number") {
		return Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 100) : null;
	}

	const text = String(value === null || value === undefined ? "" : value).trim();
	if (!text) {
		return null;
	}

	const cleaned = text.replace(/[$,]/g, "").trim();
	if (!/^[-+]?\d*(?:\.\d+)?$/.test(cleaned) || cleaned === "" || cleaned === "+" || cleaned === "-") {
		return null;
	}

	const parsed = Number(cleaned);
	if (!Number.isFinite(parsed)) {
		return null;
	}

	return Math.round((parsed + Number.EPSILON) * 100);
}

function normalizeDate(value) {
	const text = String(value === null || value === undefined ? "" : value).trim();
	if (!text) {
		return "";
	}

	const isoDate = parseIsoDate(text);
	if (isoDate) {
		return `date:${isoDate}`;
	}

	const slashDate = parseSlashDate(text);
	if (slashDate) {
		return `date:${slashDate}`;
	}

	const monthNameDate = parseMonthNameDate(text);
	if (monthNameDate) {
		return `date:${monthNameDate}`;
	}

	return normalizeText(text);
}

function parseIsoDate(text) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	if (!match) {
		return null;
	}

	return `${match[1]}-${match[2]}-${match[3]}`;
}

function parseSlashDate(text) {
	const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
	if (!match) {
		return null;
	}

	const month = Number(match[1]);
	const day = Number(match[2]);
	const year = Number(match[3]);
	if (!isValidDateParts(year, month, day)) {
		return null;
	}

	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseMonthNameDate(text) {
	const match = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(text);
	if (!match) {
		return null;
	}

	const month = parseMonthName(match[1]);
	const day = Number(match[2]);
	const year = Number(match[3]);
	if (!month || !isValidDateParts(year, month, day)) {
		return null;
	}

	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseMonthName(monthText) {
	const lookup = {
		january: 1,
		february: 2,
		march: 3,
		april: 4,
		may: 5,
		june: 6,
		july: 7,
		august: 8,
		september: 9,
		october: 10,
		november: 11,
		december: 12,
	};

	return lookup[String(monthText || "").toLowerCase()] || null;
}

function isValidDateParts(year, month, day) {
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
		return false;
	}

	const candidate = new Date(Date.UTC(year, month - 1, day));
	return candidate.getUTCFullYear() === year
		&& candidate.getUTCMonth() === month - 1
		&& candidate.getUTCDate() === day;
}

function normalizeTime(value) {
	const text = String(value === null || value === undefined ? "" : value).trim();
	if (!text) {
		return "";
	}

	const twentyFourHour = parseTwentyFourHourTime(text);
	if (twentyFourHour) {
		return `time:${twentyFourHour}`;
	}

	const twelveHour = parseTwelveHourTime(text);
	if (twelveHour) {
		return `time:${twelveHour}`;
	}

	return normalizeText(text);
}

function parseTwentyFourHourTime(text) {
	const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
	if (!match) {
		return null;
	}

	const hour = Number(match[1]);
	const minute = Number(match[2]);
	const second = match[3] !== undefined ? Number(match[3]) : null;
	if (!isValidTimeParts(hour, minute, second)) {
		return null;
	}

	return second === null
		? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
		: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function parseTwelveHourTime(text) {
	const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)$/i.exec(text);
	if (!match) {
		return null;
	}

	let hour = Number(match[1]);
	const minute = Number(match[2]);
	const second = match[3] !== undefined ? Number(match[3]) : null;
	const meridiem = match[4].toLowerCase();
	if (!isValidTimeParts(hour, minute, second) || hour < 1 || hour > 12) {
		return null;
	}

	if (meridiem === "am") {
		hour = hour === 12 ? 0 : hour;
	} else {
		hour = hour === 12 ? 12 : hour + 12;
	}

	return second === null
		? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
		: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function isValidTimeParts(hour, minute, second) {
	if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
		return false;
	}

	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
		return false;
	}

	if (second === null) {
		return true;
	}

	return Number.isInteger(second) && second >= 0 && second <= 59;
}

function normalizeText(value) {
	return String(value === null || value === undefined ? "" : value)
		.trim()
		.replace(/\s+/g, " ")
		.toLowerCase();
}