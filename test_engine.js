/* Headless test harness: engine suites + UI smoke tests via a minimal DOM shim. */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

/* ---------- extract engine block ---------- */
const start = html.indexOf('/*__ENGINE_START__*/');
const end = html.indexOf('/*__ENGINE_END__*/');
if (start < 0 || end < 0) { console.error('FATAL: engine markers not found'); process.exit(2); }
eval(html.slice(start, end));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + String(extra).split('\n').slice(0, 6).join('\n       ') : '')); }
}

const sample = {
  user_id: 42, username: 'ada', email: null, is_active: true, balance: 1250.75,
  tags: ['admin', 'beta'],
  address: { street: 'x', city: 'London', zip: 'EC1A', geo: { lat: 51.5, lng: -0.12 } },
  orders: [
    { order_id: 1001, total: 49.99, status: 'shipped', items: [{ sku: 'KB-01', qty: 1, price: 49.99 }] },
    { order_id: 1002, total: 120.0, status: 'delivered', items: [{ sku: 'MN-02', qty: 2, price: 60.0 }], coupon: null }
  ],
  created_at: '2026-09-21T10:30:00Z'
};
const an = analyze(sample);

/* ================= 1. TypeScript ================= */
console.log('\n[1] TypeScript');
const ts = emitTS(an.root, {});
check('TS: root + nested interfaces', /interface Root \{/.test(ts) && /interface Geo \{/.test(ts), ts);
check('TS: email? optional', /email\?:/.test(ts), ts);
check('TS: orders: Order[]', /orders:\s*Order\[\]/.test(ts), ts);
check('TS: no unknown leaks', !/:\s*unknown/.test(ts.replace(/\[key: string\]: unknown;/g, '')), ts);
check('TS: export toggle', /export interface Root \{/.test(emitTS(an.root, { exportKw: true })), '');
check('TS: optNull off → inline null', /email: null;/.test(emitTS(an.root, { optNull: false })), '');
check('TS: empty array → unknown[]', /empty:\s*unknown\[\]/.test(emitTS(analyze({ empty: [] }).root, {})), '');
check('TS: scalar root', /type Root = string;/.test(emitTS(analyze('hi').root, {})), '');

/* ================= 2. Go ================= */
console.log('\n[2] Go');
const go = emitGO(an.root, {});
check('GO: root struct + json tags', /type Root struct \{/.test(go) && /json:"user_id"/.test(go), go);
check('GO: UserId int64', /UserId\s+int64/.test(go), go);
check('GO: ptr toggle *string', (() => {
  const g = emitGO(analyze({ orders: [{ id: 1, note: 'ok' }, { id: 2 }] }).root, { ptr: true });
  return /Note\s+\*string/.test(g);
})(), '');

/* ================= 3. Python ================= */
console.log('\n[3] Python');
const py = emitPY(an.root, {});
check('PY: dataclass Root', /@dataclass\nclass Root:/.test(py), py);
check('PY: Optional[...] = None', (() => {
  const s = emitPY(analyze({ rows: [{ email: 'x@y.z' }, { email: null }] }).root, {});
  return /email:\s*Optional\[str\]\s*=\s*None/.test(s);
})(), '');
check('PY: defaults after required', (() => {
  const blocks = py.split('@dataclass').slice(1);
  for (const b of blocks) {
    let seenDefault = false;
    for (const l of b.split('\n').filter(l => /^\s+\w+\s*:/.test(l))) {
      if (!/=/.test(l) && seenDefault) return false;
      if (/=/.test(l)) seenDefault = true;
    }
  }
  return true;
})(), '');
check('PY: weird keys renamed + comment', /weird_key:\s*int\s*#\s*json key: "weird key!"/.test(
  emitPY(analyze({ 'weird key!': 1 }).root, {})), '');
check('PY: int+float array → List[float]', /q:\s*List\[float\]/.test(emitPY(analyze({ q: [1, 2.5] }).root, {})),
  emitPY(analyze({ q: [1, 2.5] }).root, {}));
check('PY: imports deduped once', (py.match(/^from typing import/gm) || []).length <= 1, '');

/* ================= 4. Zod ================= */
console.log('\n[4] Zod');
const z1 = emitZOD(analyze({ user_id: 42, email: null, tags: ['a'] }).root, {});
check('ZOD: import + schema + infer', /import \{ z \} from 'zod';/.test(z1) && /const RootSchema = z\.object\(\{/.test(z1) && /type Root = z\.infer<typeof RootSchema>;/.test(z1), z1);
check('ZOD: int + null-optional + array', /z\.number\(\)\.int\(\)/.test(z1) && /z\.null\(\)\.optional\(\)/.test(z1) && /z\.array\(z\.string\(\)\)/.test(z1), z1);
const z2 = emitZOD(analyze({ rows: [{ id: 1 }, { id: 2, note: 'x' }] }).root, {});
check('ZOD: nested schema before root (TDZ)', z2.indexOf('RowSchema =') < z2.indexOf('RootSchema ='), z2);
check('ZOD: nullable chain', /note: z\.string\(\)\.nullable\(\)\.optional\(\),/.test(z2), z2);

/* ================= 5. Rust (serde) ================= */
console.log('\n[5] Rust');
const rs = emitRS(an.root, {});
check('RS: derive + pub struct', /#\[derive\(Debug, Serialize, Deserialize\)\]/.test(rs) && /pub struct Root \{/.test(rs), rs);
check('RS: snake key renamed', /rename = "user_id"/.test(rs) || /pub user_id:/.test(rs), rs);
check('RS: email → Option<Value>', /pub Email:\s*Option<serde_json::Value>,/.test(rs), rs);
check('RS: Vec<Order>', /Vec<Order>/.test(rs), rs);
check('RS: skip_serializing_if on optional', /skip_serializing_if = "Option::is_none"/.test(rs), rs);
check('RS: Clone derive with exportKw', /#\[derive\(Debug, Clone, Serialize, Deserialize\)\]/.test(emitRS(an.root, { exportKw: true })), '');
check('RS: array root → Vec<i64>', /pub type Root = Vec<i64>;/.test(emitRS(analyze([1, 2]).root, {})), '');
check('RS: nested Geo struct emitted', /pub struct Geo \{/.test(rs), rs);

/* ================= 6. Pydantic v2 ================= */
console.log('\n[6] Pydantic v2');
const pyd = emitPYD(an.root, {});
check('PYD: BaseModel class', /class Root\(BaseModel\):/.test(pyd), pyd);
check('PYD: pydantic import + future annotations', /from pydantic import BaseModel, RootModel/.test(pyd) && /from __future__ import annotations/.test(pyd), pyd);
check('PYD: optional → Field(default=None)', (() => {
  const s = emitPYD(analyze({ rows: [{ email: 'x' }, { email: null }] }).root, {});
  return /email:\s*str \| None\s*=\s*Field\(default=None\)/.test(s);
})(), '');
check('PYD: nested class before root', pyd.indexOf('class Order(BaseModel)') < pyd.indexOf('class Root(BaseModel)'), pyd);
check('PYD: RootModel for array root', /RootModel\[list\[/.test(emitPYD(analyze([{ a: 1 }]).root, {})), '');

/* ================= 7. req-only (always-null stripping) ================= */
console.log('\n[7] req-only mode');
const rowsSrc = { rows: [{ id: 1, x: 'a', gone: null }, { id: 2, x: 'b', gone: null }] };
check('BASE: null-only field kept by default', /gone\?:/.test(emitTS(analyze(rowsSrc).root, {})), emitTS(analyze(rowsSrc).root, {}));
const tsStrip = emitTS(stripAlwaysNull(analyze(rowsSrc), true).root, {});
check('STRIP: gone dropped', !/gone/.test(tsStrip), tsStrip);
check('STRIP: id + x kept', /id:/.test(tsStrip) && /x:/.test(tsStrip), tsStrip);
check('STRIP: off → untouched', /gone\?:/.test(emitTS(stripAlwaysNull(analyze(rowsSrc), false).root, {})), '');
check('STRIP: root-level null untouched', /email/.test(emitTS(stripAlwaysNull(analyze({ email: null, b: 1 }), true).root, {})), '');
check('STRIP: nested objects stripped, object fields kept', (() => {
  const t = emitTS(stripAlwaysNull(analyze({ o: { a: null, b: 1 }, rows: [{ g: null }] }), true).root, {});
  return !/\ba\??:/.test(t) && /b:/.test(t);
})(), '');
check('STRIP: all-null array safe', (() => { try { stripAlwaysNull(analyze({ rows: [null, null] }), true); return true; } catch (e) { return false; } })(), '');
check('PYD: also respects strip', !/gone/.test(emitPYD(stripAlwaysNull(analyze(rowsSrc), true).root, {})), '');

/* ================= 8. regressions ================= */
console.log('\n[8] regressions');
check('REG: heterogeneous merge', (() => {
  const t = emitTS(analyze({ items: [{ a: 1, b: 'x' }, { a: 2, c: true }] }).root, {});
  return /a:\s*number/.test(t) && /b\?:/.test(t) && /c\?:/.test(t);
})(), '');
check('REG: clean names Order/Item', (() => {
  const t = emitTS(an.root, {});
  return /interface Order \{/.test(t) && /interface Item \{/.test(t) && !/Order3/.test(t);
})(), '');
check('REG: dup names deduped', (() => {
  const t = emitTS(analyze({ user: { name: 'x' }, data: { user: { age: 1 } } }).root, {});
  return (t.match(/interface User\d? \{/g) || []).length === 2;
})(), '');
check('REG: quoted numeric key', /"123":\s*number/.test(emitTS(analyze({ '123': 2 }).root, {})), '');

/* ================= 9. UI smoke tests (DOM shim) ================= */
console.log('\n[9] UI smoke tests');
const FULL = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function makeEl(id, tag) {
  const el = {
    id, tagName: (tag || 'div').toUpperCase(), children: [], dataset: {},
    style: {}, _listeners: {}, _innerHTML: '', value: '', title: '', hidden: false, _className: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { (f === undefined ? !this._s.has(c) : f) ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    remove() {}, click() {}, select() {}, focus() {}, blur() {},
    getContext() { return { clearRect() {}, fillRect() {}, set globalAlpha(v) {}, set fillStyle(v) {} }; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._innerHTML; },
    set(v) { this._innerHTML = String(v); this._text = String(v).replace(/<[^>]*>/g, ''); }
  });
  Object.defineProperty(el, 'textContent', {
    get() { return this._text !== undefined ? this._text : (this._innerHTML || ''); },
    set(v) { this._innerHTML = String(v); this._text = String(v); }
  });
  Object.defineProperty(el, 'className', {
    get() { return [...el.classList._s].join(' '); },
    set(v) { el.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
  });
  return el;
}
function makeDom() {
  const reg = {};
  ['stars', 'boot', 'pIn', 'pOut', 'input', 'inBytes', 'chips', 'samplesRow', 'errIn',
    'stNodes', 'stDepth', 'stArr', 'stTime', 'outStat', 'tabs', 'out', 'okOut',
    'stTypes', 'stFields', 'stLines', 'stNulls', 'toast', 'toastMsg', 'pwr', 'clock',
    'btnCopy', 'btnDl', 'btnSwap', 'fileIn', 'tglNull', 'tglExp', 'tglPtr', 'tglReq'
  ].forEach(id => reg[id] = makeEl(id, id === 'input' ? 'textarea' : id === 'out' ? 'pre' : 'button'));
  reg.tabs.children = ['ts', 'go', 'py', 'pyd', 'rs', 'zod'].map((l, i) => {
    const b = makeEl('tab' + i, 'button'); b.dataset.lang = l; return b;
  });
  const doc = {
    getElementById: id => reg[id] || null,
    createElement: t => makeEl('anon', t),
    querySelectorAll: () => [],
    addEventListener: () => {},
    body: makeEl('body', 'body')
  };
  return { reg, doc };
}
function runPage() {
  const { reg, doc } = makeDom();
  const ctx = {
    console, performance, requestAnimationFrame: () => 0,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    addEventListener: () => {}, URL, Blob, navigator: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: doc,
    window: { innerWidth: 1200, innerHeight: 800, document: doc }
  };
  const boot = new Function('window', 'document', 'navigator', 'localStorage', 'performance',
    'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'addEventListener', 'URL', 'Blob', 'innerWidth', 'innerHeight',
    'with (this) {' + FULL + '\nthis.__f = forge; this.__r = render; this.__lang = l => { LANG = l; };' +
    'this.__getopt = () => OPT; this.__setopt = (k, v) => { OPT[k] = v; }; this.__copy = copyOut; }');
  boot.call(ctx, ctx.window, doc, ctx.navigator, ctx.localStorage, performance,
    ctx.requestAnimationFrame, ctx.setTimeout, ctx.clearTimeout, ctx.setInterval,
    ctx.clearInterval, ctx.addEventListener, URL, Blob, 1200, 800);
  return { ctx, reg };
}

/* --- boot integrity --- */
let page;
try { page = runPage(); check('UI: full script boots in shim without throwing', true, ''); }
catch (e) { check('UI: full script boots in shim without throwing', false, e.stack); }

if (page) {
  const { ctx, reg } = page;
  check('UI: boot sample loaded into stdin', /user_id/.test(reg.input.value), reg.input.value.slice(0, 60));

  reg.input.value = '{"a": 1, "b": [1, 2]}';
  ctx.__f(true);
  check('UI: forge() populates TS output', /interface Root \{/.test(reg.out.textContent), reg.out.textContent.slice(0, 120));
  check('UI: stats counters update', +reg.stTypes.textContent >= 1 && /BYTES/.test(reg.inBytes.textContent) && +reg.stLines.textContent >= 1,
    reg.stTypes.textContent + ' | ' + reg.inBytes.textContent + ' | ' + reg.stLines.textContent);
  check('UI: okbar success message', /forged/.test(reg.okOut.textContent), reg.okOut.textContent);

  reg.input.value = '{bad json,,,}';
  ctx.__f(true);
  check('UI: bad JSON → PARSE ERROR bar + shake', reg.errIn.classList.contains('show') && /PARSE ERROR/.test(reg.errIn.textContent) && reg.pIn.classList.contains('errfocus'), reg.errIn.textContent);
  check('UI: FAIL status in titlebar', reg.outStat.textContent === 'FAIL' && reg.outStat.classList.contains('no'), reg.outStat.textContent);

  reg.input.value = '';
  ctx.__f(true);
  check('UI: empty stdin → STDIN EMPTY', /STDIN EMPTY/.test(reg.errIn.textContent), reg.errIn.textContent);

  reg.input.value = '{"a": 1}';
  ctx.__f(true);
  ctx.__lang('go'); ctx.__r();
  check('UI: render() switches to Go', /type Root struct \{/.test(reg.out.textContent), reg.out.textContent.slice(0, 80));
  ctx.__lang('py'); ctx.__r();
  check('UI: render() switches to Python', /@dataclass/.test(reg.out.textContent), reg.out.textContent.slice(0, 80));
  ctx.__lang('pyd'); ctx.__r();
  check('UI: render() switches to Pydantic', /class Root\(BaseModel\):/.test(reg.out.textContent), reg.out.textContent.slice(0, 80));
  ctx.__lang('rs'); ctx.__r();
  check('UI: render() switches to Rust', /pub struct Root \{/.test(reg.out.textContent), reg.out.textContent.slice(0, 80));
  ctx.__lang('zod'); ctx.__r();
  check('UI: render() switches to Zod', /RootSchema = z\.object\(/.test(reg.out.textContent), reg.out.textContent.slice(0, 80));
  check('UI: titlebar shows active emitter', /ZOD/.test(reg.outStat.textContent), reg.outStat.textContent);

  /* req-only toggle through the sandbox */
  reg.input.value = '{"rows":[{"id":1,"gone":null},{"id":2,"gone":null}]}';
  ctx.__lang('ts'); ctx.__f(true);
  const before = reg.out.textContent;
  ctx.__setopt('reqOnly', true); ctx.__f(true);
  check('UI: req toggle drops all-null fields', !/gone/.test(reg.out.textContent) && /gone\?:/.test(before), before.slice(0, 140));
  check('UI: NULLS stat reflects REQ-ONLY', reg.stNulls.textContent === 'REQ-ONLY', reg.stNulls.textContent);
  ctx.__setopt('reqOnly', false);

  /* copy fallback (no clipboard API in shim → legacy path) */
  let copyThrew = false;
  try { ctx.__copy(); } catch (e) { copyThrew = true; }
  check('UI: copy fallback executes safely', !copyThrew, '');
}

console.log('\n=========================================');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
