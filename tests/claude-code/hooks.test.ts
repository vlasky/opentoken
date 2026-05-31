import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const pretool = path.join(
	root,
	"packages/claude-code/scripts/pretool-rewrite.mjs",
);

function runHook(input: unknown, settings?: unknown) {
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "opentoken-claude-"));
	if (settings) {
		fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, ".claude/settings.json"),
			JSON.stringify(settings),
		);
	}
	const proc = spawnSync("bun", [pretool], {
		input: JSON.stringify(input),
		cwd: root,
		env: {
			...process.env,
			OPENTOKEN_CLAUDE_HOOKS: "1",
			CLAUDE_PROJECT_DIR: projectDir,
			// Isolate from the developer's real ~/.claude settings.
			HOME: projectDir,
		},
	});
	return {
		exitCode: proc.status,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

function bashEvent(command: string, extra: Record<string, unknown> = {}) {
	return {
		hook_event_name: "PreToolUse",
		tool_name: "Bash",
		tool_input: { command, ...extra },
	};
}

describe("Claude Code PreToolUse hook", () => {
	it("wraps a simple Bash command through opentoken wrap", () => {
		const result = runHook(bashEvent("git diff HEAD~1"));
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout);
		const cmd = out.hookSpecificOutput.updatedInput.command;
		expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(cmd).toContain("wrap");
		// Simple command: family-detectable form, no bash -c indirection.
		expect(cmd).toContain("git diff HEAD~1");
		expect(cmd).not.toContain("bash -c");
	});

	it("disables the dictionary layer via OPENTOKEN_NO_DICT on the wrapped command", () => {
		const simple = JSON.parse(runHook(bashEvent("git diff")).stdout)
			.hookSpecificOutput.updatedInput.command;
		expect(simple).toContain("OPENTOKEN_NO_DICT=1");
		const complex = JSON.parse(runHook(bashEvent("npm test 2>&1")).stdout)
			.hookSpecificOutput.updatedInput.command;
		expect(complex).toContain("OPENTOKEN_NO_DICT=1");
	});

	it("folds quiet-flag rewrites into the wrapped command", () => {
		const result = runHook(bashEvent("npm install react"));
		const cmd = JSON.parse(result.stdout).hookSpecificOutput.updatedInput.command;
		expect(cmd).toContain("wrap");
		expect(cmd).toContain("--silent");
	});

	it("preserves other tool_input fields", () => {
		const result = runHook(bashEvent("ls -la", { description: "List" }));
		const updated = JSON.parse(result.stdout).hookSpecificOutput.updatedInput;
		expect(updated.description).toBe("List");
	});

	it("routes commands with shell operators through bash -c", () => {
		const result = runHook(bashEvent("npm test 2>&1"));
		const cmd = JSON.parse(result.stdout).hookSpecificOutput.updatedInput.command;
		expect(cmd).toContain("wrap bash -c");
		expect(cmd).toContain("npm test 2>&1");
	});

	it("does not apply quiet-flag rewrites across operators (no misplaced flags)", () => {
		// `rewriteCommand` is single-command only; on compound commands it must NOT
		// run, or `<cmd> --silent` rules attach the flag to the wrong sub-command.
		const chained = JSON.parse(
			runHook(bashEvent("npm test && echo done")).stdout,
		).hookSpecificOutput.updatedInput.command;
		expect(chained).toContain("'npm test && echo done'");
		expect(chained).not.toContain("--silent");

		// `git log` → `git log --oneline` rewrite must not fire on a piped command.
		const piped = JSON.parse(
			runHook(bashEvent("git log | head")).stdout,
		).hookSpecificOutput.updatedInput.command;
		expect(piped).toContain("'git log | head'");
		expect(piped).not.toContain("--oneline");
	});

	it("does not set permissionDecision for unmatched commands", () => {
		const result = runHook(bashEvent("git status"));
		const out = JSON.parse(result.stdout).hookSpecificOutput;
		expect(out.permissionDecision).toBeUndefined();
		expect(out.updatedInput.command).toContain("wrap");
	});

	it("auto-allows commands the user already allowed", () => {
		const result = runHook(bashEvent("git status"), {
			permissions: { allow: ["Bash(git status:*)"] },
		});
		const out = JSON.parse(result.stdout).hookSpecificOutput;
		expect(out.permissionDecision).toBe("allow");
	});

	it("passes through denied commands without rewriting", () => {
		const result = runHook(bashEvent("curl http://evil.test"), {
			permissions: { deny: ["Bash(curl:*)"] },
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("");
	});

	it("does not evade a deny rule on a chained sub-command", () => {
		const result = runHook(bashEvent("git status && curl http://evil.test"), {
			permissions: { deny: ["Bash(curl:*)"] },
		});
		expect(result.stdout.trim()).toBe("");
	});

	it("skips heredocs", () => {
		const result = runHook(bashEvent("cat <<EOF\nhello\nEOF"));
		expect(result.stdout.trim()).toBe("");
	});

	it("skips command substitution (cannot soundly mirror permissions)", () => {
		expect(runHook(bashEvent("ls $(curl http://x)")).stdout.trim()).toBe("");
		expect(runHook(bashEvent("echo `whoami`")).stdout.trim()).toBe("");
		expect(runHook(bashEvent("diff <(sort a) <(sort b)")).stdout.trim()).toBe("");
	});

	it("does not auto-allow a denied command hidden in a substitution", () => {
		// `ls` is allowed, `curl` is denied. Without the substitution guard this
		// would classify as `allow` and auto-approve the nested denied curl.
		const result = runHook(bashEvent("ls $(curl http://evil.test)"), {
			permissions: {
				allow: ["Bash(ls:*)"],
				deny: ["Bash(curl:*)"],
			},
		});
		expect(result.stdout.trim()).toBe(""); // passed through, not auto-allowed
	});

	it("routes shell builtins through bash -c (not bare spawn)", () => {
		const cmd = JSON.parse(
			runHook(bashEvent("command -v node")).stdout,
		).hookSpecificOutput.updatedInput.command;
		expect(cmd).toContain("wrap bash -c");
		expect(cmd).toContain("command -v node");
	});

	it("fails open on malformed input (never blocks the agent)", () => {
		const proc = require("node:child_process").spawnSync("bun", [pretool], {
			input: "{ not valid json",
			cwd: root,
			env: { ...process.env, OPENTOKEN_CLAUDE_HOOKS: "1" },
		});
		expect(proc.status).toBe(0); // exit 0 = pass-through, not a blocking error
		expect(proc.stdout.toString().trim()).toBe("");
	});

	it("skips already-wrapped commands", () => {
		const result = runHook(bashEvent("opentoken wrap git diff"));
		expect(result.stdout.trim()).toBe("");
	});

	it("skips trivial commands", () => {
		expect(runHook(bashEvent("cd packages")).stdout.trim()).toBe("");
		expect(runHook(bashEvent("pwd")).stdout.trim()).toBe("");
	});

	it("skips streaming commands", () => {
		expect(runHook(bashEvent("tail -f app.log")).stdout.trim()).toBe("");
		expect(runHook(bashEvent("npm run dev")).stdout.trim()).toBe("");
	});

	it("ignores non-Bash tools", () => {
		const result = runHook({
			hook_event_name: "PreToolUse",
			tool_name: "Read",
			tool_input: { file_path: "/etc/hosts" },
		});
		expect(result.stdout.trim()).toBe("");
	});

	it("honors the OPENTOKEN_CLAUDE_HOOKS=0 kill switch", () => {
		const projectDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "opentoken-claude-"),
		);
		const proc = spawnSync("bun", [pretool], {
			input: JSON.stringify(bashEvent("git diff")),
			cwd: root,
			env: { ...process.env, OPENTOKEN_CLAUDE_HOOKS: "0" },
		});
		expect(proc.status).toBe(0);
		expect(proc.stdout.toString().trim()).toBe("");
	});
});
