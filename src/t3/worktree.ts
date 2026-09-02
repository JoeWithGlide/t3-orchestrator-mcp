import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * T3 home. The server derives its worktrees dir from the same base, so
 * worktrees we create land where the UI expects them.
 */
const T3_HOME = process.env.T3_HOME ?? path.join(homedir(), ".t3");

export interface CreateWorktreeInput {
  projectCwd: string;
  baseBranch: string;
  branch?: string | undefined;
  startFromOrigin?: boolean | undefined;
}

export interface CreatedWorktree {
  branch: string;
  path: string;
  baseRef: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (cause) {
    const stderr = typeof cause === "object" && cause && "stderr" in cause ? String((cause as { stderr: unknown }).stderr).trim() : "";
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || (cause instanceof Error ? cause.message : String(cause))}`);
  }
}

/**
 * Mirror of the server's createWorktree: branch `t3code/<8 hex>` unless
 * given, path `<T3 home>/worktrees/<repo dir name>/<branch with / -> ->`.
 * Only runs on the machine that hosts the T3 server (same as this MCP).
 */
export async function createWorktree(input: CreateWorktreeInput): Promise<CreatedWorktree> {
  const branch = input.branch ?? `t3code/${randomBytes(4).toString("hex")}`;
  let baseRef = input.baseBranch;

  if (input.startFromOrigin) {
    const remotes = await git(input.projectCwd, ["remote"]);
    if (remotes.split("\n").includes("origin")) {
      await git(input.projectCwd, ["fetch", "origin", input.baseBranch]);
      baseRef = `origin/${input.baseBranch}`;
    }
  }

  const repoName = path.basename(input.projectCwd);
  const worktreePath = path.join(T3_HOME, "worktrees", repoName, branch.replace(/\//g, "-"));
  await git(input.projectCwd, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
  return { branch, path: worktreePath, baseRef };
}
