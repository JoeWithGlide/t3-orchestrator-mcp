#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { hostname } from "node:os";

import { credentialsPath, listCredentials, resolveAccessToken, resolveOrigin, saveCredential } from "./config.js";
import { exchangePairingUrl, T3Client, T3Unauthenticated } from "./t3/client.js";
import { registerThreadTools } from "./tools/threads.js";

const SERVER_NAME = "t3-orchestrator-mcp";
const SERVER_VERSION = "0.1.0";

async function pair(pairingUrl: string | undefined): Promise<void> {
  if (!pairingUrl) {
    console.error(`usage: ${SERVER_NAME} pair "<pairing-url>"\n\nGet the URL from \`t3 pair\` (or the desktop app's Connections panel).`);
    process.exit(2);
  }
  const result = await exchangePairingUrl(pairingUrl, `${SERVER_NAME} on ${hostname()}`);
  const path = await saveCredential({
    origin: result.origin,
    accessToken: result.accessToken,
    scope: result.scope,
    expiresAt: new Date(Date.now() + result.expiresIn * 1000).toISOString(),
    pairedAt: new Date().toISOString(),
  });
  console.error(`Paired with ${result.origin} (scope: ${result.scope}). Credential saved to ${path}.`);
}

async function status(): Promise<void> {
  const origin = await resolveOrigin();
  const credentials = await listCredentials();
  console.error(`resolved origin: ${origin}`);
  console.error(`credentials file: ${credentialsPath}`);
  for (const credential of credentials) {
    const expired = Date.parse(credential.expiresAt) < Date.now();
    console.error(`  ${credential.origin}  paired ${credential.pairedAt}  ${expired ? "EXPIRED" : `expires ${credential.expiresAt}`}`);
  }
  const token = await resolveAccessToken(origin);
  if (!token) {
    console.error(`no valid credential for ${origin}`);
    process.exit(1);
  }
  const shell = await new T3Client(origin, token).shell();
  console.error(`connected: ${shell.projects.length} projects, ${shell.threads.length} threads`);
}

async function serve(): Promise<void> {
  const origin = await resolveOrigin();
  const token = await resolveAccessToken(origin);
  if (!token) {
    // Surface the fix in the MCP client's logs instead of dying silently.
    console.error(new T3Unauthenticated(origin).message);
    process.exit(1);
  }
  const client = new T3Client(origin, token);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerThreadTools(server, client);
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} connected to ${origin}`);
}

const [command, argument] = process.argv.slice(2);
const run = command === "pair" ? pair(argument) : command === "status" ? status() : serve();
run.catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
