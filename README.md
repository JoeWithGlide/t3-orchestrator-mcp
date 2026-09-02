# t3-orchestrator-mcp

An MCP server that lets a coding agent start, monitor, and steer [T3 Code](https://github.com/pingdotgg/t3code) threads. It talks to T3 Code's public HTTP API only, so it lives outside the T3 Code repo and is not pinned to a release.

Typical use: an orchestrator agent (in Claude Code, or in a T3 thread itself) fans a batch of tickets out into one T3 thread each, then checks back on them.

## Tools

| Tool | What it does |
|---|---|
| `t3_list_projects` | Projects with workspace root and default model |
| `t3_list_threads` | One-line status per thread: `running` / `blocked` / `idle` / `error` |
| `t3_get_thread` | Newest messages and activity for one thread |
| `t3_start_thread` | Create a thread and send its first prompt, optionally in a fresh git worktree |
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

Or per project in `.mcp.json`. Codex, Cursor, Grok, and OpenCode need their own MCP registration if you want threads on those providers to orchestrate too.

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

No `INVESTIGATION_COMPLETE` sentinel is needed. A turn is over when the thread's phase leaves `running`. `blocked` means the agent is waiting on an approval or a question; answer it in the T3 UI or from mobile.

## How it talks to T3 Code

- `GET /api/orchestration/shell` for projects and thread summaries
- `GET /api/orchestration/threads/:id?turnLimit=N` for messages and activity
- `POST /api/orchestration/dispatch` with `thread.create`, `thread.turn.start`, `thread.turn.interrupt`, `thread.meta.update`, `thread.delete`

The WebSocket path's `bootstrap` (create thread, prepare worktree, run setup script in one `thread.turn.start`) is not honored over HTTP, so `t3_start_thread` sends `thread.create` then `thread.turn.start`, and creates worktrees itself with `git worktree add` using T3's own conventions (branch `t3code/<hex>`, path `~/.t3/worktrees/<repo>/<branch>`). The project's worktree setup script does not run; put any setup in the prompt.
- `POST /oauth/token` once, to exchange the pairing credential for a bearer token

The wire types in `src/t3/types.ts` are a hand-written, tolerant subset of `packages/contracts` in the T3 Code repo. When upstream changes a field, update that one file.

## Development

```bash
npm run dev                # run from source over stdio
npm run inspect            # MCP Inspector against dist/
npm run typecheck
```
