#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deletePrompt,
  getPrompt,
  isDirectEntrypoint,
  listPrompts,
  resolveStorePath,
  setPrompt,
} from "./store.mjs";

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/p.mjs list [--json]",
      "  node scripts/p.mjs get <id> [--json]",
      "  node scripts/p.mjs set <id> <text>       (or pipe stdin / pass --stdin)",
      "  node scripts/p.mjs delete <id>",
      "  node scripts/p.mjs path",
      "",
      `Store: ${resolveStorePath()}`,
      "",
    ].join("\n"),
  );
}

function readStdinSafe() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function runCli(argv = process.argv) {
  const [, , subcommand, ...args] = argv;
  if (!subcommand || subcommand === "-h" || subcommand === "--help" || subcommand === "help") {
    printHelp();
    return;
  }

  if (subcommand === "path") {
    process.stdout.write(resolveStorePath() + "\n");
    return;
  }

  if (subcommand === "list") {
    const asJson = args.includes("--json");
    const storePath = resolveStorePath();
    const entries = listPrompts(storePath);
    if (asJson) {
      process.stdout.write(JSON.stringify({ storePath, prompts: entries }, null, 2) + "\n");
      return;
    }
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
    const asJson = args.includes("--json");
    const id = args.find((a) => a !== "--json");
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
    if (asJson) {
      process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
      return;
    }
    process.stdout.write(entry.text + "\n");
    return;
  }

  if (subcommand === "set") {
    const [id, ...rest] = args;
    let text = "";
    if (rest.length === 1 && (rest[0] === "--stdin" || rest[0] === "-")) {
      text = readStdinSafe().replace(/\r?\n$/, "");
    } else if (rest.length === 0 && !process.stdin.isTTY) {
      text = readStdinSafe().replace(/\r?\n$/, "");
    } else {
      text = rest.join(" ");
    }

    if (!id || !text.trim()) {
      process.stderr.write("Usage: node scripts/p.mjs set <id> <text>\n");
      process.exitCode = 1;
      return;
    }
    const saved = setPrompt(id, text);
    process.stdout.write(
      `${saved.created ? "Saved" : "Updated"} prompt '${saved.id}' (${saved.text.length} chars).\n`,
    );
    return;
  }

  if (subcommand === "delete") {
    const [id] = args;
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

if (isDirectEntrypoint(import.meta.url, process.argv[1], fileURLToPath)) {
  try {
    runCli(process.argv);
  } catch (err) {
    process.stderr.write(`Error: ${err?.message || err}\n`);
    process.exitCode = 1;
  }
}
