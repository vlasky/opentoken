import { analyzeContent, getCompressionPipeline } from "./router";
import { logError } from "./utils/errors";
import { logger } from "./utils/logger";
import { estimateTokens } from "./utils/tokens";

export function safeEstimateTokens(text: string): number {
	try {
		return estimateTokens(text);
	} catch {
		logger.debug(
			undefined,
			"tokens.estimate",
			"Token estimation failed, using fallback",
		);
		return Math.ceil(text.length * 0.25); // Fallback estimation
	}
}

// ─── SAFE PIPELINE WRAPPER ───

// Wraps each pipeline stage with error handling — if a stage fails, log and continue
export function safeStage<T>(
	name: string,
	fn: () => T,
	fallback: T,
	sessionID?: string,
): T {
	try {
		return fn();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		logError({
			ts: new Date().toISOString(),
			stage: name,
			tool: "unknown",
			sessionID,
			error: msg,
			stack,
			recoverable: true,
		});
		return fallback;
	}
}

export async function safeStageAsync<T>(
	name: string,
	fn: () => T | Promise<T>,
	fallback: T,
	sessionID?: string,
): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		logError({
			ts: new Date().toISOString(),
			stage: name,
			tool: "unknown",
			sessionID,
			error: msg,
			stack,
			recoverable: true,
		});
		return fallback;
	}
}

// ─── HELPERS ───

// LOSSLESS_LINE_THRESHOLD controls entry to lossless stages (ANSI strip, log fold, whitespace).
// Hard truncation cap stays at SHORT_OUTPUT_THRESHOLD (80) in the generic filter.
// This split ensures medium outputs (40-80 lines) get cleaned without risk of truncation.
const LOSSLESS_LINE_THRESHOLD = 15;
const MAX_OUTPUT_LENGTH = 5000;

export function shouldSkipFilter(output: string): boolean {
	const lines = output.split("\n");
	return (
		lines.length < LOSSLESS_LINE_THRESHOLD && output.length < MAX_OUTPUT_LENGTH
	);
}

export function hasErrors(output: string): boolean {
	const errorPatterns = [
		/error\[/i,
		/error:/i,
		/fatal:/i,
		/FAILED/i,
		/panic:/i,
		/traceback/i,
		/SyntaxError/i,
		/TypeError/i,
		/ReferenceError/i,
		/ENOENT/i,
		/EACCES/i,
		/EPERM/i,
		/MODULE_NOT_FOUND/i,
		/--- FAIL:/i,
		/assertion/i,
		/stack trace/i,
	];
	return errorPatterns.some((p) => p.test(output));
}

// Data-loss guard: a stage must not report "nothing here" when the input
// clearly had content. Token accounting can't catch this — "(no matches)" has
// fewer tokens than 26 real grep hits, so a token-only check happily keeps it.
//
// The guard is deliberately narrow: it fires only when the result is a short
// "emptiness claim" (e.g. "(no matches)", "0 results") AND the input had many
// distinct lines. This spares legitimate aggressive summarization — a filter
// turning 50 npm lines into "Added 150 packages" is not claiming emptiness, so
// it is left alone — while rejecting a filter that loses real content to a
// nothing-found sentinel.
const NEAR_EMPTY_CHARS = 32;
const MIN_DISTINCT_LINES = 5;
const EMPTINESS_CLAIM =
	/^\(?\s*(no\b|none\b|empty\b|nothing\b|0\s+(matches|results|files|entries|rows|lines))/i;

export function isSuspiciousDataLoss(
	original: string,
	filtered: string,
): boolean {
	const f = filtered.trim();
	if (f.length >= NEAR_EMPTY_CHARS) return false;
	if (!EMPTINESS_CLAIM.test(f)) return false;
	const distinct = new Set<string>();
	for (const line of original.split("\n")) {
		const t = line.trim();
		if (t.length > 0) distinct.add(t);
	}
	return distinct.size >= MIN_DISTINCT_LINES;
}

export function conservativeFilter(original: string, filtered: string): string {
	// Correctness over token savings: never emit a near-empty result when the
	// input carried many distinct lines (almost certainly destroyed data).
	if (isSuspiciousDataLoss(original, filtered)) return original;
	const origTokens = safeEstimateTokens(original);
	const filtTokens = safeEstimateTokens(filtered);
	if (filtTokens >= origTokens) return original;
	return filtered;
}

// ─── CONTENT-AWARE ROUTER ───

export function routeContent(
	content: string,
	filePath?: string,
): {
	pipeline: string[];
	analysis: ReturnType<typeof analyzeContent>;
} {
	const analysis = safeStage(
		"analyzeContent",
		() => analyzeContent(content, filePath),
		{
			type: "text" as const,
			language: "unknown" as const,
			size: 0,
			lines: 0,
			isStructured: false,
			hasErrors: false,
			isRepetitive: false,
			compressionCandidates: [],
		},
	);
	const pipeline = getCompressionPipeline(analysis);
	return { pipeline, analysis };
}
