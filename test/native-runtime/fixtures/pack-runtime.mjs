// Optional contract suite only: synthetic HOME/XDG, no external providers/OAuth.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCode } from '@opencode/sdk';
import { sha256 } from '../../../src/writing-pack.mjs';
import { parse } from 'yaml';
import http from 'node:http';

if (process.env.GALLEY_ISOLATED_RUNTIME !== '1') throw Error('Isolated test entry only');
const directory = process.env.GALLEY_FIXTURE_DIRECTORY;
const home = await fs.realpath(process.env.HOME);
const approvedTemp = path.join(await fs.realpath(os.tmpdir()), 'opencode');
if (path.dirname(home) !== approvedTemp || !/^galley-(?:pack|installed-writer)-/.test(path.basename(home)) || directory !== path.join(home, 'piece') || process.env.XDG_CONFIG_HOME !== path.join(home, 'config') || process.env.XDG_DATA_HOME !== path.join(home, 'data') || process.env.XDG_CACHE_HOME !== path.join(home, 'cache') || process.env.XDG_STATE_HOME !== path.join(home, 'state')) throw Error('Synthetic temporary HOME/XDG/piece scope required');
const enrollment = process.env.GALLEY_ENROLLMENT ? JSON.parse(await fs.readFile(process.env.GALLEY_ENROLLMENT, 'utf8')) : undefined;
const agentBytes = await fs.readFile(`${process.env.XDG_CONFIG_HOME}/opencode/agents/writer.md`, 'utf8');
const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(agentBytes);
const expectedPermissions = enrollment?.permissions ?? parse(match[1]).permissions;
let context;
const schemaProof = process.env.GALLEY_SCHEMA_PROOF === '1';
const captured = [];
let listener;
if (schemaProof) {
  listener = http.createServer(async (req, res) => {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) { req.destroy(); return; } chunks.push(chunk); }
    captured.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const callGuidance = captured.length === 2;
    const delta = callGuidance ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_synthetic_guidance', type: 'function', function: { name: 'writer_read', arguments: JSON.stringify({ target: 'guidance', phase: 'edit', resume: true }) } }] } : { role: 'assistant', content: 'Synthetic complete.' };
    res.end('data: '+JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })+'\n\ndata: '+JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: callGuidance ? 'tool_calls' : 'stop' }] })+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
}
const baseURL = schemaProof ? `http://127.0.0.1:${listener.address().port}/v1` : undefined;
const config = { policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }, ...(schemaProof ? [{ action: 'provider.use', resource: 'synthetic', effect: 'allow' }] : [])], ...(schemaProof ? { model: 'synthetic/capture', snapshots: false, providers: { synthetic: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL, apiKey: 'synthetic-not-a-credential' }, models: { capture: { capabilities: { tools: true }, limit: { context: 128000, output: 1024 } } } } } } : {}) };
let host;
try {
host = await OpenCode.create({ config: { directory: `${process.env.XDG_CONFIG_HOME}/opencode`, claude: false, content: JSON.stringify(config) }, models: { fetch: false }, fs: { filewatcher: false, fff: false }, plugins: [{ id: 'galley.runtime-probe', async setup(ctx) {
   context = ctx;
   // No OAuth/MCP servers configured in the synthetic home; reject every
   // provider HTTP request except the owned fake endpoint in schema mode.
   await ctx.session.hook('http.request', e => { if (!baseURL || !e.request.url.startsWith(baseURL + '/')) throw Error('Nonlocal provider forbidden'); });
   if (schemaProof) {
    await ctx.session.hook('title', e => { e.result = 'Synthetic schema proof'; });
    await ctx.tool.transform(e => e.add({ name: 'unrelated_probe', options: { codemode: false }, description: 'Synthetic unrelated tool', input: { type: 'object', properties: {} }, execute: async () => ({ content: 'unused' }) }));
  }
} }] });
  if (process.env.GALLEY_PIECE_DISCOVERY === '1') {
    // Same production initializer gate, no session or sacrificial prompt.
    await host.model.default({ location: { directory } });
    const plugins = await host.plugin.list({ location: { directory } });
    const piece = plugins.data.find(p => p.id === 'galley.piece');
    assert(piece, 'Production directory/index.mjs layout must be discovered');
    // Embedded SDK advertises a development host version, not native CLI 2.0.32.
    // Do not spoof it or relax the production host-version fence for this test.
    assert.equal(piece.state.status, 'failed');
    assert(piece.state.error.includes('Unverified piece native host version'));
    const resolved = await host.agent.get({ agentID: 'writer', location: { directory } });
    assert.equal(resolved.data.system.trim(), match[2].trim());
    console.log(JSON.stringify({ coldPieceLayoutDiscovery: true, nativeVersionFence: 'denied SDK development host', sessionsCreated: 0 }));
  } else {
  const s = await host.session.create({ location: { directory }, metadata: {}, title: 'Isolated discovery only' });
  await host.session.prompt({ sessionID: s.id, text: schemaProof ? 'Synthetic nonwriter schema capture. Reply briefly; no tools.' : 'Synthetic activation only; all providers denied.' });
  await host.session.wait({ sessionID: s.id });
  const resolved = await host.agent.get({ agentID: 'writer', location: { directory } });
  assert.equal(resolved.data.id, 'writer');
  assert.equal(resolved.data.mode, 'primary');
  assert.equal(resolved.data.system.trim(), match[2].trim());
  const start = resolved.data.permissions.findIndex(r => r.action === '*' && r.effect === 'deny');
  assert.deepEqual(resolved.data.permissions.slice(start, start + expectedPermissions.length), expectedPermissions);
  await host.session.switchAgent({ sessionID: s.id, agent: 'writer' });
  if (enrollment) await host.session.update({ sessionID: s.id, permissions: expectedPermissions });
  if (schemaProof) {
    await host.session.prompt({ sessionID: s.id, text: 'Synthetic writer schema capture. Reply briefly; no tools.' });
    await host.session.wait({ sessionID: s.id });
    const names = body => body.tools?.map(t => t.function?.name ?? t.name).sort() ?? [];
    assert.equal(captured.length, 3, 'Nonwriter, writer, and real tool-driven writer continuation requests required');
    const nonwriter = names(captured[0]), writer = names(captured[1]);
    assert(nonwriter.includes('unrelated_probe'));
    assert(!nonwriter.includes('writer_read') && !nonwriter.includes('writer_write'));
    assert.deepEqual(writer, ['writer_read', 'writer_write']);
    assert.deepEqual(names(captured[2]), writer);
    const toolResult = captured[2].messages.find(m => m.role === 'tool');
    assert(toolResult, 'Actual tool-result lowering must reach provider');
    assert(JSON.stringify(toolResult).includes('SYNTHETIC FULL EDIT END'));
    assert(JSON.stringify(toolResult).includes('Synthetic resume source'));
    assert(JSON.stringify(captured[2]).includes('Current phase: edit'));
    console.log(JSON.stringify({ outgoingSchemaProof: true, nonwriter, writer, fullEditResumeToolResult: true, toolResultBeyondDefaultCap: true }));
  }
  const tools = await context.tool.list();
  if (!enrollment) {
    assert(!tools.some(t => ['writer_read','writer_write'].includes(t.id)));
    const unrelated = await host.session.create({ location: { directory }, agent: 'build', metadata: {}, title: 'Unrelated discovery fixture' });
    assert.equal((await host.session.get({ sessionID: unrelated.id })).agent, 'build');
    assert(!tools.some(t => t.id.startsWith('writer_')));
    for (const action of ['edit','shell','execute','subagent','webfetch','websearch','some_mcp_tool']) await assert.rejects(context.permission.assert({ sessionID: s.id, agent: 'writer', action, resources: ['*'], save: [] }));
    console.log(JSON.stringify({ discovery: true, agent: 'writer', mode: 'primary', customWriterTools: [], unrelatedDiscovery: 'no writer tools', permissionCount: expectedPermissions.length }));
    process.exitCode = 0;
  } else {
  const read = tools.find(t => t.id === 'writer_read');
  assert(read); assert.equal(read.options.codemode, false);
  const call = { agent: 'writer', sessionID: s.id, messageID: 'msg_synthetic', id: 'tool_synthetic', signal: new AbortController().signal, progress: async () => {} };
  assert((await read.execute({ target: 'guidance' }, call)).content.includes(enrollment ? 'Exact enrollment' : 'No piece enrolled'));
  const write = tools.find(t => t.id === 'writer_write');
  await assert.rejects(read.execute({ target: 'guidance' }, { ...call, agent: 'build' }));
  if (enrollment) {
    for (const target of [enrollment.draft, enrollment.memory]) {
      const before = JSON.parse((await read.execute({ target }, call)).content);
      const text = before.text + '\nSaved synthetic text';
      await write.execute({ target, text, expectedSha256: before.sha256 }, call);
      assert.equal(await fs.readFile(target, 'utf8'), text);
      await assert.rejects(write.execute({ target, text: 'Stale overwrite', expectedSha256: before.sha256 }, call));
    }
    await assert.rejects(write.execute({ target: enrollment.source, text: 'Denied', expectedSha256: sha256(await fs.readFile(enrollment.source)) }, call));
    await assert.rejects(write.execute({ target: enrollment.otherDraft, text: 'Cross-piece denied', expectedSha256: sha256(await fs.readFile(enrollment.otherDraft)) }, call));
  } else await assert.rejects(write.execute({ target: `${directory}/draft.md`, text: 'Denied', expectedSha256: '0'.repeat(64) }, call));
  for (const action of ['read', 'edit', 'shell', 'execute', 'subagent', 'webfetch', 'websearch', 'some_mcp_tool']) {
    await assert.rejects(context.permission.assert({ sessionID: s.id, agent: 'writer', action, resources: ['*'], save: [] }));
  }
  console.log(JSON.stringify({ discovery: true, agent: resolved.data.id, mode: resolved.data.mode, permissions: resolved.data.permissions, dedicatedTools: ['writer_read', 'writer_write'], denied: ['read','edit','shell','execute','subagent','webfetch','websearch','some_mcp_tool','writer_write'] }));
  }
  }
} finally { try { await host?.close(); } finally { if (listener) { listener.closeAllConnections(); await new Promise(r => listener.close(r)); } } }
