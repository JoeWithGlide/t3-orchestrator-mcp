import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { newId, nowIso, type T3Client } from "../t3/client.js";
import type { ModelSelection, ProjectShell, ShellSnapshot, ThreadShell } from "../t3/types.js";
import { createWorktree } from "../t3/worktree.js";

/** Keep tool output well under typical client context budgets. */
const CHARACTER_LIMIT = 40_000;
const MAX_WAIT_SECONDS = 300;

/**
 * Collapse T3's session + turn state into what an orchestrator cares about.
 * "blocked" means a human (or the orchestrator) must answer something before
 * the agent continues; "idle" means the last turn finished.
 */
export type Phase = "running" | "blocked" | "idle" | "error";

export function phaseOf(thread: {
  session: ThreadShell["session"];
  latestTurn: ThreadShell["latestTurn"];
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
}): Phase {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "blocked";
  const turn = thread.latestTurn?.state;
  const session = thread.session?.status;
  if (turn === "running" || session === "starting" || session === "running") return "running";
  if (turn === "error" || session === "error") return "error";
  return "idle";
}

const modelSelectionSchema = z
  .object({
    instanceId: z
      .string()
      .describe("Provider instance id as shown in t3_list_threads' model field before the slash, e.g. 'claudeAgent' or 'codex'."),
    model: z.string().describe("Model id as the provider names it, e.g. 'claude-opus-4-6' or 'gpt-5.4'."),
  })
  .describe("Which provider instance and model run the thread. Omit to use the project's default, else the model of the project's most recent thread.");

const runtimeModeSchema = z
  .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
  .describe("Permission mode. 'auto' lets the agent edit and run commands with provider sandboxing; 'full-access' removes prompts entirely.");

const interactionModeSchema = z.enum(["default", "plan"]);

function summarizeThread(thread: ThreadShell) {
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    phase: phaseOf(thread),
    sessionStatus: thread.session?.status ?? null,
    turnState: thread.latestTurn?.state ?? null,
    lastError: thread.session?.lastError ?? null,
    hasPendingApprovals: thread.hasPendingApprovals ?? false,
    hasPendingUserInput: thread.hasPendingUserInput ?? false,
    hasActionableProposedPlan: thread.hasActionableProposedPlan ?? false,
    backgroundLiveness: thread.backgroundLiveness ?? null,
    planProgress: thread.planProgress ?? null,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    model: `${thread.modelSelection.instanceId}/${thread.modelSelection.model}`,
    runtimeMode: thread.runtimeMode,
    archived: thread.archivedAt != null,
    settled: thread.settledAt != null,
    updatedAt: thread.updatedAt,
  };
}

function textResult(value: unknown) {
  let text = JSON.stringify(value, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    text = text.slice(0, CHARACTER_LIMIT) + `\n… truncated at ${CHARACTER_LIMIT} characters. Narrow the request (fewer messages, a specific thread).`;
  }
  return { content: [{ type: "text" as const, text }], structuredContent: value as Record<string, unknown> };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function findProject(shell: ShellSnapshot, projectId: string): ProjectShell {
  const project = shell.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    const known = shell.projects.map((candidate) => `${candidate.id} (${candidate.title})`).join(", ");
    throw new Error(`Unknown projectId "${projectId}". Known projects: ${known || "none — create one in T3 Code first"}.`);
  }
  return project;
}

function findThread(shell: ShellSnapshot, threadId: string): ThreadShell {
  const thread = shell.threads.find((candidate) => candidate.id === threadId);
  if (!thread) throw new Error(`Unknown threadId "${threadId}". Call t3_list_threads to see live threads.`);
  return thread;
}

/** Most recently updated thread's model in the project, then anywhere. */
function latestThreadModel(shell: ShellSnapshot, projectId: string): ModelSelection | undefined {
  const byRecency = [...shell.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (byRecency.find((thread) => thread.projectId === projectId) ?? byRecency[0])?.modelSelection;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function registerThreadTools(server: McpServer, client: T3Client): void {
  server.registerTool(
    "t3_list_projects",
    {
      title: "List T3 Code projects",
      description:
        "List the projects (repositories) registered in the connected T3 Code environment, with their workspace root and default model. Use the projectId with t3_start_thread.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const shell = await client.shell();
        const projects = shell.projects.map((project) => ({
          projectId: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          defaultModel: project.defaultModelSelection
            ? `${project.defaultModelSelection.instanceId}/${project.defaultModelSelection.model}`
            : null,
          threadCount: shell.threads.filter((thread) => thread.projectId === project.id && thread.archivedAt == null).length,
        }));
        return textResult({ origin: client.origin, projects });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "t3_list_threads",
    {
      title: "List T3 Code threads",
      description:
        "List threads with a one-line status each: phase (running | blocked | idle | error), branch, worktree, model. Defaults to unarchived threads across all projects. Use this to check on work you started.",
      inputSchema: {
        projectId: z.string().optional().describe("Only threads in this project."),
        phase: z.enum(["running", "blocked", "idle", "error"]).optional().describe("Only threads currently in this phase."),
        includeArchived: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50).describe("Most recently updated first."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, phase, includeArchived, limit }) => {
      try {
        const shell = await client.shell();
        const threads = shell.threads
          .filter((thread) => includeArchived || thread.archivedAt == null)
          .filter((thread) => !projectId || thread.projectId === projectId)
          .map(summarizeThread)
          .filter((thread) => !phase || thread.phase === phase)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return textResult({ total: threads.length, threads: threads.slice(0, limit) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "t3_get_thread",
    {
      title: "Read a T3 Code thread",
      description:
        "Read one thread's status plus its most recent messages and activity (tool calls, approvals, failures). The final assistant message of a finished turn is the agent's report. Increase messageLimit to read further back.",
      inputSchema: {
        threadId: z.string(),
        messageLimit: z.number().int().min(1).max(50).default(6).describe("How many of the newest messages to return."),
        activityLimit: z.number().int().min(0).max(100).default(20).describe("How many of the newest activity items to return."),
        maxMessageChars: z.number().int().min(200).max(20_000).default(4000).describe("Truncate each message body to this many characters."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ threadId, messageLimit, activityLimit, maxMessageChars }) => {
      try {
        const [shell, detail] = await Promise.all([client.shell(), client.thread(threadId, messageLimit)]);
        const shellThread = shell.threads.find((thread) => thread.id === threadId);
        const thread = detail.thread;
        const messages = thread.messages.slice(-messageLimit).map((message) => ({
          id: message.id,
          role: message.role,
          createdAt: message.createdAt,
          streaming: message.streaming,
          text:
            message.text.length > maxMessageChars
              ? message.text.slice(0, maxMessageChars) + `… [${message.text.length - maxMessageChars} more chars]`
              : message.text,
        }));
        const activities = thread.activities.slice(-activityLimit).map((activity) => ({
          kind: activity.kind,
          tone: activity.tone ?? null,
          summary: activity.summary,
          createdAt: activity.createdAt,
        }));
        return textResult({
          ...(shellThread ? summarizeThread(shellThread) : { threadId, title: thread.title, phase: phaseOf({ ...thread }) }),
          messages,
          activities,
          hasOlderMessages: detail.page?.hasMore ?? false,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "t3_start_thread",
    {
      title: "Start a new T3 Code thread",
      description:
        "Create a thread in a project and send its first prompt in one step. The agent starts working immediately in the background. Optionally isolate it in a fresh git worktree off a base branch (the project's worktree setup script does NOT run; include any setup the agent needs in the prompt). Returns the threadId; poll with t3_wait_for_idle or t3_list_threads.",
      inputSchema: {
        projectId: z.string().describe("From t3_list_projects."),
        prompt: z.string().min(1).max(100_000).describe("The first user message. Include everything the agent needs; it has no context from this conversation."),
        title: z.string().min(1).max(120).describe("Short thread title shown in the sidebar, e.g. 'BUG-2688 (pscu)'."),
        modelSelection: modelSelectionSchema.optional(),
        runtimeMode: runtimeModeSchema.default("auto"),
        interactionMode: interactionModeSchema.default("default").describe("'plan' asks the agent to propose a plan before editing."),
        worktree: z
          .object({
            baseBranch: z.string().describe("Branch to fork the worktree from, e.g. 'main'."),
            branch: z.string().optional().describe("Name for the new branch. Omit to let T3 Code generate one."),
            startFromOrigin: z.boolean().default(false).describe("Fetch and start from origin/<baseBranch> instead of the local ref."),
          })
          .optional()
          .describe("Give the thread its own git worktree. Omit to work in the project's main checkout."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId, prompt, title, modelSelection, runtimeMode, interactionMode, worktree }) => {
      try {
        const shell = await client.shell();
        const project = findProject(shell, projectId);
        const resolvedModel: ModelSelection | null | undefined =
          modelSelection ?? project.defaultModelSelection ?? latestThreadModel(shell, projectId);
        if (!resolvedModel) {
          throw new Error(
            `Project "${project.title}" has no default model and no prior threads. Pass modelSelection, e.g. {"instanceId":"claudeAgent","model":"claude-opus-4-6"}.`,
          );
        }
        const created = worktree
          ? await createWorktree({
              projectCwd: project.workspaceRoot,
              baseBranch: worktree.baseBranch,
              branch: worktree.branch,
              startFromOrigin: worktree.startFromOrigin,
            })
          : null;

        const threadId = newId();
        const createdAt = nowIso();
        await client.dispatch({
          type: "thread.create",
          commandId: newId(),
          threadId,
          projectId,
          title,
          modelSelection: resolvedModel,
          runtimeMode,
          interactionMode,
          branch: created?.branch ?? null,
          worktreePath: created?.path ?? null,
          createdAt,
        });
        try {
          await client.dispatch({
            type: "thread.turn.start",
            commandId: newId(),
            threadId,
            message: { messageId: newId(), role: "user", text: prompt, attachments: [] },
            runtimeMode,
            interactionMode,
            createdAt: nowIso(),
          });
        } catch (error) {
          // Mirror the server's own bootstrap cleanup so a failed start does
          // not leave an empty thread in the sidebar.
          await client.dispatch({ type: "thread.delete", commandId: newId(), threadId }).catch(() => undefined);
          throw error;
        }
        return textResult({
          threadId,
          title,
          projectId,
          model: `${resolvedModel.instanceId}/${resolvedModel.model}`,
          branch: created?.branch ?? null,
          worktreePath: created?.path ?? null,
          next: "Call t3_wait_for_idle with this threadId, or t3_list_threads to check phase.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "t3_send_message",
    {
      title: "Send a follow-up message to a thread",
      description:
        "Send a user message to an existing thread, starting a new turn. Fails if a turn is already running; interrupt first or wait for idle.",
      inputSchema: {
        threadId: z.string(),
        text: z.string().min(1).max(100_000),
        runtimeMode: runtimeModeSchema.optional().describe("Defaults to the thread's current mode."),
        interactionMode: interactionModeSchema.optional().describe("Defaults to the thread's current mode."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ threadId, text, runtimeMode, interactionMode }) => {
      try {
        const shell = await client.shell();
        const thread = findThread(shell, threadId);
        const phase = phaseOf(thread);
        if (phase === "running") {
          throw new Error(`Thread "${thread.title}" is still running a turn. Use t3_wait_for_idle or t3_interrupt_thread first.`);
        }
        await client.dispatch({
          type: "thread.turn.start",
          commandId: newId(),
          threadId,
          message: { messageId: newId(), role: "user", text, attachments: [] },
          runtimeMode: runtimeMode ?? thread.runtimeMode,
          interactionMode: interactionMode ?? thread.interactionMode ?? "default",
          createdAt: nowIso(),
        });
        return textResult({ threadId, sent: true, previousPhase: phase });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "t3_wait_for_idle",
    {
      title: "Wait for threads to finish their turn",
      description:
        "Block until every listed thread is no longer running (idle, blocked on a question/approval, or errored), or until the timeout. Returns each thread's phase. If some are still running when it times out, call it again; do not sleep or poll t3_list_threads in a tight loop.",
      inputSchema: {
        threadIds: z.array(z.string()).min(1).max(50),
        timeoutSeconds: z.number().int().min(5).max(MAX_WAIT_SECONDS).default(120),
        pollIntervalSeconds: z.number().int().min(2).max(60).default(5),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ threadIds, timeoutSeconds, pollIntervalSeconds }) => {
      try {
        const deadline = Date.now() + timeoutSeconds * 1000;
        for (;;) {
          const shell = await client.shell();
          const statuses = threadIds.map((threadId) => {
            const thread = shell.threads.find((candidate) => candidate.id === threadId);
            return thread
              ? summarizeThread(thread)
              : { threadId, phase: "error" as Phase, title: null, lastError: "thread not found (still bootstrapping, or deleted)" };
          });
          const stillRunning = statuses.filter((status) => status.phase === "running").map((status) => status.threadId);
          if (stillRunning.length === 0 || Date.now() >= deadline) {
            return textResult({
              allIdle: stillRunning.length === 0,
              stillRunning,
              threads: statuses,
              ...(stillRunning.length > 0 ? { next: "Call t3_wait_for_idle again with the stillRunning ids." } : {}),
            });
          }
          await sleep(Math.min(pollIntervalSeconds * 1000, deadline - Date.now()));
        }
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "t3_interrupt_thread",
    {
      title: "Interrupt a running thread",
      description: "Stop the current turn on a thread. The thread stays open and can receive a new message afterwards.",
      inputSchema: { threadId: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ threadId }) => {
      try {
        await client.dispatch({ type: "thread.turn.interrupt", commandId: newId(), threadId, createdAt: nowIso() });
        return textResult({ threadId, interrupted: true });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "t3_rename_thread",
    {
      title: "Rename a thread",
      description: "Set a thread's sidebar title.",
      inputSchema: { threadId: z.string(), title: z.string().min(1).max(120) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ threadId, title }) => {
      try {
        await client.dispatch({ type: "thread.meta.update", commandId: newId(), threadId, title });
        return textResult({ threadId, title });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
