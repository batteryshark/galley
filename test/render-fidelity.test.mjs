import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment } from 'parse5';
import { renderDraft, hash, validateContinuousAnchor } from '../src/renderer.mjs';

const binding = { draft: '/draft/article.md', assetRoots: ['/draft/assets'], siteAssetRoot: '/draft/assets' };
const render = markdown => {
  const doc = renderDraft(markdown, binding);
  assert.equal(doc.revision, hash(markdown));
  let text = '';
  const walk = n => { if (n.nodeName === '#text') text += n.value; for (const c of n.childNodes || []) walk(c); };
  walk(parseFragment(doc.html)); assert.equal(text, doc.text);
  if (doc.text.trim() && doc.text.length <= 12000) validateContinuousAnchor({ kind: 'continuous', revision: doc.revision, offset: 0, quote: doc.text, prefix: '', suffix: '' }, doc);
  return doc;
};
test('bounded YAML quoted/literal/folded titles become escaped plain H1 with unchanged full-source revision', () => {
  for (const [yaml, title] of [
    ['title: "Café: \\"quoted\\" &amp; 🌊"', 'Café: "quoted" &amp; 🌊'],
    ['title: |\n  First <em>line</em>\n  Second 🌊', 'First <em>line</em>\nSecond 🌊\n'],
    ['title: >-\n  First line\n  Second line', 'First line Second line'],
  ]) {
    const doc = render(`---\r\n${yaml.replaceAll('\n', '\r\n')}\r\nlayout: post\r\n---\r\n\nBody &amp; café 🌊.\n\nNext.`);
    assert.ok(doc.text.startsWith(title)); assert.equal((doc.html.match(/<h1>/g) || []).length, 1);
    assert.doesNotMatch(doc.html, /layout:|title:|<em>/);
    assert.ok(doc.text.endsWith('Body & café 🌊.\nNext.\n'));
  }
});
test('body Markdown/raw/nested H1 prevents metadata title duplication', () => {
  for (const body of ['# Own heading', '<h1 class="x">Own heading</h1>', '> # Own heading']) {
    const doc = render(`---\ntitle: Metadata title\n---\n${body}`);
    assert.doesNotMatch(doc.text, /Metadata title/); assert.equal((doc.html.match(/<h1>/g) || []).length, 1);
  }
});
test('malformed, oversized, nonmetadata, custom-tagged and alias frontmatter fail visible; ordinary thematic breaks remain', () => {
  for (const yaml of ['title: [broken', 'title: one\ntitle: two', 'Just prose', '- prose', 'unknown: prose', 'title: !evil value', 'title: &a [*a]', 'title: OK\nx: &a [1]\ny: *a', `title: ${'x'.repeat(32769)}`, `title: ${'🌊'.repeat(9000)}`]) {
    const doc = render(`---\n${yaml}\n---\n\nBody stays.`);
    assert.match(doc.html, /<hr>/); assert.match(doc.text, /Body stays/);
    assert.equal(doc.text, renderDraft(`\n---\n${yaml}\n---\n\nBody stays.`, binding).text);
  }
  assert.match(render('---\n\nOrdinary prose.\n\n---\n\nAfter.').html, /<hr>/);
  assert.match(render('---\ntitle: Missing end\n\nBody.').text, /title: Missing end/);
  assert.equal(render('---\nlayout: post\n---\nBody.').text, 'Body.\n');
});
test('metadata HTML, entities, commands and prototype keys are inert, never Markdown interpreted', () => {
  const doc = render('---\ntitle: "<img src=x onerror=alert(1)> **bold** &amp; 🌊"\n__proto__: {polluted: true}\ncommand: "$(touch /bad)"\n---\n\n<p>A&#13;&#10;B</p>\n\nNext\n\n<table>a<tr><td>b</td></tr>c</table>');
  assert.doesNotMatch(doc.html, /<img|<strong>|command:|polluted/);
  assert.ok(doc.text.startsWith('<img src=x onerror=alert(1)> **bold** &amp; 🌊'));
  assert.ok(doc.text.endsWith('A\nBNext\nacb')); assert.equal({}.polluted, undefined);
});
test('only finite bounded integer author dimensions survive; raster-only/image attribute guards unchanged', () => {
  for (const value of ['1', '28', '32', '4096', '0032']) {
    const doc = render(`<img src="/assets/a.png" width="${value}" height="${value}" style="width:9999px" onerror="bad()" class="bad" title="bad">`);
    assert.match(doc.html, new RegExp(`width="${Number(value)}" height="${Number(value)}"`));
    assert.doesNotMatch(doc.html, /style=|onerror=|class="bad"|title=/);
  }
  for (const value of ['0', '-1', '4097', '99999999', 'NaN', 'Infinity', '32px', '10%', '1e2', '1.5', '']) {
    assert.doesNotMatch(render(`<img src="/assets/a.png" width="${value}" height="${value}">`).html, /width=|height=/);
  }
  for (const src of ['https://evil.invalid/a.png', 'data:image/svg+xml,evil']) {
    const doc = render(`<img src="${src}" width="32" onload="bad()">safe`);
    assert.doesNotMatch(doc.html, /<img|width=|onload=/); assert.equal(Object.keys(doc.images).length, 0);
  }
});
