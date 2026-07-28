// hangar-view HTTP 服务(Node 标准库 http,不引 Express)。脊柱外;呈现面只读、另有一条白名单命令写路径:每 poll
// subprocess 调 `hangar … --json` + 只读 app.yaml,派生办公室模型上屏。ZERO import
// @hangar/core;HTTP 只存在于 view↔浏览器(守不变量 #6/#7)。不直读 hangar.sqlite。
import { createServer } from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { deriveOffice, deriveLiveness, sanitizeTrace, DEFAULT_CONFIG } from './derive.js';
import { cronPeriodMs } from './cron.js';

// ── 配置显式对齐 daemon(G1)─────────────────────────────────────────────────
// core 默认 cwd 相对(resolveAppsDir/resolveDbPath);若 view 与 daemon 解析到不同
// 库/apps 根,会画出「全员没上过班 / hangar 挂了」的假象。doctor --json 不回显路径
// (回显=改 core、破零改),故 view 由**显式 env** 启动、页面回显所用路径供人工核、
// 未显式设置(落 cwd 相对)则启动告警。
const APPS_EXPLICIT = !!process.env.HANGAR_APPS;
const DB_EXPLICIT = !!process.env.HANGAR_DB;
const APPS_DIR = process.env.HANGAR_APPS ?? resolve(process.cwd(), 'apps');
const DB_PATH = process.env.HANGAR_DB ?? resolve(process.cwd(), 'hangar.sqlite');
const CONFIG_WARNING =
  APPS_EXPLICIT && DB_EXPLICIT
    ? null
    : '配置未显式对齐,可能与 daemon 不一致(HANGAR_APPS/HANGAR_DB 落 cwd 相对)——请与 daemon launchd 设同一绝对路径';
if (CONFIG_WARNING) console.error(`hangar-view: ${CONFIG_WARNING}`);
console.error(`hangar-view: HANGAR_APPS=${APPS_DIR} HANGAR_DB=${DB_PATH}`);

// hangar CLI 路径:HANGAR_CLI 覆盖,默认解析到同仓 core dist(subprocess 调,非 import)。
const CLI = process.env.HANGAR_CLI ?? fileURLToPath(new URL('../../core/dist/cli.js', import.meta.url));
const PORT = Number(process.env.PORT ?? process.env.HANGAR_VIEW_PORT ?? 8787);
// 默认绑 127.0.0.1:页面无 app 级登录,鉴权在 CF Access 边缘;绑 0.0.0.0 会让 LAN/公网直连绕过它。
const HOST = process.env.HANGAR_VIEW_HOST ?? '127.0.0.1';

// Phase 3 前端「虚拟办公室」:单文件静态页(原生 JS、无框架/无构建),经 / 路由送达。
// 读一次进内存;只消费 /api/state·/api/trace 的白名单字段(不碰 payload/args)。
const INDEX_HTML = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

/**
 * subprocess 调 `hangar <args> --json`,统一失败判定:非零退出 / 超时 / stdout 不可
 * 解析 / CLI 错误形状 {ok:false} → { ok:false, kind }。子进程 env 显式带 view 解析到的
 * HANGAR_APPS/HANGAR_DB(用 view 自己的 node 二进制),保证 view 回显路径 == CLI 读路径。
 */
function callCliJson(args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args, '--json'], {
      env: { ...process.env, HANGAR_APPS: APPS_DIR, HANGAR_DB: DB_PATH },
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    });
    let data;
    try {
      data = JSON.parse(out);
    } catch {
      return { ok: false, kind: 'unparseable' };
    }
    // 退 0 → ok:true。status/runs/trace 的业务失败恒非零退出(已被下方 catch 归 exec_failed),
    // 唯一退 0 带 {ok:false} 的是 doctor(任一 app spec/pipeline 坏是正常态)——MUST NOT 在此坍缩成
    // 顶层失败清全屋,交给 buildState 只在**环境级** check 坏时才降页框。
    return { ok: true, data };
  } catch (e) {
    return { ok: false, kind: e && e.code === 'ETIMEDOUT' ? 'timeout' : 'exec_failed' };
  }
}

// YAML 1.2 core parses `no`/`off`/`yes`/`on` as strings — coerce so the beacon skip below
// (`=== false`) catches `enabled: no` (F1: else a disabled busiest-cron app poisons liveness).
// Duplicated from @hangar/core registry.ts (view is zero-import-core; keep byte-identical).
const BOOL_WORDS = { true: true, false: false, yes: true, no: false, on: true, off: false };
const coerceEnabled = (v) => (typeof v === 'string' ? BOOL_WORDS[v.toLowerCase()] ?? v : v);

/** 只读 apps 根下每个 app.yaml → { [id]: { enabled, triggers } }。零 import core;跟随 symlink app 目录。 */
export function loadAppSpecs(appsDir) {
  const specs = {};
  let entries;
  try {
    entries = readdirSync(appsDir, { withFileTypes: true });
  } catch {
    return specs; // apps_dir_missing 等 → doctor 已另行告警
  }
  for (const ent of entries) {
    const yamlPath = join(appsDir, ent.name, 'app.yaml');
    if (!existsSync(yamlPath)) continue; // 跟随 symlink;.gitkeep 等跳过
    try {
      const spec = parseYaml(readFileSync(yamlPath, 'utf8'));
      if (spec && spec.id) {
        // 过滤非对象 trigger 元素(app.yaml 写成 `triggers: [ - ]` → [null] 会让下游 appPeriod/
        // mostFreqTrigger 对 null 取 .schedule 抛 TypeError → 整进程崩)。一处保护两个消费者。
        specs[spec.id] = {
          // enabled 供 mostFreqTrigger 过滤;缺省(undefined)与留空(null)都 `!== false` → beacon 视作 enabled。
          enabled: coerceEnabled(spec.enabled),
          triggers: (Array.isArray(spec.triggers) ? spec.triggers : []).filter((t) => t && typeof t === 'object'),
        };
      }
    } catch {
      // app.yaml 坏了 → doctor 的 spec!=ok 已呈「配置坏了」;此处静默跳过周期计算即可
    }
  }
  return specs;
}

/** app 的最频繁 cron 周期(min over triggers,ms);无 cron→null。 */
export function appPeriod(sp) {
  if (!sp) return null;
  const ps = sp.triggers.map((t) => cronPeriodMs(t.schedule, t.timezone)).filter((p) => p != null);
  return ps.length ? Math.min(...ps) : null;
}

/** 全局最频繁 cron 触发器(喂顶层存活):跨所有 app 取周期最小者,返回其**属主 app**(appId)供从该 app 自己的 runs 派生;name 可为 undefined(无名 → 'cron')。 */
export function mostFreqTrigger(specs) {
  let best = { appId: null, name: null, period: null };
  for (const id of Object.keys(specs)) {
    if (specs[id].enabled === false) continue; // beacon 只在 enabled app 间选(F1:否则禁用最频繁 cron app 毒化顶层 liveness → 误报「疑似停摆」)
    for (const t of specs[id].triggers) {
      const p = cronPeriodMs(t.schedule, t.timezone);
      if (p != null && (best.period == null || p < best.period)) best = { appId: id, name: t.name, period: p };
    }
  }
  return best;
}

function configEcho() {
  return {
    appsDir: APPS_DIR,
    dbPath: DB_PATH,
    explicit: { apps: APPS_EXPLICIT, db: DB_EXPLICIT },
    warning: CONFIG_WARNING,
  };
}

/** /api/state:派生完整办公室模型 + 两层存活 + 路径回显。顶层调用失败→整页框降级。 */
function buildState() {
  const now = Date.now();

  // 顶层调用:doctor/status——exec 失败/超时/不可解析→降页框(不清全屋 vs 陈旧绿灯,#2.2d)。
  // doctor 退 0 带 ok:false 是常态(任一 app spec/pipeline 坏);仅**环境级** check(node/sqlite/apps_dir)
  // 坏才降页框,per-app spec/pipeline 坏由 deriveOffice 呈员工级「配置坏了」⚠️(否则一个坏 pilot 塌整页)。
  const doctorR = callCliJson(['doctor']);
  if (!doctorR.ok) return frameDegraded('doctor', doctorR.kind);
  const checks = doctorR.data?.checks;
  const envBad = !checks
    ? 'unparseable'
    : checks.node !== 'ok'
      ? checks.node
      : checks.sqlite_writable !== 'ok'
        ? checks.sqlite_writable
        : checks.apps_dir !== 'ok'
          ? checks.apps_dir
          : null;
  if (envBad) return frameDegraded('doctor', envBad);
  const statusR = callCliJson(['status']);
  if (!statusR.ok) return frameDegraded('status', statusR.kind);

  const doctorApps = checks.apps ?? [];
  const statusById = {};
  for (const s of Array.isArray(statusR.data) ? statusR.data : []) {
    statusById[s.app] = { state: s.state, since: s.since, blocked: s.blocked, lastRun: s.lastRun };
  }

  const specs = loadAppSpecs(APPS_DIR);
  const appPeriodMs = {};
  const runsByApp = {};
  for (const a of doctorApps) {
    if (a.spec !== 'ok') continue; // 注册失败者无需 per-app 取数
    if (a.enabled === false) continue; // disabled 不上墙,取了也丢弃(3.3 省无谓子进程);与 deriveOffice 同源 doctor.enabled
    appPeriodMs[a.id] = appPeriod(specs[a.id]);
    // per-app 降级粒度;--limit 50:只取最近若干条(view 只需 latest + recentRuns[0..5] + beacon
    // 触发器最近一条),把输出收小到远小于 64KB —— 避开 core CLI 大历史下 process.exit 截断管道 stdout。
    const rr = callCliJson(['runs', a.id, '--limit', '50']);
    runsByApp[a.id] = rr.ok ? { ok: true, runs: rr.data } : { ok: false };
  }

  const office = deriveOffice({
    doctorApps,
    statusById,
    runsByApp,
    appPeriodMs,
    config: DEFAULT_CONFIG,
    now,
  });

  // 顶层存活喂最频繁 cron 触发器**属主 app 自己的** runs(复用 runsByApp,不再无界全表 runs;
  // 跨 app 同名/无名 cron 不再串)。属主 app 若注册失败/未取到 → appRuns undefined → unknown。
  const mf = mostFreqTrigger(specs);
  const liveness = deriveLiveness({
    appRuns: mf.appId ? runsByApp[mf.appId] : undefined,
    triggerName: mf.name,
    periodMs: mf.period,
    now,
  });

  return {
    ok: true,
    frame: 'ok',
    generatedAt: new Date(now).toISOString(),
    config: configEcho(),
    liveness,
    office,
    alerts: office.filter((e) => e.alert).map((e) => e.employee),
  };
}

function frameDegraded(source, kind) {
  return {
    ok: false,
    frame: 'fetch_failed',
    generatedAt: new Date().toISOString(),
    config: configEcho(),
    liveness: { live: 'fetch_failed', note: `顶层 ${source} 取数失败(${kind}) · 重试中` },
    office: [], // MUST NOT 沿用上一轮陈旧数据冒充健康(陈旧绿灯 = 监控说谎)
    alerts: [],
    error: { source, kind },
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

// ── 命令写路径(/api/command):白名单 (pilot,trigger) → subprocess 调 `hangar run` ──────
// view 仍只作 CLI 消费者(不直连 pilot、不直写 sqlite),不新增表/库/进程/队列/游标——命令即时
// 经 CLI 触发。白名单 = (pilot → trigger → 该 trigger 的事件契约);硬编码 v1 白名单(inbox 两
// trigger),非白名单直接拒绝、不发起 run(不做「任意 app + 任意 input」firehose)。
const COMMAND_WHITELIST = {
  inbox: {
    // add/remove 共用这一对 trigger(撤销是同一意图的反向,不是第 2 个 intent → 不新增白名单条目)。
    //
    // 两个字段刻意分开,别再合成一个:
    //   inputKeys —— 形状门要校验的 input key,**两条 trigger 都有**。
    //   partition —— 回执分桶映射,**只有写腿有**(干跑腿的 emit 是 canonical 化的请求,与 input 原串
    //                合法地不同,配分校验会误拒)。
    // 曾经用 `partition` 兼当形状门的开关,于是干跑腿(无 partition)静默失去校验,而测试还把这个洞
    // 断言成了预期。一个数据干两件事,就会在只需要其中一件的那一侧留洞。
    'interpret-feedback': {
      eventKind: 'interpretation.proposed',
      field: 'interpretation',
      fields: ['add', 'remove'],
      inputKeys: ['add', 'remove'],
    },
    'apply-feedback': {
      eventKind: 'feedback.applied',
      field: 'applied',
      fields: ['added', 'already_present', 'removed', 'not_present'],
      inputKeys: ['add', 'remove'],
      partition: [
        ['add', ['added', 'already_present']],
        ['remove', ['removed', 'not_present']],
      ],
    },
  },
};

/** 白名单 gate:返回该 (pilot,trigger) 的事件契约,非白名单→null(调用方据此 403、不发起 run)。 */
export function commandSpec(pilot, trigger) {
  // 只认自有属性:否则 ('inbox','toString')/('constructor','apply') 命中继承方法(truthy)绕过 gate。
  if (!Object.hasOwn(COMMAND_WHITELIST, pilot)) return null;
  const t = COMMAND_WHITELIST[pilot];
  return Object.hasOwn(t, trigger) ? t[trigger] : null;
}

const safeParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/**
 * subprocess **异步**调 `hangar run …`(写命令,超时 60s 上限,远大于只读 10s;async execFile
 * 不阻塞事件循环——命令期 view 仍响应 /api/state 轮询,不再整段冻结)。与 callCliJson 不同:run
 * 退出码语义丰富(0 成功 / 1 已忙或 run.failed),故非零退出也**保留 stdout**(async execFile 抛错时
 * 非零退出 e.code=exit、stdout 挂 e.stdout、超时 e.killed=true)交给 classifyRunExit 判读,而非折叠 exec_failed。
 */
const execFileP = promisify(execFile);
async function callCliRun(args) {
  try {
    const { stdout } = await execFileP(process.execPath, [CLI, ...args, '--json'], {
      env: { ...process.env, HANGAR_APPS: APPS_DIR, HANGAR_DB: DB_PATH },
      timeout: 60_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
    });
    return { exit: 0, out: stdout };
  } catch (e) {
    if (e && e.killed) return { timeout: true };                 // execFile 超时 → killed:true(SIGTERM)
    return { exit: typeof e?.code === 'number' ? e.code : 1, out: typeof e?.stdout === 'string' ? e.stdout : '' };
  }
}

/**
 * 退出码映射(纯函数,可 self-check):`hangar run --json` 的 { exit, out } →
 *  - already_running(退 1,{ok:false,kind:'already_running'})→ { outcome:'busy' }(前端「稍后重发」)
 *  - run.failed(退 1,{run,state:'failed'} 无 kind;含未知 trigger / apply 失败)→ { outcome:'failed', kind:'run_failed' }
 *  - 其它 CLI 错误(app_not_found/usage/timeout…)→ { outcome:'failed', kind }
 *  - parked/非终态(退 0,state≠'completed'≠'failed',如 waiting_human)→ { outcome:'failed', kind:'unexpected_state' }(白名单 trigger MUST NOT park)
 *  - 成功(退 0,state==='completed')→ { outcome:'ok', runId }
 * MUST NOT 把失败伪装成功;只有 completed 算成功。
 */
export function classifyRunExit(run) {
  if (run.timeout) return { outcome: 'failed', kind: 'timeout' };
  const parsed = safeParse(run.out);
  if (run.exit !== 0) {
    if (parsed?.kind === 'already_running') return { outcome: 'busy' };
    return { outcome: 'failed', kind: parsed?.kind ?? 'run_failed' };
  }
  if (!parsed?.run) return { outcome: 'failed', kind: 'unparseable' };
  if (parsed.state === 'failed') return { outcome: 'failed', kind: 'run_failed' };
  if (parsed.state !== 'completed') return { outcome: 'failed', kind: 'unexpected_state' }; // ponytail: 白名单 trigger MUST NOT park;parked/非终态在此响亮失败,不当 ok
  return { outcome: 'ok', runId: parsed.run };
}

/**
 * 从 trace(全 payload)取指定 kind 事件的 payload——**受控数据最小化放宽仅限本命令路径**:
 * 不经 sanitizeTrace 的 default-drop(default-drop 仍 governs /api/state 与 /api/trace,一行不改)。
 * 数据是用户自己刚输入指令的解析回显、单用户、Access 门后。
 *
 * **要求恰好一个同 kind 事件**:契约是「每 run 恰好 emit 一次、一次带全字段」。取第一个会把
 * 「分两次 emit(add 一个、remove 一个)」呈现为成功,而确认页/回执只显示了一半。
 *
 * 返回 `{ payload }` / `{ count }`:0 与 ≥2 是**相反的诊断**(什么都没发生 vs 发生了两次),
 * 合成一个 `missing_event` 会把 operator 指向 trace 的错误那一半。
 */
export function pickEventPayload(traceData, eventKind) {
  const evs = (Array.isArray(traceData?.events) ? traceData.events : []).filter((e) => e.kind === eventKind);
  return evs.length === 1 ? { payload: evs[0].payload } : { count: evs.length };
}

/** 白名单投影:只取 spec 声明字段、且每个必须是 string[];缺字段/非 string[] → null(契约不符)。 */
export function projectPayload(payload, fields) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const out = {};
  for (const f of fields) {
    const v = payload[f];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return null;
    out[f] = v;
  }
  return out;
}

/**
 * 回执配分校验(纯函数):对 spec.partition 的每条 `[inputKey, [桶A, 桶B]]`,断言
 * `桶A ∪ 桶B === 去重后的 input[inputKey]`;并跨全部 partition 断言**四桶全局互不重叠、桶内不重复**(按重数,非纯集合语义)。
 * 缺 input key 视作空集(部署窗口的旧 view)。不符 → 返回不匹配的 inputKey(调用方映射
 * `receipt_mismatch`)。
 *
 * 为何需要:`projectPayload` 只保证字段是 `string[]`,「四桶全空」「只报一半」「报了没请求过的
 * 地址」的回执照样过关,前端于是呈「已应用」。
 *
 * **全局唯一那半是独立的一条**:只在 partition 行内查重时,`{add:[X],remove:[X]}` 的回执
 * `{added:[X],removed:[X]}` 逐行都合规 → 放行 → 前端打印「已加入 X · 已移出 X」,而文件里
 * 只有一种结果。契约已要求 pilot 对该输入响亮失败,这里是纵深。
 *
 * **按原串比较,不归一化**:view 不知道域的 canonical 规则(守不变量 #1),故契约要求 apply 的
 * input 已是 canonical、pilot 对非 canonical 项 throw。它证明的是「回执与请求自洽」,**不是**
 * 「回执与磁盘一致」——配分正确但什么都没写的 pilot 仍会过关。
 */
export function receiptMismatch(input, proj, partition) {
  if (!Array.isArray(partition)) return null;
  const seen = new Set();
  for (const [inputKey, buckets] of partition) {
    const sent = new Set(Array.isArray(input?.[inputKey]) ? input[inputKey] : []);
    const got = buckets.flatMap((b) => proj[b]);
    if (got.length !== sent.size || got.some((s) => !sent.has(s))) return inputKey;
    for (const s of got) {
      if (seen.has(s)) return inputKey; // 桶内重复,或与另一 partition 的桶跨桶重叠
      seen.add(s);
    }
  }
  return null;
}

/**
 * input 侧形状门:缺 key 合法(视作空集,部署窗口的旧 view 只发 `{add}`),但 key 存在就必须是 `string[]`。
 * 畸形 → 返回该 key(调用方映射 400 `usage`,且必须在发起 run 之前)。
 * 用 `Object.hasOwn` 而非 `in`:与 `commandSpec` 的原型链纪律一致,不让继承属性冒充 own key。
 */
export function inputShapeError(input, inputKeys) {
  if (!Array.isArray(inputKeys)) return null;
  for (const key of inputKeys) {
    if (!Object.hasOwn(input, key)) continue; // 缺 key = 合法
    const v = input[key];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return key;
  }
  return null;
}

/** 读 POST body(JSON,≤64KB);超限/坏 JSON → reject(调用方映射 400 usage)。 */
export function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    req.setEncoding?.('utf8'); // 多字节 UTF-8(中文指令)跨 chunk 边界:真实 IncomingMessage 用 StringDecoder 缓冲半个字符;fake EventEmitter 无此法 → 可选链跳过
    let raw = '';
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return; // 超限后丢弃后续 chunk(内存有界)
      if (raw.length + c.length > limit) {
        tooBig = true;
        return reject(new Error('body_too_large')); // 只 reject、不 destroy;413 由 handleCommand 先发响应、再 destroy
      }
      raw += c;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * POST /api/command { pilot, trigger, input } → 同步阻塞在 `hangar run` 上,一次响应返回终态。
 * 白名单外 → 403 not_whitelisted、不发起 run;busy → {ok:false,busy:true};失败 → {ok:false,kind};
 * 成功 → 读该 run trace 取白名单事件 payload → {ok:true,<field>:payload}。view 只透传 input(域无关)。
 */
/**
 * `cli` 可注入,只为让 self-check 能端到端跑这条链(桩掉两个 subprocess 调用)。生产路径用默认值。
 * 没有它,删掉下面任何一处 gate 测试都仍全绿——`receipt_mismatch` 是否真被发出、gate 排在
 * `projectPayload` 之后、input 形状 gate 是否在发起 run 之前,三件事都只能靠读代码确认。
 */
export async function handleCommand(req, res, cli = { run: callCliRun, json: callCliJson }) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, kind: 'method_not_allowed' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json'))
    return sendJson(res, 415, { ok: false, kind: 'bad_content_type' }); // CSRF 纵深:挡跨站 text/plain 表单
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err && err.message === 'body_too_large') {
      sendJson(res, 413, { ok: false, kind: 'payload_too_large' }); // 先发响应、再 destroy,使 413 可靠送达
      req.destroy?.();
      return;
    }
    return sendJson(res, 400, { ok: false, kind: 'usage' });
  }
  const { pilot, trigger, input } = body ?? {};
  if (
    typeof pilot !== 'string' ||
    typeof trigger !== 'string' ||
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input)
  ) {
    return sendJson(res, 400, { ok: false, kind: 'usage' });
  }
  const spec = commandSpec(pilot, trigger);
  if (!spec) return sendJson(res, 403, { ok: false, kind: 'not_whitelisted' }); // 非白名单:不发起 run
  // 畸形 input(key 存在但非 string[])在发起 run 之前拒:否则「pilot 忽略它并回四个空桶」会走成功路径。
  // 用 spec.inputKeys(两条 trigger 都声明),不是 spec.partition(只有写腿有 → 干跑腿会失去校验)。
  if (inputShapeError(input, spec.inputKeys)) return sendJson(res, 400, { ok: false, kind: 'usage' });

  const run = await cli.run(['run', pilot, '--trigger', trigger, '--input', JSON.stringify(input)]);
  const c = classifyRunExit(run);
  if (c.outcome === 'busy') return sendJson(res, 200, { ok: false, busy: true });
  if (c.outcome === 'failed') return sendJson(res, 200, { ok: false, kind: c.kind });
  // 成功 → 读该 run 的 trace 取白名单事件 payload(受控放宽仅此路径,不经 sanitizeTrace)。
  const tr = cli.json(['trace', c.runId]);
  if (!tr.ok) return sendJson(res, 200, { ok: false, kind: `trace_${tr.kind}` });
  const ev = pickEventPayload(tr.data, spec.eventKind);
  if (ev.count !== undefined) {
    // 按 count 判别,不按 payload === undefined:后者会把「恰好一个事件但 payload 键缺失」误报成
    // duplicate_event(count 为 undefined,`undefined === 0` 为假),把 operator 指向 trace 错误的那一半。
    // 0 个 = pilot 没 emit(契约漂移或版本过旧);≥2 个 = 违反「恰好一次」,回执只覆盖了一半。
    return sendJson(res, 200, { ok: false, kind: ev.count === 0 ? 'missing_event' : 'duplicate_event' });
  }
  const proj = projectPayload(ev.payload, spec.fields); // 只投影声明字段、校验 string[](契约漂移不当成功)
  if (!proj) return sendJson(res, 200, { ok: false, kind: 'contract_mismatch' });
  if (receiptMismatch(input, proj, spec.partition)) return sendJson(res, 200, { ok: false, kind: 'receipt_mismatch' });
  return sendJson(res, 200, { ok: true, [spec.field]: proj });
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/state') {
    try {
      return sendJson(res, 200, buildState());
    } catch (err) {
      // 纵深防御:意外错误(如坏 app.yaml 漏过过滤)也降页框,绝不让进程崩(→ launchd 崩溃循环)。
      // err 细节只记 stderr(launchd 日志);响应用固定 kind——不把原始异常消息上屏(数据最小化姿态,对齐 /api/trace)。
      console.error('hangar-view: /api/state 意外错误', err);
      return sendJson(res, 200, frameDegraded('internal', 'internal'));
    }
  }
  if (url.pathname === '/api/trace') {
    try {
      const runId = url.searchParams.get('run');
      if (!runId) return sendJson(res, 400, { ok: false, kind: 'usage', error: 'missing ?run=' });
      const r = callCliJson(['trace', runId]);
      if (!r.ok) return sendJson(res, 200, { ok: false, kind: r.kind });
      return sendJson(res, 200, { ok: true, ...sanitizeTrace(r.data) }); // default-drop 白名单
    } catch {
      return sendJson(res, 200, { ok: false, kind: 'internal' });
    }
  }
  if (url.pathname === '/api/command') {
    // async(读 body + 阻塞 subprocess);createServer 不 await 回调,故 fire-and-forget + 兜底不崩进程。
    handleCommand(req, res).catch((err) => {
      console.error('hangar-view: /api/command 意外错误', err);
      if (!res.headersSent) sendJson(res, 200, { ok: false, kind: 'internal' });
    });
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(INDEX_HTML);
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found\n');
});

// 仅作为入口直跑时监听;被 test import 时不起监听(否则 node --test 会挂住不退)。
// realpathSync:入口经 symlink 时 argv[1] 是链接路径、import.meta.url 是 realpath,不解析会误判不监听
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  server.listen(PORT, HOST, () => console.error(`hangar-view: listening on http://${HOST}:${PORT}`));
}
