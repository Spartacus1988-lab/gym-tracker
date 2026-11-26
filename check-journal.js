// Run: node check-journal.js [path-to-html]
// Boots the app script against a fake localStorage and verifies saved history is never silently erased.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(process.argv[2] ?? `${__dirname}/index.html`, 'utf8');
const script = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
const KEY = 'my-workouts.journal.v1';

function boot(store, {broken = false} = {}) {
  const el = () => new Proxy({dataset: {}, addEventListener() {}, querySelector: () => el(), querySelectorAll: () => []},
    {get: (t, k) => (k in t ? t[k] : undefined)});
  const fail = () => { throw new Error('storage blocked'); };
  const localStorage = broken ? {getItem: fail, setItem: fail, removeItem: fail} : {
    getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }
  };
  const ctx = {
    document: {querySelector: () => el(), querySelectorAll: () => [], getElementById: () => null, body: {dataset: {}}},
    window: {addEventListener() {}, scrollTo() {}, scrollY: 0}, history: {replaceState() {}}, localStorage, Intl
  };
  vm.createContext(ctx);
  vm.runInContext(script + ';globalThis.T = {saveJournal, get journal() { return journal; }}', ctx);
  return ctx.T;
}

const saveHeight = app => app.saveJournal(state => { state.height = 180; });
const parked = store => Object.keys(store).filter(k => k.startsWith(KEY + '.unreadable.')).map(k => store[k]);

// 1. Corrupt JSON: original text survives a save.
{
  const store = {[KEY]: '{bad'};
  saveHeight(boot(store));
  assert.deepEqual(parked(store), ['{bad']);
  assert.equal(JSON.parse(store[KEY]).height, 180);
}

// 2. Unknown future version: preserved, not overwritten.
{
  const future = JSON.stringify({version: 2, body: [{date: '2026-11-01', weight: 80}]});
  const store = {[KEY]: future};
  saveHeight(boot(store));
  assert.deepEqual(parked(store), [future]);
}

// 3. History for an exercise the program no longer has: kept through a save.
{
  const old = [{date: '2026-11-01', weight: 50, reps: 8}];
  const store = {[KEY]: JSON.stringify({version: 1, lifts: {'old-row:oldId': old}})};
  saveHeight(boot(store));
  assert.deepEqual(JSON.parse(store[KEY]).lifts['old-row:oldId'], old);
}

// 4. Storage blocked: save reports failure, nothing is thrown.
assert.equal(saveHeight(boot({}, {broken: true})), false);

// 5. Normal path still works and a second save does not park anything.
{
  const store = {};
  const app = boot(store);
  saveHeight(app);
  app.saveJournal(state => { state.body.push({date: '2026-11-02', weight: 81}); });
  assert.equal(JSON.parse(store[KEY]).body.length, 1);
  assert.deepEqual(parked(store), []);
}

console.log('journal checks passed');
