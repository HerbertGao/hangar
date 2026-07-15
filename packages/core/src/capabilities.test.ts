import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_CAPABILITIES,
  assertCapabilities,
  createRuntimeCapabilities,
} from './capabilities.js';

test('HOST_CAPABILITIES is the frozen canonical four-marker set', () => {
  assert.equal(Object.isFrozen(HOST_CAPABILITIES), true);
  assert.deepEqual(HOST_CAPABILITIES, [
    'hangar.run.trigger-kind/v1',
    'hangar.run.abort-signal/v1',
    'hangar.run.cancelled-terminal/v1',
    'hangar.run.runtime-capabilities/v1',
  ]);
});

test('createRuntimeCapabilities returns fresh frozen snapshots of the canonical set', () => {
  const first = createRuntimeCapabilities();
  const second = createRuntimeCapabilities();
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first, HOST_CAPABILITIES);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(second), true);
  assert.deepEqual(first, HOST_CAPABILITIES);
  assert.deepEqual(second, HOST_CAPABILITIES);
});

test('assertCapabilities: all present → passes', () => {
  assert.doesNotThrow(() =>
    assertCapabilities(['hangar.run.abort-signal/v1'], HOST_CAPABILITIES),
  );
});

test('assertCapabilities: missing member → throws (fail closed)', () => {
  assert.throws(() =>
    assertCapabilities(['hangar.run.never-offered/v1'], HOST_CAPABILITIES),
  );
});

test('assertCapabilities: unknown newer version does not satisfy required → throws', () => {
  assert.throws(() =>
    assertCapabilities(['hangar.run.abort-signal/v1'], ['hangar.run.abort-signal/v2']),
  );
});

test('assertCapabilities: no module-local-default overload — both params mandatory', () => {
  // `have` is a required formal (arity 2); omitting it is a compile error, not a runtime
  // one, so this guards the signature can't regress into a defaulted single-arg form.
  assert.equal(assertCapabilities.length, 2);
});
