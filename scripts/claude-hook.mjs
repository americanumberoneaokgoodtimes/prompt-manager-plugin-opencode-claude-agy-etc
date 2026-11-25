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

export function toClaudeResponse(result) {
  const body =
    result.action === "send" && result.found
      ? `${result.systemInstruction}\n\n<resolved-user-instruction>\n${result.resolvedInstruction}\n</resolved-user-instruction>`
      : result.systemInstruction;

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `<prompt-manager-hook action="${result.action}">\n${body}\n</prompt-manager-hook>`,
    },
  };
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) {
    return;
  }
  const input = JSON.parse(raw);
  const promptText = input.prompt ?? input.lastUserInput ?? "";
  const result = executePromptCommand(promptText, resolveStorePath());
  if (!result) {
    return;
  }

  process.stdout.write(JSON.stringify(toClaudeResponse(result)) + "\n");
}

if (isDirectEntrypoint(import.meta.url, process.argv[1], fileURLToPath)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[prompt-manager claude hook error] ${err?.stack || err}\n`);
  }
}
