// Run: node check-journal.js [path-to-html]
// Boots the app script against a fake localStorage and verifies saved history is never silently erased.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(process.argv[2] ?? `${__dirname}/index.html`, 'utf8');
const script = html.match(/<script>\r?\n([\s\S]*?)<\/script>/)[1];
const KEY = 'my-workouts.journal.v1';

function boot(store, {broken = false} = {}) {
  // Minimal DOM stand-in: unknown methods are no-ops.
  const el = () => new Proxy({dataset: {}, querySelector: () => el(), querySelectorAll: () => []},
    {get: (t, k) => (k in t ? t[k] : () => el())});
  const fail = () => { throw new Error('storage blocked'); };
  const localStorage = broken ? {getItem: fail, setItem: fail, removeItem: fail} : {
    getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }
  };
  const ctx = {
    document: {querySelector: () => el(), querySelectorAll: () => [], getElementById: () => null,
      createElement: () => el(), body: el()},
    window: {addEventListener() {}, scrollTo() {}, scrollY: 0}, history: {replaceState() {}}, localStorage, Intl
  };
  vm.createContext(ctx);
  vm.runInContext(script + `;globalThis.T = {saveJournal, normalizeJournal, withSet, withoutSet, nextSetGuess,
    restSeconds, rowsById, get journal() { return journal; }}`, ctx);
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

// ---- Sets ----
const app = boot({});
const plain = value => JSON.parse(JSON.stringify(value)); // vm objects -> comparable plain objects
const D1 = '2026-11-20', D2 = '2026-11-24';

// 6. A pre-sets record (one weight per day) becomes set 1 when another set is added that day.
{
  const records = app.withSet([{date: D1, weight: 30, reps: 10}], D1, {weight: 35, reps: 8}, 'inclineDb');
  assert.deepEqual(plain(records), [{date: D1, weight: 35, reps: 8,
    sets: [{weight: 30, reps: 10}, {weight: 35, reps: 8}]}]);
}

// 7. Top set: same weight -> more reps wins; assisted machine -> less assistance wins.
{
  let r = app.withSet([], D1, {weight: 35, reps: 6}, 'inclineDb');
  r = app.withSet(r, D1, {weight: 35, reps: 8}, 'inclineDb');
  assert.equal(r[0].reps, 8);
  let a = app.withSet([], D1, {weight: 30, reps: 8}, 'assistPull');
  a = app.withSet(a, D1, {weight: 20, reps: 6}, 'assistPull');
  assert.equal(a[0].weight, 20);
}

// 8. Deleting sets: the record updates, and the last delete removes the day.
{
  let r = app.withSet([], D1, {weight: 40, reps: 8}, 'inclineDb');
  r = app.withSet(r, D1, {weight: 35, reps: 8}, 'inclineDb');
  r = app.withoutSet(r, D1, 0, 'inclineDb');
  assert.deepEqual(plain(r), [{date: D1, weight: 35, reps: 8, sets: [{weight: 35, reps: 8}]}]);
  assert.deepEqual(plain(app.withoutSet(r, D1, 0, 'inclineDb')), []);
}

// 9. Prefill: same set from last session, then today's last set once last session runs out.
{
  let r = app.withSet([], D1, {weight: 35, reps: 8}, 'inclineDb');
  r = app.withSet(r, D1, {weight: 32.5, reps: 7}, 'inclineDb');
  assert.deepEqual(plain(app.nextSetGuess(r, D2)), {weight: 35, reps: 8});
  r = app.withSet(r, D2, {weight: 36, reps: 8}, 'inclineDb');
  assert.deepEqual(plain(app.nextSetGuess(r, D2)), {weight: 32.5, reps: 7});
  r = app.withSet(r, D2, {weight: 33, reps: 7}, 'inclineDb');
  assert.deepEqual(plain(app.nextSetGuess(r, D2)), {weight: 33, reps: 7});
  assert.equal(app.nextSetGuess([], D2), undefined);
}

// 10. Normalizing: sets survive a reload, invalid sets are dropped, old records still load.
{
  const raw = {version: 1, lifts: {
    'incline-db:inclineDb': [{date: D1, weight: 99, reps: 1, sets: [{weight: 35, reps: 8}, {weight: -5, reps: 8}, null]}],
    'flat-smith:flatSmith': [{date: D1, weight: 60, reps: null}]
  }};
  const lifts = plain(app.normalizeJournal(raw).lifts);
  assert.deepEqual(lifts['incline-db:inclineDb'], [{date: D1, weight: 35, reps: 8, sets: [{weight: 35, reps: 8}]}]);
  assert.deepEqual(lifts['flat-smith:flatSmith'], [{date: D1, weight: 60, reps: null}]);
}

// 11. Rest: 6-8 rep exercises rest 2 minutes, higher-rep ones 90 seconds.
assert.equal(app.restSeconds(app.rowsById.get('incline-db')), 120);
assert.equal(app.restSeconds(app.rowsById.get('lateral')), 90);

console.log('journal checks passed');
