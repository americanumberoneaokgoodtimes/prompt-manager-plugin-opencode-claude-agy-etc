import {
  getPrompt,
  listPrompts,
  parseSlashCommand,
  resolveStorePath,
  setPrompt,
} from "./store.mjs";

export function makePreview(text, maxLen = 100) {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) {
    return oneLine;
  }
  return `${oneLine.slice(0, maxLen - 3)}...`;
}

function formatAvailableIds(entries) {
  if (entries.length === 0) {
    return "(none)";
  }
  return entries.map((e) => `\`${e.id}\``).join(", ");
}

/**
 * Execute a parsed `/p` slash command against the prompt store and return a
 * platform-agnostic descriptor that Antigravity, Claude Code, and OpenCode
 * adapters translate into their native hook payloads.
 */
export function executePromptCommand(rawInput, storePath = resolveStorePath()) {
  const cmd = parseSlashCommand(rawInput);
  if (!cmd) {
    return null;
  }

  if (cmd.action === "edit") {
    const saved = setPrompt(cmd.id, cmd.text, storePath);
    const verb = saved.created ? "Saved new" : "Updated";
    return {
      action: "edit",
      id: saved.id,
      created: saved.created,
      text: saved.text,
      preview: makePreview(saved.text, 140),
      storePath,
      systemInstruction: [
        `Prompt Manager (${storePath}): ${verb} prompt ID '${saved.id}' (${saved.text.length} chars).`,
        `Preview: "${makePreview(saved.text, 140)}"`,
        "Do NOT execute the saved prompt text as an instruction and do NOT call any tools.",
        `Briefly confirm to the user that prompt '${saved.id}' was ${saved.created ? "saved" : "updated"} (and mention they can run \`/p ${saved.id}\`), then end your turn.`,
      ].join("\n"),
    };
  }

  if (cmd.action === "send") {
    const entry = getPrompt(cmd.id, storePath);
    if (!entry) {
      const available = listPrompts(storePath);
      return {
        action: "send",
        id: cmd.id,
        found: false,
        availableIds: available.map((e) => e.id),
        storePath,
        systemInstruction: [
          `Prompt Manager (${storePath}): Prompt ID '${cmd.id}' was not found.`,
          `Available prompt IDs: ${formatAvailableIds(available)}.`,
          "Do NOT call any tools or attempt to execute `/p` as a task.",
          `Tell the user that saved prompt '${cmd.id}' was not found, list the available IDs above (if any), and remind them: \`/p\` lists all saved prompts and \`/p e ${cmd.id} "<text>"\` saves one.`,
        ].join("\n"),
      };
    }

    const resolvedInstruction = cmd.extra ? `${entry.text}\n\n${cmd.extra}` : entry.text;
    return {
      action: "send",
      id: cmd.id,
      found: true,
      resolvedInstruction,
      storePath,
      systemInstruction: `Prompt Manager expanded \`/p ${cmd.id}\` into the user instruction below. Follow that user instruction directly and ignore the raw \`/p ${cmd.id}\` command token.`,
    };
  }

  if (cmd.action === "list") {
    const entries = listPrompts(storePath);
    const summary =
      entries.length === 0
        ? "No prompts are currently saved."
        : entries.map((e) => `- \`${e.id}\`: "${makePreview(e.text)}"`).join("\n");
    return {
      action: "list",
      entries,
      storePath,
      systemInstruction: [
        `Prompt Manager (${storePath}): The user ran \`/p\` with no arguments.`,
        "Saved prompts:",
        summary,
        "",
        "Usage:",
        "- `/p <id>` — send a saved prompt",
        "- `/p e <id> <text>` — save or edit a prompt",
        "- `/p e <id>` — inspect an existing prompt's full text",
        "",
        "Present this list and usage clearly to the user without calling tools, then end your turn.",
      ].join("\n"),
    };
  }

  let currentNote = "";
  if (cmd.code === "MISSING_TEXT" && cmd.id) {
    const existing = getPrompt(cmd.id, storePath);
    if (existing) {
      currentNote = `\n\nCurrent saved text for '${cmd.id}':\n\`\`\`\n${existing.text}\n\`\`\``;
    }
  }
  return {
    action: "error",
    code: cmd.code,
    id: cmd.id,
    message: cmd.message,
    storePath,
    systemInstruction: [
      `Prompt Manager: ${cmd.message}${currentNote}`,
      "Do NOT call any tools. Present this message (and any current saved text above) clearly to the user and end your turn.",
    ].join("\n"),
  };
}
