// Fast repeated-substring finder shared by LTSC and LZW.
//
// Replaces the previous O(n·window) approach (enumerate every substring of every
// length into a map) with an O(n) seed-and-extend pass: index fixed-length
// "seed" windows once, then for each seed that repeats, extend all of its
// occurrences in lockstep to the longest common span. Returns occurrence
// positions so callers never have to re-scan the text.

export interface FoundRepeat {
	str: string;
	positions: number[]; // ascending; every position is an occurrence of `str`
}

export interface RepeatOptions {
	seedLen: number; // window size to seed on (minimum repeat length)
	maxLen: number; // cap on extended span length
	minRepeats: number; // minimum occurrences to qualify
	maxCandidates?: number; // cap distinct candidates returned (by raw length)
}

// Fast O(n) pre-check: sample positions and bail when the input lacks the
// repetitive structure these compressors need. Narrows the work to content that
// can actually benefit, skipping the heavier scan on non-repetitive output.
export function hasSufficientRepetition(
	text: string,
	seedLen: number,
	minRatio = 0.03,
): boolean {
	const maxPos = text.length - seedLen;
	if (maxPos <= 0) return false;
	const step = Math.max(1, Math.floor(maxPos / 500));
	const seen = new Set<string>();
	let repeated = 0;
	let total = 0;
	for (let i = 0; i <= maxPos; i += step) {
		const sub = text.slice(i, i + seedLen);
		if (sub.includes("\n")) continue;
		if (/^[\s\-_=]+$/.test(sub)) continue;
		total++;
		if (seen.has(sub)) repeated++;
		else seen.add(sub);
	}
	return total > 0 && repeated / total >= minRatio;
}

export function findRepeatedSpans(
	text: string,
	opts: RepeatOptions,
): FoundRepeat[] {
	const { seedLen, maxLen, minRepeats } = opts;
	const n = text.length;
	if (n < seedLen * minRepeats) return [];

	// 1. Index every seed-length window by content → occurrence positions. O(n).
	const index = new Map<string, number[]>();
	for (let i = 0; i + seedLen <= n; i++) {
		const seed = text.slice(i, i + seedLen);
		if (seed.includes("\n")) continue;
		const arr = index.get(seed);
		if (arr) arr.push(i);
		else index.set(seed, [i]);
	}

	// 2. For each repeated seed, lockstep-extend all occurrences to the longest
	//    common span (bounded by maxLen, stopping at a newline or any divergence).
	const repeats: FoundRepeat[] = [];
	const seenStr = new Set<string>();
	for (const positions of index.values()) {
		if (positions.length < minRepeats) continue;
		const base = positions[0];
		let len = seedLen;
		while (len < maxLen) {
			const refIdx = base + len;
			if (refIdx >= n) break;
			const c = text[refIdx];
			if (c === "\n") break;
			let allMatch = true;
			for (let k = 1; k < positions.length; k++) {
				const idx = positions[k] + len;
				if (idx >= n || text[idx] !== c) {
					allMatch = false;
					break;
				}
			}
			if (!allMatch) break;
			len++;
		}
		const str = text.slice(base, base + len);
		if (seenStr.has(str)) continue;
		seenStr.add(str);
		repeats.push({ str, positions: positions.slice() });
	}

	// Longest spans first — they carry the most savings and, when selected,
	// block the most overlapping shorter candidates.
	repeats.sort((a, b) => b.str.length - a.str.length);
	if (opts.maxCandidates && repeats.length > opts.maxCandidates) {
		repeats.length = opts.maxCandidates;
	}
	return repeats;
}
