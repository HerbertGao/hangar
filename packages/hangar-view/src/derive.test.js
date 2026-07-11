// Self-check for the office-model derivation. Fixed fixture JSON (no live DB) → 确定性。
// 覆盖 spec 点名的高危分支(tasks 2.4 ①–⑤)。零外部依赖(只 import ./derive.js)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveMood,
  deriveOffice,
  deriveLiveness,
  sanitizeTrace,
  staleWindowMs,
  DEFAULT_CONFIG,
} from './derive.js';

const NOW = Date.parse('2026-07-10T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

// ① mood 对 core State 全 7 枚举 + 无 run + 注册失败 皆非-undefined(有中性兜底)。
test('① mood 全 7 枚举 + 无 run + spec_invalid 皆非-undefined', () => {
  const states = ['queued', 'running', 'waiting_human', 'executing', 'completed', 'failed', 'cancelled'];
  for (const s of states) {
    const m = deriveMood(s, ago(1000), s === 'completed' ? ago(500) : null, false, 60_000, 300_000, NOW);
    assert.ok(m && typeof m.mood === 'string' && m.mood.length > 0, `state ${s} → mood 应为非空字符串`);
    assert.equal(typeof m.label, 'string');
    assert.equal(typeof m.alert, 'boolean');
  }
  // 未来/意外 state → 中性兜底,不 undefined。
  const fb = deriveMood('some_future_state', ago(1000), null, false, 60_000, 300_000, NOW);
  assert.ok(fb.mood && fb.alert === false, '意外 state 应中性兜底');

  // 无 run(never_worked)+ 注册失败(spec_broken)经 deriveOffice。
  const office = deriveOffice({
    doctorApps: [
      { id: 'fresh', spec: 'ok', pipeline: 'ok' },
      { id: 'broken', spec: 'spec_invalid', pipeline: 'unknown' },
    ],
    statusById: { fresh: { state: null, since: null, blocked: false } },
    runsByApp: {},
    appPeriodMs: {},
    config: DEFAULT_CONFIG,
    now: NOW,
  });
  const fresh = office.find((e) => e.employee === 'fresh');
  const broken = office.find((e) => e.employee === 'broken');
  assert.equal(fresh.mood, 'never_worked');
  assert.equal(fresh.alert, false);
  assert.equal(broken.mood, 'spec_broken');
  assert.equal(broken.alert, true, '注册失败呈 ⚠️、不静默省略');
});

// ② 超卡死窗的非终态样例报「疑似卡住」⚠️、窗内不报。
test('② 非终态按年龄分:超窗疑似卡住 ⚠️,窗内工作中', () => {
  const staleMs = 6 * 60_000; // 6 分卡死窗(如 poll */3 ×2)
  for (const s of ['running', 'executing', 'queued']) {
    const stuck = deriveMood(s, ago(30 * 60_000), null, false, staleMs, 300_000, NOW); // 30 分前起、超窗
    assert.equal(stuck.mood, 'stuck', `${s} 超窗应疑似卡住`);
    assert.equal(stuck.alert, true, `${s} 超窗应 ⚠️`);
    const ok = deriveMood(s, ago(60_000), null, false, staleMs, 300_000, NOW); // 1 分前起、窗内
    assert.equal(ok.mood, 'working', `${s} 窗内应工作中`);
    assert.equal(ok.alert, false, `${s} 窗内不误报`);
  }
  // waiting_human 除外:即便老,也不是「疑似卡住」而是「举手」⚠️;逾期→单一「举手·已逾期」。
  const raise = deriveMood('waiting_human', ago(30 * 60_000), null, false, staleMs, 300_000, NOW);
  assert.equal(raise.mood, 'raising_hand');
  const overdue = deriveMood('waiting_human', ago(30 * 60_000), null, true, staleMs, 300_000, NOW);
  assert.equal(overdue.mood, 'raising_hand_overdue');
  assert.equal(overdue.alert, true);
});

// ③ 终态长 run(startedAt 老、endedAt 新)不报停摆(顶层存活用 endedAt 非 startedAt)。
// 新签名:deriveLiveness 吃属主 app 的 { ok, runs }(M1),不再全表 runsOk/runs。
test('③ 终态长 run 刚完成不误报停摆(用 endedAt)', () => {
  const period = 180_000; // 3 分周期
  const longRun = [
    { id: 'r1', app: 'inbox', state: 'completed', trigger: 'poll', startedAt: ago(3 * 3600_000), endedAt: ago(10_000) },
  ];
  const alive = deriveLiveness({ appRuns: { ok: true, runs: longRun }, triggerName: 'poll', periodMs: period, now: NOW });
  assert.notEqual(alive.live, 'suspected_awol', '合法长 run 刚完成不应报停摆');
  assert.equal(alive.live, 'alive');

  // 对照:终态且 endedAt 超 2× 周期 → 疑似停摆。
  const stale = [
    { id: 'r2', app: 'inbox', state: 'completed', trigger: 'poll', startedAt: ago(20 * 60_000), endedAt: ago(15 * 60_000) },
  ];
  const awol = deriveLiveness({ appRuns: { ok: true, runs: stale }, triggerName: 'poll', periodMs: period, now: NOW });
  assert.equal(awol.live, 'suspected_awol');

  // 非终态抑制顶层停摆(由员工级卡住兜底);无 run→unknown;runs 取数失败→fetch_failed(非 unknown)。
  const nonTerminal = [{ id: 'r3', app: 'inbox', state: 'running', trigger: 'poll', startedAt: ago(60 * 60_000), endedAt: null }];
  assert.equal(deriveLiveness({ appRuns: { ok: true, runs: nonTerminal }, triggerName: 'poll', periodMs: period, now: NOW }).live, 'alive');
  assert.equal(deriveLiveness({ appRuns: { ok: true, runs: [] }, triggerName: 'poll', periodMs: period, now: NOW }).live, 'unknown');
  assert.equal(deriveLiveness({ appRuns: { ok: false }, triggerName: 'poll', periodMs: period, now: NOW }).live, 'fetch_failed');
  // CX1:属主 app 未取到(owner spec_invalid,per-app runs 未取)但有 beacon 周期 → fetch_failed(不伪装 unknown)。
  assert.equal(deriveLiveness({ appRuns: undefined, triggerName: 'poll', periodMs: period, now: NOW }).live, 'fetch_failed');
  // F-ENDEDAT-NULL:终态 run 缺 endedAt → unknown,不回落 startedAt 误报 awol。
  const noEnded = [{ id: 'r5', app: 'inbox', state: 'completed', trigger: 'poll', startedAt: ago(60 * 60_000), endedAt: null }];
  assert.equal(deriveLiveness({ appRuns: { ok: true, runs: noEnded }, triggerName: 'poll', periodMs: period, now: NOW }).live, 'unknown');
  // 无名触发器容忍:match r.trigger==='cron'。
  const unnamed = [{ id: 'r4', app: 'heartbeat', state: 'completed', trigger: 'cron', startedAt: ago(10 * 60_000), endedAt: ago(9 * 60_000) }];
  assert.equal(deriveLiveness({ appRuns: { ok: true, runs: unnamed }, triggerName: null, periodMs: 180_000, now: NOW }).live, 'suspected_awol');
});

// ④ 含 payload/args 的 trace 样例:输出无 payload、无 args(default-drop 白名单)。
test('④ trace 裁剪:输出无 payload 值、无 approval args', () => {
  const raw = {
    run: 'run_x',
    app: 'inbox',
    state: 'waiting_human',
    events: [
      { seq: 1, kind: 'run.started', at: ago(1000), payload: {} },
      { seq: 2, kind: 'notify.sent', at: ago(500), payload: { subject: '机密邮件主题', providerMessageId: 'SECRET123' } },
      { seq: 3, kind: 'approval.requested', at: ago(400), payload: { to: 'boss@corp.com' } },
    ],
    pendingApprovals: [{ id: 'ap1', tool: 'gmail.send', args: { to: 'boss@corp.com', body: '机密正文' } }],
  };
  const clean = sanitizeTrace(raw);
  const blob = JSON.stringify(clean);
  for (const leak of ['机密', 'SECRET123', 'boss@corp.com', 'subject', 'providerMessageId', 'args', 'payload', 'body']) {
    assert.ok(!blob.includes(leak), `输出不得含 "${leak}"`);
  }
  assert.deepEqual(clean.events.map((e) => [e.seq, e.kind]), [[1, 'run.started'], [2, 'notify.sent'], [3, 'approval.requested']]);
  assert.deepEqual(clean.pendingApprovals, [{ id: 'ap1', tool: 'gmail.send' }]);
  assert.equal(clean.state, 'waiting_human'); // lifecycle 字段保留
});

// ⑤ 单 app runs<app> 失败→只降该员工、不清全屋。
test('⑤ 单 app 取数失败只降该员工,其余正常', () => {
  const office = deriveOffice({
    doctorApps: [
      { id: 'inbox', spec: 'ok', pipeline: 'ok' },
      { id: 'heartbeat', spec: 'ok', pipeline: 'ok' },
    ],
    statusById: {
      inbox: { state: 'running', since: ago(60_000), blocked: false, lastRun: 'i1' },
      heartbeat: { state: 'completed', since: ago(60_000), blocked: false, lastRun: 'h1' },
    },
    runsByApp: {
      inbox: { ok: false }, // runs inbox --json 抛 SQLITE_BUSY
      heartbeat: { ok: true, runs: [{ id: 'h1', app: 'heartbeat', state: 'completed', trigger: 'cron', startedAt: ago(60_000), endedAt: ago(59_000) }] },
    },
    appPeriodMs: { inbox: 180_000, heartbeat: 86_400_000 },
    config: DEFAULT_CONFIG,
    now: NOW,
  });
  assert.equal(office.length, 2, '不清全屋');
  const inbox = office.find((e) => e.employee === 'inbox');
  const hb = office.find((e) => e.employee === 'heartbeat');
  assert.equal(inbox.mood, 'fetch_failed', '只 inbox 降取数失败');
  assert.notEqual(hb.mood, 'fetch_failed', 'heartbeat 不受影响');
  assert.equal(hb.mood, 'just_done'); // 刚 completed
  // run id 暴露:正常员工带非空 lastRun + recentRuns[].id(供抽屉取 /api/trace)。
  assert.equal(hb.lastRun, 'h1', 'lastRun 应为最近一次 run 的 id');
  assert.equal(hb.recentRuns[0].id, 'h1', 'recentRuns 每条应带自己的 id');
});

// ⑥ run id 暴露不连带泄露 payload/args:office + recentRuns 仍无 payload 值 / 无 approval args。
test('⑥ 暴露 run id 但 office 仍无 payload/args(default-drop 安全回归)', () => {
  const office = deriveOffice({
    doctorApps: [{ id: 'inbox', spec: 'ok', pipeline: 'ok' }],
    statusById: { inbox: { state: 'completed', since: ago(120_000), blocked: false, lastRun: 'run_secret_1' } },
    runsByApp: {
      inbox: {
        ok: true,
        runs: [
          // 原始 runs 条目携带域数据(payload/args/敏感字段);裁剪后 office 里不得出现。
          {
            id: 'run_secret_1', app: 'inbox', state: 'completed', trigger: 'poll',
            startedAt: ago(120_000), endedAt: ago(60_000),
            payload: { subject: '机密邮件主题', to: 'boss@corp.com' },
            args: { body: '机密正文', providerMessageId: 'SECRET123' },
          },
        ],
      },
    },
    appPeriodMs: { inbox: 180_000 },
    config: DEFAULT_CONFIG,
    now: NOW,
  });
  const emp = office.find((e) => e.employee === 'inbox');
  // 正向:run id 已暴露。
  assert.equal(emp.lastRun, 'run_secret_1', 'lastRun = 最近 run 的 id');
  assert.equal(emp.recentRuns[0].id, 'run_secret_1', 'recentRuns[].id 存在');
  // 安全回归:整屋 blob 不含任何 payload 值 / approval args / payload·args 键。
  const blob = JSON.stringify(office);
  for (const leak of ['机密', 'SECRET123', 'boss@corp.com', 'subject', 'providerMessageId', 'args', 'payload', 'body']) {
    assert.ok(!blob.includes(leak), `office 输出不得含 "${leak}"(run id 加入不得连带带出 payload)`);
  }
});

// ⑦ B1 doctor-gate:doctor ok:false 只因某 app spec 坏(环境全 ok)时,坏 app 呈 spec_broken ⚠️
// 且健康 app 照常渲染(带 run 的真 mood),不塌成空屋。
test('⑦ 单 app spec 坏不塌整屋:坏 app spec_broken + 健康 app 正常渲染', () => {
  const office = deriveOffice({
    doctorApps: [
      { id: 'good', spec: 'ok', pipeline: 'ok' },
      { id: 'broken', spec: 'spec_invalid', pipeline: 'unknown' },
    ],
    statusById: { good: { state: 'completed', since: ago(120_000), blocked: false, lastRun: 'g1' } },
    runsByApp: {
      good: { ok: true, runs: [{ id: 'g1', app: 'good', state: 'completed', trigger: 'poll', startedAt: ago(120_000), endedAt: ago(110_000) }] },
    },
    appPeriodMs: { good: 180_000 },
    config: DEFAULT_CONFIG,
    now: NOW,
  });
  assert.equal(office.length, 2, '不塌成空屋');
  const good = office.find((e) => e.employee === 'good');
  const broken = office.find((e) => e.employee === 'broken');
  assert.equal(broken.mood, 'spec_broken');
  assert.equal(broken.alert, true, '坏 app 呈 ⚠️');
  assert.notEqual(good.mood, 'spec_broken', '健康 app 不受坏 app 连累');
  assert.equal(good.mood, 'just_done'); // completed 且在新鲜窗内(endedAt 110s 前)
  assert.equal(good.lastRun, 'g1', '健康 app 正常派生带 run id');
});

// ⑧ M5 pipeline_missing → spec_broken(spec=ok/pipeline=pipeline_missing 跑不了,不当健康员工)。
test('⑧ pipeline_missing 呈 spec_broken ⚠️、label 反映 pipeline', () => {
  const office = deriveOffice({
    doctorApps: [{ id: 'nopipe', spec: 'ok', pipeline: 'pipeline_missing' }],
    statusById: {},
    runsByApp: {},
    appPeriodMs: {},
    config: DEFAULT_CONFIG,
    now: NOW,
  });
  const e = office.find((x) => x.employee === 'nopipe');
  assert.equal(e.mood, 'spec_broken');
  assert.equal(e.alert, true);
  assert.ok(e.label.includes('pipeline_missing'), 'label 反映 pipeline 坏因');
});

// ⑨ M3 两快照 skew:runs[0].id ≠ status.lastRun → 不采用 runs[0],无负 duration、lastRun 用 status.lastRun。
test('⑨ status.lastRun ≠ runs[0].id 时不混装(无负 duration、lastRun 正确)', () => {
  const office = deriveOffice({
    doctorApps: [{ id: 'inbox', spec: 'ok', pipeline: 'ok' }],
    statusById: { inbox: { state: 'completed', since: ago(60_000), blocked: false, lastRun: 'newer' } },
    runsByApp: {
      // runs[0] 是更早一条(startedAt 比 status.since 老很多);若误采用,endedMs<startedMs → 负 duration。
      inbox: { ok: true, runs: [{ id: 'older', app: 'inbox', state: 'completed', trigger: 'poll', startedAt: ago(600_000), endedAt: ago(590_000) }] },
    },
    appPeriodMs: { inbox: 180_000 },
    config: DEFAULT_CONFIG,
    now: NOW,
  });
  const e = office.find((x) => x.employee === 'inbox');
  assert.equal(e.durationSec, null, '两快照不同指时不算 duration(避免负值)');
  assert.equal(e.lastRun, 'newer', 'lastRun 用 status.lastRun 非 runs[0].id');
  assert.equal(e.endedAt, null, '不采用陈旧 runs[0] 的 endedAt');
  assert.equal(e.lastTrigger, null, '不采用陈旧 runs[0] 的 trigger');
});

// ⑩ minors:非终态 age 为 NaN → idle(不误报工作中);completed 且 mins 为 null → label 无 "null"。
test('⑩ NaN-age → idle;completed 时间戳坏 → 打盹文案省略数字', () => {
  const nan = deriveMood('running', 'not-a-date', null, false, 60_000, 300_000, NOW);
  assert.equal(nan.mood, 'idle', 'age 不可解析应中性 idle,不恒工作中');
  assert.equal(nan.alert, false);
  const nap = deriveMood('completed', 'not-a-date', null, false, 60_000, 300_000, NOW);
  assert.ok(!nap.label.includes('null'), 'mins 为 null 时不显「null 分前」');
});

// 附:staleWindowMs 配置卫生 + per-app override + clamp。
test('附:卡死窗 clamp / per-app override / 配置卫生回落', () => {
  // 默认:period 180s ×2 = 360s,在 [60s,24h] 内。
  assert.equal(staleWindowMs(DEFAULT_CONFIG, 'inbox', 180_000), 360_000);
  // 无 cron → 绝对上限 ceiling。
  assert.equal(staleWindowMs(DEFAULT_CONFIG, 'x', null), DEFAULT_CONFIG.staleCeilingMs);
  // per-app override 倍率。
  const cfg = { ...DEFAULT_CONFIG, perApp: { slow: { staleWindowMultiplier: 10 } } };
  assert.equal(staleWindowMs(cfg, 'slow', 180_000), 1_800_000);
  // 配置卫生:multiplier<=0 或 floor>ceiling → 回落默认(不炸)。
  const bad = { ...DEFAULT_CONFIG, staleWindowMultiplier: 0, staleFloorMs: 999, staleCeilingMs: 1 };
  assert.equal(staleWindowMs(bad, 'x', 180_000), 360_000, '坏配置应回落默认 ×2');
});

// ⑪ CX2:status.lastRun 落在 runs[1](TOCTOU 窗内更新的 run 顶掉 runs[0])→ 按 id 锁定那条,
// 采用其 endedAt/trigger(不因 runs[0] 不匹配就置 null)。
test('⑪ status.lastRun 在 runs[1] 时按 id 锁定、采用其 endedAt', () => {
  const office = deriveOffice({
    doctorApps: [{ id: 'inbox', spec: 'ok', pipeline: 'ok' }],
    statusById: { inbox: { state: 'completed', since: ago(120_000), blocked: false, lastRun: 'authoritative' } },
    runsByApp: {
      inbox: {
        ok: true,
        runs: [
          // runs[0] 是 TOCTOU 窗内刚出现的更新 run(status 快照还没看到它);真正的 status.lastRun 落在 runs[1]。
          { id: 'newer_toctou', app: 'inbox', state: 'running', trigger: 'poll', startedAt: ago(5_000), endedAt: null },
          { id: 'authoritative', app: 'inbox', state: 'completed', trigger: 'poll', startedAt: ago(120_000), endedAt: ago(60_000) },
        ],
      },
    },
    appPeriodMs: { inbox: 180_000 },
    config: DEFAULT_CONFIG,
    now: NOW,
  });
  const e = office.find((x) => x.employee === 'inbox');
  assert.equal(e.endedAt, ago(60_000), 'status.lastRun 在 runs[1] 时其 endedAt 被采用(非 runs[0]、非 null)');
  assert.equal(e.lastTrigger, 'poll', '采用锁定那条的 trigger');
  assert.equal(e.lastRun, 'authoritative', 'lastRun 用 status.lastRun');
});
