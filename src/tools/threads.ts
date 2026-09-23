import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { newId, nowIso, type T3Client } from "../t3/client.js";
import type { ModelSelection, ProjectShell, ShellSnapshot, ThreadShell } from "../t3/types.js";
import { prepareDispatch } from "../t3/dispatch.js";
import { phaseOf, waitForTurn, type Phase } from "../t3/turns.js";
export { phaseOf } from "../t3/turns.js";

/** Keep tool output well under typical client context budgets. */
const CHARACTER_LIMIT = 40_000;
const MAX_WAIT_SECONDS = 300;

const modelSelectionSchema = z
  .object({
    instanceId: z
      .string()
      .describe("Provider instance id as shown in t3_list_threads' model field before the slash, e.g. 'claudeAgent' or 'codex'."),
    options: z.union([z.record(z.unknown()), z.array(z.object({ id: z.string(), value: z.unknown() }))]).optional(),
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
          .map((thread) => ({ ...summarizeThread(thread), url: client.threadUrl(thread.id) }))
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
        const activities = (activityLimit === 0 ? [] : thread.activities.slice(-activityLimit)).map((activity) => ({
          kind: activity.kind,
          tone: activity.tone ?? null,
          summary: activity.summary,
          createdAt: activity.createdAt,
        }));
        return textResult({
          url: client.threadUrl(threadId),
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
    "t3_list_harnesses",
    {
      description: "List configured provider instances, availability, authentication, and their model catalogs.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return textResult({ providers: (await client.providers()).map((provider) => ({
          instanceId: provider.instanceId, driver: provider.driver, displayName: provider.displayName,
          enabled: provider.enabled, installed: provider.installed, status: provider.status,
          authStatus: provider.auth.status, availability: provider.availability, message: provider.message,
          models: provider.models.map(({ slug, name, aliases, isDefault }) => ({ slug, name, aliases, isDefault })),
        })) });
      } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    "t3_list_worktrees",
    {
      description: "List a T3 project's local branches and worktree paths on the T3 server.",
      inputSchema: { projectId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId }) => {
      try {
        const project = findProject(await client.shell(), projectId);
        return textResult({ projectId, workspaceRoot: project.workspaceRoot, refs: await client.refs(project.workspaceRoot) });
      } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    "t3_start_thread",
    {
      title: "Start a new T3 Code thread",
      description: "Create a thread and send its first prompt. Supply idempotencyKey for safe recovery after a timeout. Use an existing worktreePath or create a worktree through T3, optionally running its setup script. Returns threadId, messageId, and url. wait=true waits for this prompt's reply.",
      inputSchema: {
        projectId: z.string(),
        prompt: z.string().min(1).max(100_000).describe("Complete task packet; the worker has no coordinator conversation context."),
        title: z.string().min(1).max(120),
        modelSelection: modelSelectionSchema.optional(),
        runtimeMode: runtimeModeSchema.default("auto"),
        interactionMode: interactionModeSchema.default("default"),
        worktreePath: z.string().optional().describe("Existing path returned by t3_list_worktrees. Mutually exclusive with worktree."),
        worktree: z.object({
          baseBranch: z.string(),
          branch: z.string().optional(),
          startFromOrigin: z.boolean().default(false),
          runSetupScript: z.boolean().default(false).describe("Run the project's configured setup script before the agent starts."),
        }).optional(),
        idempotencyKey: z.string().min(1).max(200).optional().describe("Persist before dispatch and reuse with identical arguments after a timeout."),
        wait: z.boolean().default(false),
        timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).default(60),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ idempotencyKey, wait, timeoutSeconds, ...input }) => {
      let recovery: { threadId: string; messageId: string; idempotencyKey: string } | undefined;
      try {
        const { projectId, prompt, title, modelSelection, runtimeMode, interactionMode, worktree, worktreePath } = input;
        if (worktree && worktreePath) throw new Error("Pass either worktree or worktreePath, not both.");
        const dispatch = await prepareDispatch(client.origin, "start", idempotencyKey, input, async () => {
          const shell = await client.shell();
          const project = findProject(shell, projectId);
          const resolvedModel = modelSelection ?? project.defaultModelSelection ?? latestThreadModel(shell, projectId);
          if (!resolvedModel) throw new Error(`Project "${project.title}" has no default model. Use t3_list_harnesses and pass modelSelection.`);
          const provider = (await client.providers()).find((p) => p.instanceId === resolvedModel.instanceId);
          if (!provider?.enabled || !provider.installed || !["ready", "warning"].includes(provider.status) || provider.auth.status === "unauthenticated" || provider.availability === "unavailable") {
            throw new Error(`Provider "${resolvedModel.instanceId}" is unavailable. Use t3_list_harnesses for valid choices.`);
          }
          if (!provider.models.some((m) => m.slug === resolvedModel.model || m.aliases?.includes(resolvedModel.model))) {
            throw new Error(`Model "${resolvedModel.model}" is not offered by "${provider.instanceId}". Use t3_list_harnesses.`);
          }
          const refs = worktree || worktreePath ? await client.refs(project.workspaceRoot) : [];
          const existing = worktreePath ? refs.find((ref) => ref.worktreePath === worktreePath) : undefined;
          if (worktreePath && !existing && worktreePath !== project.workspaceRoot) throw new Error("worktreePath does not belong to this project. Use t3_list_worktrees.");
          if (worktree && !refs.some((ref) => ref.name === worktree.baseBranch)) throw new Error(`Unknown local base branch "${worktree.baseBranch}".`);
          const createdAt = nowIso();
          return {
            type: "thread.turn.start", commandId: newId(), threadId: newId(),
            message: { messageId: newId(), role: "user", text: prompt, attachments: [] },
            modelSelection: resolvedModel, runtimeMode, interactionMode, createdAt,
            bootstrap: {
              createThread: { projectId, title, modelSelection: resolvedModel, runtimeMode, interactionMode, branch: existing?.name ?? null, worktreePath: worktreePath ?? null, createdAt },
              ...(worktree ? {
                prepareWorktree: { projectCwd: project.workspaceRoot, baseBranch: worktree.baseBranch, ...(worktree.branch ? { branch: worktree.branch } : {}), startFromOrigin: worktree.startFromOrigin },
                runSetupScript: worktree.runSetupScript,
              } : {}),
            },
          };
        });
        const { command } = dispatch;
        recovery = { threadId: command.threadId, messageId: command.message.messageId, idempotencyKey: dispatch.idempotencyKey };
        if (!dispatch.reused) {
          await client.rpc("orchestration.dispatchCommand", command);
        } else {
          const detail = await client.thread(command.threadId);
          if (!detail.thread.messages.some((m) => m.id === command.message.messageId)) {
            throw new Error("Previous launch has no visible prompt yet. It may still be preparing or may have failed. Inspect the thread before creating a replacement; the bootstrap was not resubmitted.");
          }
        }
        const detail = await client.thread(command.threadId);
        return textResult({
          ...summarizeThread(detail.thread), ...recovery, reused: dispatch.reused,
          worktreeSetup: detail.thread.activities.findLast((activity) => activity.kind === "worktree-setup")?.payload ?? null,
          url: client.threadUrl(command.threadId),
          ...(wait ? { result: await waitForTurn(client, command.threadId, command.message.messageId, timeoutSeconds) } : {}),
        });
      } catch (error) {
        return recovery ? { ...errorResult(error), structuredContent: { ...recovery, url: client.threadUrl(recovery.threadId), recoveryRequired: true } } : errorResult(error);
      }
    },
  );

  server.registerTool(
    "t3_send_message",
    {
      title: "Send a follow-up message to a thread",
      description: "Start a new turn on an idle thread. Reuse idempotencyKey with identical arguments to avoid duplicate messages. wait=true waits for this message's reply.",
      inputSchema: {
        threadId: z.string(), text: z.string().min(1).max(100_000),
        runtimeMode: runtimeModeSchema.optional(), interactionMode: interactionModeSchema.optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
        wait: z.boolean().default(false),
        timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).default(60),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ idempotencyKey, wait, timeoutSeconds, ...input }) => {
      let recovery: { threadId: string; messageId: string; idempotencyKey: string } | undefined;
      try {
        const { threadId, text, runtimeMode, interactionMode } = input;
        const thread = findThread(await client.shell(), threadId);
        const dispatch = await prepareDispatch(client.origin, `send:${threadId}`, idempotencyKey, input, () => ({
          type: "thread.turn.start", commandId: newId(), threadId,
          message: { messageId: newId(), role: "user", text, attachments: [] },
          runtimeMode: runtimeMode ?? thread.runtimeMode,
          interactionMode: interactionMode ?? thread.interactionMode ?? "default", createdAt: nowIso(),
        }));
        const { command } = dispatch;
        recovery = { threadId, messageId: command.message.messageId, idempotencyKey: dispatch.idempotencyKey };
        const detail = await client.thread(threadId);
        const sent = detail.thread.messages.some((m) => m.id === command.message.messageId);
        if (!sent) {
          if (phaseOf(thread) === "running" || phaseOf(thread) === "blocked") throw new Error("Thread is running or blocked. Wait or resolve its pending request before sending new work.");
          await client.dispatch(command);
        }
        return textResult({ ...recovery, sent: true, reused: dispatch.reused, url: client.threadUrl(threadId), ...(wait ? { result: await waitForTurn(client, threadId, command.message.messageId, timeoutSeconds) } : {}) });
      } catch (error) {
        return recovery ? { ...errorResult(error), structuredContent: { ...recovery, recoveryRequired: true } } : errorResult(error);
      }
    },
  );

  server.registerTool(
    "t3_wait_for_turn",
    {
      description: "Wait for the reply to a specific messageId returned by start/send. Reports blocked, interrupted, error, superseded, or timedOut separately from completed. Never substitutes another turn's reply.",
      inputSchema: { threadId: z.string(), messageId: z.string(), timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).default(60) },
      annotations: { readOnlyHint: true },
    },
    async ({ threadId, messageId, timeoutSeconds }) => {
      try { return textResult(await waitForTurn(client, threadId, messageId, timeoutSeconds)); }
      catch (error) { return errorResult(error); }
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
