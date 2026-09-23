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
  options?: Record<string, unknown> | Array<{ id: string; value?: unknown }> | undefined;
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

// Bootstrap is sent over WebSocket RPC; ordinary commands use HTTP.
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
      modelSelection?: ModelSelection;
      bootstrap?: {
        createThread?: Omit<Extract<Command, { type: "thread.create" }>, "type" | "commandId" | "threadId">;
        prepareWorktree?: { projectCwd: string; baseBranch: string; branch?: string; startFromOrigin?: boolean };
        runSetupScript?: boolean;
      };
      titleSeed?: string;
      runtimeMode: RuntimeMode;
      interactionMode: InteractionMode;
      createdAt: string;
    }
  | { type: "thread.turn.interrupt"; commandId: string; threadId: string; createdAt: string }
  | { type: "thread.delete"; commandId: string; threadId: string }
  | { type: "thread.meta.update"; commandId: string; threadId: string; title: string }
  | { type: "thread.archive"; commandId: string; threadId: string; createdAt: string };

export interface Provider {
  instanceId: string;
  driver: string;
  displayName?: string;
  enabled: boolean;
  installed: boolean;
  status: string;
  auth: { status: string };
  availability?: string;
  message?: string;
  models: Array<{ slug: string; name: string; aliases?: string[]; isDefault?: boolean }>;
}

export interface VcsRef {
  name: string;
  current: boolean;
  worktreePath: string | null;
}
