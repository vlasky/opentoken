#!/usr/bin/env bun
// OpenToken PreToolUse hook for Claude Code (Bash only).
//
// Claude Code's PostToolUse hooks cannot rewrite tool output, so transparent
// output compression is achieved here, before execution: the Bash command is
// rewritten to run through `opentoken wrap`, which executes the real command
// and compresses its stdout. Claude Code then captures the already-compressed
// output. This is the same mechanism RTK uses for its Claude Code integration.
//
// This behaviour is specific to the Claude Code hook. Other harnesses
// (OpenCode plugin, MCP server, the CLI itself) are untouched.
//
// The hook is fail-open: any error (including a failed dynamic import) results
// in a clean pass-through so a compression bug can never block the agent.

// ─── stdin / stdout ───

async function readStdin() {
	let input = "";
	for await (const chunk of Bun.stdin.stream()) {
		input += new TextDecoder().decode(chunk);
	}
	return input.trim() ? JSON.parse(input) : {};
}

function writeJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

// ─── opentoken CLI resolution ───
// Prefer a globally-installed `opentoken`; fall back to running the workspace
// CLI entry through bun. If neither resolves, the hook passes through silently.

function resolveOpentoken() {
	const onPath = Bun.which("opentoken");
	if (onPath) return "opentoken";
	try {
		const url = import.meta.resolve("@mrgray17/opentoken-cli/src/cli.ts");
		const cliPath = url.startsWith("file:") ? Bun.fileURLToPath(url) : url;
		return `bun ${JSON.stringify(cliPath)}`;
	} catch {
		return null;
	}
}

// ─── command shape detection ───

// Shell operators that change command structure when the line is prefixed with
// `opentoken wrap `. Quotes, globs and `$VAR` are intentionally NOT listed —
// the outer shell expands those and `opentoken wrap` receives correct argv.
const SHELL_OPERATORS = /[|&;<>`()\n]|\$\(/;
// Leading environment assignment, e.g. `FOO=1 cmd` — breaks bare prefixing.
const LEADING_ASSIGN = /^\s*\w+=/;

function isComplex(command) {
	return SHELL_OPERATORS.test(command) || LEADING_ASSIGN.test(command);
}

// Command / process substitution and backticks. We cannot reason about which
// commands execute inside these without a real shell parser, so permission
// mirroring (deny/allow) would be unsound — e.g. `ls $(curl evil)` looks like
// an allowed `ls` but runs a denied `curl`. Such commands are passed through
// untouched so Claude Code applies its native permission handling to them.
const SUBSTITUTION = /\$\(|`|<\(|>\(/;

// Shell builtins / keywords that have no executable of the same name. `wrap`
// runs the command with `spawn(..., { shell: false })`, so these must go
// through `bash -c` or they fail with ENOENT (e.g. `command -v node`).
const SHELL_ONLY = new Set([
	"source",
	".",
	"command",
	"eval",
	"exec",
	"declare",
	"local",
	"let",
	"read",
	"mapfile",
	"readarray",
	"builtin",
	"shopt",
	"getopts",
	"hash",
	"caller",
	"compgen",
	"complete",
	"enable",
	"bind",
	"trap",
	"wait",
	"times",
	"ulimit",
	"if",
	"for",
	"while",
	"until",
	"case",
	"function",
	"time",
]);

function firstWord(command) {
	return command.trim().split(/\s+/)[0]?.split("/").pop() ?? "";
}

// A command needs a real shell (`bash -c`) when it has shell operators or its
// leading word is a builtin/keyword with no matching executable.
function needsShell(command) {
	return isComplex(command) || SHELL_ONLY.has(firstWord(command));
}

// Trivial commands with no/negligible output — not worth a wrap subprocess.
const TRIVIAL = new Set([
	"cd",
	"pwd",
	"echo",
	"export",
	"set",
	"unset",
	"true",
	"false",
	"clear",
	":",
	"alias",
	"which",
	"type",
]);

// Long-running / interactive / streaming commands. `opentoken wrap` buffers
// stdout until the child exits, so wrapping these would withhold output or
// hang — pass them through untouched.
const SKIP_PATTERNS = [
	/^\s*(vi|vim|nano|emacs|less|more|top|htop|man|ssh)\b/,
	/\btail\b[^|;&]*\s-f\b/,
	/--follow\b/,
	/\bwatch\b/,
	/\b(npm|yarn|pnpm|bun)\s+(run\s+)?(dev|serve|watch)\b/,
];

function shouldSkip(command) {
	if (command.includes("<<")) return true; // heredoc
	if (command.includes("opentoken")) return true; // already wrapped
	if (SUBSTITUTION.test(command)) return true; // unsound to mirror permissions
	if (SKIP_PATTERNS.some((re) => re.test(command))) return true;
	return TRIVIAL.has(firstWord(command));
}

// ─── permission rules (deny > ask > allow > default) ───
// Mirror the user's existing Claude Code Bash permission posture so the rewrite
// neither bypasses a deny rule nor nags on already-allowed commands.

function settingsPaths(projectDir) {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return [
		`${projectDir}/.claude/settings.json`,
		`${projectDir}/.claude/settings.local.json`,
		home ? `${home}/.claude/settings.json` : "",
	].filter(Boolean);
}

function bashPrefixes(rules) {
	const out = [];
	for (const rule of rules ?? []) {
		if (typeof rule !== "string") continue;
		const m = rule.match(/^Bash\((.*)\)$/);
		if (!m) continue;
		out.push(m[1].replace(/:\*$/, "").trim());
	}
	return out;
}

async function loadRules(projectDir) {
	const deny = [];
	const ask = [];
	const allow = [];
	for (const path of settingsPaths(projectDir)) {
		try {
			const file = Bun.file(path);
			if (!(await file.exists())) continue;
			const perms = JSON.parse(await file.text())?.permissions ?? {};
			deny.push(...bashPrefixes(perms.deny));
			ask.push(...bashPrefixes(perms.ask));
			allow.push(...bashPrefixes(perms.allow));
		} catch {
			// Unreadable/invalid settings → ignore this file (fail safe: no allow).
		}
	}
	return { deny, ask, allow };
}

function prefixMatch(command, prefix) {
	if (prefix === "" || prefix === "*") return true;
	const cmd = command.trim();
	return cmd === prefix || cmd.startsWith(`${prefix} `);
}

// Split on shell operators so a denied sub-command (e.g. `a && curl evil`) is caught.
function segments(command) {
	return command.split(/&&|\|\||[|;&\n]/).map((s) => s.trim());
}

function classify(command, rules) {
	const segs = segments(command);
	if (segs.some((seg) => rules.deny.some((p) => prefixMatch(seg, p)))) {
		return "deny";
	}
	if (segs.some((seg) => rules.ask.some((p) => prefixMatch(seg, p)))) {
		return "ask";
	}
	if (rules.allow.some((p) => prefixMatch(command, p))) return "allow";
	return "default";
}

// ─── wrapped command construction ───

function singleQuote(s) {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

// Disable the marker-based dictionary compression (LTSC/LZW/abbreviation) for
// the Claude Code path: a benchmark showed it adds little real token savings on
// typical tool output while forcing the model to decode `$N` legends (and risking
// the markers leaking into tool calls). The lossless noise removal and legible
// folding still run.
const NO_DICT = "OPENTOKEN_NO_DICT=1 ";

function buildWrapped(otk, command, rewriteCommand) {
	if (needsShell(command)) {
		// Compound command or shell builtin: wrap the original verbatim through a
		// real shell. `rewriteCommand` assumes a single command — its append-style
		// rules (`<cmd> --silent`) would attach flags to the wrong sub-command
		// across operators, so it is skipped here. The `wrap` pipeline still
		// compresses the output; content routing folds diffs/logs regardless.
		return `${NO_DICT}${otk} wrap bash -c ${singleQuote(command)}`;
	}
	// Simple command: apply quiet-flag rewrites, then prefix directly so family
	// detection sees the real command.
	return `${NO_DICT}${otk} wrap ${rewriteCommand(command)}`;
}

// ─── main ───

try {
	if (process.env.OPENTOKEN_CLAUDE_HOOKS === "0") process.exit(0);

	const event = await readStdin();
	if (event.hook_event_name !== "PreToolUse" || event.tool_name !== "Bash") {
		process.exit(0);
	}

	const toolInput = event.tool_input ?? {};
	const command =
		typeof toolInput.command === "string" ? toolInput.command : "";
	if (!command || shouldSkip(command)) process.exit(0);

	const otk = resolveOpentoken();
	if (!otk) process.exit(0); // opentoken CLI unavailable → pass through

	// Dynamic import: if core cannot be resolved, the catch below fails open
	// rather than crashing the module load and blocking the agent.
	const { rewriteCommand } = await import("@mrgray17/opentoken-core/precall");

	const projectDir =
		process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd();
	const rules = await loadRules(projectDir);
	const verdict = classify(command, rules);

	// Deny: do not rewrite. Let Claude Code's native deny rule handle the
	// original command — wrapping it would evade the deny matcher.
	if (verdict === "deny") process.exit(0);

	const wrapped = buildWrapped(otk, command, rewriteCommand);

	const hookSpecificOutput = {
		hookEventName: "PreToolUse",
		updatedInput: { ...toolInput, command: wrapped },
	};

	// Only auto-allow when the user already allowed the original command.
	// ask / default fall through to Claude Code's normal permission prompt.
	if (verdict === "allow") {
		hookSpecificOutput.permissionDecision = "allow";
		hookSpecificOutput.permissionDecisionReason =
			"OpenToken wrapped this command to compress its output.";
	}

	writeJson({ hookSpecificOutput });
} catch (err) {
	// Fail open: log for debugging but exit 0 so the original command runs
	// untouched. A compression hook must never block the agent.
	const msg = err instanceof Error ? err.message : String(err);
	process.stderr.write(`opentoken pretool hook: ${msg}\n`);
	process.exit(0);
}
