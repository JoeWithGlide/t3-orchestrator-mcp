import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { T3Client } from '../dist/t3/client.js';
import { prepareDispatch } from '../dist/t3/dispatch.js';
import { turnResult, phaseOf, waitForTurn } from '../dist/t3/turns.js';
import { rpcCall } from '../dist/t3/rpc.js';

const command = () => ({ type: 'thread.turn.start', commandId: crypto.randomUUID(), threadId: crypto.randomUUID(), message: { messageId: crypto.randomUUID(), role: 'user', text: 'hello', attachments: [] }, runtimeMode: 'auto', interactionMode: 'default', createdAt: new Date().toISOString() });

test('dispatch survives a coordinator restart without changing IDs or resolved defaults', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 't3-dispatch-'));
  try {
    const first = await prepareDispatch('http://localhost:3773', 'start', 'ticket-1', { title: 'hello', worktree: { branch: 'one', baseBranch: 'main' } }, command, dir);
    const retry = await prepareDispatch('http://localhost:3773', 'start', 'ticket-1', { worktree: { baseBranch: 'main', branch: 'one' }, title: 'hello' }, () => { throw new Error('must preserve recorded defaults'); }, dir);
    assert.equal(retry.reused, true);
    assert.deepEqual(retry.command, first.command);
    await assert.rejects(prepareDispatch('http://localhost:3773', 'start', 'ticket-1', { title: 'different' }, command, dir), /different arguments/);
    assert.equal((await stat(path.join(dir, 'dispatches'))).mode & 0o777, 0o700);
    const concurrent = await Promise.all(Array.from({ length: 24 }, () => prepareDispatch('http://localhost:3773', 'start', 'concurrent', { prompt: 'hello' }, command, dir)));
    assert.equal(concurrent.filter(r => !r.reused).length, 1);
    assert.equal(new Set(concurrent.map(r => r.command.threadId)).size, 1);
  } finally { await rm(dir, { recursive: true }); }
});

const old = '2026-09-20T10:00:00.000Z';
const now = '2026-09-20T10:01:00.000Z';
const thread = () => ({ id: 'thread', session: { status: 'ready' }, latestTurn: { turnId: 'turn', state: 'completed', requestedAt: now, assistantMessageId: 'reply' }, messages: [{ id: 'prompt', role: 'user', createdAt: now, turnId: null, streaming: false }, { id: 'reply', role: 'assistant', turnId: 'turn', text: 'done', streaming: false }] });

test('wait matches the requested prompt and its completed assistant reply', () => {
  assert.equal(turnResult(thread(), 'prompt', null).reply.text, 'done');
  assert.equal(turnResult(thread(), 'prompt', 'turn').completed, false);
  const wrongTurn = thread(); wrongTurn.messages[0].turnId = 'different-turn';
  assert.equal(turnResult(wrongTurn, 'prompt', null).completed, false);
  const stale = thread(); stale.latestTurn.requestedAt = old;
  assert.equal(turnResult(stale, 'prompt', null).completed, false);
  assert.equal(turnResult(stale, 'prompt', null).reply, null);
  const streaming = thread(); streaming.messages[1].streaming = true;
  assert.equal(turnResult(streaming, 'prompt', null).completed, false);
  const superseded = thread(); superseded.messages.push({ id: 'newer', role: 'user', createdAt: now });
  assert.equal(turnResult(superseded, 'prompt', null).status, 'superseded');
  assert.equal(turnResult(superseded, 'prompt', null).reply, null);
});

test('blocked, interrupted, missing, and unknown states never count as completion', async () => {
  const interrupted = thread(); interrupted.latestTurn.state = 'interrupted';
  assert.equal(turnResult(interrupted, 'prompt', null).completed, false);
  assert.equal(phaseOf({ ...thread(), hasPendingUserInput: true }), 'blocked');
  assert.throws(() => phaseOf({ ...thread(), latestTurn: { state: 'new-wire-state' } }), /Unknown T3 turn state/);
  const client = { thread: async () => ({ thread: thread() }), shell: async () => ({ threads: [thread()] }), threadUrl: () => 'http://t3/thread' };
  const missing = await waitForTurn(client, 'thread', 'missing', null, 0);
  assert.equal(missing.timedOut, true);
  assert.equal(missing.completed, false);
});

test('RPC authenticates, handles T3 envelopes, and reports disconnects and timeouts', async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  server.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer test-token');
    socket.on('message', raw => {
      const req = JSON.parse(raw.toString());
      if (req._tag !== 'Request') return;
      if (req.tag === 'ok') socket.send(JSON.stringify([{ _tag: 'Pong' }, { _tag: 'Exit', requestId: req.id, exit: { _tag: 'Success', value: { providers: [] } } }]));
      if (req.tag === 'reject') socket.send(JSON.stringify({ _tag: 'Exit', requestId: req.id, exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: 'denied' }] } }));
      if (req.tag === 'disconnect') socket.close();
    });
  });
  try {
    assert.deepEqual(await rpcCall(origin, 'test-token', 'ok', {}), { providers: [] });
    await assert.rejects(rpcCall(origin, 'test-token', 'reject', {}), /denied/);
    await assert.rejects(rpcCall(origin, 'test-token', 'disconnect', {}), /disconnected/);
    await assert.rejects(rpcCall(origin, 'test-token', 'timeout', {}, 30), /timed out/);
  } finally { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); }
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerThreadTools } from '../dist/tools/threads.js';

test('MCP retries launch once, recover lost responses, attach worktrees, and dedupe follow-ups', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 't3-tools-'));
  const previous = process.env.T3_ORCHESTRATOR_CONFIG_DIR;
  process.env.T3_ORCHESTRATOR_CONFIG_DIR = dir;
  const threads = [];
  let starts = 0, sends = 0, lastCommand;
  let urlUnavailable = true;
  const api = {
    origin: 'http://t3',
    shell: async () => ({ projects: [{ id: 'p', title: 'project', workspaceRoot: '/repo', defaultModelSelection: { instanceId: 'codex', model: 'default', options: [{ id: 'effort', value: 'low' }] } }], threads }),
    providers: async () => [{ instanceId: 'codex', enabled: true, installed: true, status: 'ready', auth: { status: 'authenticated' }, models: [{ slug: 'default' }] }],
    refs: async () => [{ name: 'main', worktreePath: '/repo' }, { name: 'issue', worktreePath: '/repo-issue' }],
    threadUrl: async id => { if (urlUnavailable) throw new Error("environment unavailable"); return `http://t3/env/${id}`; },
    thread: async id => ({ thread: threads.find(t => t.id === id) }),
    rpc: async (_tag, c) => {
      starts++; lastCommand = c;
      threads.push({ ...c.bootstrap.createThread, id: c.threadId, createdAt: c.createdAt, updatedAt: c.createdAt, latestTurn: null, session: { status: 'starting' }, activities: [], messages: [{ id: c.message.messageId, role: 'user', text: c.message.text, createdAt: c.createdAt }] });
      throw new Error('lost response');
    },
    dispatch: async c => {
      sends++;
      threads.find(t => t.id === c.threadId).messages.push({ id: c.message.messageId, role: 'user', text: c.message.text, createdAt: c.createdAt });
    },
  };
  const server = new McpServer({ name: 'test', version: '1' });
  registerThreadTools(server, api);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const input = { projectId: 'p', title: 'one', prompt: 'hello', idempotencyKey: 'one', worktree: { baseBranch: 'main', runSetupScript: true } };
  try {
    const first = await call('t3_start_thread', input);
    assert.equal(first.isError, true);
    assert.equal(first.structuredContent.recoveryRequired, true);
    assert.equal(first.structuredContent.url, null);
    assert.ok(first.structuredContent.threadId);
    urlUnavailable = false;
    const retry = await call('t3_start_thread', input);
    assert.equal(retry.isError, undefined);
    assert.equal(retry.structuredContent.threadId, first.structuredContent.threadId);
    assert.equal(starts, 1);
    assert.equal(lastCommand.bootstrap.runSetupScript, true);
    assert.deepEqual(lastCommand.modelSelection.options, [{ id: 'effort', value: 'low' }]);
    assert.equal((await call('t3_start_thread', { ...input, prompt: 'different' })).isError, true);
    assert.equal((await call('t3_start_thread', { ...input, idempotencyKey: 'bad', worktreePath: '/outside', worktree: undefined })).isError, true);
    assert.equal(starts, 1);
    const attached = await call('t3_start_thread', { ...input, idempotencyKey: 'attach', worktree: undefined, worktreePath: '/repo-issue' });
    assert.equal(attached.isError, true);
    assert.equal(lastCommand.bootstrap.createThread.worktreePath, '/repo-issue');
    assert.equal(lastCommand.bootstrap.createThread.branch, 'issue');
    threads[0].session.status = 'ready';
    const follow = { threadId: threads[0].id, text: 'follow', idempotencyKey: 'follow' };
    const sent = await call('t3_send_message', follow);
    threads[0].session.status = 'running';
    const repeated = await call('t3_send_message', follow);
    assert.equal(sent.isError, undefined);
    assert.equal(repeated.isError, undefined);
    assert.equal(sent.structuredContent.messageId, repeated.structuredContent.messageId);
    assert.equal(sends, 1);
    assert.equal((await call('t3_send_message', { ...follow, idempotencyKey: 'busy' })).isError, true);
    const read = await call('t3_get_thread', { threadId: threads[0].id, activityLimit: 0 });
    assert.deepEqual(read.structuredContent.activities, []);
  } finally {
    await client.close(); await server.close();
    if (previous === undefined) delete process.env.T3_ORCHESTRATOR_CONFIG_DIR;
    else process.env.T3_ORCHESTRATOR_CONFIG_DIR = previous;
    await rm(dir, { recursive: true });
  }
});

test('a fresh client can generate a retry URL without calling shell first', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/.well-known/t3/environment');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ environmentId: 'environment' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { assert.equal(await new T3Client(origin, 'test').threadUrl('thread'), `${origin}/environment/thread`); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
