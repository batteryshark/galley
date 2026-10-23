import { randomBytes } from 'node:crypto';
import { readPrivate } from './private.mjs';
import { processBirth } from './native-owner.mjs';
import { executeNative } from './native-worker.mjs';
import { ipcRequest } from './native-ipc.mjs';

// One fixed local binding. Reconnect is control-plane only: no retained jobs/replay.
export function nativePlugin(bindingFile, { execute = executeNative, id = 'galley.native' } = {}) {
  return { id, async setup(ctx) {
    const instance = randomBytes(32).toString('hex');
    const birth = processBirth(process.pid);
    let stopped = false, working, timer, b, generation, delay = 100;
    const request = (binding, body) => ipcRequest(binding, { pid: process.pid, instance, generation, ...body });
    async function tick() {
      if (stopped) return;
      working = (async () => {
        try {
          const next = await readPrivate(bindingFile);
          if (next.retired || ctx.location.directory !== next.sessionDirectory || !/^[a-f0-9]{64}$/.test(next.token) || !/^[a-f0-9]{64}$/.test(next.epoch)) throw new Error('Inactive binding');
          if (next.ownerPID !== undefined && (process.pid !== next.ownerPID || Math.abs(birth - next.ownerStartedAt) > 1500)) throw new Error('Wrong owner');
          if (next.epoch !== b?.epoch) { b = next; generation = undefined; }
          const current = b;
          if (b.ownerPID === undefined && !generation) generation = (await request(current, { op: 'register', birth, directory: ctx.location.directory })).generation;
          const job = await request(current, { op: 'claim' });
          delay = 200;
          if (!job || stopped) return;
          let result, failed = false;
          try { result = await execute(ctx, job, async () => { if (stopped) throw new Error('Unloaded'); await request(current, { op: 'authorize', id: job.id }); }); }
          catch { failed = true; }
          if (!stopped) await request(current, { op: 'result', id: job.id, result, failed });
        } catch { generation = undefined; delay = Math.min(delay * 2, 2000); /* Never replay a claimed job. */ }
      })();
      try { await working; } finally { working = undefined; if (!stopped) { timer = setTimeout(tick, delay); timer.unref(); } }
    }
    void tick();
    return async () => {
      stopped = true; clearTimeout(timer); await working;
      if (b && generation) await request(b, { op: 'release' }).catch(() => {});
    };
  } };
}
