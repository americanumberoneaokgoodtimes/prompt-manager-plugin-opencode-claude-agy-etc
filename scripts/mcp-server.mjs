import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  deletePrompt,
  getPrompt,
  isDirectEntrypoint,
  listPrompts,
  resolveStorePath,
  setPrompt,
} from "./store.mjs";

export const SERVER_INFO = {
  name: "prompt-manager",
  version: "1.0.0",
};

export const TOOLS = [
  {
    name: "list_prompts",
    description: "List all saved prompts with their IDs, text, and timestamps.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_prompt",
    description: "Retrieve the full instruction text for a saved prompt ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The saved prompt ID to look up.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "save_prompt",
    description: "Create or update a saved prompt instruction under the given ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The prompt ID (cannot contain whitespace or be 'e' or 'd').",
        },
        text: {
          type: "string",
          description: "The prompt instruction text to save.",
        },
      },
      required: ["id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_prompt",
    description: "Delete a saved prompt by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The saved prompt ID to delete.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(text, isError = false) {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

export function handleToolCall(name, args, storePath = resolveStorePath()) {
  const safeArgs = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  switch (name) {
    case "list_prompts": {
      const entries = listPrompts(storePath);
      return textResult(JSON.stringify({ storePath, prompts: entries }, null, 2));
    }
    case "get_prompt": {
      if (typeof safeArgs.id !== "string" || !safeArgs.id.trim()) {
        return textResult("Missing required string parameter 'id'.", true);
      }
      const entry = getPrompt(safeArgs.id, storePath);
      if (!entry) {
        return textResult(`Prompt '${safeArgs.id}' not found.`, true);
      }
      return textResult(JSON.stringify(entry, null, 2));
    }
    case "save_prompt": {
      if (typeof safeArgs.id !== "string" || !safeArgs.id.trim()) {
        return textResult("Missing required string parameter 'id'.", true);
      }
      if (typeof safeArgs.text !== "string" || !safeArgs.text.trim()) {
        return textResult("Missing required string parameter 'text'.", true);
      }
      const saved = setPrompt(safeArgs.id, safeArgs.text, storePath);
      return textResult(JSON.stringify(saved, null, 2));
    }
    case "delete_prompt": {
      if (typeof safeArgs.id !== "string" || !safeArgs.id.trim()) {
        return textResult("Missing required string parameter 'id'.", true);
      }
      const deleted = deletePrompt(safeArgs.id, storePath);
      if (!deleted) {
        return textResult(`Prompt '${safeArgs.id}' not found.`, true);
      }
      return textResult(`Deleted prompt '${safeArgs.id}'.`);
    }
    default:
      return textResult(`Unknown tool '${name}'.`, true);
  }
}

export function handleMessage(msg, storePath = resolveStorePath(), sendFn = send) {
  if (!msg || typeof msg !== "object") {
    return;
  }
  const { id, method, params } = msg;

  // Notifications have no id and expect no response.
  if (id === undefined || id === null) {
    return;
  }

  switch (method) {
    case "initialize":
      sendFn({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    case "ping":
      sendFn({ jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list":
      sendFn({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    case "tools/call":
      try {
        const result = handleToolCall(params?.name, params?.arguments, storePath);
        sendFn({ jsonrpc: "2.0", id, result });
      } catch (err) {
        sendFn({ jsonrpc: "2.0", id, result: textResult(err?.message || String(err), true) });
      }
      return;
    default:
      sendFn({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1], fileURLToPath)) {
  process.stdout.on("error", (err) => {
    if (err?.code === "EPIPE") {
      process.exit(0);
    }
  });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const msg = JSON.parse(trimmed);
      handleMessage(msg);
    } catch (err) {
      sendError(null, -32700, `Parse error: ${err?.message || String(err)}`);
    }
  });
}
