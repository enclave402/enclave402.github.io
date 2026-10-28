// Builds index.html, sitemap.xml and llms.txt from the manifests listed in sources.json.
// Usage: node scripts/build.mjs [--offline]   (--offline skips remote manifests and link checks)
import { readFileSync, writeFileSync } from 'node:fs';

const offline = process.argv.includes('--offline');
const cfg = JSON.parse(readFileSync('sources.json', 'utf8'));
const schema = JSON.parse(readFileSync('schema/manifest.schema.json', 'utf8')).properties.items.items;
const errors = [];
const warnings = [];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const plain = (s) => s.replace(/<[^>]+>/g, '');

function validate(item, where) {
  for (const k of schema.required) if (typeof item[k] !== 'string' || !item[k]) errors.push(`${where}: missing "${k}"`);
  for (const [k, rule] of Object.entries(schema.properties)) {
    const v = item[k];
    if (v === undefined) continue;
    if (rule.enum && !rule.enum.includes(v)) errors.push(`${where}: "${k}" must be one of ${rule.enum.join('/')}`);
    if (rule.pattern && !new RegExp(rule.pattern).test(v)) errors.push(`${where}: "${k}" fails ${rule.pattern}`);
  }
}

const items = [];
for (const src of cfg.sources) {
  let manifest;
  try {
    if (src.file) manifest = JSON.parse(readFileSync(src.file, 'utf8'));
    else if (offline) continue;
    else {
      const res = await fetch(src.url);
      if (res.status === 404 && !src.required) { warnings.push(`${src.name}: no manifest yet (404)`); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    }
  } catch (e) {
    errors.push(`${src.name}: cannot read manifest (${e.message})`);
    continue;
  }
  if (!Array.isArray(manifest.items)) { errors.push(`${src.name}: "items" must be an array`); continue; }
  manifest.items.forEach((it) => { validate(it, `${src.name}/${it.id ?? '?'}`); items.push({ ...it, source: src.name }); });
}

const ids = new Set();
for (const it of items) { if (ids.has(it.id)) errors.push(`duplicate id ${it.id}`); ids.add(it.id); }

if (!offline) {
  await Promise.all(items.map(async (it) => {
    try {
      const res = await fetch(it.url, { redirect: 'follow' });
      if (res.status !== 200) errors.push(`${it.source}/${it.id}: ${it.url} returned ${res.status}`);
    } catch (e) { errors.push(`${it.source}/${it.id}: ${it.url} unreachable (${e.message})`); }
  }));
}

if (errors.length) {
  console.error('GATES FAILED, nothing written:\n- ' + errors.join('\n- '));
  process.exit(1);
}
warnings.forEach((w) => console.warn('warn: ' + w));

const href = (it) => (it.utm ? `${it.url}${it.url.includes('?') ? '&' : '?'}${cfg.utm}` : it.url);
const card = (it) => `    <a class="card${it.featured ? ' featured' : ''}" href="${esc(href(it))}">
      <span class="tag">${esc(it.label ?? it.type)}</span>
      <h3>${esc(it.title)}</h3>
      <p>${it.summary}</p>
      <span class="go">${esc(it.cta ?? 'Open →')}</span>
    </a>`;

// Featured first, then free items, then the rest (give-first).
const order = (a, b) => Number(!!b.featured) - Number(!!a.featured) || Number(a.price !== 'free') - Number(b.price !== 'free');

const sections = cfg.lanes.map((lane) => {
  const list = items.filter((i) => i.lane === lane.id).sort(order);
  if (!list.length) return '';
  return `  <h2>${esc(lane.title)}</h2>\n  <div class="grid">\n${list.map(card).join('\n')}\n  </div>\n`;
}).join('\n');

// The template's card sections sit between the lede and the About heading; they are replaced wholesale.
const tpl = readFileSync('templates/index.html', 'utf8');
const from = tpl.indexOf('  <h2>');
const to = tpl.indexOf('  <h2>About</h2>');
writeFileSync('index.html', tpl.slice(0, from) + sections + '\n' + tpl.slice(to));
writeFileSync('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${cfg.site}/</loc></url>\n</urlset>\n`);
writeFileSync('llms.txt', '# Enclave402\n\n> Resource hub for Oliver Haughton (Coach Hype): tools for ADHD and AuDHD adults, and for people building with AI agents.\n\n' +
  cfg.lanes.map((l) => `## ${l.title}\n\n` + items.filter((i) => i.lane === l.id).sort(order).map((i) => `- [${i.title}](${i.url}): ${plain(i.summary)}`).join('\n')).join('\n\n') + '\n');
console.log(`built ${items.length} cards`);
