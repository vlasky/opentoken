import { describe, expect, it } from "bun:test";
import { compressLTSC, decompressLTSC } from "@mrgray17/opentoken-core/ltsc";
import { compressLZW, decompressLZW } from "@mrgray17/opentoken-core/lzw";

// Seeded PRNG for reproducible fuzzing.
function rng(seed: number) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Build varied inputs: repetitive spans, paths, words, whitespace — but no `$`
// or dictionary-header text, so we test the lossless domain the coders target
// (literal `$N`/header collisions are a separate, pre-existing limitation).
function makeInput(rand: () => number): string {
	const fragments = [
		"packages/core/src/families/git.ts:12: export function filter",
		"    at Object.<anonymous> (/Users/dev/app/node_modules/pkg/lib/index.js:42:9)",
		"[INFO] task completed in 1234ms with status ok and cache hit",
		"the quick brown fox jumps over the lazy dog near the river bank",
		"abcdefghij klmnopqrst uvwxyz0123 456789ABCD EFGHIJKLMN",
		"  ",
		"\n",
	];
	const n = 3 + Math.floor(rand() * 60);
	let out = "";
	for (let i = 0; i < n; i++) {
		out += fragments[Math.floor(rand() * fragments.length)];
		if (rand() < 0.5) out += `-${Math.floor(rand() * 1000)}`;
		out += rand() < 0.7 ? "\n" : " ";
	}
	return out;
}

describe("LTSC/LZW fast finder — lossless roundtrip (fuzz)", () => {
	// What the consumer gets back must always equal the input: the decompressed
	// result when compressed, or the original (untouched) when not.
	const ltscRecover = (x: string) => {
		const r = compressLTSC(x);
		return r.compressed ? decompressLTSC(r.result) : r.result;
	};
	const lzwRecover = (x: string) => {
		const r = compressLZW(x);
		return r.compressed ? decompressLZW(r.result) : r.result;
	};

	it("LTSC roundtrips 200 varied inputs", () => {
		const rand = rng(1);
		for (let i = 0; i < 200; i++) {
			const input = makeInput(rand);
			expect(ltscRecover(input)).toBe(input);
		}
	});

	it("LZW roundtrips 200 varied inputs", () => {
		const rand = rng(2);
		for (let i = 0; i < 200; i++) {
			const input = makeInput(rand);
			expect(lzwRecover(input)).toBe(input);
		}
	});

	it("never corrupts on marker/delimiter collisions (self-check bails)", () => {
		// Literal $N markers, comma-heavy (LTSC dict delimiter), header-like text:
		// the lossless self-check must make compress bail rather than corrupt.
		const adversarial = [
			"price is $1,$2,$3 and $10 each, repeated price is $1,$2,$3 and $10 each",
			"a,b,c,d,e,f,g,h,i,j,k,l,m,a,b,c,d,e,f,g,h,i,j,k,l,m,a,b,c,d,e,f,g,h,i,j",
			'{"x":"v","y":"v","z":"v","x":"v","y":"v","z":"v","x":"v","y":"v","z":"v"}',
			"$1$1$1$1$1$1$1$1$1$1$1$1 some text $1$1$1$1$1$1$1$1$1$1$1$1 more text",
		];
		for (const a of adversarial) {
			expect(ltscRecover(a)).toBe(a);
			expect(lzwRecover(a)).toBe(a);
		}
	});

	it("compresses highly repetitive content (the target niche)", () => {
		const log = Array.from(
			{ length: 200 },
			(_, i) => `[build] compiling module src/components/widget${i % 20}/index.tsx ... ok`,
		).join("\n");
		const ltsc = compressLTSC(log);
		const lzw = compressLZW(log);
		expect(ltsc.compressed || lzw.compressed).toBe(true);
		expect(decompressLTSC(ltsc.result)).toBe(log);
		expect(decompressLZW(lzw.result)).toBe(log);
	});

	it("does not hang on large repetitive input (perf regression guard)", () => {
		// Previously: LTSC ~2.9s, LZW ~85s on this size. Must now be fast.
		const big = Array.from(
			{ length: 600 },
			(_, i) => `2026-06-01T10:00:${i % 60} INFO request id=req-${i % 50} path=/api/v1/users status=200 took=${i % 999}ms`,
		).join("\n");
		const t1 = Date.now();
		compressLTSC(big);
		const ltscMs = Date.now() - t1;
		const t2 = Date.now();
		compressLZW(big);
		const lzwMs = Date.now() - t2;
		expect(ltscMs).toBeLessThan(1000);
		expect(lzwMs).toBeLessThan(1000);
	});

	it("bails fast (no compression) on non-repetitive input", () => {
		const unique = "Hello world, this is unique prose with little repetition at all.";
		expect(compressLTSC(unique).compressed).toBe(false);
		expect(compressLZW(unique).compressed).toBe(false);
	});
});
