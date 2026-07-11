// Pure office-model derivation from hangar CLI --json data. NO I/O, NO external
// imports — fully deterministic on fixture input so self-check can cover the
// high-risk branches without a live DB (see derive.test.js).
//
// Implements the 8 spec requirements' derivation: roster (doctor 权威源左连
// status,去重 app id)、mood 全 7 枚举 + 无 run + 注册失败、按年龄分工作中/疑似
// 卡住、两层存活(顶层 endedAt / 员工级年龄)、per-app 降级、default-drop 白名单。

/** core State enum — the 3 terminal states drive freshness/AWOL logic. */
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Defaults are the hygiene fallback (always valid), separate from user config so a
 *  malformed override can never poison them. Stale window = employee "疑似卡住" 判定;
 *  liveness uses a fixed 2× 周期 per spec (separate knob). */
export const DEFAULT_CONFIG = {
  staleWindowMultiplier: 2, // 卡死窗 = 最频繁周期 × 此值
  staleFloorMs: 60_000, // clamp 下限:1 分
  staleCeilingMs: 24 * 60 * 60_000, // clamp 上限 / 无 cron 时的绝对上限:24 时
  freshMs: 5 * 60_000, // completed「刚搞定」新鲜窗
  // ponytail: per-app override 结构就位(慢/低频 pilot 会稳态误报「疑似卡住」——倍率是
  // 校准 knob);真有 pilot 稳态误报时往这里塞 { [appId]: { staleWindowMultiplier, ... } }。
  perApp: {},
};

const mins = (ms) => (Number.isFinite(ms) ? Math.round(ms / 60_000) : null);

/**
 * 卡死窗(ms):最频繁周期 × 倍率,clamp 到 [floor, ceiling];无 cron(periodMs==null)→
 * 绝对上限 ceiling。配置卫生:multiplier>0 且 floor≤ceiling,否则整体回落 DEFAULT_CONFIG。
 */
export function staleWindowMs(config, appId, periodMs) {
  const o = (config.perApp && config.perApp[appId]) || {};
  let mult = o.staleWindowMultiplier ?? config.staleWindowMultiplier;
  let floor = o.staleFloorMs ?? config.staleFloorMs;
  let ceil = o.staleCeilingMs ?? config.staleCeilingMs;
  if (!(mult > 0) || !(floor <= ceil)) {
    mult = DEFAULT_CONFIG.staleWindowMultiplier;
    floor = DEFAULT_CONFIG.staleFloorMs;
    ceil = DEFAULT_CONFIG.staleCeilingMs;
  }
  if (periodMs == null) return ceil; // 无 cron 触发器 → 绝对上限
  return Math.min(Math.max(periodMs * mult, floor), ceil);
}

/**
 * State + 时间戳 → { mood, label, alert }。覆盖 core State 全 7 枚举,有中性兜底
 * (default 分支)——绝不返回 undefined。⚠️ 触发集 = {failed, waiting_human,
 * 超卡死窗的非终态(疑似卡住)}(注册失败在 deriveOffice 里另计)。
 * `waiting_human` 单独处理(不进按年龄的 stuck 逻辑);blocked ⊂ waiting_human →
 * 单一「举手·已逾期」,不画冲突态。
 */
export function deriveMood(state, startedAt, endedAt, blocked, staleMs, freshMs, now) {
  const startedMs = Date.parse(startedAt);
  const endedMs = endedAt ? Date.parse(endedAt) : null;
  switch (state) {
    case 'completed': {
      const since = now - (endedMs ?? startedMs); // 衰减按 endedAt(spec:上次搞定 N 分前)
      if (since < freshMs) return { mood: 'just_done', label: '✅ 刚搞定,伸懒腰', alert: false };
      const m = mins(since); // 时间戳不可解析 → null,文案省略数字(不显「上次搞定 null 分前」)
      return { mood: 'napping', label: m == null ? '💤 打盹' : `💤 打盹(上次搞定 ${m} 分前)`, alert: false };
    }
    case 'failed':
      return { mood: 'crashed', label: '💥 翻车', alert: true };
    case 'cancelled':
      // 仅 `hangar reject` 产生的终态;中性、非 ⚠️,文案区别于「打盹」。
      return { mood: 'wrapped_up', label: '🚪 收工·已驳回', alert: false };
    case 'waiting_human':
      return blocked
        ? { mood: 'raising_hand_overdue', label: '🙋 举手 · 已逾期', alert: true }
        : { mood: 'raising_hand', label: '🙋 举手等你拍板', alert: true };
    case 'running':
    case 'executing':
    case 'queued': {
      // 非终态按年龄分:窗内工作中,超窗疑似卡住 ⚠️(否则 hung run 永久占 inFlight 却永显工作中)。
      const age = now - startedMs;
      if (!Number.isFinite(age)) return { mood: 'idle', label: `· ${state}`, alert: false }; // 时间戳坏 → 中性,不误报工作中
      return age > staleMs
        ? { mood: 'stuck', label: '😰 疑似卡住', alert: true }
        : { mood: 'working', label: '⌨️ 埋头干活', alert: false };
    }
    default:
      // 中性兜底:任何未来/意外 state 都有非-undefined 映射,不渲染 undefined。
      return { mood: 'idle', label: `· ${state}`, alert: false };
  }
}

function neverWorked(appId, blocked) {
  return base(appId, 'never_worked', '🆕 还没上过班', false, { blocked });
}

function base(appId, mood, label, alert, extra) {
  return {
    employee: appId,
    mood,
    label,
    alert,
    state: null,
    lastTrigger: null,
    startedAt: null,
    endedAt: null,
    ageMin: null,
    durationSec: null,
    blocked: false,
    recentRuns: [],
    ...extra,
  };
}

/**
 * 花名册 = doctor.checks.apps[](全 id 超集,含注册失败者),去重键 app id,左连 status
 * 取 run-state/started_at/blocked——NOT「status ∪ doctor.errors」并集。每个 app 一名员工。
 *
 * @param doctorApps  doctor.checks.apps: [{ id, spec, pipeline }]
 * @param statusById  { [appId]: { state, since, blocked } }  (status --json 左连)
 * @param runsByApp   { [appId]: { ok:true, runs:[...] } | { ok:false } }  (runs <app> per-app 降级粒度)
 * @param appPeriodMs { [appId]: number|null }  最频繁 cron 周期(ms),无 cron→null
 * @param config      ViewConfig(见 DEFAULT_CONFIG)
 * @param now         Date.now()
 */
export function deriveOffice({ doctorApps, statusById, runsByApp, appPeriodMs, config, now }) {
  const seen = new Set();
  const office = [];
  for (const a of doctorApps || []) {
    if (seen.has(a.id)) continue; // 去重键 = app id
    seen.add(a.id);

    // 注册失败(spec_invalid / app_unresolved)或 pipeline 缺失(spec=ok/pipeline=pipeline_missing,
    // 跑不了):经 doctor.checks.apps[].{spec,pipeline} != 'ok',呈员工级「配置坏了」⚠️,MUST NOT 静默省略。
    if (a.spec !== 'ok' || a.pipeline !== 'ok') {
      const reason = a.spec !== 'ok' ? a.spec : a.pipeline;
      office.push(base(a.id, 'spec_broken', `🧰 配置坏了(${reason})`, true, {}));
      continue;
    }

    // 禁用排除(broken 优先于 disabled):broken 检查已在先,仅对 spec=ok ∧ pipeline=ok 的
    // otherwise-healthy app 施加 enabled === false 排除——坏 app 不能靠禁用藏起来(与「CLI 取数失败」
    // 需求一致)。缺 enabled(undefined:旧 core 未上报 / 注册失败无解析 spec)视作 true、不排除。
    if (a.enabled === false) continue;

    const st = statusById[a.id]; // 左连 status;缺失(两快照 skew)→ 视作 never-ran
    const blocked = st?.blocked ?? false;
    const state = st?.state ?? null;
    if (state == null) {
      office.push(neverWorked(a.id, blocked)); // 已注册但无 latest run,或 skew 短暂遗漏
      continue;
    }

    // per-app runs<app> 降级粒度:该调用失败→只降这一名员工,不清全屋(#2.2d)。
    const rr = runsByApp[a.id];
    if (rr && rr.ok === false) {
      office.push(base(a.id, 'fetch_failed', '📡 取数失败 · 重试中', false, { blocked }));
      continue;
    }
    const runs = rr && rr.ok && Array.isArray(rr.runs) ? rr.runs : []; // 守非数组(对齐 deriveLiveness),避免 .find 抛
    // status(权威 id/since)与 runs 是两次独立快照;在 runs 里按 id 锁定 status.lastRun 指向的那条
    // (TOCTOU 窗内新 run 可能顶掉 runs[0]),采用它的 endedAt/trigger/duration;找不到→ null 用
    // status.lastRun——防两快照 skew 混装(负 duration、指错 run)。
    const latest = runs.find((r) => r.id === st.lastRun) ?? null;
    const startedAt = st.since; // 权威 started_at 来自 status(左连)
    const endedAt = latest?.endedAt ?? null;
    const trigger = latest?.trigger ?? null;

    const staleMs = staleWindowMs(config, a.id, appPeriodMs?.[a.id] ?? null);
    const m = deriveMood(state, startedAt, endedAt, blocked, staleMs, config.freshMs, now);

    const startedMs = Date.parse(startedAt);
    const endedMs = endedAt ? Date.parse(endedAt) : null;
    const ageMs = now - (endedMs ?? startedMs);
    office.push({
      employee: a.id,
      mood: m.mood,
      label: m.label,
      alert: m.alert,
      state, // lifecycle 字段(default-drop 白名单允许)
      lastTrigger: trigger,
      startedAt,
      endedAt,
      ageMin: mins(ageMs),
      durationSec: endedMs && Number.isFinite(startedMs) ? Math.round((endedMs - startedMs) / 1000) : null,
      blocked,
      // run id:/api/trace 的不透明查询入参(非 payload/args、无域数据),供抽屉主时间线。
      // 用 status.lastRun(权威 latest,与两快照 skew 无关),而非可能陈旧的 runs[0]。
      lastRun: st.lastRun ?? null,
      // 抽屉「最近几次成败」:default-drop 白名单——只 lifecycle 字段 + run id,无 payload。
      recentRuns: runs.slice(0, 5).map((r) => ({
        id: r.id,
        state: r.state,
        trigger: r.trigger,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      })),
    });
  }
  return office;
}

/**
 * 顶层本体存活(新鲜度启发式,非精确判死)。最频繁 cron 触发器的最近一次 run
 * (started_at 最新那条、不论终态):
 *  - 非终态 → 抑制顶层「停摆」(它 fire 过就证明 daemon 活),由员工级卡住兜底 → 'alive'
 *  - 终态且 now - **endedAt** > 2× 周期 → 'suspected_awol'(用 endedAt,合法长 run 刚完成不误报)
 *  - 无匹配 run → 'unknown'(从未触发)
 *  - 喂 liveness 的 runs 调用失败 → 'fetch_failed'(MUST NOT 伪装成 unknown)
 * triggerName 为 null/undefined(无名触发器,Run.trigger='cron' 类别)→ 匹配 r.trigger==='cron'。
 */
export function deriveLiveness({ appRuns, triggerName, periodMs, now }) {
  // appRuns = 属主 app 的 runsByApp 条目:{ ok:true, runs } | { ok:false } | undefined。
  if (appRuns?.ok === false) return { live: 'fetch_failed', note: '喂 liveness 的 runs 取数失败 · 重试中' };
  if (periodMs == null) return { live: 'unknown', note: '无 cron 触发器,存活未知' };
  // 有 beacon 周期但拿不到 owner app 的 runs(owner core 侧 spec_invalid、per-app runs 未取)→ 取数缺失,
  // 非 unknown(unknown 严格限于「该 app runs 成功返回且无匹配 run」)。
  if (!appRuns) return { live: 'fetch_failed', note: 'owner app runs 取数缺失(注册失败/未取到) · 重试中' };
  const match = (Array.isArray(appRuns?.runs) ? appRuns.runs : []).filter((r) =>
    triggerName == null ? r.trigger === 'cron' : r.trigger === triggerName,
  );
  if (match.length === 0) return { live: 'unknown', note: '该触发器从未产出 run(dev 手动测 / 无 daemon)' };
  const latest = match[0]; // runs 已按 started_at 倒序
  if (!TERMINAL.has(latest.state)) {
    return { live: 'alive', note: '最近一次触发为非终态(daemon 刚 fire),顶层抑制、员工级卡住兜底' };
  }
  if (!latest.endedAt) return { live: 'unknown', note: '最近一次触发已达终态但缺结束时间,存活未知' }; // 不回落 startedAt 误报 awol
  const endedMs = Date.parse(latest.endedAt);
  const overdue = Number.isFinite(endedMs) && now - endedMs > 2 * periodMs;
  return overdue
    ? { live: 'suspected_awol', note: `最近一次触发约 ${mins(now - endedMs)} 分前结束,超 2× 周期 —— hangar 疑似停摆` }
    : { live: 'alive', note: '最近一次触发按时完成' };
}

/**
 * 数据最小化 = 域无关 default-drop 白名单。trace --json 原样含完整 payload 和
 * pendingApprovals.args(core cli.ts);此处**只**挑白名单字段,丢弃全部 payload 值
 * 与全部 approval args(NOT 按敏感字段名裁剪——那要域知识、破 #1、对非-email pilot
 * 默认泄露)。连脊柱自产的 run.failed.payload.error 也一并丢,失败原因回 CLI hangar trace。
 */
export function sanitizeTrace(trace) {
  const events = Array.isArray(trace?.events)
    ? trace.events.map((e) => ({ seq: e.seq, kind: e.kind, at: e.at })) // 丢 payload
    : [];
  const pendingApprovals = Array.isArray(trace?.pendingApprovals)
    ? trace.pendingApprovals.map((a) => ({ id: a.id, tool: a.tool })) // 丢 args
    : [];
  return {
    run: trace?.run ?? null,
    app: trace?.app ?? null,
    state: trace?.state ?? null, // lifecycle 字段
    events,
    pendingApprovals,
  };
}
