import { describe, expect, it } from "bun:test";
import {
	applyBashFilter,
	conservativeFilter,
	isSuspiciousDataLoss,
} from "@mrgray17/opentoken-core";

// Rec 2 — the data-loss guard inside conservativeFilter.
describe("isSuspiciousDataLoss", () => {
	const manyDistinct = Array.from(
		{ length: 12 },
		(_, i) => `src/file${i}.ts:${i}: distinct line number ${i} here`,
	).join("\n");

	it("flags a near-empty result when the input had many distinct lines", () => {
		expect(isSuspiciousDataLoss(manyDistinct, "(no matches)")).toBe(true);
	});

	it("does NOT flag legitimate aggressive summarization", () => {
		// A filter turning 50 npm lines into a short summary is not claiming
		// emptiness — it must not be reverted.
		expect(isSuspiciousDataLoss(manyDistinct, "Added 150 packages")).toBe(false);
		expect(isSuspiciousDataLoss(manyDistinct, "12 files changed")).toBe(false);
	});

	it("does NOT flag legitimate redundancy folding", () => {
		const redundant = Array.from({ length: 1000 }, () => "same line").join("\n");
		expect(isSuspiciousDataLoss(redundant, "1000 x same line")).toBe(false);
	});

	it("flags other emptiness claims (0 results)", () => {
		expect(isSuspiciousDataLoss(manyDistinct, "0 results")).toBe(true);
	});

	it("does NOT flag a substantial result", () => {
		expect(isSuspiciousDataLoss(manyDistinct, manyDistinct)).toBe(false);
	});

	it("conservativeFilter returns the original instead of a near-empty result", () => {
		expect(conservativeFilter(manyDistinct, "(no matches)")).toBe(manyDistinct);
	});
});

// Rec 1 — grep/rg output is parsed before the generic normalizers, so real
// matches are never collapsed to "(no matches)".
describe("applyBashFilter grep ordering (regression)", () => {
	const rgOutput = Array.from({ length: 26 }, (_, i) => {
		const fams = ["git", "npm", "cargo", "docker", "pip", "make", "test", "fs"];
		const name = fams[i % fams.length];
		return `packages/core/src/families/${name}.ts:${10 + i}:export function filter${name}Output(cmd: string, output: string): string {`;
	}).join("\n");

	it("does not collapse real rg matches to (no matches)", async () => {
		const result = await applyBashFilter("t", "rg --no-heading -n export", rgOutput);
		expect(result.trim()).not.toBe("(no matches)");
		expect(result.length).toBeGreaterThan(50);
	});

	it("preserves the match count header", async () => {
		const result = await applyBashFilter("t", "rg -n export", rgOutput);
		expect(result).toContain("26 matches");
	});

	it("returns empty output when grep genuinely matched nothing", async () => {
		// Real `rg`/`grep` with no matches prints nothing — the pipeline passes
		// the empty output straight through (no false "(no matches)" inflation).
		const result = await applyBashFilter("t", "rg -n needle", "");
		expect(result.trim()).toBe("");
	});
});
