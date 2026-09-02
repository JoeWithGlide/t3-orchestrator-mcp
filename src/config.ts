import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Where the MCP keeps its long-lived bearer token. One file per server
 * origin so the same install can talk to a worktree dev server and the
 * real one without clobbering.
 */
const CONFIG_DIR = process.env.T3_ORCHESTRATOR_CONFIG_DIR ?? path.join(homedir(), ".config", "t3-orchestrator-mcp");
const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials.json");

/** The live server writes this next to its database on startup. */
const DEFAULT_RUNTIME_STATE_FILE = path.join(homedir(), ".t3", "userdata", "server-runtime.json");

export interface StoredCredential {
  origin: string;
  accessToken: string;
  scope: string;
  expiresAt: string;
  pairedAt: string;
}

interface CredentialsFile {
  credentials: Record<string, StoredCredential>;
}

async function readCredentialsFile(): Promise<CredentialsFile> {
  try {
    const raw = await readFile(CREDENTIALS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
    return { credentials: parsed.credentials ?? {} };
  } catch {
    return { credentials: {} };
  }
}

export async function saveCredential(credential: StoredCredential): Promise<string> {
  const file = await readCredentialsFile();
  file.credentials[normalizeOrigin(credential.origin)] = credential;
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  return CREDENTIALS_FILE;
}

export async function loadCredential(origin: string): Promise<StoredCredential | undefined> {
  const file = await readCredentialsFile();
  return file.credentials[normalizeOrigin(origin)];
}

export async function listCredentials(): Promise<StoredCredential[]> {
  return Object.values((await readCredentialsFile()).credentials);
}

/**
 * Canonical origin for keying credentials. Loopback spellings collapse to
 * 127.0.0.1 so a pairing URL that says `localhost` matches the origin the
 * server records in server-runtime.json.
 */
export function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1") {
    url.hostname = "127.0.0.1";
  }
  return url.origin;
}

/**
 * Resolve which T3 server to talk to. Precedence: explicit T3_ORIGIN, then
 * the origin recorded by the running local server, then localhost:3773.
 */
export async function resolveOrigin(): Promise<string> {
  if (process.env.T3_ORIGIN) return normalizeOrigin(process.env.T3_ORIGIN);
  const runtimeFile = process.env.T3_RUNTIME_STATE_FILE ?? DEFAULT_RUNTIME_STATE_FILE;
  try {
    const raw = await readFile(runtimeFile, "utf8");
    const parsed = JSON.parse(raw) as { origin?: string };
    if (parsed.origin) return normalizeOrigin(parsed.origin);
  } catch {
    // fall through
  }
  return "http://127.0.0.1:3773";
}

/**
 * Resolve the bearer token for an origin. T3_ACCESS_TOKEN wins so the MCP
 * can run in environments with no home directory.
 */
export async function resolveAccessToken(origin: string): Promise<string | undefined> {
  if (process.env.T3_ACCESS_TOKEN) return process.env.T3_ACCESS_TOKEN;
  const stored = await loadCredential(origin);
  if (!stored) return undefined;
  if (Date.parse(stored.expiresAt) < Date.now()) return undefined;
  return stored.accessToken;
}

export const credentialsPath = CREDENTIALS_FILE;
