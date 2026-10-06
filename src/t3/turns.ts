import type { T3Client } from "./client.js";
import type { ThreadShell, ThreadDetail } from "./types.js";

export type Phase = "running" | "blocked" | "idle" | "error";

export function phaseOf(thread: Pick<ThreadShell, "session" | "latestTurn" | "hasPendingApprovals" | "hasPendingUserInput">): Phase {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "blocked";
  const turn = thread.latestTurn?.state;
  const session = thread.session?.status;
  if (turn && !["running", "completed", "interrupted", "error"].includes(turn)) throw new Error(`Unknown T3 turn state: ${turn}`);
  if (session && !["idle", "starting", "running", "ready", "interrupted", "stopped", "error"].includes(session)) throw new Error(`Unknown T3 session status: ${session}`);
  if (turn === "running" || session === "starting" || session === "running") return "running";
  if (turn === "error" || session === "error") return "error";
  return "idle";
}

export function turnResult(thread: ThreadDetail, messageId: string, previousTurnId: string | null, shellThread?: ThreadShell) {
  const phase = phaseOf(shellThread ?? thread);
  const message = thread.messages.find((m) => m.id === messageId && m.role === "user");
  const latestUser = thread.messages.findLast((m) => m.role === "user");
  const turn = thread.latestTurn;
  const matched = message && latestUser?.id === messageId && turn?.requestedAt &&
    turn.turnId !== previousTurnId &&
    (message.turnId ? message.turnId === turn.turnId : Date.parse(turn.requestedAt) >= Date.parse(message.createdAt));
  const status = message && latestUser?.id !== messageId ? "superseded"
    : matched ? turn.state : "pending";
  const reply = matched && status === "completed"
    ? thread.messages.find((m) => m.id === turn.assistantMessageId && m.turnId === turn.turnId && m.role === "assistant" && !m.streaming)
    : undefined;
  return {
    threadId: thread.id, messageId, phase, status,
    turnId: matched ? turn.turnId : null,
    completed: status === "completed" && !!reply && phase === "idle",
    reply: reply ? { id: reply.id, text: reply.text.slice(0, 20_000), truncated: reply.text.length > 20_000 } : null,
    lastError: thread.session?.lastError ?? null,
  };
}

export async function waitForTurn(client: T3Client, threadId: string, messageId: string, previousTurnId: string | null, timeoutSeconds: number) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const [detail, shell] = await Promise.all([client.thread(threadId, 50), client.shell()]);
    const result = turnResult(detail.thread, messageId, previousTurnId, shell.threads.find((t) => t.id === threadId));
    const stopped = result.completed || ["error", "interrupted", "superseded"].includes(result.status) || ["blocked", "error"].includes(result.phase);
    if (stopped || Date.now() >= deadline) return { ...result, timedOut: !stopped, url: await client.threadUrl(threadId) };
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
  }
}
