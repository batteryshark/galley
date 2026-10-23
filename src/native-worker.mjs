import { isDeepStrictEqual as equal } from 'node:util';

export function within(work, ms = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native deadline')), ms);
    Promise.resolve().then(work).then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}
export function exactAdmission(a, sessionID, p) {
  return a?.id === p.id && a.sessionID === sessionID && a.type === 'user' && a.delivery === 'queue'
    && equal(a.payload, { text: p.text }) && Number.isFinite(a.time?.created) && a.time.created > 0;
}
export function assertSession(s, binding) {
  if (s?.id !== binding.sessionId || s.location?.directory !== binding.sessionDirectory || s.agent !== binding.agent) throw new Error('Native affinity mismatch');
}
export async function executeNative(ctx, job, authorize, ms = 1000) {
  const call = fn => within(fn, ms);
  const b = job.binding;
  if (ctx.location.directory !== b.sessionDirectory) throw new Error('Plugin location mismatch');
  if (job.kind === 'startup') {
    const { prepared: p, model } = job;
    const resolved = await call(() => ctx.agent.get({ agentID: p.agent }));
    const a = resolved.data;
    // V2 appends its built-in browser deny after configured agent permissions.
    // Accept only that redundant deny; session readback remains exactly prepared.
    const rules = a?.permissions;
    const exactTail = offset => Array.isArray(rules) && equal(rules.slice(0, rules.length - offset).slice(-p.profile.permissions.length), p.profile.permissions);
    const permissionsMatch = exactTail(0) || (equal(rules?.at(-1), { action: 'browser', resource: '*', effect: 'deny' }) && exactTail(1));
    const mismatches = [
      [resolved.location?.directory !== p.directory, 'location'], [a?.id !== p.agent, 'agent'],
      [a?.mode !== 'primary', 'mode'], [a?.system !== p.profile.system, 'system'],
      [!permissionsMatch, 'permissions'],
    ].filter(([changed]) => changed).map(([, name]) => name);
    if (mismatches.length) throw new Error(`Full runtime profile mismatch (${mismatches.join(', ')}); start writers with node bin/galley-writer.mjs start <writer.json>`);
    if (p.capabilities && !(await call(() => ctx.tool.list())).some(t => t.id === p.capabilities.chiefTool)) throw new Error('Writer image guard/chief tool not loaded');
    if (job.parentID) {
      const parent = await call(() => ctx.session.get({ sessionID: job.parentID }));
      if (parent.id !== job.parentID || parent.location?.directory !== p.directory) throw new Error('Parent location mismatch');
    }
    await authorize();
    // A linked child must not inherit the lead's automation/goal metadata.
    const created = await call(() => ctx.session.create({ location: { directory: p.directory }, ...(job.parentID ? { parentID: job.parentID } : {}), metadata: {}, agent: p.agent, model, permissions: p.profile.permissions }));
    if (!/^ses_[\w-]+$/.test(created?.id || '')) throw new Error('Uncertain create');
    const s = await call(() => ctx.session.get({ sessionID: created.id }));
    assertSession(s, { ...b, sessionId: created.id });
    if (job.parentID && s.parentID !== job.parentID) throw new Error('Parent readback mismatch');
    if (!equal(s.metadata, {})) throw new Error('Created metadata mismatch');
    if (!equal(s.model, model) || !equal(s.permissions, p.profile.permissions)) throw new Error('Created profile mismatch');
    return s;
  }
  const s = await call(() => ctx.session.get({ sessionID: b.sessionId }));
  assertSession(s, b);
  if (job.kind === 'inspect') return { id: s.id, directory: s.location.directory, agent: s.agent, upstreamIdentity: b.upstreamIdentity };
  if (job.kind === 'selfcheck') {
    const p = job.prepared;
    const { assertWriterAffinity, checkChief } = await import('./writer-tools.mjs');
    const imageCommand = p.capabilities.imageCommand;
    const policy = { agent: p.agent, directory: p.directory, permissions: p.profile.permissions, ...p.capabilities };
    assertWriterAffinity(s, policy, b.sessionId);
    if (!equal(s.model, job.model)) throw new Error('Writer model does not match the requested model');
    const tools = await call(() => ctx.tool.list());
    if (!tools.some(t => t.id === p.capabilities.chiefTool)) throw new Error('Writer chief tool not loaded');
    const shell = tools.find(t => t.id === 'shell');
    if (!shell) throw new Error('Writer image tool not loaded');
    const chief = await call(() => checkChief(ctx, policy, s.id));
    const help = await within(() => shell.execute({ command: `${imageCommand} --help` }, { sessionID: s.id, agent: p.agent, messageID: `msg_${job.id.replaceAll('-', '')}`, id: `check_${job.id}`, signal: AbortSignal.timeout(10000), progress: async () => {} }), 11000);
    if (help.output?.exit !== 0 || help.output?.truncated !== false || help.output?.status !== 'completed' || typeof help.output?.output !== 'string' || !help.output.output.includes('--prompt')) throw new Error('Writer image help returned an invalid shell output');
    return { imageHelp: true, chief, sessionId: s.id };
  }
  if (job.kind === 'observe') return { session: s, messages: await call(() => ctx.session.context({ sessionID: b.sessionId })) };
  if (job.kind === 'stop') { await authorize(); await call(() => ctx.session.interrupt({ sessionID: b.sessionId, continue: false })); return { stopped: true }; }
  if (job.kind === 'feedback') {
    await authorize();
    const a = await call(() => ctx.session.prompt({ sessionID: b.sessionId, ...job.payload }));
    if (!exactAdmission(a, b.sessionId, job.payload)) throw new Error('Uncertain admission');
    return { accepted: true, messageId: job.payload.id };
  }
  if (job.kind === 'reconcile') {
    // Installed Plugin.Context has context, but no inbox/message API. No HTTP fallback.
    const messages = await call(() => ctx.session.context({ sessionID: b.sessionId }));
    const m = messages.find(x => x.id === job.payload.id);
    return { status: !m ? 'absent-not-retryable' : m.type === 'user' && m.text === job.payload.text && ['files', 'agents', 'skills'].every(k => m[k] === undefined || (Array.isArray(m[k]) && !m[k].length)) ? 'observed-message' : 'conflict' };
  }
  throw new Error('Unknown native work');
}
