#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { openStore } from '../src/store.mjs';
import { validateBinding, boundedRead } from '../src/files.mjs';
import { startServer } from '../src/server.mjs';
import { prepareWriter } from '../src/writer.mjs';

const [command, argument] = process.argv.slice(2);
const directory = path.resolve('.galley');
let store;
try {
  if (command === 'serve-connected') throw new Error('Retired desktop path; use native connector');
  if (command === 'enroll') {
    if (!argument) throw new Error('Usage: node bin/galley.mjs enroll binding.json');
    const binding = await validateBinding(JSON.parse((await boundedRead(path.resolve(argument), 32768)).toString()));
    store = await openStore(directory, binding);
    console.log('Private document binding enrolled locally. No upstream connection created.');
  } else if (['link', 'revoke', 'writer-preview', 'serve', 'serve-connected'].includes(command)) {
    store = await openStore(directory);
    if (command === 'link') {
      const token = await store.issue();
      const origin = process.env.GALLEY_ORIGIN || 'http://127.0.0.1:4177';
      console.log(`${origin}/galley/#review=${token}`); // Intentional one-time terminal output, never server log.
    } else if (command === 'revoke') {
      await store.transaction(s => { for (const cap of s.capabilities) cap.revoked = true; });
      console.log('All review links revoked.');
    } else if (command === 'writer-preview') {
      const prepared = await prepareWriter(store.state.binding);
      const output = path.join(directory, 'writer-preview.json');
      // Exclusive creation prevents overwriting either user work or a symlink.
      await fs.writeFile(output, JSON.stringify(prepared, null, 2), { flag: 'wx', mode: 0o600 });
      console.log('Prepared .galley/writer-preview.json; not applied, no session started.');
    } else {
      const upstream = undefined;
      const app = await startServer({ store, port: 4177, publicOrigin: process.env.GALLEY_ORIGIN, upstream });
      console.log(`Galley listening on loopback port 4177, /galley/. Upstream ${upstream ? 'dedicated (revalidated per send)' : 'disconnected'}.`);
      const activeStore = store;
      let closing = false;
      const close = async () => { if (closing) return; closing = true; await app.close(); await activeStore.close(); };
      process.once('SIGINT', close); process.once('SIGTERM', close);
      store = undefined; // Ownership transferred to signal handlers below.
    }
  } else throw new Error('Commands: enroll <binding.json>, link, revoke, writer-preview, serve (disconnected foreground only); native connector has separate operator CLI');
} catch {
  console.error('Galley command failed. Check arguments, canonical binding, private state permissions, dependencies, or existing lock. Reconcile any uncertain delivery; never replay it.');
  process.exitCode = 1;
} finally { if (store) await store.close(); }
