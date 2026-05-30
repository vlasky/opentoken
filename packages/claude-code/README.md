# OpenToken for Claude Code

OpenToken works with Claude Code in two complementary layers:

- **Hook (transparent, Bash only).** A `PreToolUse` hook rewrites each Bash
  command to run through `opentoken wrap`, which executes the real command and
  compresses its stdout. Claude Code then captures the already-compressed
  output — no model cooperation required.
- **MCP (explicit, any tool).** Exposes `opentoken_transform`,
  `opentoken_rewrite`, and `opentoken_stats` as tools the model can call.

> **Why Bash only?** Claude Code's `PostToolUse` hooks cannot rewrite tool
> output, so output can only be compressed *before* it is captured — by
> rewriting the command that produces it. That is possible for `Bash` (there is
> a command to wrap) but not for the built-in `Read`, `Grep`, or `Glob` tools,
> which have no command in the middle to intercept. For those, use the MCP
> `opentoken_transform` tool. This is the same boundary every hook-based tool
> hits (e.g. RTK).

## Hook

Install the package, then run the installer. It **merges** into your existing
`.claude/settings.json` (preserving other hooks and permissions) and backs the
file up to `.bak` first — it never overwrites:

```bash
bun add -d @mrgray17/opentoken-claude-code
bunx opentoken-claude-code install          # project-local: ./.claude/settings.json
bunx opentoken-claude-code install --global # all projects: ~/.claude/settings.json
bunx opentoken-claude-code install --mcp    # also register the MCP server in .mcp.json
```

Other commands:

```bash
opentoken-claude-code status      # is the hook installed? is the CLI reachable?
opentoken-claude-code uninstall   # remove only our hook, keep everything else
```

| Flag | Effect |
|------|--------|
| *(none)* | Install into `./.claude/settings.json` (project-local) |
| `--global` | Install into `~/.claude/settings.json` (all projects) |
| `--dir <path>` | Use `<path>` as the project root instead of the cwd |
| `--mcp` | Also register the MCP server in the project's `.mcp.json` |

The installer is idempotent — re-running it updates the entry in place rather
than duplicating it. To install by hand instead, merge `settings.example.json`
into `.claude/settings.json` yourself.

The hook calls the `opentoken` CLI. Install it globally for the fastest path
(`npm i -g @mrgray17/opentoken-cli`); otherwise the hook falls back to running
the workspace CLI through `bun`. `opentoken-claude-code status` reports whether
it is reachable.

### Behaviour

- **Simple commands** (`git diff`, `npm install`, `cargo build`) are rewritten
  to `opentoken wrap <command>`, preserving command-family detection.
- **Commands with shell operators** (`npm test 2>&1`, `a && b`) are wrapped via
  `opentoken wrap bash -c '…'`; content-based folding still applies.
- **Permissions are respected.** The hook reads your Claude Code Bash
  permission rules and mirrors them: denied commands pass through untouched (so
  Claude Code's native deny applies), already-allowed commands are auto-allowed,
  and everything else follows the normal permission prompt.
- **Skipped:** heredocs, already-wrapped commands, trivial commands (`cd`,
  `pwd`, `echo`, …), and streaming/interactive commands (`tail -f`, `watch`,
  `npm run dev`, editors) — the latter because `wrap` buffers stdout until the
  child exits.

Set `OPENTOKEN_CLAUDE_HOOKS=0` to disable the hook without removing configuration.

## MCP

```bash
claude mcp add --transport stdio opentoken -- opentoken-mcp
```

For project-scoped setup, copy `mcp.json` to `.mcp.json` at the project root.
