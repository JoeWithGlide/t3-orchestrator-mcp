import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Command } from "./types.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface DispatchRecord {
  fingerprint: string;
  command: Extract<Command, { type: "thread.turn.start" }>;
}

export async function prepareDispatch(origin: string, scope: string, key: string | undefined, input: unknown, build: () => DispatchRecord["command"] | Promise<DispatchRecord["command"]>, directory = process.env.T3_ORCHESTRATOR_CONFIG_DIR ?? path.join(homedir(), ".config", "t3-orchestrator-mcp")) {
  const idempotencyKey = key ?? randomUUID();
  const dir = path.join(directory, "dispatches");
  const file = path.join(dir, `${hash(`${origin}\n${scope}\n${idempotencyKey}`)}.json`);
  const fingerprint = hash(canonical(input));
  const readExisting = async () => {
    const existing = JSON.parse(await readFile(file, "utf8")) as DispatchRecord;
    if (existing.fingerprint !== fingerprint) throw new Error("This idempotencyKey belongs to different arguments. Use the original arguments or a new key for new work.");
    return { ...existing, idempotencyKey, reused: true };
  };
  try { return await readExisting(); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const record: DispatchRecord = { fingerprint, command: await build() };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    return { ...record, idempotencyKey, reused: false };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    return readExisting();
  }
}
