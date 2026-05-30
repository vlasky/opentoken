#!/usr/bin/env bun
// Installer for the OpenToken Claude Code hook.
//
//   opentoken-claude-code install     add the PreToolUse hook to Claude Code settings
//   opentoken-claude-code uninstall   remove it again
//   opentoken-claude-code status      report whether it is installed
//
// Settings are merged, never overwritten: existing hooks, permissions, and any
// other keys are preserved, and the prior file is backed up to `<file>.bak`.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFileSync } from "@mrgray17/opentoken-core/utils/atomic-write";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(HERE, "../scripts/pretool-rewrite.mjs");
const NM_HOOK =
	"node_modules/@mrgray17/opentoken-claude-code/scripts/pretool-rewrite.mjs";

const USAGE = `opentoken-claude-code — install the OpenToken hook for Claude Code

Usage:
  opentoken-claude-code install [options]     add the PreToolUse Bash hook
  opentoken-claude-code uninstall [options]   remove the hook
  opentoken-claude-code status [options]      show installation status

Options:
  --global        target ~/.claude/settings.json (default: ./.claude/settings.json)
  --dir <path>    project directory for a project-local install (default: cwd)
  --mcp           also register the MCP server in .mcp.json (project scope)
  -h, --help      show this help
`;

// ─── small helpers ───

function log(msg) {
	process.stdout.write(`${msg}\n`);
}
function warn(msg) {
	process.stderr.write(`⚠ ${msg}\n`);
}
function fail(msg) {
	process.stderr.write(`✗ ${msg}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const opts = { command: argv[0], global: false, mcp: false, dir: null };
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--global") opts.global = true;
		else if (a === "--mcp") opts.mcp = true;
		else if (a === "--dir") opts.dir = argv[++i];
		else if (a === "-h" || a === "--help") opts.help = true;
		else warn(`ignoring unknown option: ${a}`);
	}
	return opts;
}

// Read a JSON file, returning {} when absent. Aborts (rather than clobbering)
// when a present file is not valid JSON, so we never destroy hand-edited data.
function readJson(path) {
	if (!existsSync(path)) return {};
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		fail(`cannot read ${path}: ${err.message}`);
	}
	if (!text.trim()) return {};
	try {
		return JSON.parse(text);
	} catch {
		fail(
			`${path} is not valid JSON — fix or move it before installing (left untouched).`,
		);
	}
}

function writeJson(path, value) {
	if (existsSync(path)) {
		// Back up the prior file before replacing it.
		atomicWriteFileSync(`${path}.bak`, readFileSync(path, "utf8"), 0o644);
	} else {
		mkdirSync(dirname(path), { recursive: true });
	}
	atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 0o644);
}

function settingsPath(opts) {
	if (opts.global) return join(homedir(), ".claude", "settings.json");
	return join(resolve(opts.dir ?? process.cwd()), ".claude", "settings.json");
}

// The command string Claude Code will run. Prefer the portable
// $CLAUDE_PROJECT_DIR form when the package is installed in the target project,
// so committed settings work for teammates; otherwise an absolute path.
function hookCommand(opts) {
	if (!opts.global) {
		const projectDir = resolve(opts.dir ?? process.cwd());
		if (existsSync(join(projectDir, NM_HOOK))) {
			return `bun "$CLAUDE_PROJECT_DIR/${NM_HOOK}"`;
		}
	}
	return `bun ${JSON.stringify(HOOK_SCRIPT)}`;
}

function cliReachable() {
	if (Bun.which("opentoken")) return true;
	try {
		import.meta.resolve("@mrgray17/opentoken-cli/src/cli.ts");
		return true;
	} catch {
		return false;
	}
}

// ─── settings transforms ───

// Identify our hook by BOTH markers so we never strip an unrelated user hook
// that happens to share the `pretool-rewrite.mjs` filename.
function isOurHook(hook) {
	const cmd = hook?.command;
	return (
		typeof cmd === "string" &&
		cmd.includes("pretool-rewrite.mjs") &&
		cmd.includes("opentoken")
	);
}

// Remove every OpenToken hook entry; prune emptied containers. Returns true if
// anything was removed.
function stripOpenToken(settings) {
	let removed = false;
	const pre = settings.hooks?.PreToolUse;
	if (!Array.isArray(pre)) return false;
	const kept = [];
	for (const block of pre) {
		const hooks = Array.isArray(block?.hooks) ? block.hooks : [];
		const filtered = hooks.filter((h) => !isOurHook(h));
		if (filtered.length !== hooks.length) removed = true;
		if (filtered.length > 0) kept.push({ ...block, hooks: filtered });
		else if (hooks.length === 0) kept.push(block); // unrelated empty block, leave it
	}
	if (kept.length > 0) settings.hooks.PreToolUse = kept;
	else delete settings.hooks.PreToolUse;
	if (settings.hooks && Object.keys(settings.hooks).length === 0) {
		delete settings.hooks;
	}
	return removed;
}

function addOpenToken(settings, command) {
	settings.hooks ??= {};
	settings.hooks.PreToolUse ??= [];
	settings.hooks.PreToolUse.push({
		matcher: "Bash",
		hooks: [{ type: "command", command, timeout: 10 }],
	});
}

function hasOpenToken(settings) {
	const pre = settings.hooks?.PreToolUse;
	if (!Array.isArray(pre)) return false;
	return pre.some((block) =>
		(Array.isArray(block?.hooks) ? block.hooks : []).some(isOurHook),
	);
}

// ─── mcp ───

function mcpPath(opts) {
	return join(resolve(opts.dir ?? process.cwd()), ".mcp.json");
}

function installMcp(opts) {
	const path = mcpPath(opts);
	const cfg = readJson(path);
	cfg.mcpServers ??= {};
	const existed = "opentoken" in cfg.mcpServers;
	cfg.mcpServers.opentoken = { command: "opentoken-mcp" };
	writeJson(path, cfg);
	log(`${existed ? "↻ updated" : "✓ added"} MCP server in ${path}`);
}

// ─── commands ───

function install(opts) {
	const path = settingsPath(opts);
	const settings = readJson(path);
	const command = hookCommand(opts);
	const had = hasOpenToken(settings);
	stripOpenToken(settings); // make re-install idempotent (update in place)
	addOpenToken(settings, command);
	writeJson(path, settings);
	log(`${had ? "↻ updated" : "✓ installed"} OpenToken hook in ${path}`);
	log(`  command: ${command}`);
	if (existsSync(`${path}.bak`)) log(`  backup:  ${path}.bak`);
	if (opts.mcp) installMcp(opts);
	if (!cliReachable()) {
		warn(
			"the `opentoken` CLI was not found — the hook passes through until it is.\n" +
				"  install it globally: npm i -g @mrgray17/opentoken-cli",
		);
	}
	log("\nStart a new Claude Code session (hooks load at session start).");
}

function uninstall(opts) {
	const path = settingsPath(opts);
	if (!existsSync(path)) {
		log(`nothing to do — ${path} does not exist`);
		return;
	}
	const settings = readJson(path);
	if (!stripOpenToken(settings)) {
		log(`nothing to do — no OpenToken hook found in ${path}`);
		return;
	}
	writeJson(path, settings);
	log(`✓ removed OpenToken hook from ${path}`);
	log(`  backup: ${path}.bak`);
}

function status(opts) {
	const path = settingsPath(opts);
	const settings = readJson(path);
	const installed = hasOpenToken(settings);
	log(`settings: ${path}${existsSync(path) ? "" : " (missing)"}`);
	log(`hook:     ${installed ? "installed ✓" : "not installed"}`);
	log(`cli:      ${cliReachable() ? "reachable ✓" : "NOT reachable ✗"}`);
	const mcp = readJson(mcpPath(opts));
	log(
		`mcp:      ${mcp.mcpServers?.opentoken ? "registered ✓" : "not registered"} (${mcpPath(opts)})`,
	);
}

// ─── main ───

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.command) {
	process.stdout.write(USAGE);
	process.exit(opts.command ? 0 : 1);
}
switch (opts.command) {
	case "install":
		install(opts);
		break;
	case "uninstall":
		uninstall(opts);
		break;
	case "status":
		status(opts);
		break;
	default:
		fail(`unknown command: ${opts.command}\n\n${USAGE}`);
}
