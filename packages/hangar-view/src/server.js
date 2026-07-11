// hangar-view HTTP 服务(Node 标准库 http,不引 Express)。脊柱外、只读:每 poll
// subprocess 调 `hangar … --json` + 只读 app.yaml,派生办公室模型上屏。ZERO import
// @hangar/core;HTTP 只存在于 view↔浏览器(守不变量 #6/#7)。不直读 hangar.sqlite。
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
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

/** 只读 apps 根下每个 app.yaml → { [id]: { triggers } }。零 import core;跟随 symlink app 目录。 */
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
    appPeriodMs[a.id] = appPeriod(specs[a.id]);
    const rr = callCliJson(['runs', a.id]); // per-app 降级粒度
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
