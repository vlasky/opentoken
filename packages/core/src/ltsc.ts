// LTSC — Lossless Token Sequence Compression
// LZ77-style: finds repeated sequences, replaces with meta-tokens, prepends a
// dictionary. Fully lossless. Repeated-span discovery uses the shared O(n)
// seed-and-extend finder (utils/repeats); previously it enumerated every
// substring of every length (O(n·window)) — ~seconds on larger inputs.

import { findRepeatedSpans, hasSufficientRepetition } from "./utils/repeats";

const SEED_LEN = 8; // narrow to meaningful repeats; sub-marker spans never pay off
const MAX_DICT_SIZE = 80;
const MIN_REPEATS = 2;
const MAX_WINDOW = 512;
const MAX_CANDIDATES = 400; // bound the non-overlap selection work
const MAX_INPUT_LEN = 50_000; // Skip compression for very large outputs

interface Repeat {
	str: string;
	positions: number[];
	savings?: number;
}

// Find repeated substrings worth dictionary-coding (fast seed-and-extend).
function findRepeatedSubstrings(text: string): Repeat[] {
	const spans = findRepeatedSpans(text, {
		seedLen: SEED_LEN,
		maxLen: MAX_WINDOW,
		minRepeats: MIN_REPEATS,
		maxCandidates: MAX_CANDIDATES,
	});

	const repeats: Repeat[] = [];
	for (const { str, positions } of spans) {
		const metaTokenOverhead = 3;
		const dictEntryOverhead = 3 + str.length;
		const originalCost = positions.length * str.length;
		const replacementCost = positions.length * metaTokenOverhead;
		const savings = originalCost - replacementCost - dictEntryOverhead;
		if (savings > 0) repeats.push({ str, positions, savings });
	}

	repeats.sort((a, b) => (b.savings ?? 0) - (a.savings ?? 0));
	return repeats;
}

// Select non-overlapping repeats (greedy, best-first)
function selectNonOverlapping(repeats: Repeat[]): Repeat[] {
	const selected: Repeat[] = [];
	const usedPositions = new Set<string>();

	for (const repeat of repeats) {
		if (selected.length >= MAX_DICT_SIZE) break;

		const nonOverlappingPositions: number[] = [];
		const blockedPositions = new Set<string>();
		for (const pos of repeat.positions) {
			const key = `${pos}-${repeat.str.length}`;
			if (usedPositions.has(key)) continue;

			let overlaps = false;
			for (let i = pos; i < pos + repeat.str.length; i++) {
				if (usedPositions.has(String(i)) || blockedPositions.has(String(i))) {
					overlaps = true;
					break;
				}
			}
			if (!overlaps) {
				nonOverlappingPositions.push(pos);
				for (let i = pos; i < pos + repeat.str.length; i++) {
					blockedPositions.add(String(i));
				}
			}
		}

		if (nonOverlappingPositions.length >= MIN_REPEATS) {
			selected.push({ str: repeat.str, positions: nonOverlappingPositions });
			for (const p of nonOverlappingPositions) {
				for (let i = p; i < p + repeat.str.length; i++) {
					usedPositions.add(String(i));
				}
			}
		}
	}

	return selected;
}

// Apply compression: replace repeats with meta-tokens, prepend dictionary
export function compressLTSC(text: string): {
	compressed: boolean;
	result: string;
	savings: number;
} {
	const originalLength = text.length;

	// Skip compression for very large outputs (performance guard)
	if (originalLength > MAX_INPUT_LEN) {
		return { compressed: false, result: text, savings: 0 };
	}

	// Narrow: bail fast on input without enough repetitive structure to benefit.
	if (!hasSufficientRepetition(text, SEED_LEN)) {
		return { compressed: false, result: text, savings: 0 };
	}

	// Stage 1: Find repeated substrings
	const repeats = findRepeatedSubstrings(text);
	if (repeats.length === 0) {
		return { compressed: false, result: text, savings: 0 };
	}

	// Stage 2: Select non-overlapping repeats
	const selected = selectNonOverlapping(repeats);
	if (selected.length === 0) {
		return { compressed: false, result: text, savings: 0 };
	}

	// Stage 3: Build dictionary and replacements
	const dict: string[] = [];
	const replacements: Array<{ pos: number; len: number; token: string }> = [];

	for (let i = 0; i < selected.length; i++) {
		const token = `$${i + 1}`;
		dict.push(`${token}=${selected[i].str}`);

		for (const pos of selected[i].positions) {
			replacements.push({ pos, len: selected[i].str.length, token });
		}
	}

	// Sort by position descending (replace without offset issues)
	replacements.sort((a, b) => b.pos - a.pos);

	let compressed = text;
	for (const rep of replacements) {
		compressed =
			compressed.slice(0, rep.pos) +
			rep.token +
			compressed.slice(rep.pos + rep.len);
	}

	// Prepend dictionary as comment block (LLMs parse this format)
	const dictBlock = `<!--LTSC:${dict.join(",")}-->\n`;
	const result = dictBlock + compressed;
	const savings = originalLength - result.length;

	// Only return compressed if it's actually smaller
	if (savings <= 0) {
		return { compressed: false, result: text, savings: 0 };
	}

	// Losslessness guarantee: a dictionary entry or marker can collide with the
	// content (e.g. a stored span containing the "," dict delimiter, or a literal
	// "$N" in the input). Verify the result decompresses exactly; if not, bail to
	// the original rather than emit corrupted output. Makes "lossless" true by
	// construction instead of by assumption.
	if (decompressLTSC(result) !== text) {
		return { compressed: false, result: text, savings: 0 };
	}

	return { compressed: true, result, savings };
}

// Decompress LTSC (for verification/testing)
export function decompressLTSC(text: string): string {
	const dictMatch = text.match(/^<!--LTSC:(.+?)-->\n/);
	if (!dictMatch) return text;

	const dictStr = dictMatch[1];
	const dict = new Map<string, string>();

	for (const entry of dictStr.split(",")) {
		const eqIdx = entry.indexOf("=");
		if (eqIdx > 0) {
			dict.set(entry.slice(0, eqIdx), entry.slice(eqIdx + 1));
		}
	}

	let result = text.slice(dictMatch[0].length);
	for (const [token, str] of dict) {
		result = result.split(token).join(str);
	}

	return result;
}
