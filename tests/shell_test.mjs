/**
 * Static integrity test for the offline shell and the CSP contract.
 *
 *   node tests/shell_test.mjs
 *
 * WHY THIS EXISTS. Two invariants hold this app together, and both are the kind
 * that a human maintains by reading two lists side by side and believing they
 * match. That is how they drift.
 *
 *   1. THE PRECACHE LIST IS COMPLETE. Every file the app needs to boot must be in
 *      SHELL in web/sw.js. js/capability.js was imported by js/app.js and absent
 *      from SHELL for the whole build. Offline reload still worked — the fetch
 *      handler caches any file on its first successful online load — so nothing
 *      looked wrong. It only breaks if the worker installs and the tab closes
 *      before that module is fetched, which is a bug that appears once, on a
 *      judge's phone, and cannot be reproduced afterwards.
 *
 *   2. NOTHING THE CSP FORBIDS IS IN THE SOURCE. The server sends
 *      `script-src 'self'` with no 'unsafe-inline'. That header is what makes an
 *      injected <script> inert, and the price is that an inline <script> or an
 *      on*= attribute in index.html silently stops running. Silently: no error
 *      in the page, just a feature that no longer happens. The service-worker
 *      registration used to be exactly such a script.
 *
 * Both are checked by reading the files, so a wrong answer here is a build that
 * would have failed on stage.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not url.pathname: the project lives under a directory with a
// space in its name, and a file: URL percent-encodes it. Reading the pathname
// directly looks for "New%20folder" and gets ENOENT.
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB = join(ROOT, 'web');

let failures = 0;
const groups = new Map();

function ok(group, label, cond, detail) {
  groups.set(group, (groups.get(group) || 0) + 1);
  if (!cond) {
    failures++;
    console.error(`\n  FAIL [${group}] ${label}`);
    if (detail) console.error(`    ${detail}`);
  }
}

const read = (p) => readFileSync(join(WEB, p), 'utf8');

// ---------------------------------------------------------------------------
// 1. Walk the real dependency graph
// ---------------------------------------------------------------------------

/** Every ES module reachable from an entry point, as web-relative paths. */
function moduleGraph(entries) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!existsSync(join(WEB, rel))) continue;
    const src = read(rel);
    // Static imports and re-exports only. A dynamic import() would not be
    // precached by this walk, which is a reason not to add one.
    const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"](\.[^'"]+)['"]/g;
    for (const m of src.matchAll(re)) {
      const target = relative(WEB, resolve(join(WEB, dirname(rel)), m[1])).replace(/\\/g, '/');
      stack.push(target);
    }
  }
  return seen;
}

const html = read('index.html');

// index.html's own references: scripts, stylesheets, manifest, icons.
const htmlRefs = new Set();
for (const m of html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)) htmlRefs.add(m[1]);
for (const m of html.matchAll(/<link[^>]*\shref=["']([^"']+)["']/g)) htmlRefs.add(m[1]);

const entries = [...htmlRefs].filter((r) => r.endsWith('.js'));
ok('graph', 'index.html loads at least one script', entries.length > 0);

const modules = moduleGraph(entries);
ok('graph', 'the module graph was actually walked', modules.size >= 5,
   `found ${modules.size}: ${[...modules].join(', ')}`);
// If this fails, the regex above stopped matching the app's import style and every
// other assertion in section 2 is passing vacuously.
ok('graph', 'transitive imports are followed (capability.js is 2 hops from index.html)',
   modules.has('js/capability.js'),
   `graph: ${[...modules].sort().join(', ')}`);

// manifest icons
let manifestIcons = [];
try {
  const mf = JSON.parse(read('manifest.webmanifest'));
  manifestIcons = (mf.icons || []).map((i) => i.src.replace(/^\.?\//, ''));
  ok('graph', 'the manifest declares icons', manifestIcons.length > 0);
} catch (e) {
  ok('graph', 'manifest.webmanifest parses as JSON', false, String(e.message));
}

// Everything the app needs on disk before it can boot offline.
const needed = new Set([
  'index.html',
  ...[...htmlRefs].map((r) => r.replace(/^\.?\//, '')),
  ...modules,
  ...manifestIcons,
]);
needed.delete('sw.js');   // the worker is fetched by the browser, never precached

for (const f of needed) {
  ok('exists', `${f} is on disk`, existsSync(join(WEB, f)));
}

// ---------------------------------------------------------------------------
// 2. The precache list must cover all of it
// ---------------------------------------------------------------------------

const sw = read('sw.js');
const shellBlock = sw.match(/const SHELL\s*=\s*\[([\s\S]*?)\]/);
ok('precache', 'SHELL is declared in sw.js', !!shellBlock);

const shell = new Set(
  (shellBlock ? [...shellBlock[1].matchAll(/['"]([^'"]+)['"]/g)] : [])
    .map((m) => m[1].replace(/^\.\//, '')),
);
ok('precache', 'SHELL is not empty', shell.size > 0);
ok('precache', "SHELL precaches the navigation root ('./')", shell.has('') || shell.has('/'),
   'without it, opening the app offline at / has nothing to serve');

for (const f of needed) {
  ok('precache', `${f} is precached`, shell.has(f),
     `add './${f}' to SHELL in web/sw.js — the app cannot boot offline without it`);
}

// The reverse direction too: sw.js adds each entry individually and swallows the
// failure with a console.warn, so a typo'd path degrades offline capability
// without failing anything.
for (const f of shell) {
  if (f === '' || f === '/') continue;
  ok('precache', `SHELL entry ${f} exists`, existsSync(join(WEB, f)),
     'a precache entry that 404s is warned about and then ignored at runtime');
}

// A VERSION bump is what retires the previous cache. Editing a shell file without
// bumping leaves phones serving the old build.
const version = sw.match(/const VERSION\s*=\s*['"]([^'"]+)['"]/);
ok('precache', 'sw.js declares a VERSION', !!version);
ok('precache', 'VERSION is namespaced and versioned',
   !!version && /^nirogya-v\d+$/.test(version[1]), version && version[1]);

// ---------------------------------------------------------------------------
// 3. The CSP contract
// ---------------------------------------------------------------------------

// `script-src 'self'` blocks inline script. Any <script> without src= must be
// empty.
for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
  const [, attrs, body] = m;
  if (/\ssrc=/.test(attrs)) continue;
  ok('csp', 'no inline <script> in index.html', body.trim() === '',
     `blocked by script-src 'self': ${body.trim().slice(0, 70)}...`);
}

// ...and so does an inline event-handler attribute. h() uses addEventListener,
// so `oninput:` in the JS is fine; this looks only at the HTML.
const handlerAttrs = [...html.matchAll(/\son(?:click|load|error|input|change|submit)\s*=/gi)];
ok('csp', 'no on*= handler attributes in index.html', handlerAttrs.length === 0,
   handlerAttrs.map((m) => m[0]).join(' '));

// Every source of the CSP must actually be needed, and everything needed must be
// allowed. style-src carries 'unsafe-inline' because h() sets style="" attributes;
// assert that is still true rather than leaving the exemption unexplained.
const appPy = readFileSync(join(ROOT, 'server', 'app.py'), 'utf8');
for (const directive of ['default-src \'self\'', 'script-src \'self\'', 'object-src \'none\'',
                         'base-uri \'none\'', 'frame-ancestors \'none\'']) {
  ok('csp', `app.py sends ${directive}`, appPy.includes(directive));
}
ok('csp', "script-src does NOT allow 'unsafe-inline'",
   !/script-src[^"']*unsafe-inline/.test(appPy),
   "that single token would undo the app's main XSS mitigation");
ok('csp', "style-src DOES allow 'unsafe-inline' (h() writes style= attributes)",
   /style-src 'self' 'unsafe-inline'/.test(appPy));

// The app loads nothing from a third party. That is what lets the CSP be this
// strict — no CDN for a font, no analytics beacon, no unpkg module — so it is
// worth asserting rather than assuming.
//
// Matched at LOAD POSITIONS only, not on any absolute URL in the text. Comments
// and user-facing strings legitimately mention off-origin addresses: capability.js
// explains secure contexts by naming "https://" and "http://192.168.x.x:8000",
// and flagging those would train us to ignore this check.
const LOADS = [
  [/<(?:script|img|iframe|source)[^>]*\ssrc=["'](https?:[^"']+)/gi, 'element src'],
  [/<link[^>]*\shref=["'](https?:[^"']+)/gi, 'link href'],
  [/(?:^|[^.\w])import\s[^;]*?from\s*["'](https?:[^"']+)/gm, 'module import'],
  [/import\s*\(\s*["'](https?:[^"']+)/g, 'dynamic import'],
  [/fetch\s*\(\s*["'`](https?:[^"'`]+)/g, 'fetch'],
  [/(?:importScripts|new\s+Worker)\s*\(\s*["'](https?:[^"']+)/g, 'worker'],
  [/@import\s+(?:url\()?["']?(https?:[^"')]+)/gi, 'css @import'],
  [/url\(\s*["']?(https?:[^"')]+)/gi, 'css url()'],
];
for (const f of ['index.html', 'css/app.css', ...modules]) {
  const src = read(f);
  const hits = [];
  for (const [re, kind] of LOADS) {
    for (const m of src.matchAll(re)) hits.push(`${kind}: ${m[1]}`);
  }
  ok('third party', `${f} loads nothing off-origin`, hits.length === 0, hits.join('; '));
}

// And prove that check can fire, rather than trusting a green row: the same
// matcher run over a line that really does load a CDN script must catch it.
ok('third party', 'the off-origin matcher actually matches a CDN load',
   LOADS.some(([re]) => {
     re.lastIndex = 0;
     return re.test('<script src="https://cdn.example.com/x.js"></script>');
   }));

// ---------------------------------------------------------------------------
// 4. No HTML sink anywhere in the client
// ---------------------------------------------------------------------------
// The XSS argument for this app is not "we escape carefully", it is "there is no
// parser to reach": every node is built with createElement/createTextNode. That
// claim is only true while it is true of every file, and it is one line of
// convenience away from being false.
const SINKS = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write',
               'eval(', 'new Function('];
for (const f of modules) {
  const src = read(f);
  for (const sink of SINKS) {
    // Comments discuss these by name on purpose — the whole point of svgEl()'s
    // docstring is explaining why innerHTML is wrong there. Strip comments first.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    ok('no html sink', `${f} does not use ${sink}`, !code.includes(sink),
       'the app builds DOM nodes; a markup sink would give injected text a parser');
  }
}

// ---------------------------------------------------------------------------
const total = [...groups.values()].reduce((a, b) => a + b, 0);
console.log(`\nShell + CSP: ${total} assertions across ${groups.size} groups`);
for (const [g, n] of groups) console.log(`  ${String(n).padStart(4)}  ${g}`);
console.log(`  precached: ${shell.size} entries, ${needed.size} required files, ${modules.size} modules`);

if (failures) {
  console.error(`\n${failures} FAILURE(S).`);
  console.error('A missing precache entry breaks offline reload; a CSP violation '
    + 'breaks a feature silently. Both show up first in front of an audience.');
  process.exit(1);
}
console.log('SHELL OK - every file the app boots from is precached, and nothing '
  + 'the CSP forbids is in the source.\n');
