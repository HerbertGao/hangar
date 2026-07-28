// Server-level self-check:A8 崩溃点(坏 app.yaml → [null] trigger → 消费者对 null 取 .schedule
// 抛 TypeError → buildState 崩 → 无 try/catch → 整进程崩、launchd 崩溃循环)的锚。
// 只测纯编排函数;import server.js 因 main-module 守卫不起监听(否则 node --test 挂住不退)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { loadAppSpecs, appPeriod, mostFreqTrigger, commandSpec, classifyRunExit, pickEventPayload, projectPayload, receiptMismatch, inputShapeError, handleCommand, readJsonBody } from './server.js';
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
    fields: ['add', 'remove'],
    inputKeys: ['add', 'remove'],
  });
  assert.deepEqual(commandSpec('inbox', 'apply-feedback'), {
    eventKind: 'feedback.applied',
    field: 'applied',
    fields: ['added', 'already_present', 'removed', 'not_present'],
    inputKeys: ['add', 'remove'],
    partition: [
      ['add', ['added', 'already_present']],
      ['remove', ['removed', 'not_present']],
    ],
  });
  // 形状门必须覆盖两条 trigger:干跑腿也声明 inputKeys。曾经用 partition 兼当开关,于是干跑腿静默无门。
  for (const t of ['interpret-feedback', 'apply-feedback']) {
    assert.deepEqual(commandSpec('inbox', t).inputKeys, ['add', 'remove'], `${t} 必须声明 inputKeys`);
  }
  // partition 的桶名必须都在 fields 里,否则 proj[桶] 恒 undefined → 每条命令永久 receipt_mismatch。
  const aSpec = commandSpec('inbox', 'apply-feedback');
  for (const [, buckets] of aSpec.partition) {
    for (const b of buckets) assert.ok(aSpec.fields.includes(b), `partition 桶 ${b} 必须在 fields 里`);
  }
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
test('7.1:pickEventPayload —— 恰好一个才给 payload;0 与 ≥2 分开报数', () => {
  const interpretTrace = {
    events: [
      { seq: 1, kind: 'run.started', payload: {} },
      { seq: 2, kind: 'interpretation.proposed', payload: { add: ['ci@github.com'], remove: [] } },
    ],
  };
  assert.deepEqual(pickEventPayload(interpretTrace, 'interpretation.proposed'), {
    payload: { add: ['ci@github.com'], remove: [] },
  });

  const applyTrace = {
    events: [
      {
        seq: 2,
        kind: 'feedback.applied',
        payload: { added: ['x@y.com'], already_present: [], removed: [], not_present: [] },
      },
    ],
  };
  assert.deepEqual(pickEventPayload(applyTrace, 'feedback.applied'), {
    payload: { added: ['x@y.com'], already_present: [], removed: [], not_present: [] },
  });

  // 0 与 ≥2 是相反的诊断,故分开报数(调用方映射成 missing_event / duplicate_event)
  assert.deepEqual(pickEventPayload({ events: [] }, 'interpretation.proposed'), { count: 0 }, '缺事件→count 0');
  assert.deepEqual(pickEventPayload({}, 'feedback.applied'), { count: 0 }, '无 events 字段→count 0,不抛');
  // 契约:每 run 恰好 emit 一次、一次带全字段。分两次 emit(add 一个、remove 一个)取第一个 =
  // 确认页只显示一半却判成功。故 ≥2 个同 kind 事件 MUST 也不给 payload(回 {count}),不静默挑一个。
  const splitTrace = {
    events: [
      { seq: 1, kind: 'interpretation.proposed', payload: { add: ['a@x'], remove: [] } },
      { seq: 2, kind: 'interpretation.proposed', payload: { add: [], remove: ['b@y'] } },
    ],
  };
  assert.deepEqual(pickEventPayload(splitTrace, 'interpretation.proposed'), { count: 2 }, '2 个同 kind 事件→count 2,不取第一个');
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
  // add/remove 契约。字段字面量由 :114-123 的断言钉住(那里才是锁跨仓契约的地方);本块从 commandSpec()
  // 取真实 fields,钉的是「投影语义与白名单同源」——两块合起来才既防写错契约、又防两处漂移。
  // 只 emit 旧字段的 pilot(未上线 remove)MUST 落 contract_mismatch,不静默成功 —— 这条锁「inbox 先、view 后」的部署序。
  const iFields = commandSpec('inbox', 'interpret-feedback').fields;
  const aFields = commandSpec('inbox', 'apply-feedback').fields;
  assert.deepEqual(projectPayload({ add: ['a@b'], remove: [] }, iFields), { add: ['a@b'], remove: [] });
  assert.equal(projectPayload({ add: ['a@b'] }, iFields), null, '旧 pilot 只 emit add 一字段 → null');
  assert.equal(projectPayload({ add: [], remove: [1] }, iFields), null, 'remove 非 string[] → null');
  assert.deepEqual(
    projectPayload({ added: [], already_present: [], removed: ['a@b'], not_present: [] }, aFields),
    { added: [], already_present: [], removed: ['a@b'], not_present: [] },
  );
  assert.equal(
    projectPayload({ added: ['a'], already_present: [] }, aFields),
    null,
    '旧 pilot 只 emit added/already_present 两字段(缺 removed/not_present)→ null',
  );
});

// 7.1 回执配分:形状合法但与请求不符的回执 MUST NOT 当成功(静默说谎的主要形态)。
test('7.1:receiptMismatch —— 回执必须与本次请求配分', () => {
  const part = commandSpec('inbox', 'apply-feedback').partition;
  const ok = { added: ['a@x'], already_present: [], removed: ['b@y'], not_present: [] };
  assert.equal(receiptMismatch({ add: ['a@x'], remove: ['b@y'] }, ok, part), null, '配分一致 → 通过');
  // 四桶全空:形状全合法、projectPayload 放行,但 pilot 什么都没报 → 前端会显示「无变更」
  assert.equal(
    receiptMismatch({ add: ['a@x'], remove: [] }, { added: [], already_present: [], removed: [], not_present: [] }, part),
    'add',
  );
  // 旧 pilot 忽略 remove 半边(只处理 add)
  assert.equal(
    receiptMismatch({ add: ['a@x'], remove: ['b@y'] }, { added: ['a@x'], already_present: [], removed: [], not_present: [] }, part),
    'remove',
  );
  // 报了请求里没有的地址。**基数必须相等**:若回执比请求多一个,长度检查会先拒,membership 那半
  // 就永远不是任何测试失败的唯一原因 —— 删掉它套件仍全绿。这里 1 换 1,只有 membership 能抓。
  assert.equal(
    receiptMismatch({ add: ['a@x'], remove: [] }, { added: ['z@z'], already_present: [], removed: [], not_present: [] }, part),
    'add',
  );
  // 基数不等的那种也留一条(长度检查负责)
  assert.equal(
    receiptMismatch({ add: ['a@x'], remove: [] }, { added: ['a@x'], already_present: ['z@z'], removed: [], not_present: [] }, part),
    'add',
  );
  // 桶内重复:a 被报了两次、b 一次没报 —— 长度检查过不了这条,只有查重能抓
  assert.equal(
    receiptMismatch({ add: ['a@x', 'b@y'], remove: [] }, { added: ['a@x', 'a@x'], already_present: [], removed: [], not_present: [] }, part),
    'add',
  );
  // 同一 partition 行内两桶重复
  assert.equal(
    receiptMismatch({ add: ['a@x'], remove: [] }, { added: ['a@x'], already_present: ['a@x'], removed: [], not_present: [] }, part),
    'add',
  );
  // **跨桶重叠**:{add:[X],remove:[X]} 的回执逐行都合规,只有全局唯一能抓。放行的后果是前端打印
  // 「已加入 X · 已移出 X」而文件里只有一种结果。契约已要求 pilot 对该输入 throw,这里是纵深。
  assert.equal(
    receiptMismatch(
      { add: ['a@x'], remove: ['a@x'] },
      { added: ['a@x'], already_present: [], removed: ['a@x'], not_present: [] },
      part,
    ),
    'remove',
  );
  // 缺 input key 视作空集(旧 view 只发 add / 手工 POST)
  assert.equal(
    receiptMismatch({ add: ['a@x'] }, { added: ['a@x'], already_present: [], removed: [], not_present: [] }, part),
    null,
  );
  // interpret-feedback 无 partition 声明 → 不校验(input 是 NL 文本,无可配分对象)
  assert.equal(receiptMismatch({ text: 'x' }, { add: [], remove: [] }, commandSpec('inbox', 'interpret-feedback').partition), null);
});

// 7.1 input 形状:缺 key 合法(部署窗口的旧 view 只发 add),key 存在就必须是 string[]。
test('7.1:inputShapeError —— 缺 key 合法、畸形 key 响亮、两条腿同等', () => {
  const keys = commandSpec('inbox', 'apply-feedback').inputKeys;
  assert.equal(inputShapeError({ add: ['a@x'], remove: [] }, keys), null);
  assert.equal(inputShapeError({ add: ['a@x'] }, keys), null, '缺 remove key → 合法(视作空集)');
  assert.equal(inputShapeError({}, keys), null, '两个 key 都缺 → 合法');
  assert.equal(inputShapeError({ add: 'x' }, keys), 'add', 'key 存在但非数组 → 畸形');
  assert.equal(inputShapeError({ add: [1] }, keys), 'add', '元素非 string → 畸形');
  assert.equal(inputShapeError({ add: [], remove: null }, keys), 'remove', 'null 不当空集');
  // 干跑腿同等受门。此前这里断言的是「无 partition → 不校验」,把缺口写成了预期——现在反过来。
  const iKeys = commandSpec('inbox', 'interpret-feedback').inputKeys;
  assert.equal(inputShapeError({ text: 'x' }, iKeys), null, '纯 {text} → 无 add/remove key → 合法');
  assert.equal(inputShapeError({ add: 'x' }, iKeys), 'add', '干跑腿的结构化 input 也必须被校验');
  // 原型链纪律:继承来的 add 不算 own key(与 commandSpec 的 Object.hasOwn 一致)
  assert.equal(inputShapeError(Object.create({ add: 'x' }), iKeys), null, '继承属性不冒充 own key');
});

// 7.1 端到端(桩 CLI):证明三处 gate 真的接在链上、且顺序对。
// 没有这一条,删掉 handleCommand 里的 receipt_mismatch 那行、或把 input 形状 gate 挪到 run 之后,
// 测试仍全绿(实测过)。这里桩掉两个 subprocess 调用,其余走真实代码路径。
test('7.1:handleCommand 端到端 —— receipt_mismatch 真会发出、gate 顺序正确', async () => {
  const fakeReq = (body) => {
    const r = new EventEmitter();
    r.method = 'POST';
    r.headers = { 'content-type': 'application/json' };
    setImmediate(() => { r.emit('data', JSON.stringify(body)); r.emit('end'); });
    return r;
  };
  const fakeRes = () => {
    const out = {};
    return { out, writeHead(c) { out.code = c; }, end(s) { out.body = JSON.parse(s); } };
  };
  // 桩:run 恒成功,trace 回给定 payload;记录 run 被调用几次(用于断言 gate 在 run 之前)
  const stub = (payload) => {
    const calls = { run: 0 };
    return {
      calls,
      run: async () => { calls.run += 1; return { exit: 0, out: '{"run":"r1","state":"completed"}' }; },
      json: () => ({ ok: true, data: { events: [{ seq: 1, kind: 'feedback.applied', payload }] } }),
    };
  };

  // ① 配分不符(pilot 忽略了 remove 半边)→ receipt_mismatch,HTTP 200,不是 ok:true
  let res = fakeRes();
  let cli = stub({ added: ['a@x'], already_present: [], removed: [], not_present: [] });
  await handleCommand(fakeReq({ pilot: 'inbox', trigger: 'apply-feedback', input: { add: ['a@x'], remove: ['b@y'] } }), res, cli);
  assert.deepEqual(res.out, { code: 200, body: { ok: false, kind: 'receipt_mismatch' } });

  // ② 顺序:payload 缺字段时必须先落 contract_mismatch(不是 receipt_mismatch)
  res = fakeRes();
  cli = stub({ added: ['a@x'], already_present: [] });
  await handleCommand(fakeReq({ pilot: 'inbox', trigger: 'apply-feedback', input: { add: ['a@x'], remove: [] } }), res, cli);
  assert.deepEqual(res.out, { code: 200, body: { ok: false, kind: 'contract_mismatch' } });

  // ③ 配分一致 → ok:true,payload 只含声明字段
  res = fakeRes();
  cli = stub({ added: ['a@x'], already_present: [], removed: [], not_present: [] });
  await handleCommand(fakeReq({ pilot: 'inbox', trigger: 'apply-feedback', input: { add: ['a@x'] } }), res, cli);
  assert.deepEqual(res.out, {
    code: 200,
    body: { ok: true, applied: { added: ['a@x'], already_present: [], removed: [], not_present: [] } },
  });

  // ④ input 畸形 → 400 usage,且 **run 一次都没发起**(gate 必须在 run 之前,否则畸形输入已经写过了)
  res = fakeRes();
  cli = stub({ added: [], already_present: [], removed: [], not_present: [] });
  await handleCommand(fakeReq({ pilot: 'inbox', trigger: 'apply-feedback', input: { add: 'x' } }), res, cli);
  assert.deepEqual(res.out, { code: 400, body: { ok: false, kind: 'usage' } });
  assert.equal(cli.calls.run, 0, '畸形 input MUST NOT 发起 run');

  // ④b 干跑腿的畸形 input 同样在 run 之前被拦。此前形状门挂在 partition 上(只有写腿有),实测
  //     `interpret-feedback` + `{add:"x"}` 会起一个 run 并返回 200 ok:true —— 结构化入口正是 Pi 要用的那个。
  res = fakeRes();
  cli = stub({ added: [], already_present: [], removed: [], not_present: [] });
  await handleCommand(fakeReq({ pilot: 'inbox', trigger: 'interpret-feedback', input: { add: 'x' } }), res, cli);
  assert.deepEqual(res.out, { code: 400, body: { ok: false, kind: 'usage' } });
  assert.equal(cli.calls.run, 0, '干跑腿的畸形 input 也 MUST NOT 发起 run');

  // ④c 纯 {text} 不受形状门影响(既有 NL→add 路径必须零回退)
  res = fakeRes();
  cli = {
    calls: { run: 0 },
    run: async function () { this.calls.run += 1; return { exit: 0, out: '{"run":"r1","state":"completed"}' }; },
    json: () => ({ ok: true, data: { events: [{ seq: 1, kind: 'interpretation.proposed', payload: { add: ['a@x'], remove: [] } }] } }),
  };
  await handleCommand(fakeReq({ pilot: 'inbox', trigger: 'interpret-feedback', input: { text: '把 a@x 降噪' } }), res, cli);
  assert.deepEqual(res.out, { code: 200, body: { ok: true, interpretation: { add: ['a@x'], remove: [] } } });
  assert.equal(cli.calls.run, 1, '{text} 路径照常发起 run');

  // ⑤ 同 kind 事件出现两次 → duplicate_event(不静默取第一个;0 个才是 missing_event,见 ⑥)
  res = fakeRes();
  cli = {
    run: async () => ({ exit: 0, out: '{"run":"r1","state":"completed"}' }),
    json: () => ({ ok: true, data: { events: [
      { seq: 1, kind: 'feedback.applied', payload: { added: ['a@x'], already_present: [], removed: [], not_present: [] } },
      { seq: 2, kind: 'feedback.applied', payload: { added: [], already_present: [], removed: [], not_present: [] } },
    ] } }),
  };
  await handleCommand(fakeReq({ pilot: 'inbox', trigger: 'apply-feedback', input: { add: ['a@x'] } }), res, cli);
  assert.deepEqual(res.out, { code: 200, body: { ok: false, kind: 'duplicate_event' } }, '≥2 事件 → duplicate,不是 missing');

  // ⑥ 一个事件都没 emit → missing_event(与 ⑤ 相反的诊断,kind 必须分开)
  res = fakeRes();
  cli = {
    run: async () => ({ exit: 0, out: '{"run":"r1","state":"completed"}' }),
    json: () => ({ ok: true, data: { events: [{ seq: 1, kind: 'run.started', payload: {} }] } }),
  };
  await handleCommand(fakeReq({ pilot: 'inbox', trigger: 'apply-feedback', input: { add: ['a@x'] } }), res, cli);
  assert.deepEqual(res.out, { code: 200, body: { ok: false, kind: 'missing_event' } });
});

// 7.1 body 超限:MUST 立即 reject(不 hang)、且不在 readJsonBody 内 destroy——413 由 handleCommand
// 先发响应、再 destroy(fake EventEmitter 无 destroy 也不会被调)。
test('7.1:readJsonBody 超限立即 reject、不 destroy', async () => {
  const req = new EventEmitter();
  const p = readJsonBody(req);
  req.emit('data', 'x'.repeat(64 * 1024 + 1));
  await assert.rejects(p, /body_too_large/);
});
