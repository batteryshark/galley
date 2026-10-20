import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';

test('preview exact static mappings retain CSP, Host, query and production gates without state writes', async t => {
  const root = await fs.mkdtemp(path.resolve('.test-galley-preview-'));
  const draft = path.join(root, 'draft.md');
  await fs.writeFile(draft, '# Inert test fixture\n');
  const store = await openStore(path.join(root, 'state'), { draft, sessionDirectory: root, sessionId: 'ses_fake', upstreamIdentity: 'fake-only', assetRoots: [] });
  const origin = 'https://preview.invalid';
  const app = await startServer({ store, publicOrigin: origin });
  t.after(async () => { await app.close(); await store.close(); await fs.rm(root, { recursive: true }); });
  const before = JSON.stringify(store.state);
  function request(url, { host = 'preview.invalid', method = 'GET' } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: app.server.address().port, path: url, method, headers: { Host: host } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.end();
    });
  }
  for (const [route, type] of [['preview', 'text/html'], ['preview.js', 'text/javascript'], ['preview.css', 'text/css']]) {
    const result = await request(`/galley/${route}`);
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-type'], `${type}; charset=utf-8`);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.match(result.headers['content-security-policy'], /img-src blob:/);
    assert.doesNotMatch(result.headers['content-security-policy'], /unsafe-inline/);
    assert.equal((await request(`/galley/${route}`, { host: '127.0.0.1:4177' })).status, 403);
    assert.equal((await request(`/galley/${route}?x=1`)).status, 400);
    assert.equal((await request(`/galley/${route}`, { method: 'POST' })).status, 401);
  }
  for (const route of ['/preview/', '/preview.html', '/api/document', '/image/' + 'a'.repeat(32), '/native', '/preview/../state.json']) {
    assert.equal((await request('/galley' + route)).status, 401);
  }
  assert.equal((await request('/galley/%70review')).status, 400);
  assert.equal((await request('/preview')).status, 404);
  const js = (await request('/galley/preview.js')).body;
  assert.doesNotMatch(js, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|\/api\//);
  assert.equal(JSON.stringify(store.state), before);
});
