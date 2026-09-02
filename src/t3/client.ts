import { randomUUID } from "node:crypto";

import type { Command, DispatchResult, ShellSnapshot, ThreadDetailSnapshot } from "./types.js";

const REQUESTED_SCOPES = "orchestration:read orchestration:operate";

export class T3ClientError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "T3ClientError";
  }
}

export class T3Unauthenticated extends Error {
  constructor(readonly origin: string) {
    super(
      `No valid credential for ${origin}. Run \`t3 pair\` in a terminal, copy the pairing URL, then run \`t3-orchestrator-mcp pair "<pairing-url>"\`.`,
    );
    this.name = "T3Unauthenticated";
  }
}

export interface TokenExchangeResult {
  accessToken: string;
  scope: string;
  expiresIn: number;
}

/**
 * Trade a one-time pairing credential for a long-lived bearer token. The
 * pairing URL from `t3 pair` carries the credential in its hash (#token=)
 * so it never hits server logs; older builds used ?token=.
 */
export async function exchangePairingUrl(pairingUrl: string, clientLabel: string): Promise<{ origin: string } & TokenExchangeResult> {
  const url = new URL(pairingUrl);
  const token =
    new URLSearchParams(url.hash.replace(/^#/, "")).get("token") ?? url.searchParams.get("token");
  if (!token) throw new Error("Pairing URL does not contain a token (expected #token=... or ?token=...).");

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: token,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: REQUESTED_SCOPES,
    client_label: clientLabel,
  });
  const response = await fetch(`${url.origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const json = (await response.json().catch(() => undefined)) as
    | { access_token?: string; scope?: string; expires_in?: number; error?: string; message?: string }
    | undefined;
  if (!response.ok || !json?.access_token) {
    throw new T3ClientError(
      `Token exchange failed (${response.status}): ${json?.message ?? json?.error ?? "unknown error"}`,
      response.status,
      json,
    );
  }
  return {
    origin: url.origin,
    accessToken: json.access_token,
    scope: json.scope ?? REQUESTED_SCOPES,
    expiresIn: json.expires_in ?? 30 * 24 * 3600,
  };
}

export class T3Client {
  constructor(
    readonly origin: string,
    private readonly accessToken: string,
  ) {}

  private async request<T>(method: "GET" | "POST", pathname: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.origin}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      throw new T3ClientError(
        `Could not reach T3 Code at ${this.origin}. Is the server (desktop app or \`npx t3\`) running?`,
        undefined,
        cause,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new T3Unauthenticated(this.origin);
    }
    const text = await response.text();
    const json = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      const detail =
        typeof json === "object" && json !== null && "message" in json
          ? String((json as { message: unknown }).message)
          : text.slice(0, 500);
      throw new T3ClientError(`${method} ${pathname} failed (${response.status}): ${detail}`, response.status, json);
    }
    return json as T;
  }

  shell(): Promise<ShellSnapshot> {
    return this.request("GET", "/api/orchestration/shell");
  }

  thread(threadId: string, turnLimit?: number): Promise<ThreadDetailSnapshot> {
    const query = turnLimit ? `?turnLimit=${turnLimit}` : "";
    return this.request("GET", `/api/orchestration/threads/${encodeURIComponent(threadId)}${query}`);
  }

  dispatch(command: Command): Promise<DispatchResult> {
    return this.request("POST", "/api/orchestration/dispatch", command);
  }
}

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();
