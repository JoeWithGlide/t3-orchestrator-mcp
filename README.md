# t3-orchestrator-mcp

An MCP server that lets a coding agent start, monitor, and steer [T3 Code](https://github.com/pingdotgg/t3code) threads. It uses T3 Code's HTTP API for thread reads and ordinary commands, and authenticated WebSocket RPC for provider discovery and native worktree bootstrap. Tested against T3 Code 0.0.42.

Typical use: an orchestrator agent (in Claude Code, or in a T3 thread itself) fans a batch of tickets out into one T3 thread each, then checks back on them.

## Tools

| Tool | What it does |
|---|---|
| `t3_list_projects` | Projects with workspace root and default model |
| `t3_list_threads` | One-line status per thread: `running` / `blocked` / `idle` / `error` |
| `t3_get_thread` | Newest messages and activity for one thread |
| `t3_start_thread` | Start a thread in a new or existing worktree, with optional setup and wait |
| `t3_list_harnesses` | Configured provider instances, availability, and models |
| `t3_list_worktrees` | Local branches and worktree paths for a project |
| `t3_wait_for_turn` | Wait for a specific message and return its completed reply |
| `t3_send_message` | Follow-up message on an existing thread |
| `t3_wait_for_idle` | Block (up to 5 min) until listed threads stop running |
| `t3_interrupt_thread` | Stop the current turn |
| `t3_rename_thread` | Set the sidebar title |

## Setup

```bash
cd ~/Work/t3-orchestrator-mcp
npm install && npm run build
```

Pair once with the running T3 server. In a terminal where the T3 CLI is available:

```bash
t3 pair            # or: node apps/server/src/bin.ts pair  from a t3code checkout
```

Copy the printed pairing URL (it carries a one-time token in the `#token=` fragment) and exchange it:

```bash
node dist/index.js pair "http://127.0.0.1:3773/#token=..."
node dist/index.js status     # confirms origin, credential, project/thread counts
```

The bearer token is stored in `~/.config/t3-orchestrator-mcp/credentials.json` (mode 0600) and is valid for 30 days. Re-run `pair` when `status` reports it expired.

## Register with Claude Code

Global, so it is available in every Claude Code session including ones running inside T3 threads:

```json
// ~/.claude.json  →  "mcpServers"
{
  "t3": {
    "command": "node",
    "args": ["/Users/<you>/Work/t3-orchestrator-mcp/dist/index.js"]
  }
}
```

Or per project in `.mcp.json`, or with `claude mcp add --scope user t3 -- node /path/to/dist/index.js`.

Codex: `codex mcp add t3 -- node /path/to/dist/index.js` (writes `[mcp_servers.t3]` to `~/.codex/config.toml`).

Pi: add the same `t3` entry under `mcpServers` in `~/.pi/agent/mcp.json`. Pi also imports Claude Code's servers, so the explicit entry just removes that dependency.

Cursor, Grok, and OpenCode need their own registration if threads on those providers should orchestrate too.

## Configuration

| Variable | Purpose |
|---|---|
| `T3_ORIGIN` | Server origin. Default: the `origin` in `~/.t3/userdata/server-runtime.json`, else `http://127.0.0.1:3773` |
| `T3_ACCESS_TOKEN` | Bearer token override; skips the credentials file |
| `T3_RUNTIME_STATE_FILE` | Alternate `server-runtime.json`, e.g. a worktree's `.t3/userdata/server-runtime.json` |
| `T3_ORCHESTRATOR_CONFIG_DIR` | Where credentials live |

Point at a worktree dev server with `T3_ORIGIN=http://127.0.0.1:<port>` and pair against it separately; credentials are keyed by origin.

## Orchestrating from a skill

The cmux-based flow (create workspace, wait for shell, send `cc '...'`, wait for banner, `capture-pane`) collapses to:

1. `t3_list_projects` to get the `projectId`.
2. One `t3_start_thread` per ticket with the full prompt, a title like `BUG-2688 (pscu)`, `runtimeMode: "auto"`, and `worktree: { baseBranch: "main" }` if the investigations should not share a checkout.
3. `t3_wait_for_idle` with all the thread ids, then `t3_get_thread` on each to read the final assistant message.

Use `t3_list_harnesses` when choosing an explicit provider/model. Omitted model selection still uses the project default, then the most recent thread. Both array and record forms of model options are preserved.

### Worktrees and setup

Pass `worktree: { baseBranch: "main", branch: "my-issue", runSetupScript: true }` to let T3 create the worktree and run its configured setup script. The local base branch must exist. `startFromOrigin: true` asks T3 to fetch first, with T3's local-base fallback when no matching remote exists. Setup remains off by default for compatibility. T3 controls whether setup runs synchronously or in the background according to the script's `async` setting.

To attach an existing checkout, pass a `worktreePath` returned by `t3_list_worktrees`, instead of `worktree`. Only paths belonging to the selected project are accepted. The coordinator must keep one writer per worktree.

### Retries and recovery

Persist an `idempotencyKey` before calling start or send. Reuse it with identical task arguments after a timeout; `wait` and `timeoutSeconds` may change. Calls return the key, `threadId`, `messageId`, and a local T3 URL. Changed task arguments under an existing key are rejected.

Dispatch records live under `~/.config/t3-orchestrator-mcp/dispatches`, or `T3_ORCHESTRATOR_CONFIG_DIR`. They contain prompts and resolved commands, with directory mode 0700 and file mode 0600. Keep these records while a coordinator may retry, and use the same config directory across coordinator restarts. A different directory or a deleted record loses duplicate protection.

Launch records are written before submitting T3's bootstrap. A retry reads the original thread and never resubmits that bootstrap, because T3 setup has side effects outside its command receipts. If a crash occurred before submission, or the outcome remains uncertain, the tool returns recovery IDs and an error. Inspect that thread and worktree before choosing a new key. Interrupted or failed workers are not automatically relaunched. Follow-up retries reuse the same T3 command and message IDs.

### Waiting

Use `wait: true` on start/send, or call `t3_wait_for_turn` with their returned `messageId`. Only `completed: true` proves a completed reply for that prompt. A previous reply, a streaming reply, a blocked approval, an interrupted turn, and a timeout do not count. If another prompt has overtaken it, the result is `superseded`; inspect thread history rather than treating the newer reply as its result. Replies are capped at 20,000 characters with a `truncated` flag.

`t3_wait_for_idle` remains available for coordinating several threads. Its `allIdle` means none is running, not that every task succeeded. Send new work only after the current turn stops; resolve pending questions or approvals through T3. Thread state and the final report remain the source of truth.

## How it talks to T3 Code

- `GET /api/orchestration/shell` for projects and thread summaries
- `GET /api/orchestration/threads/:id?turnLimit=N` for messages and activity
- `POST /api/orchestration/dispatch` with `thread.create`, `thread.turn.start`, `thread.turn.interrupt`, `thread.meta.update`, `thread.delete`

New threads use `orchestration.dispatchCommand` over `/ws` with T3's `bootstrap.createThread` and optional `prepareWorktree`. T3 owns worktree creation and setup. The bridge does not open T3's database or run Git commands locally. `server.getConfig` and `vcs.listRefs` provide provider and worktree discovery.

The wire types are a small subset of T3's contracts. Unknown turn/session states fail explicitly rather than appearing idle. T3's application APIs can change; verify compatibility when upgrading the server.

## Development

```bash
npm run dev                # run from source over stdio
npm run inspect            # MCP Inspector against dist/
npm run typecheck
npm test                   # RPC, retry, and turn-matching tests
```
