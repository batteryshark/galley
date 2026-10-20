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
    if (resolved.location?.directory !== p.directory || a?.id !== p.agent || a.mode !== 'primary' || a.system !== p.profile.system || !Array.isArray(a.permissions) || !equal(a.permissions.slice(-p.profile.permissions.length), p.profile.permissions)) throw new Error('Full runtime profile mismatch');
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
