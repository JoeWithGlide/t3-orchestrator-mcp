/**
 * Hand-written, tolerant subset of T3 Code's wire types.
 *
 * Deliberately NOT imported from @t3tools/contracts (private, unpublished).
 * Every field we read is optional-or-nullable on our side so newer servers
 * that add or drop fields keep decoding. Source of truth in the t3code repo:
 * packages/contracts/src/orchestration.ts and environmentHttp.ts.
 */

export type SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "ready"
  | "interrupted"
  | "stopped"
  | "error";

export type TurnState = "running" | "interrupted" | "completed" | "error";

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type InteractionMode = "default" | "plan";

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: Record<string, unknown>;
}

export interface Session {
  status: SessionStatus;
  providerName?: string | null;
  providerInstanceId?: string;
  activeTurnId?: string | null;
  lastError?: string | null;
  updatedAt?: string;
}

export interface LatestTurn {
  turnId: string;
  state: TurnState;
  requestedAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  assistantMessageId?: string | null;
}

export interface ProjectShell {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection?: ModelSelection | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ThreadShell {
  id: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode?: InteractionMode;
  branch: string | null;
  worktreePath: string | null;
  latestTurn: LatestTurn | null;
  session: Session | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  settledAt?: string | null;
  snoozedUntil?: string | null;
  latestUserMessageAt?: string | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  hasActionableProposedPlan?: boolean;
  backgroundLiveness?: "working" | "monitoring" | null;
  planProgress?: { step: string; completedSteps: number; totalSteps: number } | null;
}

export interface ShellSnapshot {
  snapshotSequence: number;
  projects: ProjectShell[];
  threads: ThreadShell[];
  updatedAt: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | string;
  text: string;
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
}

export interface Activity {
  id: string;
  tone?: string;
  kind: string;
  summary: string;
  payload?: unknown;
  turnId: string | null;
  createdAt: string;
}

export interface ThreadDetail extends Omit<ThreadShell, "hasPendingApprovals" | "hasPendingUserInput"> {
  messages: Message[];
  activities: Activity[];
  deletedAt?: string | null;
}

export interface ThreadDetailSnapshot {
  snapshotSequence: number;
  thread: ThreadDetail;
  page?: { hasMore: boolean; beforeCursor: string | null };
}

export interface DispatchResult {
  sequence: number;
}

/**
 * Commands we send through POST /api/orchestration/dispatch.
 *
 * Note: the `bootstrap` field of thread.turn.start (create thread + prepare
 * worktree in one call) is only honored on the WebSocket path. Over HTTP the
 * command goes straight to the decider, so we create the thread ourselves.
 */
export type Command =
  | {
      type: "thread.create";
      commandId: string;
      threadId: string;
      projectId: string;
      title: string;
      modelSelection: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: InteractionMode;
      branch: string | null;
      worktreePath: string | null;
      createdAt: string;
    }
  | {
      type: "thread.turn.start";
      commandId: string;
      threadId: string;
      message: { messageId: string; role: "user"; text: string; attachments: [] };
      titleSeed?: string;
      runtimeMode: RuntimeMode;
      interactionMode: InteractionMode;
      createdAt: string;
    }
  | { type: "thread.turn.interrupt"; commandId: string; threadId: string; createdAt: string }
  | { type: "thread.delete"; commandId: string; threadId: string }
  | { type: "thread.meta.update"; commandId: string; threadId: string; title: string }
  | { type: "thread.archive"; commandId: string; threadId: string; createdAt: string };
