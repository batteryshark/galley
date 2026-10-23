import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { boundedRead, validateBinding, inside } from './files.mjs';
import { privateDirectory, readPrivate, writePrivate } from './private.mjs';
import { verifyPrepared } from './writer.mjs';
import { openStore } from './store.mjs';
import { openNative } from './native-ipc.mjs';

const sameAuthor = (a, b) => ['sessionId', 'sessionDirectory', 'agent'].every(k => a[k] === b[k]);
async function preparedAuthor(c, binding) {
  const p = JSON.parse(await boundedRead(c.preparedFile, 2 * 1024 * 1024));
  await verifyPrepared(p);
  const journal = await readPrivate(path.join(c.privateDirectory, `startup-${binding.agent}.json`));
  if (c.mode !== 'attach' || p.agent !== binding.agent || p.directory !== binding.sessionDirectory || p.draft !== binding.draft || journal.state !== 'created-not-edit-verified' || journal.sessionId !== binding.sessionId || journal.agent !== binding.agent || journal.digest !== p.digest) throw new Error('Confirmed author/prepared binding required');
  return p;
}

// Deliberately narrow: existing exact draft grants or the shipped single-level
// _drafts/*.md grant. No new permission, glob engine or author identity is created.
export function assertDraftPermission(permissions, binding) {
  const local = path.relative(binding.sessionDirectory, binding.draft);
  if (!inside(binding.sessionDirectory, binding.draft) || !local || /[*?\[\]{}!\\]/.test(local)) throw new Error('Invalid draft scope');
  for (const action of ['read', 'edit']) {
    let effect;
    for (const r of permissions) {
      if (r.action !== '*' && r.action !== action) continue;
      if (r.resource === '*' || r.resource === local || r.resource === binding.draft || (r.resource === '_drafts/*.md' && /^_drafts\/[^/]+\.md$/.test(local))) effect = r.effect;
      // Other patterns are not interpreted as authority. Fail closed if an
      // unfamiliar deny could affect the target (known unrelated skill reads OK).
      else if (r.effect === 'deny') throw new Error('Unsupported draft deny scope');
    }
    if (effect !== 'allow') throw new Error('Existing writer cannot read/edit this draft');
  }
}

export function draftUpstream(native, authorBinding, binding, prepared, model) {
  if (!sameAuthor(authorBinding, binding)) throw new Error('Draft author changed');
  assertDraftPermission(prepared.profile.permissions, binding);
  async function check() {
    const { session: s } = await native.observe();
    if (s.id !== binding.sessionId || s.agent !== binding.agent || s.location?.directory !== binding.sessionDirectory || !equal(s.permissions, prepared.profile.permissions) || !equal(s.model, model)) throw new Error('Live author profile changed');
    assertDraftPermission(s.permissions, binding);
    return { id: s.id, agent: s.agent, directory: s.location.directory, upstreamIdentity: native.identity };
  }
  return {
    async inspect(id) { if (id !== binding.sessionId) throw new Error('Wrong draft author'); return check(); },
    async submit(input) {
      if (input.sessionId !== binding.sessionId || input.directory !== binding.sessionDirectory || input.upstreamIdentity !== native.identity) throw new Error('Wrong draft dispatch');
      // The immutable, persisted batch must explicitly identify THIS draft.
      const payload = JSON.parse(input.text.slice(input.text.indexOf('\n') + 1));
      if (payload.draft !== binding.draft) throw new Error('Feedback draft mismatch');
      await check();
      return native.submit(input);
    },
  };
}

// Offline operator enrollment. Source store is locked, never rewritten in place
// as a different draft; exclusive new store/output files prevent replacement.
export async function enrollAdditionalDraft(input) {
  const c = await readPrivate(input.authorOperatorFile);
  if (c.mode !== 'attach') throw new Error('Attach-only author required');
  const source = await openStore(c.storeDirectory);
  let store;
  try {
    const author = source.state.binding;
    const p = await preparedAuthor({ ...c, preparedFile: input.preparedFile }, author);
    const binding = await validateBinding({ ...author, draft: input.draft, assetRoots: input.assetRoots, ...(input.siteAssetRoot ? { siteAssetRoot: input.siteAssetRoot } : {}) });
    if (binding.draft === author.draft) throw new Error('Draft already enrolled');
    assertDraftPermission(p.profile.permissions, binding);
    if (!input.model?.providerID || !input.model?.id) throw new Error('Exact existing author model required');
    if ((c.additionalDraftStores || []).length >= 32) throw new Error('Additional draft limit reached');
    for (const directory of c.additionalDraftStores || []) {
      const existing = await openStore(directory);
      try {
        if (!sameAuthor(author, existing.state.binding)) throw new Error('Existing draft author changed');
        if (existing.state.binding.draft === binding.draft) throw new Error('Draft already enrolled');
      } finally { await existing.close(); }
    }
    await privateDirectory(input.storeDirectory, author.sessionDirectory);
    await privateDirectory(path.dirname(input.operatorOutput), author.sessionDirectory);
    await privateDirectory(path.dirname(input.resultFile), author.sessionDirectory);
    const origin = new URL(input.publicOrigin);
    if (origin.origin !== input.publicOrigin || origin.protocol !== 'https:') throw new Error('Exact private HTTPS origin required');
    store = await openStore(input.storeDirectory, binding);
    const token = await store.issue(input.ttl ?? 86400000);
    const operator = { ...c, preparedFile: input.preparedFile, model: input.model, additionalDraftStores: [...(c.additionalDraftStores || []), input.storeDirectory] };
    await writePrivate(input.operatorOutput, operator, { exclusive: true });
    const result = { reviewLink: `${input.publicOrigin}/galley/#review=${token}`, expires: new Date(store.state.capabilities.at(-1).expires).toISOString(), draft: binding.draft, sessionId: binding.sessionId, agent: binding.agent, authorOperator: input.authorOperatorFile, operator: input.operatorOutput, storeDirectory: input.storeDirectory, checks: { enrollment: true, liveReview: 'pending service attach and read-only link check' } };
    await writePrivate(input.resultFile, result, { exclusive: true });
    return { resultFile: input.resultFile, operator: input.operatorOutput };
  } finally { await store?.close(); await source.close(); }
}

// A single existing native owner serves its confirmed author and all separately
// authorized draft stores. No plugin install/reload or startup job is involved.
export async function attachDraftAuthor(c, { connect = openNative } = {}) {
  const stores = []; let native;
  const close = async () => { for (const s of stores) await s.close(); await native?.close(); };
  try {
    const author = await openStore(c.storeDirectory); stores.push(author);
    if (!Array.isArray(c.additionalDraftStores) || c.additionalDraftStores.length > 32) throw new Error('Bounded additional draft registry required');
    const p = await preparedAuthor(c, author.state.binding);
    native = await connect({ directory: c.privateDirectory, binding: author.state.binding, ownerPID: c.ownerPID, ownerStartedAt: c.ownerStartedAt });
    await native.waitOwner();
    for (const directory of c.additionalDraftStores || []) stores.push(await openStore(directory));
    if (new Set(stores.map(s => s.state.binding.draft)).size !== stores.length) throw new Error('Duplicate draft enrollment');
    const entries = [];
    for (const store of stores) {
      await validateBinding(store.state.binding);
      const upstream = draftUpstream(native, author.state.binding, store.state.binding, p, c.model);
      await upstream.inspect(store.state.binding.sessionId);
      await store.transaction(s => { s.binding.upstreamIdentity = native.identity; });
      entries.push({ store, upstream });
    }
    return { entries, close };
  } catch (e) { await close(); throw e; }
}
