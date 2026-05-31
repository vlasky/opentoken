import { afterEach, describe, expect, it } from "bun:test";
import { applyBashFilter } from "@mrgray17/opentoken-core";

// A repetitive stack trace: LTSC/LZW reliably produce `$N` markers + a legend
// here (long repeated path prefixes that BPE tokenizes well = real savings).
const STACKTRACE = [
	"Error: connect ECONNREFUSED 127.0.0.1:5432",
	...Array.from({ length: 20 }, (_, i) => {
		const pkgs = [
			"pg/lib/client.js",
			"pg-pool/index.js",
			"express/lib/router/index.js",
			"express/lib/router/layer.js",
			"knex/lib/runner.js",
		];
		return `    at Object.<anonymous> (/Users/dev/app/node_modules/${pkgs[i % pkgs.length]}:${100 + i}:${10 + i})`;
	}),
	"    at /Users/dev/app/src/db/connection.js:18:22",
].join("\n");

const MARKERS = /<!--LTSC|<!--LZW|\[OpenToken Dictionary\]/;

describe("OPENTOKEN_NO_DICT — Claude Code dictionary opt-out", () => {
	afterEach(() => {
		process.env.OPENTOKEN_NO_DICT = undefined;
	});

	it("emits dictionary markers by default (control)", async () => {
		process.env.OPENTOKEN_NO_DICT = undefined;
		const out = await applyBashFilter("d1", "node server.js", STACKTRACE);
		expect(out).toMatch(MARKERS);
	});

	it("emits NO dictionary markers when OPENTOKEN_NO_DICT=1", async () => {
		process.env.OPENTOKEN_NO_DICT = "1";
		const out = await applyBashFilter("d2", "node server.js", STACKTRACE);
		expect(out).not.toMatch(MARKERS);
	});

	it("still compresses (folds) the output without the dictionary layer", async () => {
		process.env.OPENTOKEN_NO_DICT = "1";
		const out = await applyBashFilter("d3", "node server.js", STACKTRACE);
		// Lossless/folding stages still run, so the result is shorter than raw
		// and the model-critical facts survive verbatim (no markers to expand).
		expect(out.length).toBeLessThan(STACKTRACE.length);
		expect(out).toContain("5432");
		expect(out).toContain("src/db/connection.js");
	});
});
