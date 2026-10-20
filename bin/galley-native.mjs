#!/usr/bin/env node
import path from 'node:path';
import { boundedRead } from '../src/files.mjs';
import { openStore } from '../src/store.mjs';
import { openNative } from '../src/native-ipc.mjs';
import { startPreparedWriter } from '../src/startup.mjs';
import { startServer } from '../src/server.mjs';
import { readPrivate } from '../src/private.mjs';
import { openPieceManager } from '../src/new-piece.mjs';
import { openPieceControl } from '../src/piece-control.mjs';

// All configuration is a trusted operator file. No control endpoint or browser input.
let store, native, app, pieces, control;
let interrupted = false, signalDone;
const signal = new Promise(resolve => { signalDone = resolve; });
function stop() { interrupted = true; signalDone(); void native?.close(); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
async function close() { await control?.close(); await app?.close(); await pieces?.close(); await native?.close(); await store?.close(); }
try {
  const [file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) throw new Error('Explicit operator configuration required');
  const c = JSON.parse(await boundedRead(path.resolve(file), 8192));
  if (!['startup', 'attach'].includes(c.mode) || !path.isAbsolute(c.privateDirectory) || !path.isAbsolute(c.storeDirectory)) throw new Error('Invalid operator configuration');
  store = await openStore(c.storeDirectory);
  if (c.mode === 'startup' && store.state.comments.length) throw new Error('Startup requires empty synthetic review');
  let prepared;
  if (c.mode === 'startup') prepared = JSON.parse(await boundedRead(c.preparedFile, 2 * 1024 * 1024));
  const binding = { ...store.state.binding, ...(prepared ? { agent: prepared.agent } : {}) };
  if (c.mode === 'attach') {
    const journal = await readPrivate(path.join(c.privateDirectory, `startup-${binding.agent}.json`));
    if (journal.state !== 'created-not-edit-verified' || journal.sessionId !== binding.sessionId || journal.agent !== binding.agent) throw new Error('Attach requires confirmed exact writer');
  }
  native = await openNative({ directory: c.privateDirectory, binding, ownerPID: c.ownerPID, ownerStartedAt: c.ownerStartedAt });
  if (interrupted) throw new Error('Stopped');
  console.log('Private native binding ready. Waiting for the single authenticated Galley project plugin owner within 60 seconds.');
  await native.waitOwner();
  if (prepared) {
    const s = await startPreparedWriter(prepared, c.model, { directory: c.privateDirectory, connector: native, parentID: c.parentID });
    await store.transaction(state => { Object.assign(state.binding, { sessionId: s.id, agent: prepared.agent, upstreamIdentity: native.identity }); });
    console.log(JSON.stringify({ sessionId: s.id, agent: s.agent, state: 'created-not-edit-verified' }));
  } else {
    await native.inspect(binding.sessionId);
    await store.transaction(state => { state.binding.upstreamIdentity = native.identity; });
  }
  if (c.managedPiecesFile) {
    const pc = await readPrivate(c.managedPiecesFile);
    if (pc.publicOrigin !== process.env.GALLEY_ORIGIN) throw new Error('Managed/legacy review origin mismatch');
    pieces = await openPieceManager(pc);
    const restored = await pieces.restore();
    if (restored.unavailable.length) console.error('Some managed pieces are unavailable; their histories are retained without replay. Reconcile privately.');
    control = await openPieceControl({ directory: pc.controlDirectory, manager: pieces });
  }
  app = await startServer({ store, upstream: native, port: 4177, publicOrigin: process.env.GALLEY_ORIGIN, ...(pieces ? { resolveReview: token => pieces.resolveReview(token) } : {}) });
  console.log('Galley native review on 127.0.0.1:4177/galley/. Admission is not edit completion.');
  await signal;
} catch {
  console.error('Native connector stopped. Reconcile journals and uncertain comments; never repeat uncertain startup/send.');
  process.exitCode = 1;
} finally { await close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
