/**
 * Minimal DOM + IndexedDB shim, enough to execute web/js/app.js under Node.
 *
 * WHY THIS EXISTS: there is no browser and no npm in this environment, so
 * Puppeteer/jsdom are unavailable. Without something like this, the only
 * "verification" possible on the UI layer is that it parses — which would not
 * have caught a single one of the bugs that actually break demos (a missing
 * export, a field name that disagrees with the API, an event handler that throws
 * on first click).
 *
 * DELIBERATE LIMITS, stated so nobody mistakes this for a browser:
 *   - no layout, no CSS, no paint. Visual regressions are invisible here.
 *   - selectors support only `tag`, `.class`, `#id` and descendant combinators,
 *     which is all app.js uses.
 *   - events do not bubble and there is no default action.
 * It verifies WIRING and DATA FLOW. Looking at the app on a real phone is still
 * required, and is step 1 of the demo-day runbook.
 */

class ClassList {
  constructor(el) { this.el = el; }
  get _s() { return new Set((this.el.className || '').split(/\s+/).filter(Boolean)); }
  _w(s) { this.el.className = [...s].join(' '); }
  add(...c) { const s = this._s; c.forEach((x) => s.add(x)); this._w(s); }
  remove(...c) { const s = this._s; c.forEach((x) => s.delete(x)); this._w(s); }
  contains(c) { return this._s.has(c); }
  toggle(c, on) {
    const has = this.contains(c);
    const want = on === undefined ? !has : !!on;
    if (want) this.add(c); else this.remove(c);
    return want;
  }
}

class Node {
  constructor() { this.childNodes = []; this.parentNode = null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
}

class TextNode extends Node {
  constructor(t) { super(); this.nodeType = 3; this.data = String(t); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class Element extends Node {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new ClassList(this);
    this._className = '';
    this._value = '';
    this._html = '';
    this.hidden = false;
    this.checked = false;
    const self = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => self.attributes.get(`data-${camelToDash(k)}`),
      set: (_, k, v) => { self.attributes.set(`data-${camelToDash(k)}`, String(v)); return true; },
    });
  }

  get className() { return this._className; }
  set className(v) { this._className = String(v || ''); }
  get id() { return this.attributes.get('id') || ''; }
  set id(v) { this.attributes.set('id', String(v)); }
  get value() { return this._value; }
  set value(v) { this._value = v == null ? '' : String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  get style() {
    if (!this._style) this._style = { cssText: '' };
    return this._style;
  }

  setAttribute(k, v) {
    if (k === 'class') { this.className = v; return; }
    if (k === 'value') { this.value = v; return; }
    if (k === 'checked') { this.checked = true; return; }
    if (k === 'hidden') { this.hidden = true; return; }
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    if (k === 'class') return this.className;
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }

  append(...kids) {
    for (const k of kids) {
      const n = typeof k === 'object' && k && k.nodeType ? k : new TextNode(k);
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  appendChild(k) { this.append(k); return k; }
  removeChild(k) {
    const i = this.childNodes.indexOf(k);
    if (i >= 0) { this.childNodes.splice(i, 1); k.parentNode = null; }
    return k;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...kids) {
    this.childNodes.forEach((c) => { c.parentNode = null; });
    this.childNodes = [];
    this.append(...kids.filter((k) => k !== null && k !== undefined && k !== false && k !== ''));
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) { this.replaceChildren(new TextNode(v)); }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this.listeners.get(type) || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  /** Fires listeners on THIS node only — no bubbling. */
  dispatch(type, ev = {}) {
    const list = (this.listeners.get(type) || []).slice();
    const e = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...ev };
    return Promise.all(list.map((fn) => fn.call(this, e)));
  }
  click() { return this.dispatch('click'); }

  // --- selectors -----------------------------------------------------------
  _descendants(out = []) {
    for (const c of this.childNodes) {
      if (c.nodeType === 1) { out.push(c); c._descendants(out); }
    }
    return out;
  }
  querySelectorAll(sel) {
    const groups = sel.split(',').map((s) => s.trim()).filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const g of groups) {
      for (const el of matchDescendant(this, g)) {
        if (!seen.has(el)) { seen.add(el); out.push(el); }
      }
    }
    out.forEach = Array.prototype.forEach.bind(out);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  scrollIntoView() {}
  focus() {}
}

function camelToDash(k) { return k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`); }

/**
 * An element in a non-HTML namespace, i.e. what createElementNS returns.
 *
 * It exists so the shim reproduces the two SVG constraints app.js has to work
 * around, instead of quietly tolerating code that a browser would reject:
 *
 *   - tagName keeps its case ('path', not 'PATH'), because an SVG element's local
 *     name is case-sensitive.
 *   - className is read-only. On a real SVGElement it is an SVGAnimatedString, so
 *     `el.className = 'spark'` throws — which is precisely why svgEl() exists
 *     separately from h(). If someone folds the two factories back together, this
 *     throws here rather than on stage.
 */
class NsElement extends Element {
  constructor(tag, ns) {
    super(tag);
    this.namespaceURI = ns;
    this.tagName = String(tag);
  }
  get className() { return this.attributes.get('class') || ''; }
  set className(v) {
    throw new TypeError('shim: SVGElement.className is read-only (SVGAnimatedString); '
      + `use setAttribute('class', ${JSON.stringify(String(v))}) — see svgEl() in app.js`);
  }
  setAttribute(k, v) {
    // No class/value/checked/hidden shortcuts here: in SVG they are ordinary
    // attributes, and routing `class` through the className setter would throw.
    this.attributes.set(k, String(v));
  }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
}

// Tags that only mean anything in the SVG namespace. document.createElement()
// returns an HTMLUnknownElement for these: it occupies its CSS box and paints
// NOTHING, which is how three blank 318x62 gaps shipped where the trend charts
// were meant to be. A browser gives no error for it, so the shim has to.
const SVG_ONLY = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline',
                          'polygon', 'ellipse', 'g', 'defs', 'use']);

function matchesSimple(el, part) {
  // part e.g. "nav.tabs", ".chip", "#view", "a"
  const m = part.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/);
  if (!m) throw new Error(`shim: unsupported selector part "${part}"`);
  const [, tag, rest] = m;
  // Case-insensitive on the tag, so `path` finds an SVG <path> whose tagName the
  // shim deliberately keeps lowercase.
  if (tag && el.tagName.toUpperCase() !== tag.toUpperCase()) return false;
  for (const tok of rest.match(/[.#][\w-]+/g) || []) {
    if (tok[0] === '.' && !el.classList.contains(tok.slice(1))) return false;
    if (tok[0] === '#' && el.id !== tok.slice(1)) return false;
  }
  return true;
}

function matchDescendant(root, sel) {
  const parts = sel.split(/\s+/).filter(Boolean);
  let level = root._descendants();
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const hits = level.filter((el) => matchesSimple(el, part));
    if (i === parts.length - 1) return hits;
    level = hits.flatMap((el) => el._descendants());
  }
  return [];
}

// ---------------------------------------------------------------------------
// IndexedDB: in-memory, only the surface db.js touches.
//
// The request lifecycle is modelled properly rather than faked, because db.js
// depends on it. Two behaviours matter:
//
//   1. A transaction completes only once every request it spawned has settled.
//      An earlier version fired oncomplete on a bare setTimeout(0), so a handler
//      that issued further work from inside request.onsuccess ran AFTER the
//      transaction had already reported completion. db.reject() does exactly that
//      — get, then put+delete inside onsuccess — so it would have been tested
//      against semantics no real database has.
//   2. transaction() takes one store name or several. db.reject() moves a record
//      between two stores and needs both in one transaction, since a crash
//      between the put and the delete would leave the record in both.
// ---------------------------------------------------------------------------

function makeIndexedDB() {
  const stores = new Map();

  const dbObj = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore(name, { keyPath }) {
      stores.set(name, { keyPath, rows: new Map() });
      return {};
    },
    transaction(names) {
      const wanted = Array.isArray(names) ? names : [names];
      for (const n of wanted) {
        if (!stores.has(n)) throw new Error(`shim: no object store "${n}"`);
      }
      const t = { oncomplete: null, onerror: null, onabort: null, error: null };

      let pending = 0;
      let settled = false;
      const drain = () => {
        if (settled || pending > 0) return;
        settled = true;
        if (t.oncomplete) t.oncomplete();
      };
      // One tick to let the caller's synchronous body issue its requests. If it
      // issued none, this is what completes the transaction.
      setTimeout(drain, 0);

      /** A deferred request, settling on a later tick like the real thing. */
      function request(compute) {
        pending++;
        const r = { result: undefined, onsuccess: null, onerror: null };
        setTimeout(() => {
          try {
            r.result = compute();
            if (r.onsuccess) r.onsuccess({ target: r });
          } catch (e) {
            t.error = e;
            settled = true;
            if (t.onerror) t.onerror(e); else if (t.onabort) t.onabort(e);
            return;
          } finally {
            pending--;
          }
          drain();
        }, 0);
        return r;
      }

      t.objectStore = (name) => {
        if (wanted.length > 1 && !wanted.includes(name)) {
          throw new Error(`shim: "${name}" is not in this transaction's scope`);
        }
        const st = stores.get(Array.isArray(names) ? name : names);
        return {
          put: (v) => request(() => { st.rows.set(v[st.keyPath], v); return v[st.keyPath]; }),
          get: (k) => request(() => st.rows.get(k)),
          getAll: () => request(() => [...st.rows.values()]),
          delete: (k) => request(() => { st.rows.delete(k); }),
          clear: () => request(() => { st.rows.clear(); }),
        };
      };
      return t;
    },
  };

  return {
    _stores: stores,
    open() {
      const r = { result: dbObj, onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => {
        if (r.onupgradeneeded) r.onupgradeneeded({ target: r });
        if (r.onsuccess) r.onsuccess({ target: r });
      }, 0);
      return r;
    },
  };
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/**
 * Build the DOM that index.html provides, install globals, and return handles.
 * The node set here MUST mirror web/index.html — if they drift, app.js will
 * throw on a null element, which is exactly the failure we want surfaced.
 */
export function installDom({ origin = 'http://127.0.0.1:8000', online = true } = {}) {
  const doc = new Element('#document');
  const body = new Element('body');
  doc.append(body);

  const badge = new Element('div'); badge.className = 'synthetic-badge';
  const header = new Element('header'); header.className = 'top';
  const netPill = new Element('span'); netPill.className = 'pill'; netPill.id = 'net-pill';
  const netText = new Element('span'); netText.id = 'net-text'; netText.textContent = 'Online';
  const queuePill = new Element('span'); queuePill.className = 'pill warn'; queuePill.id = 'queue-pill'; queuePill.hidden = true;
  // Records the server permanently refused. An <a>, not a <span>, because in
  // index.html it links to #/preflight — the only screen that can clear them.
  const rejectPill = new Element('a'); rejectPill.className = 'pill bad'; rejectPill.id = 'reject-pill';
  rejectPill.setAttribute('href', '#/preflight'); rejectPill.hidden = true;
  netPill.append(netText);
  header.append(netPill, queuePill, rejectPill);

  const view = new Element('main'); view.id = 'view';

  // Mirrors index.html. Node has no service worker and window.isSecureContext is
  // undefined here, so capability.js will correctly report offline reload as
  // unavailable and the banner path gets exercised on every test run -- which is
  // the behaviour we actually want covered.
  const capbanner = new Element('div'); capbanner.className = 'capbanner'; capbanner.id = 'capbanner'; capbanner.hidden = true;

  const nav = new Element('nav'); nav.className = 'tabs';
  for (const route of ['#/screen', '#/roster', '#/dashboard', '#/model']) {
    const a = new Element('a');
    a.setAttribute('href', route);
    a.setAttribute('data-route', route);
    nav.append(a);
  }
  body.append(badge, header, capbanner, view, nav);

  const byId = {
    'net-pill': netPill, 'net-text': netText, 'queue-pill': queuePill,
    'reject-pill': rejectPill, capbanner, view,
  };
  doc.getElementById = (id) => byId[id] || doc.querySelector(`#${id}`) || null;
  doc.createElement = (t) => {
    if (SVG_ONLY.has(String(t).toLowerCase())) {
      throw new Error(`shim: createElement('${t}') is not an SVG element — it produces an `
        + 'HTMLUnknownElement that renders as a blank box. Use svgEl() / createElementNS.');
    }
    return new Element(t);
  };
  doc.createElementNS = (ns, t) => (ns && !/xhtml/.test(ns) ? new NsElement(t, ns) : new Element(t));
  doc.createTextNode = (t) => new TextNode(t);
  doc.body = body;
  doc.documentElement = doc;

  const winListeners = new Map();
  const loc = {
    _hash: '#/screen',
    origin,
    get href() { return `${origin}/index.html${this._hash}`; },
    get hash() { return this._hash; },
    set hash(v) {
      const next = String(v);
      if (next === this._hash) return;
      this._hash = next;
      (winListeners.get('hashchange') || []).forEach((f) => f({ type: 'hashchange' }));
    },
    pathname: '/index.html',
  };

  const win = {
    location: loc,
    addEventListener: (t, fn) => {
      if (!winListeners.has(t)) winListeners.set(t, []);
      winListeners.get(t).push(fn);
    },
    removeEventListener: () => {},
    dispatchEvent: (e) => (winListeners.get(e.type) || []).forEach((f) => f(e)),
    scrollTo: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    // No SpeechRecognition on purpose: voice.js must degrade, not crash.
    SpeechRecognition: undefined,
    webkitSpeechRecognition: undefined,
  };

  const nav_ = { onLine: online, userAgent: 'nirogya-shim' };

  globalThis.window = win;
  globalThis.document = doc;
  globalThis.location = loc;
  // Node 22 ships a read-only global `navigator`, so plain assignment throws.
  Object.defineProperty(globalThis, 'navigator', {
    value: nav_, writable: true, configurable: true,
  });
  globalThis.indexedDB = makeIndexedDB();
  globalThis.Element = Element;

  // Same-origin relative fetch: Node's fetch needs an absolute URL.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) =>
    realFetch(String(url).startsWith('http') ? url : origin + url, opts);

  return {
    doc, body, view, nav, netPill, netText, queuePill, rejectPill, loc, win, navigator: nav_,
    /** Fire a window event, e.g. 'online'. */
    fire: (type) => (winListeners.get(type) || []).forEach((f) => f({ type })),
    setOnline: (v) => { nav_.onLine = v; },
    text: (el = view) => el.textContent.replace(/\s+/g, ' ').trim(),
    /** All elements under `el` matching a shim selector. */
    all: (sel, el = view) => el.querySelectorAll(sel),
    one: (sel, el = view) => el.querySelector(sel),
    /** Type into an input and fire its `input` listener, as a user would. */
    async type(el, value) { el.value = String(value); await el.dispatch('input', { target: el }); },
    /** Pick a chip by its visible label inside a container. */
    async chip(container, label) {
      const c = container.querySelectorAll('.chip').find((x) => x.textContent === label);
      if (!c) throw new Error(`no chip labelled "${label}"`);
      await c.click();
      return c;
    },
    async check(id) {
      const cb = view.querySelectorAll('input').find((x) => x.getAttribute('id') === id);
      if (!cb) throw new Error(`no checkbox #${id}`);
      cb.checked = true;
      await cb.dispatch('change', { target: cb });
      return cb;
    },
  };
}

export { Element, TextNode, NsElement };
