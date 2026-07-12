// Server-level self-check:A8 崩溃点(坏 app.yaml → [null] trigger → 消费者对 null 取 .schedule
// 抛 TypeError → buildState 崩 → 无 try/catch → 整进程崩、launchd 崩溃循环)的锚。
// 只测纯编排函数;import server.js 因 main-module 守卫不起监听(否则 node --test 挂住不退)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { loadAppSpecs, appPeriod, mostFreqTrigger, commandSpec, classifyRunExit, pickEventPayload, projectPayload, readJsonBody } from './server.js';
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

// 5.5 coercion 一致性:`enabled: no`(YAML 字符串,非布尔)必须也让 beacon 跳过它。否则 core/daemon/
// office 都按 `no` 禁用了它,唯独 view 的 beacon 用生 yaml 值(`'no' === false` 为 false)不跳 →
// 复现 F1 假「疑似停摆」。loadAppSpecs MUST 与 core registry 同法 coerce。
test('5.5:enabled: no(coerce)的最频繁 cron app 也被 beacon 跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-view-beacon-no-'));
  try {
    mkdirSync(join(dir, 'fastno'));
    writeFileSync(join(dir, 'fastno', 'app.yaml'), 'id: fastno\nenabled: no\ntriggers:\n  - schedule: "* * * * *"\n');
    mkdirSync(join(dir, 'slowon'));
    writeFileSync(join(dir, 'slowon', 'app.yaml'), 'id: slowon\ntriggers:\n  - name: poll\n    schedule: "*/5 * * * *"\n');
    const specs = loadAppSpecs(dir);
    assert.equal(specs.fastno.enabled, false, 'enabled: no coerces to false in loadAppSpecs (beacon path)');
    const mf = mostFreqTrigger(specs);
    assert.equal(mf.appId, 'slowon', 'enabled: no 的最频繁 cron app 不被选为 beacon(coerce 生效)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 7.1 命令写路径:白名单 gate —— 只 (inbox, interpret-feedback)/(inbox, apply-feedback) 放行,
// 白名单外(别的 app / 未知 trigger)MUST 返回 null(调用方据此 403、不发起 run)。
test('7.1:白名单 gate —— 白名单内放行、白名单外被拒', () => {
  assert.deepEqual(commandSpec('inbox', 'interpret-feedback'), {
    eventKind: 'interpretation.proposed',
    field: 'interpretation',
    fields: ['add'],
  });
  assert.deepEqual(commandSpec('inbox', 'apply-feedback'), {
    eventKind: 'feedback.applied',
    field: 'applied',
    fields: ['added', 'already_present'],
  });
  assert.equal(commandSpec('inbox', 'digest'), null, '白名单外 trigger 被拒');
  assert.equal(commandSpec('inbox', 'poll'), null, '白名单外 trigger 被拒');
  assert.equal(commandSpec('mailbox', 'interpret-feedback'), null, '白名单外 pilot 被拒(不做任意 app firehose)');
  assert.equal(commandSpec('inbox', ''), null, '空 trigger 被拒');
  assert.equal(commandSpec('__proto__', 'x'), null, '原型链 key 不被误当白名单');
  // 原型链绕过回归:继承方法名(toString/constructor)MUST NOT 被误当白名单
  assert.equal(commandSpec('inbox', 'toString'), null, '继承方法名不被误当 trigger');
  assert.equal(commandSpec('inbox', 'constructor'), null, '继承方法名不被误当 trigger');
  assert.equal(commandSpec('constructor', 'apply'), null, '继承方法名不被误当 pilot');
});

// 7.1 退出码映射:already_running→busy、run.failed→失败、成功→取 runId(供后续读 trace)。
test('7.1:classifyRunExit —— busy / 失败 / 成功 三路映射', () => {
  // already_running(退 1,CLI 错误 emit)→ busy(前端「稍后重发」)
  assert.deepEqual(
    classifyRunExit({ exit: 1, out: '{"ok":false,"kind":"already_running"}' }),
    { outcome: 'busy' },
  );
  // run.failed(退 1,{run,state:'failed'} 无 kind;含未知 trigger / apply 失败)→ 失败,不伪装成功
  assert.deepEqual(
    classifyRunExit({ exit: 1, out: '{"run":"r1","state":"failed"}' }),
    { outcome: 'failed', kind: 'run_failed' },
  );
  // 其它 CLI 错误 kind(app_not_found/usage…)透传
  assert.deepEqual(
    classifyRunExit({ exit: 1, out: '{"ok":false,"kind":"app_not_found"}' }),
    { outcome: 'failed', kind: 'app_not_found' },
  );
  // 超时 → 失败
  assert.deepEqual(classifyRunExit({ timeout: true }), { outcome: 'failed', kind: 'timeout' });
  // 成功(退 0,completed)→ ok + runId
  assert.deepEqual(
    classifyRunExit({ exit: 0, out: '{"run":"r2","state":"completed"}' }),
    { outcome: 'ok', runId: 'r2' },
  );
  // 防御:退 0 却 state:failed / 不可解析 → 失败(不当成功)
  assert.deepEqual(
    classifyRunExit({ exit: 0, out: '{"run":"r3","state":"failed"}' }),
    { outcome: 'failed', kind: 'run_failed' },
  );
  assert.deepEqual(classifyRunExit({ exit: 0, out: 'not json' }), { outcome: 'failed', kind: 'unparseable' });
  // parked(退 0,waiting_human):白名单 trigger 不该 park → 响亮失败,不当 ok
  assert.deepEqual(
    classifyRunExit({ exit: 0, out: '{"run":"r","state":"waiting_human"}' }),
    { outcome: 'failed', kind: 'unexpected_state' },
  );
});

// 7.1 成功后从 trace 取白名单事件 payload(受控放宽仅此路径);找不到该 kind → undefined(契约漂移)。
test('7.1:pickEventPayload —— 成功取事件 payload,缺事件→undefined', () => {
  const interpretTrace = {
    events: [
      { seq: 1, kind: 'run.started', payload: {} },
      { seq: 2, kind: 'interpretation.proposed', payload: { add: ['ci@github.com'] } },
    ],
  };
  assert.deepEqual(pickEventPayload(interpretTrace, 'interpretation.proposed'), { add: ['ci@github.com'] });

  const applyTrace = {
    events: [{ seq: 2, kind: 'feedback.applied', payload: { added: ['x@y.com'], already_present: [] } }],
  };
  assert.deepEqual(pickEventPayload(applyTrace, 'feedback.applied'), { added: ['x@y.com'], already_present: [] });

  assert.equal(pickEventPayload({ events: [] }, 'interpretation.proposed'), undefined, '缺事件→undefined');
  assert.equal(pickEventPayload({}, 'feedback.applied'), undefined, '无 events 字段→undefined,不抛');
});

// 7.1 事件 payload 白名单投影:只取 spec.fields、且每个校验为 string[];非数组/缺字段 → null(契约不符)。
test('7.1:projectPayload —— 只投影声明字段并校验 string[]', () => {
  assert.deepEqual(projectPayload({ add: ['a@b'] }, ['add']), { add: ['a@b'] });
  assert.equal(projectPayload({ add: 'x' }, ['add']), null, '非数组 → null');
  assert.deepEqual(projectPayload({ add: ['x'], leak: 's', reasoning: 'y' }, ['add']), { add: ['x'] }, '多余字段被丢(MUST NOT 透传整 payload)');
  assert.equal(projectPayload({ add: [1] }, ['add']), null, '非 string 元素 → null(契约不符)');
  assert.deepEqual(
    projectPayload({ added: ['a'], already_present: [] }, ['added', 'already_present']),
    { added: ['a'], already_present: [] },
  );
  assert.equal(projectPayload({ added: ['a'] }, ['added', 'already_present']), null, '缺字段 → null');
});

// 7.1 body 超限:MUST 立即 reject(不 hang)、且不在 readJsonBody 内 destroy——413 由 handleCommand
// 先发响应、再 destroy(fake EventEmitter 无 destroy 也不会被调)。
test('7.1:readJsonBody 超限立即 reject、不 destroy', async () => {
  const req = new EventEmitter();
  const p = readJsonBody(req);
  req.emit('data', 'x'.repeat(64 * 1024 + 1));
  await assert.rejects(p, /body_too_large/);
});
