import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { executePromptCommand } from "./handler.mjs";
import { isDirectEntrypoint, resolveStorePath } from "./store.mjs";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Determine if this PreInvocation call is the first model invocation for the
 * latest user turn. Normally invocationNum === 0 on every new turn; if a client
 * keeps incrementing invocationNum across turns, fall back to inspecting the
 * tail of transcriptPath for any PLANNER_RESPONSE after the last USER_INPUT.
 */
export function isFirstInvocationOfTurn(input) {
  if (input.invocationNum === 0) {
    return true;
  }
  const transcriptPath = input.transcriptPath;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }
  try {
    const stat = fs.statSync(transcriptPath);
    const readBytes = Math.min(stat.size, 65536);
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
      const lines = buf.toString("utf8").split(/\r?\n/);
      // Scan backwards: if we hit USER_INPUT before PLANNER_RESPONSE, no model
      // response has happened yet for the current user prompt.
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "USER_INPUT") {
            return true;
          }
          if (entry.type === "PLANNER_RESPONSE") {
            return false;
          }
        } catch {
          // Ignore partial first line when reading from a tail offset.
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  return false;
}

function toAntigravityResponse(result) {
  const injectSteps = [
    {
      systemMessage: {
        systemMessage: result.systemInstruction,
      },
    },
  ];
  if (result.action === "send" && result.found) {
    injectSteps.push({ userMessage: result.resolvedInstruction });
  }
  return { injectSteps };
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) {
    process.stdout.write("{}\n");
    return;
  }
  const input = JSON.parse(raw);
  if (!isFirstInvocationOfTurn(input)) {
    process.stdout.write("{}\n");
    return;
  }

  const result = executePromptCommand(input.lastUserInput ?? "", resolveStorePath());
  if (!result) {
    process.stdout.write("{}\n");
    return;
  }

  process.stdout.write(JSON.stringify(toAntigravityResponse(result)) + "\n");
}

if (isDirectEntrypoint(import.meta.url, process.argv[1], fileURLToPath)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[prompt-manager hook error] ${err?.stack || err}\n`);
    process.stdout.write("{}\n");
  }
}
