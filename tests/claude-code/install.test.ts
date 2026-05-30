import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const bin = path.join(root, "packages/claude-code/bin/opentoken-claude-code.mjs");

function run(args: string[], dir: string) {
	const proc = spawnSync("bun", [bin, ...args, "--dir", dir], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, HOME: dir },
	});
	return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

function tmp() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "otk-install-"));
}

function settingsFile(dir: string) {
	return path.join(dir, ".claude", "settings.json");
}

function readSettings(dir: string) {
	return JSON.parse(fs.readFileSync(settingsFile(dir), "utf8"));
}

function preToolUseCommands(settings: any): string[] {
	return (settings.hooks?.PreToolUse ?? []).flatMap((b: any) =>
		(b.hooks ?? []).map((h: any) => h.command),
	);
}

describe("opentoken-claude-code installer", () => {
	it("installs into a project with no prior settings", () => {
		const dir = tmp();
		const r = run(["install"], dir);
		expect(r.status).toBe(0);
		const cmds = preToolUseCommands(readSettings(dir));
		expect(cmds.length).toBe(1);
		expect(cmds[0]).toContain("pretool-rewrite.mjs");
	});

	it("preserves existing unrelated settings and hooks", () => {
		const dir = tmp();
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			settingsFile(dir),
			JSON.stringify({
				permissions: { allow: ["Bash(git status:*)"] },
				hooks: {
					PreToolUse: [
						{
							matcher: "Write",
							hooks: [{ type: "command", command: "my-own-hook.sh" }],
						},
					],
					PostToolUse: [
						{ matcher: "Edit", hooks: [{ type: "command", command: "fmt.sh" }] },
					],
				},
			}),
		);
		run(["install"], dir);
		const s = readSettings(dir);
		expect(s.permissions.allow).toEqual(["Bash(git status:*)"]);
		expect(s.hooks.PostToolUse[0].hooks[0].command).toBe("fmt.sh");
		const cmds = preToolUseCommands(s);
		expect(cmds).toContain("my-own-hook.sh"); // user's hook untouched
		expect(cmds.some((c) => c.includes("pretool-rewrite.mjs"))).toBe(true);
	});

	it("is idempotent — re-installing does not duplicate", () => {
		const dir = tmp();
		run(["install"], dir);
		run(["install"], dir);
		const ours = preToolUseCommands(readSettings(dir)).filter((c) =>
			c.includes("pretool-rewrite.mjs"),
		);
		expect(ours.length).toBe(1);
	});

	it("backs up a pre-existing settings file", () => {
		const dir = tmp();
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(settingsFile(dir), JSON.stringify({ model: "opus" }));
		run(["install"], dir);
		expect(fs.existsSync(`${settingsFile(dir)}.bak`)).toBe(true);
		expect(JSON.parse(fs.readFileSync(`${settingsFile(dir)}.bak`, "utf8"))).toEqual(
			{ model: "opus" },
		);
		// original key still present in the merged result
		expect(readSettings(dir).model).toBe("opus");
	});

	it("uninstall removes only our hook and keeps the rest", () => {
		const dir = tmp();
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			settingsFile(dir),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "Write",
							hooks: [{ type: "command", command: "keep-me.sh" }],
						},
					],
				},
			}),
		);
		run(["install"], dir);
		run(["uninstall"], dir);
		const cmds = preToolUseCommands(readSettings(dir));
		expect(cmds).toContain("keep-me.sh");
		expect(cmds.some((c) => c.includes("pretool-rewrite.mjs"))).toBe(false);
	});

	it("uninstall prunes empty containers when we were the only hook", () => {
		const dir = tmp();
		run(["install"], dir);
		run(["uninstall"], dir);
		const s = readSettings(dir);
		expect(s.hooks).toBeUndefined();
	});

	it("refuses to overwrite invalid JSON", () => {
		const dir = tmp();
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(settingsFile(dir), "{ this is not json ");
		const r = run(["install"], dir);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("not valid JSON");
		// untouched
		expect(fs.readFileSync(settingsFile(dir), "utf8")).toBe("{ this is not json ");
	});

	it("does not strip an unrelated user hook that shares the filename", () => {
		const dir = tmp();
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			settingsFile(dir),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "Bash",
							// same basename, but not ours (no `opentoken` in the path)
							hooks: [{ type: "command", command: "bun ./my/pretool-rewrite.mjs" }],
						},
					],
				},
			}),
		);
		run(["uninstall"], dir);
		const cmds = preToolUseCommands(readSettings(dir));
		expect(cmds).toContain("bun ./my/pretool-rewrite.mjs");
	});

	it("status reports installed vs not", () => {
		const dir = tmp();
		expect(run(["status"], dir).stdout).toContain("not installed");
		run(["install"], dir);
		expect(run(["status"], dir).stdout).toContain("installed ✓");
	});

	it("--mcp registers the server in .mcp.json without clobbering", () => {
		const dir = tmp();
		fs.writeFileSync(
			path.join(dir, ".mcp.json"),
			JSON.stringify({ mcpServers: { other: { command: "other-mcp" } } }),
		);
		run(["install", "--mcp"], dir);
		const mcp = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
		expect(mcp.mcpServers.other.command).toBe("other-mcp");
		expect(mcp.mcpServers.opentoken.command).toBe("opentoken-mcp");
	});
});
