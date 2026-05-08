import {
  DISPENSARY_LIST_FALLBACK_PATH,
  DISPENSARY_LIST_PATH,
  DISPENSARY_MATCH_THRESHOLD,
} from "./constants.js";

const matcherState = {
  dispensaryLookupEntries: null,
  dispensaryLookupPromise: null,
  dispensaryLookupPath: "",
};

function getOfficialDispensaryName(info) {
  if (!info || typeof info !== "object") {
    return "";
  }

  const candidates = [
    info.Name,
    info.name,
    info.NAME,
    info.officialName,
    info.official_name,
    info.dispensaryName,
    info.dispensary_name,
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) {
      return value;
    }
  }

  return "";
}

async function ensureDispensaryLookupLoaded() {
  if (Array.isArray(matcherState.dispensaryLookupEntries) && matcherState.dispensaryLookupEntries.length > 0) {
    return matcherState.dispensaryLookupEntries;
  }

  if (matcherState.dispensaryLookupPromise) {
    return matcherState.dispensaryLookupPromise;
  }

  matcherState.dispensaryLookupPromise = (async () => {
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
        matcherState.dispensaryLookupEntries = entries;
        matcherState.dispensaryLookupPath = path;
        return entries;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("No dispensary list file could be loaded.");
  })();

  try {
    return await matcherState.dispensaryLookupPromise;
  } finally {
    matcherState.dispensaryLookupPromise = null;
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

    const officialName = getOfficialDispensaryName(info);
    if (!officialName) {
      continue;
    }

    const normalizedAddressNoZip = stripAddressZip(normalizedAddress);
    entries.push({
      address,
      normalizedAddress,
      normalizedAddressNoZip,
      firstNumber: extractLeadingAddressNumber(normalizedAddress),
      tokens: tokenizeAddress(normalizedAddressNoZip),
      officialName,
      name: officialName,
      licenseNumber: String(info && info.license ? info.license : "").trim(),
    });
  }

  return entries;
}

export async function findDispensaryMatchFromOcrText(text) {
  const lookupEntries = await ensureDispensaryLookupLoaded();
  if (!Array.isArray(lookupEntries) || lookupEntries.length === 0) {
    return null;
  }

  const candidates = extractAddressCandidatesFromText(text);
  if (candidates.length === 0) {
    return null;
  }

  let bestMatch = null;
  const scoredMatches = [];

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
      scoredMatches.push({ score, candidate, entry });
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = {
          score,
          candidate,
          entry,
        };
      }
    }
  }

  logTopMatchesForCandidate(bestMatch, scoredMatches);

  if (!bestMatch || bestMatch.score < DISPENSARY_MATCH_THRESHOLD) {
    return null;
  }

  const officialName = String(
    bestMatch.entry && (bestMatch.entry.officialName || bestMatch.entry.name)
      ? bestMatch.entry.officialName || bestMatch.entry.name
      : ""
  ).trim();
  if (!officialName) {
    return null;
  }

  return {
    name: officialName,
    licenseNumber: bestMatch.entry.licenseNumber,
    score: Number(bestMatch.score),
    matchedAddress: bestMatch.entry.address,
    matchedCandidate: bestMatch.candidate.raw,
  };
}

function logTopMatchesForCandidate(bestMatch, scoredMatches) {
  if (!bestMatch || !Array.isArray(scoredMatches) || scoredMatches.length === 0) {
    return;
  }

  const cleanedAddress = String(
    bestMatch.candidate && bestMatch.candidate.normalizedAddress ? bestMatch.candidate.normalizedAddress : ""
  );

  const topMatches = scoredMatches
    .filter((match) => {
      return match && match.candidate && match.candidate.normalizedAddress === cleanedAddress;
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((match) => {
      const percent = Math.round((Number(match.score) || 0) * 1000) / 10;
      return {
        name: String(match.entry && match.entry.name ? match.entry.name : ""),
        address: String(match.entry && match.entry.address ? match.entry.address : ""),
        score: `${percent}%`,
      };
    });

  console.log("[Matcher] Cleaned Address:", cleanedAddress);
  console.log("[Matcher] Top 3 Matches:", topMatches);
}

export function getPrimaryPhysicalAddressFromOcrText(text) {
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

function preCleanOcrTextForMatching(text) {
  let cleaned = String(text || "");

  // Join split alphanumeric sequences first so fold artifacts do not fragment tokens.
  cleaned = cleaned.replace(/([A-Z0-9])[~_*|\\]+([A-Z0-9])/gi, "$1$2");
  cleaned = cleaned.replace(/[~_*|\\]+/g, " ");
  cleaned = cleaned.replace(/[ \t]+/g, " ");
  cleaned = cleaned.replace(/\s*\n\s*/g, "\n");

  return cleaned.trim();
}

function extractZipAnchoredSnippet(text) {
  // Collapse newlines into spaces so multi-line addresses are in one string,
  // then find the first Oregon zip code (97xxx) and grab the 50 chars before it
  // plus the zip itself (and optional +4). This gives a clean address snippet
  // even when OCR fragments the address across lines.
  const flat = String(text || "").replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const zipMatch = flat.match(/\b(97\d{3}(?:-\d{4})?)\b/);
  if (!zipMatch) {
    return "";
  }
  const zipStart = zipMatch.index;
  const zipEnd = zipMatch.index + zipMatch[0].length;
  const before = flat.slice(Math.max(0, zipStart - 50), zipStart).trim();
  const snippet = `${before} ${zipMatch[0]}`.trim();
  return snippet;
}

function extractAddressCandidatesFromText(text) {
  const preCleanedText = preCleanOcrTextForMatching(text);
  const lines = String(preCleanedText || "")
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

  // --- Zip-anchored snippet (highest priority) ---
  // Grab the 50 chars before the first Oregon zip code — this is almost always
  // the exact address line even when OCR has garbled the street type.
  const zipSnippet = extractZipAnchoredSnippet(text);
  if (zipSnippet) {
    addCandidate(zipSnippet);
  }

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

export function normalizeAddressForLookup(value) {
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

export function scoreAddressSimilarity(a, b) {
  const normA = normalizeAddressForLookup(a);
  const normB = normalizeAddressForLookup(b);
  if (!normA || !normB) {
    return 0;
  }
  if (normA === normB) {
    return 1;
  }
  const numA = extractLeadingAddressNumber(normA);
  const numB = extractLeadingAddressNumber(normB);
  if (numA && numB && numA !== numB) {
    return 0;
  }
  const noZipA = stripAddressZip(normA);
  const noZipB = stripAddressZip(normB);
  const tokensA = tokenizeAddress(noZipA);
  const tokensB = tokenizeAddress(noZipB);
  const textScore = Math.max(
    stringSimilarity(normA, normB),
    stringSimilarity(noZipA, noZipB)
  );
  const tokenScore = tokenSetSimilarity(tokensA, tokensB);
  return (textScore * 0.72) + (tokenScore * 0.28);
}

export function addressesLikelySameLocation(a, b, threshold = 0.72) {
  return scoreAddressSimilarity(a, b) >= threshold;
}

/**
 * Extracts the first recognizable 10-digit phone number from OCR text.
 * Returns the digits-only string (e.g. "5031234567") or "" if none found.
 */
export function extractPhoneFromText(text) {
  // Match common formats: (503) 555-1234 | 503-555-1234 | 503.555.1234 | 5035551234
  const phonePattern = /\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g;
  const matches = String(text || "").match(phonePattern);
  if (!matches) {
    return "";
  }
  // Return the first match as digits only
  return matches[0].replace(/\D/g, "");
}

export function scoreNameSimilarity(a, b) {
  const normA = String(a || "").trim().toLowerCase();
  const normB = String(b || "").trim().toLowerCase();
  if (!normA || !normB) {
    return 0;
  }
  if (normA === normB) {
    return 1;
  }
  // Prefix containment: e.g. "la mota" vs "la mota northeast portland"
  if (normA.startsWith(normB) || normB.startsWith(normA)) {
    const shorter = Math.min(normA.length, normB.length);
    const longer = Math.max(normA.length, normB.length);
    return 0.80 + (0.20 * (shorter / longer));
  }
  const tokensA = normA.split(/\s+/).filter((t) => t.length >= 2);
  const tokensB = normB.split(/\s+/).filter((t) => t.length >= 2);
  const textScore = stringSimilarity(normA, normB);
  const tokenScore = tokenSetSimilarity(tokensA, tokensB);
  return (textScore * 0.60) + (tokenScore * 0.40);
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
