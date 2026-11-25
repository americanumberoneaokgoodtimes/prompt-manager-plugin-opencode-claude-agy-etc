---
name: p
description: >-
  Manage and send saved prompt instructions by ID via /p <id> and
  /p e <id> <text>. Use only when explicitly invoked as /p.
disable-model-invocation: true
---

# Prompt Manager (`/p`)

This skill registers the `/p` slash command (namespaced as `/prompt-manager:p` in
Antigravity and Claude Code). A pre-turn hook (`PreInvocation` in Antigravity,
`UserPromptSubmit` in Claude Code, or `command.execute.before`/`chat.message` in
OpenCode) handles `/p` deterministically before model execution.

## Behavior

1. **If a hook message (`Prompt Manager ...`, `<prompt-manager-hook>`, or `[Prompt Manager]`) is already present in this turn:**
   Follow that hook output directly:
   - For `/p e <id> <text>` (save/edit), confirm the save briefly without executing `<text>`.
   - For `/p <id>` (send), follow the injected resolved instruction directly.
   - For `/p` (list), `/p e <id>` (inspect), `/p d <id>` (delete), or errors/missing IDs, report the hook message and stop.

2. **Fallback (only if no hook handled this turn):**
   Use the bundled `prompts` MCP tools (`list_prompts`, `get_prompt`, `save_prompt`, `delete_prompt`):
   - `/p` (no arguments): call `list_prompts` and display saved IDs, previews, and usage (`/p <id>`, `/p e <id> <text>`, `/p e <id>`, `/p d <id>`).
   - `/p e <id> <text>`: call `save_prompt` with `id` and `text`, then confirm the save without executing `<text>`.
   - `/p e <id>` (no `<text>`): call `get_prompt` for `id` to show the current saved text (if any) and edit/delete usage.
   - `/p d <id>`: call `delete_prompt` for `id` and confirm deletion (or report not found).
   - `/p <id>` (first argument is not `e` or `d`): call `get_prompt` for `id`. If found, follow the returned `text` as the user's instruction; if not found, list available IDs with `list_prompts` and show `/p e <id> "<text>"`.
