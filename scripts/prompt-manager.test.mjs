import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  deletePrompt,
  getPrompt,
  listPrompts,
  loadStore,
  parseSlashCommand,
  resolveStorePath,
  setPrompt,
  unwrapQuotes,
} from "./store.mjs";
import { executePromptCommand } from "./handler.mjs";
import { isFirstInvocationOfTurn } from "./p-hook.mjs";
import { handleMessage } from "./mcp-server.mjs";
import defaultPlugin, { plugin, PromptManagerPlugin, createPromptManagerHooks } from "../opencode/plugin.js";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..");

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-plugin-p-test-"));
  return { dir, storePath: path.join(dir, "prompts.json") };
}

test("parseSlashCommand handles edit, send, list, and non-/p inputs", () => {
  const sampleText =
    "begin doing the things you do best, but only if you think it's the best thing to do. Begin if you think you're ready, and if not then ask me about it for more information";
  assert.deepEqual(parseSlashCommand(`/p e 1 "${sampleText}"`), {
    action: "edit",
    id: "1",
    text: sampleText,
  });

  assert.deepEqual(parseSlashCommand("/p e review 'check security and tests'"), {
    action: "edit",
    id: "review",
    text: "check security and tests",
  });

  assert.deepEqual(parseSlashCommand("/p e quick unquoted multi word prompt"), {
    action: "edit",
    id: "quick",
    text: "unquoted multi word prompt",
  });

  assert.deepEqual(parseSlashCommand("/p e multi \"line 1\nline 2\""), {
    action: "edit",
    id: "multi",
    text: "line 1\nline 2",
  });

  assert.deepEqual(parseSlashCommand("/p 1"), {
    action: "send",
    id: "1",
    extra: "",
  });

  assert.deepEqual(parseSlashCommand("/p 1 focus on auth.ts"), {
    action: "send",
    id: "1",
    extra: "focus on auth.ts",
  });

  assert.deepEqual(parseSlashCommand("/p"), { action: "list" });
  assert.deepEqual(parseSlashCommand("  /prompt-manager:p   2  "), {
    action: "send",
    id: "2",
    extra: "",
  });

  assert.equal(parseSlashCommand("/p e").action, "error");
  assert.equal(parseSlashCommand("/p e 1").code, "MISSING_TEXT");
  assert.equal(parseSlashCommand("/p e e hello").code, "RESERVED_ID");
  assert.equal(parseSlashCommand("/p e d hello").code, "RESERVED_ID");
  assert.equal(parseSlashCommand('/p e "my id" hello').code, "INVALID_ID");
  assert.equal(parseSlashCommand('/p e "" hello').code, "INVALID_ID");
  assert.equal(parseSlashCommand('/p ""').code, "INVALID_ID");
  assert.deepEqual(parseSlashCommand("/p d 1"), { action: "delete", id: "1" });
  assert.equal(parseSlashCommand("/p d").code, "MISSING_ID");
  assert.equal(parseSlashCommand("/p d 1 2").code, "UNEXPECTED_ARGS");
  assert.equal(parseSlashCommand("/plan refactor auth"), null);
  assert.equal(parseSlashCommand("regular message"), null);
});

test("unwrapQuotes only strips outer matching pair", () => {
  assert.equal(unwrapQuotes('"hello world"'), "hello world");
  assert.equal(unwrapQuotes("'hello world'"), "hello world");
  assert.equal(unwrapQuotes('"hello \\"quoted\\" world"'), 'hello "quoted" world');
  assert.equal(unwrapQuotes('"path\\\\"'), "path\\");
  assert.equal(unwrapQuotes('"a\\"'), '"a\\"');
  assert.equal(unwrapQuotes('"a" and "b"'), '"a" and "b"');
  assert.equal(unwrapQuotes("C:\\Users\\test\\new"), "C:\\Users\\test\\new");
});

test("store rejects reserved prototype keys and ignores Object.prototype lookups", () => {
  const { dir, storePath } = makeTempStore();
  try {
    assert.equal(getPrompt("toString", storePath), null);
    assert.equal(getPrompt("constructor", storePath), null);
    assert.equal(getPrompt("__proto__", storePath), null);
    assert.equal(deletePrompt("toString", storePath), false);
    assert.throws(() => setPrompt("__proto__", "bad", storePath), /reserved/);
    assert.throws(() => setPrompt("constructor", "bad", storePath), /reserved/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store CRUD persists and sorts naturally", () => {
  const { dir, storePath } = makeTempStore();
  try {
    assert.deepEqual(listPrompts(storePath), []);
    assert.equal(getPrompt("1", storePath), null);

    const first = setPrompt("10", "ten", storePath);
    assert.equal(first.created, true);
    const second = setPrompt("2", "two", storePath);
    assert.equal(second.created, true);
    const updated = setPrompt("2", "two updated", storePath);
    assert.equal(updated.created, false);

    assert.equal(getPrompt("2", storePath)?.text, "two updated");
    assert.deepEqual(
      listPrompts(storePath).map((e) => e.id),
      ["2", "10"],
    );

    assert.equal(deletePrompt("2", storePath), true);
    assert.equal(deletePrompt("2", storePath), false);
    assert.deepEqual(
      listPrompts(storePath).map((e) => e.id),
      ["10"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("p-hook.mjs saves on /p e, expands on /p <id>, and skips tool-loop retries", () => {
  const { dir, storePath } = makeTempStore();
  const transcriptPath = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({ step_index: 0, type: "USER_INPUT" }) +
      "\n" +
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE" }) +
      "\n",
  );
  const env = { ...process.env, PROMPT_MANAGER_STORE_PATH: storePath };

  try {
    const saveRes = spawnSync("node", ["./scripts/p-hook.mjs"], {
      cwd: PLUGIN_ROOT,
      env,
      input: JSON.stringify({
        invocationNum: 0,
        lastUserInput: '/p e 1 "Check every edge case carefully"',
      }),
      encoding: "utf8",
    });
    assert.equal(saveRes.status, 0);
    const saveJson = JSON.parse(saveRes.stdout);
    assert.equal(saveJson.injectSteps.length, 1);
    assert.match(saveJson.injectSteps[0].systemMessage.systemMessage, /Saved new prompt ID '1'/);

    const sendRes = spawnSync("node", ["./scripts/p-hook.mjs"], {
      cwd: PLUGIN_ROOT,
      env,
      input: JSON.stringify({
        invocationNum: 0,
        lastUserInput: "/p 1",
      }),
      encoding: "utf8",
    });
    assert.equal(sendRes.status, 0);
    const sendJson = JSON.parse(sendRes.stdout);
    assert.equal(sendJson.injectSteps.length, 2);
    assert.equal(sendJson.injectSteps[1].userMessage, "Check every edge case carefully");

    const loopRes = spawnSync("node", ["./scripts/p-hook.mjs"], {
      cwd: PLUGIN_ROOT,
      env,
      input: JSON.stringify({
        invocationNum: 1,
        transcriptPath,
        lastUserInput: "/p 1",
      }),
      encoding: "utf8",
    });
    assert.equal(loopRes.status, 0);
    assert.deepEqual(JSON.parse(loopRes.stdout), {});

    const missRes = spawnSync("node", ["./scripts/p-hook.mjs"], {
      cwd: PLUGIN_ROOT,
      env,
      input: JSON.stringify({
        invocationNum: 0,
        lastUserInput: "/p 99",
      }),
      encoding: "utf8",
    });
    assert.equal(missRes.status, 0);
    assert.match(JSON.parse(missRes.stdout).injectSteps[0].systemMessage.systemMessage, /not found/);

    // Inspect existing prompt via /p e 1 (no text)
    const inspectRes = spawnSync("node", ["./scripts/p-hook.mjs"], {
      cwd: PLUGIN_ROOT,
      env,
      input: JSON.stringify({
        invocationNum: 0,
        lastUserInput: "/p e 1",
      }),
      encoding: "utf8",
    });
    assert.equal(inspectRes.status, 0);
    assert.match(
      JSON.parse(inspectRes.stdout).injectSteps[0].systemMessage.systemMessage,
      /Check every edge case carefully/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("claude-hook.mjs handles UserPromptSubmit for /p e, /p <id>, /p, and regular prompts", () => {
  const { dir, storePath } = makeTempStore();
  const env = { ...process.env, PROMPT_MANAGER_STORE_PATH: storePath };

  try {
    const saveRes = spawnSync("node", ["./scripts/claude-hook.mjs"], {
      cwd: PLUGIN_ROOT,
      env,
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: '/p e 1 "Claude prompt body"',
      }),
      encoding: "utf8",
    });
    assert.equal(saveRes.status, 0);
    const saveJson = JSON.parse(saveRes.stdout);
    assert.equal(saveJson.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(saveJson.hookSpecificOutput.additionalContext, /Saved new prompt ID '1'/);

    const sendRes = spawnSync("node", ["./scripts/claude-hook.mjs"], {
      cwd: PLUGIN_ROOT,
      env,
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "/p 1",
      }),
      encoding: "utf8",
    });
    assert.equal(sendRes.status, 0);
    const sendJson = JSON.parse(sendRes.stdout);
    assert.match(sendJson.hookSpecificOutput.additionalContext, /Claude prompt body/);

    const passRes = spawnSync("node", ["./scripts/claude-hook.mjs"], {
      cwd: PLUGIN_ROOT,
      env,
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "normal user prompt",
      }),
      encoding: "utf8",
    });
    assert.equal(passRes.status, 0);
    assert.equal(passRes.stdout.trim(), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode plugin registers command + mcp and handles command.execute.before & chat.message", async () => {
  const { dir, storePath } = makeTempStore();
  const prevStore = process.env.PROMPT_MANAGER_STORE_PATH;
  process.env.PROMPT_MANAGER_STORE_PATH = storePath;

  try {
    const hooks = await PromptManagerPlugin({});

    const cfg = {};
    await hooks.config(cfg);
    assert.equal(cfg.command.p.template, "/p $ARGUMENTS");
    assert.equal(cfg.mcp["prompt-manager"].type, "local");
    assert.equal(cfg.mcp["prompt-manager"].command[0], "node");

    // 1. Save via command.execute.before
    const cmdSaveOut = { parts: [{ type: "text", text: '/p e 1 "OpenCode saved instruction"' }] };
    await hooks["command.execute.before"](
      { sessionID: "s1", command: "p", arguments: 'e 1 "OpenCode saved instruction"' },
      cmdSaveOut,
    );
    assert.match(cmdSaveOut.parts[0].text, /Saved new prompt ID '1'/);

    // 2. Send via command.execute.before
    const cmdSendOut = { parts: [{ type: "text", text: "/p 1", id: "part-1" }] };
    await hooks["command.execute.before"](
      { sessionID: "s1", command: "p", arguments: "1" },
      cmdSendOut,
    );
    assert.equal(cmdSendOut.parts[0].text, "OpenCode saved instruction");
    assert.equal(cmdSendOut.parts[0].id, "part-1");

    // 3. Send via raw chat.message when command hook was not invoked
    const chatOut = {
      parts: [
        { type: "text", text: "/p 1" },
        { type: "file", url: "file:///example.ts" },
      ],
    };
    await hooks["chat.message"]({ sessionID: "s2" }, chatOut);
    assert.equal(chatOut.parts.length, 2);
    assert.equal(chatOut.parts[0].text, "OpenCode saved instruction");
    assert.equal(chatOut.parts[1].type, "file");

    // 4. Guard against double-expansion if saved prompt text itself starts with /p
    setPrompt("nested", "/p 1", storePath);
    const nestedOut = { parts: [{ type: "text", text: "/p nested" }] };
    await hooks["command.execute.before"](
      { sessionID: "s3", command: "p", arguments: "nested" },
      nestedOut,
    );
    assert.equal(nestedOut.parts[0].text, "/p 1");
    await hooks["chat.message"]({ sessionID: "s3" }, nestedOut);
    assert.equal(nestedOut.parts[0].text, "/p 1");
  } finally {
    if (prevStore === undefined) {
      delete process.env.PROMPT_MANAGER_STORE_PATH;
    } else {
      process.env.PROMPT_MANAGER_STORE_PATH = prevStore;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp-server.mjs handles initialize, tools/list, and CRUD tool calls", () => {
  const { dir, storePath } = makeTempStore();
  try {
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "save_prompt", arguments: { id: "1", text: "Hello MCP" } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_prompt", arguments: { id: "1" } },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "list_prompts", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "delete_prompt", arguments: { id: "1" } },
      },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "get_prompt", arguments: null },
      },
    ];

    const res = spawnSync("node", ["./scripts/mcp-server.mjs"], {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, PROMPT_MANAGER_STORE_PATH: storePath },
      input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    const replies = res.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(replies.length, 7);
    assert.equal(replies[0].result.serverInfo.name, "prompt-manager");
    assert.equal(replies[1].result.tools.length, 4);
    assert.match(replies[2].result.content[0].text, /Hello MCP/);
    assert.match(replies[3].result.content[0].text, /Hello MCP/);
    assert.match(replies[4].result.content[0].text, /"id": "1"/);
    assert.match(replies[5].result.content[0].text, /Deleted prompt '1'/);
    assert.equal(replies[6].result.isError, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("p.mjs CLI supports set, get, list, and delete preserving literal text", () => {
  const { dir, storePath } = makeTempStore();
  const env = { ...process.env, PROMPT_MANAGER_STORE_PATH: storePath };
  try {
    const setRes = spawnSync("node", ["./scripts/p.mjs", "set", "1", '"CLI prompt"'], {
      cwd: PLUGIN_ROOT,
      env,
      encoding: "utf8",
    });
    assert.equal(setRes.status, 0);
    assert.match(setRes.stdout, /Saved prompt '1'/);

    const getRes = spawnSync("node", ["./scripts/p.mjs", "get", "1"], {
      cwd: PLUGIN_ROOT,
      env,
      encoding: "utf8",
    });
    assert.equal(getRes.status, 0);
    assert.equal(getRes.stdout.trim(), '"CLI prompt"');

    const delRes = spawnSync("node", ["./scripts/p.mjs", "delete", "1"], {
      cwd: PLUGIN_ROOT,
      env,
      encoding: "utf8",
    });
    assert.equal(delRes.status, 0);
    assert.match(delRes.stdout, /Deleted prompt '1'/);

    // Pipe stdin + --json + path + clean validation error
    const stdinSet = spawnSync("node", ["./scripts/p.mjs", "set", "2", "--stdin"], {
      cwd: PLUGIN_ROOT,
      env,
      input: "line one\nline two\n",
      encoding: "utf8",
    });
    assert.equal(stdinSet.status, 0);
    assert.match(stdinSet.stdout, /Saved prompt '2'/);

    const listJsonRes = spawnSync("node", ["./scripts/p.mjs", "list", "--json"], {
      cwd: PLUGIN_ROOT,
      env,
      encoding: "utf8",
    });
    assert.equal(listJsonRes.status, 0);
    const listParsed = JSON.parse(listJsonRes.stdout);
    assert.equal(listParsed.prompts.length, 1);
    assert.equal(listParsed.prompts[0].text, "line one\nline two");

    const getJsonRes = spawnSync("node", ["./scripts/p.mjs", "get", "2", "--json"], {
      cwd: PLUGIN_ROOT,
      env,
      encoding: "utf8",
    });
    assert.equal(getJsonRes.status, 0);
    assert.equal(JSON.parse(getJsonRes.stdout).id, "2");

    const pathRes = spawnSync("node", ["./scripts/p.mjs", "path"], {
      cwd: PLUGIN_ROOT,
      env,
      encoding: "utf8",
    });
    assert.equal(pathRes.status, 0);
    assert.equal(pathRes.stdout.trim(), path.resolve(storePath));

    const badSetRes = spawnSync("node", ["./scripts/p.mjs", "set", "d", "bad"], {
      cwd: PLUGIN_ROOT,
      env,
      encoding: "utf8",
    });
    assert.equal(badSetRes.status, 1);
    assert.match(badSetRes.stderr, /^Error: Prompt ID cannot be 'd'/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store handles null prompts, malformed JSON, legacy keys, and ~/ expansion", () => {
  const { dir, storePath } = makeTempStore();
  const prevEnv = process.env.PROMPT_MANAGER_STORE_PATH;
  try {
    fs.writeFileSync(storePath, JSON.stringify({ version: 1, prompts: null }), "utf8");
    assert.throws(() => loadStore(storePath), /Invalid prompt store format/);

    fs.writeFileSync(storePath, "{not valid json", "utf8");
    assert.throws(() => loadStore(storePath), /Failed to parse prompt store/);

    fs.writeFileSync(
      storePath,
      JSON.stringify({ version: 1, prompts: { d: "legacy", __proto__: "bad" } }),
      "utf8",
    );
    const loaded = loadStore(storePath);
    assert.equal(loaded.prompts.d.text, "legacy");
    assert.equal(Object.hasOwn(loaded.prompts, "__proto__"), false);
    assert.throws(() => setPrompt("d", "new", storePath), /reserved/);

    process.env.PROMPT_MANAGER_STORE_PATH = "~/custom-prompts/prompts.json";
    assert.equal(
      resolveStorePath(),
      path.resolve(path.join(os.homedir(), "custom-prompts", "prompts.json")),
    );
  } finally {
    if (prevEnv === undefined) {
      delete process.env.PROMPT_MANAGER_STORE_PATH;
    } else {
      process.env.PROMPT_MANAGER_STORE_PATH = prevEnv;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("executePromptCommand handles inspect, delete, fence escaping, and store errors", () => {
  const { dir, storePath } = makeTempStore();
  try {
    setPrompt("1", "Use ```js\nconsole.log(1)\n``` safely", storePath);
    const inspectFound = executePromptCommand("/p e 1", storePath);
    assert.equal(inspectFound.action, "inspect");
    assert.equal(inspectFound.found, true);
    assert.match(inspectFound.systemInstruction, /````\nUse ```js/);

    const inspectMissing = executePromptCommand("/p e missing", storePath);
    assert.equal(inspectMissing.action, "error");
    assert.equal(inspectMissing.code, "MISSING_TEXT");

    const delFound = executePromptCommand("/p d 1", storePath);
    assert.equal(delFound.action, "delete");
    assert.equal(delFound.deleted, true);
    assert.equal(getPrompt("1", storePath), null);

    const delMissing = executePromptCommand("/p d 1", storePath);
    assert.equal(delMissing.action, "delete");
    assert.equal(delMissing.deleted, false);

    fs.writeFileSync(storePath, "{corrupt", "utf8");
    const storeErr = executePromptCommand("/p 1", storePath);
    assert.equal(storeErr.action, "error");
    assert.equal(storeErr.code, "STORE_ERROR");
    assert.match(storeErr.systemInstruction, /Failed to parse prompt store/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isFirstInvocationOfTurn scans across >64KB tool output chunks", () => {
  const { dir } = makeTempStore();
  const transcriptPath = path.join(dir, "big-transcript.jsonl");
  try {
    const bigPayload = "x".repeat(80 * 1024);
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "/p 1" }),
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "calling tool" }),
        JSON.stringify({ step_index: 2, type: "GENERIC", content: bigPayload }),
      ].join("\n") + "\n",
      "utf8",
    );
    assert.equal(isFirstInvocationOfTurn({ invocationNum: 2, transcriptPath }), false);

    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({ step_index: 3, type: "USER_INPUT", content: bigPayload }) + "\n",
      "utf8",
    );
    assert.equal(isFirstInvocationOfTurn({ invocationNum: 3, transcriptPath }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode plugin exports support both v2 plugin definition and v1 function", async () => {
  assert.equal(typeof defaultPlugin, "object");
  assert.equal(defaultPlugin.id, "@americanumberoneaokgoodtimes/p-plugin");
  assert.equal(typeof defaultPlugin.setup, "function");
  assert.equal(defaultPlugin, plugin);

  const hooksFromSetup = await defaultPlugin.setup({});
  assert.equal(typeof hooksFromSetup["command.execute.before"], "function");
  assert.equal(typeof hooksFromSetup["chat.message"], "function");
  assert.equal(typeof hooksFromSetup.config, "function");

  const hooksFromV1 = await PromptManagerPlugin({});
  assert.equal(typeof hooksFromV1["command.execute.before"], "function");

  const hooksFromFactory = await createPromptManagerHooks({});
  assert.equal(typeof hooksFromFactory["command.execute.before"], "function");
});

test("OpenCode plugin normalizes leading slash, handles missing sessionID, and supports /p d", async () => {
  const { dir, storePath } = makeTempStore();
  const prevStore = process.env.PROMPT_MANAGER_STORE_PATH;
  process.env.PROMPT_MANAGER_STORE_PATH = storePath;
  try {
    const hooks = await PromptManagerPlugin({});
    setPrompt("nested", "/p 1", storePath);
    setPrompt("1", "one", storePath);

    const outNoSession = { parts: [{ type: "text", text: "/p nested" }] };
    await hooks["command.execute.before"](
      { command: "/p", arguments: "nested" },
      outNoSession,
    );
    assert.equal(outNoSession.parts[0].text, "/p 1");
    await hooks["chat.message"]({}, outNoSession);
    assert.equal(outNoSession.parts[0].text, "/p 1");

    const delOut = { parts: [{ type: "text", text: "/p d 1" }] };
    await hooks["command.execute.before"]({ command: "p", arguments: "d 1" }, delOut);
    assert.match(delOut.parts[0].text, /Deleted prompt ID '1'/);
    assert.equal(getPrompt("1", storePath), null);
  } finally {
    if (prevStore === undefined) {
      delete process.env.PROMPT_MANAGER_STORE_PATH;
    } else {
      process.env.PROMPT_MANAGER_STORE_PATH = prevStore;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp-server handleMessage handles ping, validation errors, and unknown methods", () => {
  const { dir, storePath } = makeTempStore();
  try {
    const sent = [];
    const sendFn = (msg) => sent.push(msg);
    handleMessage({ jsonrpc: "2.0", id: 1, method: "ping" }, storePath, sendFn);
    handleMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "save_prompt", arguments: { id: "1" } } },
      storePath,
      sendFn,
    );
    handleMessage({ jsonrpc: "2.0", id: 3, method: "unknown/method" }, storePath, sendFn);
    assert.deepEqual(sent[0], { jsonrpc: "2.0", id: 1, result: {} });
    assert.equal(sent[1].result.isError, true);
    assert.match(sent[1].result.content[0].text, /Missing required string parameter 'text'/);
    assert.equal(sent[2].error.code, -32601);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
