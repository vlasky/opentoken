// LZW-Style Token Substitution — Lossless Repetitive Content Compression
// Finds high-frequency repeated substrings, replaces with single-token markers,
// prepends a lightweight dictionary. Fully lossless, zero quality risk.
// 20-40% savings on repetitive output (stack traces, error logs, test output).

import {
	type FoundRepeat,
	findRepeatedSpans,
	hasSufficientRepetition,
} from "./utils/repeats";

const MIN_SUBSTRING_LEN = 8; // Minimum repeated substring length (chars)
const MAX_DICT_SIZE = 30; // Maximum dictionary entries
const MIN_OCCURRENCES = 2; // Minimum times a substring must appear
const MAX_WINDOW = 120; // Max substring length to dictionary-code
const MAX_CANDIDATES = 400;
const MAX_INPUT_LEN = 50_000; // Guard: skip the scan for oversized inputs

interface DictEntry {
	id: string;
	original: string;
	positions: number[];
	count: number;
	savings: number;
}

function entrySavings(len: number, occurrences: number): number {
	const markerLen = 2; // $1, $2, …
	const dictEntryLen = 4 + len; // "$N = str\n"
	return occurrences * len - (occurrences * markerLen + dictEntryLen);
}

// Find repeated substrings worth dictionary-coding (fast seed-and-extend).
function findRepeatedSubstrings(text: string): DictEntry[] {
	const spans: FoundRepeat[] = findRepeatedSpans(text, {
		seedLen: MIN_SUBSTRING_LEN,
		maxLen: MAX_WINDOW,
		minRepeats: MIN_OCCURRENCES,
		maxCandidates: MAX_CANDIDATES,
	});

	const entries: DictEntry[] = [];
	for (const { str, positions } of spans) {
		if (/^[\s\-_=]+$/.test(str)) continue; // skip whitespace/punctuation runs
		const savings = entrySavings(str.length, positions.length);
		if (savings > 0) {
			entries.push({
				id: "",
				original: str,
				positions,
				count: positions.length,
				savings,
			});
		}
	}
	entries.sort((a, b) => b.savings - a.savings);
	return entries;
}

// Select non-overlapping entries (greedy, highest savings first). Uses the
// occurrence positions from the finder — no O(n²) re-scan of the text.
function selectNonOverlapping(entries: DictEntry[]): DictEntry[] {
	const selected: DictEntry[] = [];
	const used = new Set<number>();

	for (const entry of entries) {
		if (selected.length >= MAX_DICT_SIZE) break;
		const len = entry.original.length;
		const nonOverlapping: number[] = [];

		for (const pos of entry.positions) {
			let overlaps = false;
			for (let j = 0; j < len; j++) {
				if (used.has(pos + j)) {
					overlaps = true;
					break;
				}
			}
			if (!overlaps) nonOverlapping.push(pos);
		}

		if (nonOverlapping.length >= MIN_OCCURRENCES) {
			const savings = entrySavings(len, nonOverlapping.length);
			if (savings > 0) {
				for (const pos of nonOverlapping) {
					for (let j = 0; j < len; j++) used.add(pos + j);
				}
				entry.positions = nonOverlapping;
				entry.count = nonOverlapping.length;
				entry.savings = savings;
				selected.push(entry);
			}
		}
	}

	return selected;
}

export function compressLZW(text: string): {
	compressed: boolean;
	result: string;
	savings: number;
} {
	const originalLength = text.length;

	if (originalLength > MAX_INPUT_LEN) {
		return { compressed: false, result: text, savings: 0 };
	}

	// Narrow: skip the scan for non-compressible input
	if (!hasSufficientRepetition(text, MIN_SUBSTRING_LEN)) {
		return { compressed: false, result: text, savings: 0 };
	}

	// Find repeated substrings
	const entries = findRepeatedSubstrings(text);
	if (entries.length === 0) {
		return { compressed: false, result: text, savings: 0 };
	}

	// Select non-overlapping entries
	const selected = selectNonOverlapping(entries);
	if (selected.length === 0) {
		return { compressed: false, result: text, savings: 0 };
	}

	// Assign IDs and build dictionary
	const dict: string[] = [];
	const replacements: Array<{ pos: number; len: number; marker: string }> = [];

	for (let i = 0; i < selected.length; i++) {
		const id = `$${i + 1}`;
		selected[i].id = id;
		dict.push(`${id} = ${selected[i].original}`);
	}

	// Build replacements directly from the selected (non-overlapping) positions.
	for (const entry of selected) {
		for (const pos of entry.positions) {
			replacements.push({ pos, len: entry.original.length, marker: entry.id });
		}
	}

	replacements.sort((a, b) => b.pos - a.pos);

	// Apply replacements
	let compressed = text;
	for (const rep of replacements) {
		compressed =
			compressed.slice(0, rep.pos) +
			rep.marker +
			compressed.slice(rep.pos + rep.len);
	}

	// Prepend dictionary
	const dictBlock = `[OpenToken Dictionary]\n${dict.join("\n")}\n\n`;
	const result = dictBlock + compressed;

	const savings = originalLength - result.length;

	// Only return compressed if it's actually smaller
	if (savings <= 0) {
		return { compressed: false, result: text, savings: 0 };
	}

	// Losslessness guarantee: if a marker/dictionary entry collides with the
	// content, bail to the original rather than emit corrupted output.
	if (decompressLZW(result) !== text) {
		return { compressed: false, result: text, savings: 0 };
	}

	return { compressed: true, result, savings };
}

// Decompress LZW (for verification/testing)
export function decompressLZW(text: string): string {
	const dictMatch = text.match(/^\[OpenToken Dictionary\]\n(.+?)\n\n/s);
	if (!dictMatch) return text;

	const dictLines = dictMatch[1].split("\n");
	const dict = new Map<string, string>();

	for (const line of dictLines) {
		const match = line.match(/^(\$\d+) = (.+)$/);
		if (match) {
			dict.set(match[1], match[2]);
		}
	}

	let result = text.slice(dictMatch[0].length);
	for (const [marker, original] of dict) {
		result = result.split(marker).join(original);
	}

	return result;
}
