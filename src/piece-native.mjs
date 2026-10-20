import { isDeepStrictEqual as equal } from 'node:util';
import { preparePackWriter, guidance, writerPlugin } from './pack-writer.mjs';
import { within, assertSession, exactAdmission } from './native-worker.mjs';
import { nativePlugin } from './native-plugin.mjs';
import { readPrivate } from './private.mjs';

export function observationalMetadata(metadata) {
  if (equal(metadata, {})) return true;
  const work = metadata?.openchamber?.work;
  const assist = metadata?.openchamber?.assist;
  // Verified advisory UI shape only. Text remains untrusted data: never read as
  // instructions, forwarded, executed, or used to authorize a writer operation.
  const assistShape = assist === undefined || (!!assist && !Array.isArray(assist) &&
    equal(Object.keys(assist).sort(), ['forMessageID', 'generatedAt', 'recap', 'suggestion']) &&
    typeof assist.recap === 'string' && assist.recap.length <= 320 &&
    typeof assist.suggestion === 'string' && assist.suggestion.length <= 500 &&
    typeof assist.forMessageID === 'string' && /^msg_[\w-]{1,128}$/.test(assist.forMessageID) &&
    Number.isSafeInteger(assist.generatedAt) && assist.generatedAt >= 0);
  return !!work && equal(Object.keys(metadata).sort(), ['openchamber']) &&
    equal(Object.keys(metadata.openchamber).sort(), assist === undefined ? ['work'] : ['assist', 'work']) && assistShape &&
    equal(Object.keys(work).sort(), ['openedAt', 'openedBy', 'state']) &&
    work.state === 'open' && work.openedBy === 'auto' && Number.isSafeInteger(work.openedAt) && work.openedAt >= 0;
}

// Separate protocol: legacy dynamic agents and their journals remain untouched.
export async function executePieceNative(ctx, job, authorize, ms = 1000) {
  const call = fn => within(fn, ms), b = job.binding;
  if (b.protocol !== 'pack-writer-v1' || b.agent !== 'writer' || ctx.location.directory !== b.sessionDirectory) throw new Error('Piece native affinity mismatch');
  const p = await preparePackWriter(b.pack, b.enrollment);
  if (p.fingerprint !== b.fingerprint || p.enrollmentDigest !== b.enrollmentDigest) throw new Error('Piece pack changed; explicit adapter refresh required');
  await guidance(p);
  const verify = (s, sessionId = b.sessionId) => {
    assertSession(s, { ...b, sessionId });
    if (s.parentID || !(job.kind === 'startup' ? equal(s.metadata, {}) : observationalMetadata(s.metadata)) || !equal(s.permissions, p.sessionPermissions) || !equal(s.model, b.model)) throw new Error('Piece session profile mismatch');
    return s;
  };
  if (job.kind === 'startup') {
    const resolved = await call(() => ctx.agent.get({ agentID: 'writer' }));
    const a = resolved.data;
    if (resolved.location?.directory !== b.sessionDirectory || a?.id !== 'writer' || a.mode !== 'primary' || a.system !== p.profile.system || !equal(a.permissions?.slice(-p.profile.permissions.length), p.profile.permissions)) throw new Error('Resolved named writer mismatch');
    await authorize();
    const created = await call(() => ctx.session.create({ location: { directory: b.sessionDirectory }, title: b.title, metadata: {}, agent: 'writer', model: b.model, permissions: p.sessionPermissions }));
    if (!/^ses_[\w-]+$/.test(created?.id || '')) throw new Error('Uncertain piece create');
    return verify(await call(() => ctx.session.get({ sessionID: created.id })), created.id);
  }
  const s = verify(await call(() => ctx.session.get({ sessionID: b.sessionId })));
  if (s.metadata.openchamber?.assist) {
    // The supported lookup is scoped to this exact session, not a regex-based
    // claim of message ownership. No advisory text enters a prompt or tool job.
    const messages = await call(() => ctx.session.context({ sessionID: s.id }));
    if (!messages.some(m => m.id === s.metadata.openchamber.assist.forMessageID && m.type === 'assistant')) throw new Error('Advisory message not in exact writer session');
  }
  if (job.kind === 'inspect') return { id: s.id, directory: s.location.directory, agent: s.agent, upstreamIdentity: b.upstreamIdentity };
  if (job.kind === 'feedback') {
    await authorize();
    const receipt = await call(() => ctx.session.prompt({ sessionID: s.id, ...job.payload }));
    if (!exactAdmission(receipt, s.id, job.payload)) throw new Error('Uncertain piece admission');
    return { accepted: true, messageId: job.payload.id };
  }
  if (job.kind === 'observe') return { session: s, messages: await call(() => ctx.session.context({ sessionID: s.id })) };
  throw new Error('Unsupported piece operation');
}

export function piecePlugin(bindingFile, options, sessionFile) {
  return { id: 'galley.piece', async setup(ctx) {
    // Never register schemas in an ancestor/global location.
    if (ctx.location.directory !== options.enrollment.directory) return;
    if (ctx.app?.version !== '2.0.32') throw new Error('Unverified piece native host version');
    const scoped = Object.create(ctx);
    scoped.session = Object.create(ctx.session);
    scoped.session.get = async input => {
      const enrolled = await readPrivate(sessionFile);
      if (enrolled.sessionId !== input.sessionID) throw new Error('Session not enrolled for this piece');
      return ctx.session.get(input);
    };
    await writerPlugin(options).setup(scoped);
    return nativePlugin(bindingFile, { execute: executePieceNative }).setup(ctx);
  } };
}
