import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const cli = path.join(root, "packages/cli/src/cli.ts");

// Run `opentoken wrap <parts...>`. `parts` are passed as separate argv entries
// (the CLI spawns parts[0] with shell:false), so wrap them in `bash -c '<script>'`
// to exercise real shell behaviour.
function wrap(parts: string[], opts: { timeoutMs?: number } = {}) {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "otk-wrap-"));
	const proc = spawnSync("bun", [cli, "wrap", ...parts], {
		cwd: root,
		encoding: "utf8",
		timeout: opts.timeoutMs ?? 30000,
		maxBuffer: 256 * 1024 * 1024,
		env: { ...process.env, XDG_CONFIG_HOME: temp, XDG_DATA_HOME: temp },
	});
	return proc;
}

describe("opentoken wrap", () => {
	it("propagates a nonzero exit code when the command produces no stdout", () => {
		const r = wrap(["bash", "-c", "exit 7"]);
		expect(r.status).toBe(7);
		expect(r.stdout).toBe("");
	});

	it("propagates a nonzero exit code when the command also writes stdout", () => {
		const r = wrap(["bash", "-c", "echo out; exit 3"]);
		expect(r.status).toBe(3);
		expect(r.stdout).toContain("out");
	});

	it("returns exit 0 and the (transformed) stdout on success", () => {
		const r = wrap(["bash", "-c", "echo hello"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("hello");
	});

	it("passes stderr through untouched", () => {
		const r = wrap(["bash", "-c", "echo to-stderr 1>&2"]);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("to-stderr");
		expect(r.stdout).toBe(""); // nothing on stdout
	});

	it("does not deadlock on high-volume stderr (concurrent drain)", () => {
		// The child fills the stderr pipe buffer (>64KB) before writing stdout.
		// A sequential drain (stdout-then-stderr) would deadlock here; concurrent
		// draining must let it complete.
		const start = Date.now();
		const r = wrap(
			["bash", "-c", "for i in $(seq 1 20000); do echo line $i 1>&2; done; echo DONE"],
			{ timeoutMs: 20000 },
		);
		const elapsed = Date.now() - start;
		expect(r.signal).toBeNull(); // not killed by the spawn timeout
		expect(elapsed).toBeLessThan(20000);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("DONE");
		expect(r.stderr).toContain("line 1");
		expect(r.stderr).toContain("line 20000");
	});

	it("compresses verbose stdout (transform is applied)", () => {
		// 60 identical lines fold; output must be smaller than the raw input.
		const r = wrap(["bash", "-c", "for i in $(seq 1 60); do echo repeated-line; done"]);
		expect(r.status).toBe(0);
		expect(r.stdout.length).toBeGreaterThan(0);
		expect(r.stdout.length).toBeLessThan("repeated-line\n".length * 60);
	});
});
