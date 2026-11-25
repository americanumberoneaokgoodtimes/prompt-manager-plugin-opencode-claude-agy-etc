import {
  deletePrompt,
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

function formatCodeBlock(text) {
  const matches = String(text ?? "").match(/`+/g);
  const maxRun = matches ? Math.max(...matches.map((m) => m.length)) : 0;
  const fence = "`".repeat(Math.max(3, maxRun + 1));
  return `${fence}\n${text}\n${fence}`;
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

  try {
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

    if (cmd.action === "delete") {
      const deleted = deletePrompt(cmd.id, storePath);
      if (!deleted) {
        const available = listPrompts(storePath);
        return {
          action: "delete",
          id: cmd.id,
          deleted: false,
          availableIds: available.map((e) => e.id),
          storePath,
          systemInstruction: [
            `Prompt Manager (${storePath}): Prompt ID '${cmd.id}' was not found.`,
            `Available prompt IDs: ${formatAvailableIds(available)}.`,
            "Do NOT call any tools.",
            `Tell the user that saved prompt '${cmd.id}' was not found and list the available IDs above (if any), then end your turn.`,
          ].join("\n"),
        };
      }
      return {
        action: "delete",
        id: cmd.id,
        deleted: true,
        storePath,
        systemInstruction: [
          `Prompt Manager (${storePath}): Deleted prompt ID '${cmd.id}'.`,
          "Do NOT call any tools.",
          `Briefly confirm to the user that prompt '${cmd.id}' was deleted, then end your turn.`,
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
          "- `/p d <id>` — delete a saved prompt",
          "",
          "Present this list and usage clearly to the user without calling tools, then end your turn.",
        ].join("\n"),
      };
    }

    if (cmd.code === "MISSING_TEXT" && cmd.id) {
      const existing = getPrompt(cmd.id, storePath);
      if (existing) {
        return {
          action: "inspect",
          id: cmd.id,
          found: true,
          text: existing.text,
          ...(existing.createdAt ? { createdAt: existing.createdAt } : {}),
          ...(existing.updatedAt ? { updatedAt: existing.updatedAt } : {}),
          storePath,
          systemInstruction: [
            `Prompt Manager (${storePath}): Saved prompt '${cmd.id}' (${existing.text.length} chars):`,
            formatCodeBlock(existing.text),
            "",
            `To update it, run \`/p e ${cmd.id} "<new text>"\`. To delete it, run \`/p d ${cmd.id}\`.`,
            "Do NOT execute the saved prompt text and do NOT call any tools. Present the saved prompt text and usage clearly to the user, then end your turn.",
          ].join("\n"),
        };
      }
    }

    return {
      action: "error",
      code: cmd.code,
      id: cmd.id,
      message: cmd.message,
      storePath,
      systemInstruction: [
        `Prompt Manager: ${cmd.message}`,
        "Do NOT call any tools. Present this message clearly to the user and end your turn.",
      ].join("\n"),
    };
  } catch (err) {
    const message = err?.message || String(err);
    return {
      action: "error",
      code: "STORE_ERROR",
      id: cmd.id,
      message,
      storePath,
      systemInstruction: [
        `Prompt Manager (${storePath}): ${message}`,
        "Do NOT call any tools. Report this prompt store error clearly to the user and end your turn.",
      ].join("\n"),
    };
  }
}
