import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const STORE_VERSION = 1;
const RESERVED_IDS = new Set(["e", "__proto__", "constructor", "prototype"]);

/**
 * Resolve the persistent JSON file path used to store saved prompts.
 * Order of precedence:
 * 1. PROMPT_MANAGER_STORE_PATH (explicit file override)
 * 2. Existing tool-specific store if already populated (migration/compat)
 * 3. ~/.prompt-manager/prompts.json (shared default across Antigravity, Claude Code, OpenCode, and CLI)
 */
export function resolveStorePath() {
  const explicit = process.env.PROMPT_MANAGER_STORE_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  const sharedDefault = path.join(os.homedir(), ".prompt-manager", "prompts.json");
  if (fs.existsSync(sharedDefault)) {
    return sharedDefault;
  }

  const candidates = [
    process.env.PLUGIN_DATA?.trim() && path.join(process.env.PLUGIN_DATA.trim(), "prompts.json"),
    process.env.CLAUDE_PLUGIN_DATA?.trim() && path.join(process.env.CLAUDE_PLUGIN_DATA.trim(), "prompts.json"),
    path.join(os.homedir(), ".gemini", "config", "prompt-manager", "prompts.json"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return sharedDefault;
}

function emptyStore() {
  return { version: STORE_VERSION, prompts: Object.create(null) };
}

/**
 * Load the prompt store from disk, returning an empty store if missing.
 */
export function loadStore(storePath = resolveStorePath()) {
  if (!fs.existsSync(storePath)) {
    return emptyStore();
  }
  const raw = fs.readFileSync(storePath, "utf8");
  if (!raw.trim()) {
    return emptyStore();
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || typeof parsed.prompts !== "object" || Array.isArray(parsed.prompts)) {
    throw new Error(`Invalid prompt store format in ${storePath}`);
  }
  const prompts = Object.create(null);
  for (const [id, entry] of Object.entries(parsed.prompts)) {
    if (RESERVED_IDS.has(id)) continue;
    if (typeof entry === "string") {
      prompts[id] = { text: entry };
    } else if (entry && typeof entry === "object" && typeof entry.text === "string") {
      prompts[id] = {
        text: entry.text,
        ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
        ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
      };
    }
  }
  return {
    version: typeof parsed.version === "number" ? parsed.version : STORE_VERSION,
    prompts,
  };
}

/**
 * Atomically persist the prompt store to disk, cleaning up temp files on error
 * and handling transient Windows file-locking errors on rename.
 */
export function saveStore(store, storePath = resolveStorePath()) {
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.prompts.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const plainPrompts = {};
  for (const [id, entry] of Object.entries(store.prompts)) {
    if (!RESERVED_IDS.has(id)) {
      plainPrompts[id] = entry;
    }
  }
  const payload =
    JSON.stringify(
      {
        version: STORE_VERSION,
        prompts: plainPrompts,
      },
      null,
      2,
    ) + "\n";

  try {
    fs.writeFileSync(tmpPath, payload, "utf8");
    const maxAttempts = process.platform === "win32" ? 4 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        fs.renameSync(tmpPath, storePath);
        return;
      } catch (err) {
        const retryable = err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES");
        if (!retryable || attempt === maxAttempts) {
          throw err;
        }
        // Synchronous brief backoff for transient Windows AV/indexer locks.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * attempt);
      }
    }
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure.
      }
    }
  }
}

/**
 * Validate a prompt ID.
 */
export function validatePromptId(id) {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Prompt ID must be a non-empty string.");
  }
  if (/\s/.test(id)) {
    throw new Error("Prompt ID cannot contain whitespace.");
  }
  if (id === "e") {
    throw new Error("Prompt ID cannot be 'e' because 'e' is reserved for editing/adding prompts.");
  }
  if (RESERVED_IDS.has(id)) {
    throw new Error(`Prompt ID '${id}' is reserved.`);
  }
  return id;
}

/**
 * Get a saved prompt entry by ID, or null if not found.
 */
export function getPrompt(id, storePath = resolveStorePath()) {
  if (typeof id !== "string" || !id || RESERVED_IDS.has(id)) {
    return null;
  }
  const store = loadStore(storePath);
  if (!Object.hasOwn(store.prompts, id)) {
    return null;
  }
  return { id, ...store.prompts[id] };
}

/**
 * Add or update a saved prompt entry.
 */
export function setPrompt(id, text, storePath = resolveStorePath()) {
  const validId = validatePromptId(id);
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Prompt text must be a non-empty string.");
  }
  const store = loadStore(storePath);
  const now = new Date().toISOString();
  const hasExisting = Object.hasOwn(store.prompts, validId);
  const existing = hasExisting ? store.prompts[validId] : null;
  const entry = {
    text,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store.prompts[validId] = entry;
  saveStore(store, storePath);
  return {
    id: validId,
    ...entry,
    created: !hasExisting,
  };
}

/**
 * Delete a saved prompt entry by ID. Returns true if it existed.
 */
export function deletePrompt(id, storePath = resolveStorePath()) {
  if (typeof id !== "string" || !id || RESERVED_IDS.has(id)) {
    return false;
  }
  const store = loadStore(storePath);
  if (!Object.hasOwn(store.prompts, id)) {
    return false;
  }
  delete store.prompts[id];
  saveStore(store, storePath);
  return true;
}

/**
 * Return all saved prompts sorted naturally by ID.
 */
export function listPrompts(storePath = resolveStorePath()) {
  const store = loadStore(storePath);
  return Object.entries(store.prompts)
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" }));
}

/**
 * Unwrap a single outer pair of matching "..." or '...' quotes when the opening
 * quote closes unescaped at the very last character of the trimmed string.
 */
export function unwrapQuotes(raw) {
  const trimmed = raw.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) {
    return trimmed;
  }
  let out = "";
  let escaped = false;
  for (let i = 1; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      if (ch === quote || ch === "\\") {
        out += ch;
      } else {
        out += "\\" + ch;
      }
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === quote) {
      if (i === trimmed.length - 1) {
        return out;
      }
      // Unescaped quote appeared before the end, so this is not one wrapped string.
      return trimmed;
    }
    out += ch;
  }
  // Closing quote was escaped (or dangling backslash), so keep original string.
  return trimmed;
}

/**
 * Consume the next whitespace-delimited (or quoted) token from text.
 * Returns { token, rest } or null if empty.
 */
function consumeToken(input) {
  const s = input.trimStart();
  if (!s) {
    return null;
  }
  const first = s[0];
  if (first === '"' || first === "'") {
    let token = "";
    let escaped = false;
    for (let i = 1; i < s.length; i++) {
      const ch = s[i];
      if (escaped) {
        token += ch === first || ch === "\\" ? ch : "\\" + ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === first) {
        const after = s.slice(i + 1);
        if (!after || /^\s/.test(after)) {
          return { token, rest: after.replace(/^\s+/, "") };
        }
        break;
      }
      token += ch;
    }
  }
  const match = s.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }
  return {
    token: match[1],
    rest: match[2] ?? "",
  };
}

/**
 * Check whether the current script module was executed directly as the Node entrypoint,
 * safely normalizing symlinks, relative paths, and Windows drive-letter casing.
 */
export function isDirectEntrypoint(importMetaUrl, argvPath = process.argv[1], fileURLToPathFn) {
  if (!argvPath) {
    return false;
  }
  try {
    const modulePath = fs.realpathSync(fileURLToPathFn(importMetaUrl));
    const entryPath = fs.realpathSync(path.resolve(argvPath));
    if (process.platform === "win32") {
      return modulePath.toLowerCase() === entryPath.toLowerCase();
    }
    return modulePath === entryPath;
  } catch {
    return false;
  }
}

/**
 * Parse a user slash command starting with /p (or /prompt-manager:p).
 * Returns null if the input is not a /p command.
 */
export function parseSlashCommand(input) {
  if (typeof input !== "string") {
    return null;
  }
  const match = input.trimStart().match(/^\/(?:prompt-manager:)?p(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }
  const body = (match[1] ?? "").trimStart();
  if (!body) {
    return { action: "list" };
  }

  const first = consumeToken(body);
  if (!first) {
    return { action: "list" };
  }

  if (first.token === "e") {
    const idToken = consumeToken(first.rest);
    if (!idToken) {
      return {
        action: "error",
        code: "MISSING_ID",
        message: "Missing prompt ID and text. Usage: /p e <saved_prompt_ID> <text>",
      };
    }
    if (RESERVED_IDS.has(idToken.token)) {
      return {
        action: "error",
        code: "RESERVED_ID",
        id: idToken.token,
        message:
          idToken.token === "e"
            ? "Prompt ID cannot be 'e' because 'e' is reserved for editing/adding prompts."
            : `Prompt ID '${idToken.token}' is reserved.`,
      };
    }
    if (!idToken.rest || !idToken.rest.trim()) {
      return {
        action: "error",
        code: "MISSING_TEXT",
        id: idToken.token,
        message: `Missing prompt text for ID '${idToken.token}'. Usage: /p e ${idToken.token} "<text>"`,
      };
    }
    const text = unwrapQuotes(idToken.rest);
    if (!text.trim()) {
      return {
        action: "error",
        code: "EMPTY_TEXT",
        id: idToken.token,
        message: `Prompt text for ID '${idToken.token}' cannot be empty.`,
      };
    }
    return {
      action: "edit",
      id: idToken.token,
      text,
    };
  }

  return {
    action: "send",
    id: first.token,
    extra: first.rest.trim(),
  };
}
