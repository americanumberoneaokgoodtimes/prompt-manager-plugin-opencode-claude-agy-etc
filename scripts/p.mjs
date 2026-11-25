import {
  deletePrompt,
  getPrompt,
  listPrompts,
  resolveStorePath,
  setPrompt,
} from "./store.mjs";

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/p.mjs list",
      "  node scripts/p.mjs get <id>",
      "  node scripts/p.mjs set <id> <text>",
      "  node scripts/p.mjs delete <id>",
      "",
      `Store: ${resolveStorePath()}`,
      "",
    ].join("\n"),
  );
}

function main() {
  const [, , subcommand, id, ...rest] = process.argv;
  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    printHelp();
    return;
  }

  if (subcommand === "list") {
    const entries = listPrompts();
    if (entries.length === 0) {
      process.stdout.write("No saved prompts.\n");
      return;
    }
    for (const entry of entries) {
      process.stdout.write(`${entry.id}\t${entry.text.replace(/\s+/g, " ")}\n`);
    }
    return;
  }

  if (subcommand === "get") {
    if (!id) {
      process.stderr.write("Missing prompt ID.\n");
      process.exitCode = 1;
      return;
    }
    const entry = getPrompt(id);
    if (!entry) {
      process.stderr.write(`Prompt '${id}' not found.\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(entry.text + "\n");
    return;
  }

  if (subcommand === "set") {
    if (!id || rest.length === 0) {
      process.stderr.write("Usage: node scripts/p.mjs set <id> <text>\n");
      process.exitCode = 1;
      return;
    }
    const text = rest.join(" ");
    const saved = setPrompt(id, text);
    process.stdout.write(
      `${saved.created ? "Saved" : "Updated"} prompt '${saved.id}' (${saved.text.length} chars).\n`,
    );
    return;
  }

  if (subcommand === "delete") {
    if (!id) {
      process.stderr.write("Missing prompt ID.\n");
      process.exitCode = 1;
      return;
    }
    const removed = deletePrompt(id);
    if (!removed) {
      process.stderr.write(`Prompt '${id}' not found.\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Deleted prompt '${id}'.\n`);
    return;
  }

  process.stderr.write(`Unknown subcommand '${subcommand}'.\n`);
  printHelp();
  process.exitCode = 1;
}

main();
