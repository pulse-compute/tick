import assert from 'node:assert/strict';
import test from 'node:test';
import { createBindings, createCoordinationBinding } from '../../dist/bindings.js';
import { createJobCoordinator } from '../../dist/core.js';
import { createRunner } from '../../dist/runner.js';
import { createFastlyTrigger } from '../../dist/adapters/fastly-trigger.js';
import { createFastlyKvStore } from '../../dist/adapters/fastly-kv.js';
import { createCooperativeController } from '../../dist/cancellation.js';
import { fixture } from '../../proof/trigger/reference.mjs';

function options(f) {
  return { coordination: { name: 'state', prefix: 'jobs/' }, stores: { state: { kind: 'provided', store: f.store } },
    clock: f.clock, ids: f.definition.bindings.ids, resources: { observations: { save: async () => {} } } };
}
function coordinator(f, bindings) {
  return createJobCoordinator({ namespace: f.definition.namespace, job: f.definition.jobs[0], limits: f.definition.limits,
    coordination: bindings.coordination, clock: bindings.clock, ids: bindings.ids });
}

test('logical mappings capture a provided store without I/O and preserve resource identity', () => {
  const f = fixture(), input = options(f); let guards = 0;
  const bound = createBindings({ ...input, validateResources: (value) => { guards++; return typeof value.observations.save === 'function'; } });
  assert.equal(guards, 1); assert.equal(f.calls.length, 0);
  assert.equal(bound.resources, input.resources); assert.equal(Object.isFrozen(bound), true);
  assert.equal(Object.isFrozen(bound.coordination.store.capabilities), true);
  assert.equal(Object.isFrozen(input.resources), false);
  assert.equal(coordinator(f, bound).key, 'jobs/["tick.job.v1","tick05-reference","job-0"]');
});

test('jobs and admission can map the same physical dependency with distinct literal prefixes', async () => {
  const f = fixture(), input = options(f);
  const jobs = createBindings(input);
  const admission = createCoordinationBinding({ name: 'state', prefix: 'admission/' }, input.stores);
  const receive = createFastlyTrigger({ ...f.options, definition: { ...f.definition, bindings: jobs },
    admission: { ...f.admission, coordination: admission } });
  const response = await receive(f.request());
  assert.equal(response.status, 200); assert.equal((await response.json()).metrics.executions, 4);
  assert.ok(f.calls.some((call) => call.key.startsWith('admission/')));
  assert.ok(f.calls.some((call) => call.key.startsWith('jobs/')));
  assert.equal(f.calls.some((call) => call.key.startsWith('jobs/jobs/')), false);
});

test('HTTP mapping is explicit, lazy about credentials, and never adds the core prefix twice', async () => {
  const f = fixture(); let credentials = 0, calls = 0;
  const mapped = createCoordinationBinding({ name: 'state', prefix: 'logical/jobs/' }, { state: { kind: 'fastly-kv-http', options: {
    storeId: 'test-store', token: async () => { credentials++; return 'credential'; }, fetch: async (url) => {
      calls++; assert.equal(decodeURIComponent(new URL(url).pathname.split('/keys/')[1]), 'logical/jobs/["tick.job.v1","tick05-reference","job-0"]');
      return new Response(null, { status: 404 });
    },
  } } });
  assert.equal(credentials, 0); assert.equal(calls, 0);
  await mapped.store.read(coordinator(f, { ...createBindings(options(f)), coordination: mapped }).key);
  assert.equal(credentials, 1); assert.equal(calls, 1);
});

test('unknown, inherited, weak and unsupported-native mappings fail without trying alternatives', () => {
  const f = fixture(), ref = { name: 'state', prefix: 'test/' };
  for (const stores of [{ other: { kind: 'provided', store: f.store } }, Object.create({ state: { kind: 'provided', store: f.store } }),
    { state: { kind: 'fastly-kv-native', store: f.store } }, { state: { kind: 'provided', store: { get() {}, put() {} } } },
    { state: { kind: 'provided', store: { ...f.store, capabilities: { ...f.store.capabilities, scope: 'pop-local' } } } }]) {
    assert.throws(() => createCoordinationBinding(ref, stores), { name: 'TypeError', message: 'Invalid Tick coordination mapping' });
  }
  for (const reference of [{ name: 1, prefix: '' }, { name: '', prefix: '' }, { name: 'state', prefix: '../bad/' }, { name: 'state', prefix: 'x'.repeat(129) }]) {
    assert.throws(() => createCoordinationBinding(reference, options(f).stores), TypeError);
  }
  assert.equal(f.calls.length, 0);
});

test('resource validation fails closed and keeps validator-time mutation from replacing captured bindings', () => {
  const f = fixture();
  for (const validateResources of [() => false, () => { throw new Error('private-resource-details'); }, 'not-callable']) {
    assert.throws(() => createBindings({ ...options(f), validateResources }), { name: 'TypeError', message: 'Invalid Tick application bindings' });
  }
  const input = options(f), original = input.resources;
  input.validateResources = () => { input.resources = { unsafe: true }; input.clock = {}; return true; };
  const bound = createBindings(input);
  assert.equal(bound.resources, original); assert.equal(bound.clock.nowMs(), 1000);
  const { resources, ...missing } = options(f);
  assert.throws(() => createBindings(missing), TypeError);
  assert.equal(f.calls.length, 0);
});

test('core, runner and trigger share binding declaration checks before provider I/O', () => {
  for (const failure of ['read', 'cas', 'clock', 'ids', 'name']) {
    const f = fixture(), definition = { ...f.definition, bindings: { ...f.definition.bindings } };
    if (failure === 'clock') definition.bindings.clock = { nowMs: () => 1000 };
    else if (failure === 'ids') definition.bindings.ids = { newMutationId: () => 'id' };
    else definition.bindings.coordination = { ...definition.bindings.coordination,
      ...(failure === 'name' ? { name: { private: 'payload' } } : { store: { ...f.store, [failure === 'read' ? 'read' : 'compareAndSwap']: 1 } }) };
    assert.throws(() => createJobCoordinator({ namespace: definition.namespace, job: definition.jobs[0], limits: definition.limits,
      coordination: definition.bindings.coordination, clock: definition.bindings.clock, ids: definition.bindings.ids }), TypeError);
    assert.throws(() => createRunner(definition, f.runtime), TypeError);
    assert.throws(() => createFastlyTrigger({ ...f.options, definition }), TypeError);
    assert.equal(f.calls.length, 0);
  }
});

test('binding getter exceptions and malformed telemetry are sanitized during construction', () => {
  const f = fixture(), store = { ...f.store, get capabilities() { throw new Error('private-credential'); } };
  assert.throws(() => createBindings({ ...options(f), stores: { state: { kind: 'provided', store } } }),
    { name: 'TypeError', message: 'Invalid Tick application bindings' });
  assert.throws(() => createRunner({ ...f.definition, bindings: { ...f.definition.bindings, telemetry: { emit: 1 } } }, f.runtime),
    { name: 'TypeError', message: 'Invalid Tick telemetry binding' });
  assert.equal(f.calls.length, 0);
});

test('captured methods retain this and ignore later configuration mutation', async () => {
  const f = fixture(), calls = [];
  const store = { ...f.store, marker: 'correct', async read(key) { calls.push(this.marker); return f.store.read(key); } };
  const input = options(f); input.stores.state.store = store;
  const bound = createBindings(input);
  store.read = () => assert.fail('mutated read'); store.capabilities.atomicCreate = false;
  input.clock.nowMs = () => assert.fail('mutated clock'); input.ids.newMutationId = () => assert.fail('mutated IDs');
  const result = await coordinator(f, bound).claim({ requestId: 'test', deadlineMs: 6000, signal: createCooperativeController().signal });
  assert.equal(result.status, 'owned'); assert.deepEqual(calls, ['correct']);
});

test('direct runner captures store methods before I/O', async () => {
  const f = fixture(), runner = createRunner(f.definition, f.runtime);
  f.store.read = () => assert.fail('mutated store'); f.store.compareAndSwap = () => assert.fail('mutated CAS');
  const result = await runner.tick({ requestId: 'captured', deadlineMs: 6000, signal: createCooperativeController().signal });
  assert.equal(result.status, 'finished'); assert.equal(result.results[0].outcome, 'completed');
});

test('invalid native signals reject before admission/job I/O instead of claiming transport cancellation', async () => {
  for (const controller of [{ signal: createCooperativeController().signal, nativeSignal: new AbortController().signal, abort() {} },
    (() => { const c = createCooperativeController(); return { ...c, nativeSignal: c.signal }; })(),
    { signal: { aborted: undefined, addEventListener() {}, removeEventListener() {} }, abort() {} }]) {
    const f = fixture(), runtime = { ...f.runtime, createCancellationController: () => controller };
    await assert.rejects(createRunner(f.definition, runtime).tick({ requestId: 'invalid', deadlineMs: 6000, signal: createCooperativeController().signal }), TypeError);
    assert.equal((await createFastlyTrigger({ ...f.options, runtime })(f.request())).status, 503);
    assert.equal(f.calls.length, 0);
  }
});

test('reusing an active controller is rejected across invocations before new storage work', async () => {
  const f = fixture(), controller = createCooperativeController();
  const runtime = { ...f.runtime, createCancellationController: () => ({ signal: controller.signal, abort() {} }) };
  const runner = createRunner({ ...f.definition, jobs: [] }, runtime);
  const invocation = { requestId: 'empty', deadlineMs: 6000, signal: createCooperativeController().signal };
  assert.equal((await runner.tick(invocation)).status, 'finished');
  await assert.rejects(runner.tick(invocation), /fresh signals/);
  assert.equal(f.calls.length, 0);
});

test('Fastly HTTP captures token, transport and native signal before token awaits', async () => {
  const controller = new AbortController(); let release, received;
  const credential = new Promise((yes) => { release = yes; });
  const input = { storeId: 'original', token: () => credential, signal: controller.signal, fetch: async (url, init) => {
    received = { url, signal: init.signal }; return new Response(null, { status: 404 });
  } };
  const store = createFastlyKvStore(input), reading = store.read('key');
  input.token = () => assert.fail('mutated token'); input.fetch = () => assert.fail('mutated fetch');
  input.storeId = 'changed'; input.signal = new AbortController().signal;
  release('credential'); assert.equal((await reading).status, 'absent');
  assert.equal(received.url, 'https://api.fastly.com/resources/stores/kv/original/keys/key');
  assert.equal(received.signal, controller.signal);
  assert.throws(() => createFastlyKvStore({ ...input, signal: createCooperativeController().signal }), TypeError);
  assert.throws(() => createFastlyKvStore({ ...input, storeId: { toString: () => 'store' } }), TypeError);
});
