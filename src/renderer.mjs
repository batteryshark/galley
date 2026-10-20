import { createHash } from 'node:crypto';
import { Marked } from 'marked';
import sanitize from 'sanitize-html';
import { parseFragment, serialize } from 'parse5';
import { parseDocument, isMap, isScalar, isAlias, visit } from 'yaml';
import * as fs from 'node:fs/promises';
import { assetPath, boundedRead, noLinks, readImage } from './files.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const normalize = text => text.replace(/\s+/g, ' ').trim();

// Fail visible: only a bounded, recognized leading metadata map is removed.
// Inspect the core-schema AST, never materialize objects or expand aliases.
function frontmatter(markdown) {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(markdown);
  if (!opening) return { body: markdown };
  const limit = 32768, start = opening[0].length;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(markdown.slice(start, start + limit + 1));
  if (!closing) return { body: markdown };
  const yaml = markdown.slice(start, start + closing.index);
  if (Buffer.byteLength(yaml, 'utf8') > limit) return { body: markdown };
  try {
    const doc = parseDocument(yaml, { schema: 'core', customTags: [], strict: true, uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) return { body: markdown };
    let safe = true;
    const tags = new Set(['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map(t => `tag:yaml.org,2002:${t}`));
    visit(doc, (_key, node) => { if (isAlias(node) || (node?.tag && !tags.has(node.tag))) safe = false; });
    const keys = doc.contents.items.map(pair => isScalar(pair.key) ? pair.key.value : null);
    if (!safe || keys.some(k => typeof k !== 'string') || !keys.some(k => ['title','layout','date','description','tags','toc','published','author'].includes(k))) return { body: markdown };
    const title = doc.get('title', true);
    if (title !== undefined && (!isScalar(title) || typeof title.value !== 'string')) return { body: markdown };
    return { body: markdown.slice(start + closing.index + closing[0].length), title: title?.value };
  } catch { return { body: markdown }; }
}

const escapeHTML = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only this module may produce HTML for the document container. Raw HTML is
// parsed by maintained libraries, then restricted to inert document elements.
export function renderDraft(markdown, binding, assetDigests = {}) {
  const parser = new Marked({ gfm: true, async: false });
  const { body, title } = frontmatter(markdown);
  const tokens = parser.lexer(body);
  // Raw author H1s count too; title is plain escaped text, not Markdown/HTML.
  if (title?.trim() && !sanitize(parser.parser(tokens), { allowedTags: ['h1'], allowedAttributes: {} }).includes('<h1>')) {
    tokens.unshift({ type: 'html', raw: `<h1>${escapeHTML(title)}</h1>\n`, text: `<h1>${escapeHTML(title)}</h1>\n`, metadataTitle: true });
  }
  if (tokens.length > 4000) throw new Error('Too many blocks');
  const images = {};
  const occurrences = new Map();
  const blocks = [];
  for (const token of tokens) {
    if (token.type === 'space' || token.type === 'def') continue;
    const fragment = [token]; fragment.links = tokens.links;
    const sanitized = sanitize(parser.parser(fragment), {
      allowedTags: ['h1','h2','h3','h4','h5','h6','p','br','hr','strong','em','del','s','blockquote','ul','ol','li','pre','code','table','thead','tbody','tr','th','td','a','img'],
      allowedAttributes: { a: ['href', 'rel'], img: ['data-image', 'alt', 'width', 'height'], ol: ['start'] },
      allowedSchemes: [], allowProtocolRelative: false,
      transformTags: {
        a: (_tag, attrs) => ({ tagName: 'a', attribs: attrs.href?.startsWith('#') && /^#[a-z\d_-]+$/i.test(attrs.href) ? { href: attrs.href, rel: 'noreferrer' } : {} }),
        img: (_tag, attrs) => {
          try {
            const file = assetPath(attrs.src, binding);
            const id = hash(JSON.stringify([file, assetDigests[file] || 'unavailable'])).slice(0, 32);
            if (Object.keys(images).length >= 64 && !images[id]) throw new Error('Image limit');
            images[id] = file;
            const dimensions = {};
            for (const key of ['width', 'height']) {
              if (/^\d{1,4}$/.test(attrs[key] || '') && Number(attrs[key]) >= 1 && Number(attrs[key]) <= 4096) dimensions[key] = String(Number(attrs[key]));
            }
            return { tagName: 'img', attribs: { 'data-image': id, alt: (attrs.alt || '').slice(0, 512), ...dimensions } };
          } catch { return { tagName: 'span', attribs: {} }; }
        },
      },
    });
    // HTML5 input normalization and tree repair (including table foster
    // parenting) must precede BOTH serialization and anchor extraction. Only
    // sanitized inert elements reach this parser; no raw Markdown HTML returns.
    const tree = parseFragment(sanitized);
    const html = serialize(tree);
    let rawText = '';
    const walk = node => { if (node.nodeName === '#text') rawText += node.value; for (const child of node.childNodes || []) walk(child); };
    walk(tree);
    const text = normalize(rawText);
    const digest = hash(token.raw).slice(0, 20);
    const count = occurrences.get(digest) || 0; occurrences.set(digest, count + 1);
    const id = `b-${digest}-${count}`;
    blocks.push({ id, text, rawText, heading: token.type === 'heading' || token.metadataTitle ? text : null, html });
  }
  return { revision: hash(markdown), blocks, images, text: blocks.map(b => b.rawText).join(''),
    html: blocks.map(b => `<section class="draft-block" id="${b.id}" data-block="${b.id}">${b.html}</section>`).join(''),
    sections: blocks.filter(b => b.heading).map(b => ({ id: b.id, title: b.heading })) };
}

// Text revision remains Markdown-only: image replacement does not stale exact
// text anchors. Presentation revision and opaque asset IDs include image bytes.
// Per-reader cache holds at most 64 metadata/digest entries, never image bytes.
export function presentationReader(binding, imageRead = readImage) {
  let cache = new Map(), tail = Promise.resolve();
  const signature = st => [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join(':');
  async function read() {
    const markdown = (await boundedRead(binding.draft)).toString('utf8');
    const candidates = renderDraft(markdown, binding);
    const nextCache = new Map(), digests = {};
    let total = 0;
    for (const file of Object.values(candidates.images)) {
      try {
        await noLinks(file);
        const st = await fs.stat(file, { bigint: true });
        if (!st.isFile() || st.size > 5n * 1024n * 1024n) throw new Error('Image size/type denied');
        total += Number(st.size);
        if (total > 20 * 1024 * 1024) throw new Error('Document image budget exceeded');
        const key = signature(st), prior = cache.get(file);
        let digest = prior?.key === key ? prior.digest : null;
        if (!digest) {
          const { data } = await imageRead(file);
          await noLinks(file);
          if (signature(await fs.stat(file, { bigint: true })) !== key) throw new Error('Image changed');
          digest = hash(data);
        }
        nextCache.set(file, { key, digest }); digests[file] = digest;
      } catch { digests[file] = 'unavailable'; }
    }
    cache = nextCache;
    const doc = renderDraft(markdown, binding, digests);
    return { ...doc, assetDigests: digests, presentationRevision: hash(JSON.stringify([doc.revision, digests])) };
  }
  return () => {
    const task = tail.then(read);
    tail = task.catch(() => {});
    return task;
  };
}

export function validateAnchor(anchor, document) {
  if (anchor?.kind === 'continuous') return validateContinuousAnchor(anchor, document);
  if (!anchor || anchor.revision !== document.revision) throw Object.assign(new Error('Draft changed; reselect the passage. Your message is still yours.'), { status: 409 });
  const block = document.blocks.find(b => b.id === anchor.block);
  if (!block || typeof anchor.quote !== 'string' || anchor.quote.length > 12000 || !anchor.quote || !Number.isInteger(anchor.offset) || anchor.offset < 0) throw Object.assign(new Error('Invalid selection'), { status: 400 });
  const { quote, offset, prefix, suffix } = anchor;
  if (typeof prefix !== 'string' || typeof suffix !== 'string' || prefix.length > 80 || suffix.length > 80 || block.text.slice(offset, offset + quote.length) !== quote || block.text.slice(Math.max(0, offset - prefix.length), offset) !== prefix || block.text.slice(offset + quote.length, offset + quote.length + suffix.length) !== suffix) throw Object.assign(new Error('Selection context does not match'), { status: 409 });
  return { revision: anchor.revision, block: block.id, quote, offset, prefix, suffix };
}

export function validateContinuousAnchor(a, doc) {
  const bad = message => Object.assign(new Error(message), { status: 409 });
  if (!a || a.kind !== 'continuous' || a.revision !== doc.revision) throw bad('Draft changed; original quote and note retained');
  const { quote, offset, prefix, suffix } = a;
  if (typeof quote !== 'string' || !quote.trim() || quote.length > 12000 || !Number.isInteger(offset) || offset < 0 || typeof prefix !== 'string' || typeof suffix !== 'string' || prefix.length > 80 || suffix.length > 80) throw bad('Invalid continuous selection');
  if (doc.text.slice(offset, offset + quote.length) !== quote || doc.text.slice(Math.max(0, offset - prefix.length), offset) !== prefix || doc.text.slice(offset + quote.length, offset + quote.length + suffix.length) !== suffix) throw bad('Selection context does not match; original quote retained');
  return { kind: 'continuous', revision: doc.revision, quote, offset, prefix, suffix };
}

// Never use client HTML/paths. Relocation is presentation-only: immutable original
// quote/context stays in history and dispatch requires the current text revision.
export function locateAnchor(a, doc) {
  if (a?.kind !== 'continuous') return null;
  if (a.revision === doc.revision) {
    try { return validateContinuousAnchor(a, doc); } catch { return null; }
  }
  const hits = []; let at = -1;
  while ((at = doc.text.indexOf(a.quote, at + 1)) !== -1) {
    hits.push(at); if (hits.length > 4000) return null;
  }
  const contextual = hits.filter(i => doc.text.slice(Math.max(0, i - a.prefix.length), i) === a.prefix && doc.text.slice(i + a.quote.length, i + a.quote.length + a.suffix.length) === a.suffix);
  const candidates = contextual.length === 1 ? contextual : hits;
  if (candidates.length !== 1) return null;
  const offset = candidates[0];
  return { kind: 'continuous', revision: doc.revision, quote: a.quote, offset, prefix: doc.text.slice(Math.max(0, offset - 80), offset), suffix: doc.text.slice(offset + a.quote.length, offset + a.quote.length + 80) };
}
