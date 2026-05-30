import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";

const root = path.resolve(import.meta.dir, "../..");
const server = path.join(root, "packages/mcp/src/server.ts");

async function callTool(name: string, args: Record<string, unknown>) {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "opentoken-mcp-"));
	const child = spawn("bun", ["run", server], {
		cwd: root,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			XDG_CONFIG_HOME: temp,
			XDG_DATA_HOME: temp,
		},
	});
	const rl = createInterface({ input: child.stdout });
	child.stdin.write(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}) + "\n",
	);
	const [line] = (await once(rl, "line")) as [string];
	child.kill();
	return JSON.parse(line);
}

describe("MCP server", () => {
	it("returns transformed output for opentoken_transform", async () => {
		const response = await callTool("opentoken_transform", {
			tool: "bash",
			command: "printf color",
			output: "\u001b[31mhello\u001b[0m",
		});

		expect(response.error).toBeUndefined();
		expect(response.result.content[0].text).toBe("hello");
	});

	it("returns rewritten command shape for opentoken_rewrite", async () => {
		const response = await callTool("opentoken_rewrite", {
			command: "npm install react",
		});

		expect(response.error).toBeUndefined();
		const parsed = JSON.parse(response.result.content[0].text);
		expect(parsed.changed).toBe(true);
		expect(parsed.command).toContain("--silent");
	});
});
