// Server-level self-check:A8 崩溃点(坏 app.yaml → [null] trigger → 消费者对 null 取 .schedule
// 抛 TypeError → buildState 崩 → 无 try/catch → 整进程崩、launchd 崩溃循环)的锚。
// 只测纯编排函数;import server.js 因 main-module 守卫不起监听(否则 node --test 挂住不退)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAppSpecs, appPeriod, mostFreqTrigger } from './server.js';
import { deriveLiveness } from './derive.js';

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

// 5.5 beacon 层:loadAppSpecs 读出 enabled → mostFreqTrigger 跳过 disabled → 禁用最频繁 cron 的 app 时
// beacon 落下一个 enabled app,顶层 liveness MUST NOT 因禁用 app 的陈旧 endedAt 报「疑似停摆」。
test('5.5:禁用最频繁 cron 的 app,beacon 落 enabled app、不误报停摆', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-view-beacon-'));
  try {
    // fastdisabled:enabled:false 且是全场最频繁 cron(每 1 分)——若不跳过会被选为 beacon。
    mkdirSync(join(dir, 'fastdisabled'));
    writeFileSync(join(dir, 'fastdisabled', 'app.yaml'), 'id: fastdisabled\nenabled: false\ntriggers:\n  - schedule: "* * * * *"\n');
    // slowenabled:enabled 省略(视作 true),较慢 cron(每 5 分)。
    mkdirSync(join(dir, 'slowenabled'));
    writeFileSync(join(dir, 'slowenabled', 'app.yaml'), 'id: slowenabled\ntriggers:\n  - name: poll\n    schedule: "*/5 * * * *"\n');

    const specs = loadAppSpecs(dir);
    assert.equal(specs.fastdisabled.enabled, false, 'loadAppSpecs 读出 enabled:false');
    assert.equal(specs.slowenabled.enabled, undefined, 'enabled 省略 → undefined(视作 true)');

    // mostFreqTrigger 跳过 disabled → 落 slowenabled(而非最频繁的 fastdisabled)。
    const mf = mostFreqTrigger(specs);
    assert.equal(mf.appId, 'slowenabled', 'beacon 落下一 enabled app,不选禁用的最频繁 cron');
    assert.equal(mf.name, 'poll');

    // 顶层 liveness 从 beacon(slowenabled)自己的 runs 派生:fastdisabled 的陈旧 endedAt 无从毒化。
    const now = Date.parse('2026-07-10T12:00:00.000Z');
    const beaconRuns = { ok: true, runs: [{ id: 's1', app: 'slowenabled', state: 'running', trigger: 'poll', startedAt: new Date(now - 60_000).toISOString(), endedAt: null }] };
    const liveness = deriveLiveness({ appRuns: beaconRuns, triggerName: mf.name, periodMs: mf.period, now });
    assert.notEqual(liveness.live, 'suspected_awol', 'MUST NOT 因禁用 app 的陈旧 endedAt 报「疑似停摆」');
    assert.equal(liveness.live, 'alive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 5.5 边角:唯一剩下的 enabled app 无 cron(全 enabled app 无 run/无 cron)→ beacon 落 unknown、不报停摆。
test('5.5:全 enabled app 无 cron → beacon unknown,不报停摆', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-view-beacon2-'));
  try {
    mkdirSync(join(dir, 'fastdisabled'));
    writeFileSync(join(dir, 'fastdisabled', 'app.yaml'), 'id: fastdisabled\nenabled: false\ntriggers:\n  - schedule: "* * * * *"\n');
    mkdirSync(join(dir, 'nocron'));
    writeFileSync(join(dir, 'nocron', 'app.yaml'), 'id: nocron\ntriggers: []\n');
    const specs = loadAppSpecs(dir);
    const mf = mostFreqTrigger(specs);
    assert.equal(mf.appId, null, '禁用最频繁 cron 跳过后无 enabled cron app → beacon 无属主');
    assert.equal(mf.period, null);
    const liveness = deriveLiveness({ appRuns: undefined, triggerName: mf.name, periodMs: mf.period, now: Date.now() });
    assert.equal(liveness.live, 'unknown', '全 enabled app 无 cron → unknown、MUST NOT 报停摆');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
