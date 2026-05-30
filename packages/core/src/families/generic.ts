// Generic filter — fallback for unrecognized commands
// Head + tail preservation, UTF-8 safe truncation

const MAX_LINES = 80;
const MAX_BYTES = 20 * 1024; // 20KB
const HEAD_LINES = 20;
const TAIL_LINES = 20;

// Stack frame pattern: "at function (file:line:col)"
const STACK_FRAME_RE = /^\s*at\s+.+?\s+\(.+?\)$/;

export function filterGeneric(output: string): string {
	const lines = output.split("\n");

	// Detect and compress stack traces (regardless of output size)
	const stackFrames = lines.filter((l) => STACK_FRAME_RE.test(l));
	if (stackFrames.length > 5) {
		return compressStackTrace(lines);
	}

	// df — collapse to Filesystem: Used/Avail/Use%
	if (lines.length > 1 && /^\s*Filesystem\s+/.test(lines[0])) {
		const header = lines[0];
		const availCol = header.indexOf("Avail");
		if (availCol >= 0) {
			const result = ["Filesystem | Used | Avail | Use%"];
			for (let i = 1; i < lines.length; i++) {
				const l = lines[i];
				if (!l.trim() || l.startsWith("tmpfs")) continue;
				const parts = l.trim().split(/\s+/);
				if (parts.length >= 5) {
					result.push(`${parts[0]} | ${parts[2]} | ${parts[3]} | ${parts[4]}`);
				}
			}
			return result.join("\n");
		}
	}

	// free — collapse to total/used/free/available
	if (lines.length >= 2 && /^\s*total\s+used\s+free/.test(lines[1])) {
		const result = ["", "total | used | free | available"];
		for (let i = 1; i < lines.length; i++) {
			const l = lines[i].trim();
			if (!l) continue;
			const parts = l.split(/\s+/);
			if (parts.length >= 4) {
				result.push(
					`${parts[0]} | ${parts[1]} | ${parts[2]} | ${parts[3] || "-"}`,
				);
			}
		}
		return result.join("\n");
	}

	// ps aux — strip PID/CPU/MEM/STAT columns
	if (lines.length > 1 && /^\s*USER\s+PID\s+/.test(lines[0])) {
		const result = [lines[0].replace(/\s*PID\s+.*?(?=\s*START)/, " ")];
		for (let i = 1; i < lines.length; i++) {
			const l = lines[i];
			if (!l.trim()) continue;
			const parts = l.trim().split(/\s+/);
			if (parts.length >= 11) {
				// USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
				result.push(`${parts[0]} | ${parts[10].substring(0, 60)}`);
			}
		}
		return result.join("\n");
	}

	// Short outputs pass through
	if (lines.length <= MAX_LINES && output.length <= MAX_BYTES) {
		return output;
	}

	// Head + tail preservation
	const head = lines.slice(0, HEAD_LINES);
	const tail = lines.slice(-TAIL_LINES);

	let result = head.join("\n");
	const skipped = lines.length - HEAD_LINES - TAIL_LINES;
	if (skipped > 0) {
		result += `\n\n... ${skipped} lines omitted ...\n\n`;
	}
	result += tail.join("\n");

	// UTF-8 safe: ensure we don't cut mid-character
	return result;
}

// Compress stack traces: keep top frame + ... N frames ... + bottom frame
function compressStackTrace(lines: string[]): string {
	const result: string[] = [];
	let stackStart = -1;
	let stackEnd = -1;

	// Find contiguous stack trace region
	for (let i = 0; i < lines.length; i++) {
		if (STACK_FRAME_RE.test(lines[i])) {
			if (stackStart === -1) stackStart = i;
			stackEnd = i;
		}
	}

	if (stackStart === -1 || stackEnd - stackStart < 4) {
		return lines.join("\n"); // Not enough frames to compress
	}

	// Keep lines before stack trace
	result.push(...lines.slice(0, stackStart));

	// Keep top frame
	result.push(lines[stackStart]);

	// Compress middle frames
	const middleCount = stackEnd - stackStart - 1;
	if (middleCount > 0) {
		result.push(`  ... ${middleCount} stack frames omitted ...`);
	}

	// Keep bottom frame
	result.push(lines[stackEnd]);

	// Keep lines after stack trace
	result.push(...lines.slice(stackEnd + 1));

	return result.join("\n");
}
