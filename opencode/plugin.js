import path from "node:path";
import { fileURLToPath } from "node:url";
import { executePromptCommand } from "../scripts/handler.mjs";
import { resolveStorePath } from "../scripts/store.mjs";

let opencodePluginSdk = null;
try {
  opencodePluginSdk = await import("@opencode/plugin");
} catch {
  // Runtime host does not supply @opencode/plugin or running in standalone/test environment
}

const Plugin = opencodePluginSdk?.Plugin || {
  define: (def) => def,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, "..", "scripts", "mcp-server.mjs");

function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function replaceTextInParts(parts, newText) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return [{ type: "text", text: newText }];
  }
  const firstTextIdx = parts.findIndex((p) => p && p.type === "text");
  if (firstTextIdx === -1) {
    return [{ type: "text", text: newText }, ...parts];
  }
  const updatedFirst = { ...parts[firstTextIdx], type: "text", text: newText };
  const nextParts = [];
  for (let i = 0; i < parts.length; i++) {
    if (i === firstTextIdx) {
      nextParts.push(updatedFirst);
    } else if (parts[i]?.type !== "text") {
      // Keep non-text attachments while dropping redundant text fragments.
      nextParts.push(parts[i]);
    }
  }
  return nextParts;
}

function replacementForResult(result) {
  if (result.action === "send" && result.found) {
    return result.resolvedInstruction;
  }
  return `[Prompt Manager]\n${result.systemInstruction}`;
}

/**
 * OpenCode plugin hook factory.
 */
export const createPromptManagerHooks = async (_ctx) => {
  const recentlyHandled = new Map();
  const DEDUP_TTL_MS = 5000;

  function pruneExpired(now) {
    for (const [k, entry] of recentlyHandled.entries()) {
      if (now - entry.at > DEDUP_TTL_MS) {
        recentlyHandled.delete(k);
      }
    }
  }

  function markHandled(sessionID, text) {
    const now = Date.now();
    pruneExpired(now);
    const key = sessionID || "__default__";
    recentlyHandled.set(key, { text, at: now });
  }

  function wasJustHandled(sessionID, text) {
    const now = Date.now();
    pruneExpired(now);
    const key = sessionID || "__default__";
    const entry = recentlyHandled.get(key);
    if (!entry) return false;
    if (entry.text === text) {
      recentlyHandled.delete(key);
      return true;
    }
    return false;
  }

  return {
    config: async (config) => {
      config.command = config.command || {};
      if (!config.command.p) {
        config.command.p = {
          description: "Save, edit, inspect, delete, list, or send reusable prompts (/p <id>, /p e <id> <text>, /p d <id>)",
          template: "/p $ARGUMENTS",
        };
      }
      config.mcp = config.mcp || {};
      if (!config.mcp["prompt-manager"]) {
        config.mcp["prompt-manager"] = {
          type: "local",
          command: ["node", MCP_SERVER_PATH],
        };
      }
    },

    "command.execute.before": async (input, output) => {
      const commandName = typeof input?.command === "string" ? input.command.replace(/^\/+/, "") : "";
      if (commandName !== "p" && commandName !== "prompt-manager:p") {
        return;
      }
      const args = typeof input.arguments === "string" ? input.arguments.trim() : "";
      const rawCommand = args ? `/p ${args}` : "/p";
      const result = executePromptCommand(rawCommand, resolveStorePath());
      if (!result) {
        return;
      }
      const replacement = replacementForResult(result);
      output.parts = replaceTextInParts(output.parts, replacement);
      markHandled(input.sessionID, replacement);
    },

    "chat.message": async (input, output) => {
      if (!output || !Array.isArray(output.parts)) {
        return;
      }
      const text = extractTextFromParts(output.parts);
      if (wasJustHandled(input?.sessionID, text)) {
        return;
      }
      const result = executePromptCommand(text, resolveStorePath());
      if (!result) {
        return;
      }
      output.parts = replaceTextInParts(output.parts, replacementForResult(result));
    },
  };
};

/**
 * OpenCode v1 function-style plugin entrypoint.
 */
export const PromptManagerPlugin = async (ctx) => {
  return await createPromptManagerHooks(ctx);
};

/**
 * OpenCode dual-compatibility plugin definition supporting both V1 and V2.
 * Based on OpenCode V1 to V2 migration guide: https://opencode.ai/docs/build/plugins/migrate-v1/
 *
 * - V2 loader looks for: `id` and `setup(ctx)` (created via Plugin.define)
 * - V1 loader looks for: `server(ctx)` (or direct function invocation / hook object)
 */
export const plugin = {
  // --- V2 Loader looks for this ---
  ...Plugin.define({
    id: "@americanumberoneaokgoodtimes/p-plugin",
    name: "prompt-manager",
    description: "Prompt Manager plugin for OpenCode (/p)",
    setup: async (ctx) => {
      return await createPromptManagerHooks(ctx);
    },
  }),

  // --- V1 Loader looks for this ---
  async server(ctx) {
    return await createPromptManagerHooks(ctx);
  },
};

export default plugin;
