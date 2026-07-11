// Server-level self-check:A8 崩溃点(坏 app.yaml → [null] trigger → 消费者对 null 取 .schedule
// 抛 TypeError → buildState 崩 → 无 try/catch → 整进程崩、launchd 崩溃循环)的锚。
// 只测纯编排函数;import server.js 因 main-module 守卫不起监听(否则 node --test 挂住不退)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAppSpecs, appPeriod, mostFreqTrigger } from './server.js';

// A8:app.yaml 的 triggers 写成含 null/非对象元素 → loadAppSpecs MUST 过滤掉,
// 且下游 appPeriod/mostFreqTrigger MUST NOT 抛。
test('A8:坏 triggers(null/非对象)被过滤,消费者不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-view-test-'));
  try {
    mkdirSync(join(dir, 'badapp'));
    writeFileSync(
      join(dir, 'badapp', 'app.yaml'),
      'id: badapp\ntriggers:\n  - null\n  - "just-a-string"\n  - 42\n  - schedule: "*/3 * * * *"\n',
    );
    const specs = loadAppSpecs(dir);
    assert.deepEqual(specs.badapp.triggers, [{ schedule: '*/3 * * * *' }], '仅保留对象元素,过滤 null/字符串/数字');
    // 消费者对过滤后的 triggers 不抛(A8 的两处崩点)。
    assert.doesNotThrow(() => appPeriod(specs.badapp));
    assert.doesNotThrow(() => mostFreqTrigger(specs));

    // 全坏 triggers → 空数组、周期 null,仍不抛。
    mkdirSync(join(dir, 'allbad'));
    writeFileSync(join(dir, 'allbad', 'app.yaml'), 'id: allbad\ntriggers: [null, null]\n');
    const specs2 = loadAppSpecs(dir);
    assert.deepEqual(specs2.allbad.triggers, []);
    assert.equal(appPeriod(specs2.allbad), null);
    assert.doesNotThrow(() => mostFreqTrigger(specs2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
