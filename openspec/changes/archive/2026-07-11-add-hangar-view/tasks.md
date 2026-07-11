# Tasks — add-hangar-view

## 1. 预研 + 可行性验证(Phase A)
- [x] 1.1 核对 `status/runs/trace --json` 形状与 SKILL 契约一致(dev 实测)
- [x] 1.2 验 `trace` 含 pilot emit 域事件(`notify.sent`)
- [x] 1.3 stdlib 脚本从真实 `status+runs` 派生「办公室模型」(情绪/衰减/⚠️/时长)——证明零改 core 可派生
- [x] 1.4 确认 `node-cron`+`yaml` 已在 core、next-run/周期由 hangar 现网 `getNextRuns` 已做,无需重造
- [x] 1.5 抓出并纳规格:无 poll run 的库报 `unknown`、不误警 AWOL
- [x] 1.6 治理 ratify(#9):`DESIGN.md`/`ROADMAP.md`(Phase 1.5)/`CLAUDE.md` 收窄「web workbench 永不做」

## 2. `packages/hangar-view` 骨架(Phase B · 数据管道先行)
- [x] 2.1 建 package(独立进程、与 `@hangar/core` 无 import 依赖;`http` 标准库,不引 Express)
- [x] 2.2 `/api/state`:subprocess 调 `hangar status/runs --json` + 只读 `app.yaml`,派生办公室模型(把 1.3 的脚本收成模块);**由显式 `HANGAR_APPS`/`HANGAR_DB` env 启动(与 daemon launchd 同绝对路径)、页面回显所用路径、未显式设置则告警**(G1;不依赖 doctor 回显路径——它不提供)
- [x] 2.2b 员工态**按年龄分**:非终态 `started_at` 在卡死窗内→工作中;**超窗任何非终态(running/executing/queued)→疑似卡住 ⚠️**(G2);卡死窗 = 最频繁周期 × `staleWindowMultiplier`(默认 2、per-app 可 override、clamp floor/ceiling)+ 盲区文案「慢/低频 pilot 会稳态误报」(H1);花名册权威源 = `doctor.checks.apps[]` 左连 status(去重键 app id,H3/J1),`checks.apps[].spec!='ok'` 呈「配置坏了」⚠️、不静默省略(G8)
- [x] 2.2c 本体存活两层:顶层「疑似停摆」仅终态 poll 且 `now - **endedAt** > 2×周期`(用 endedAt,G6);非终态抑制顶层、由 2.2b 员工级卡住兜底;无 run→unknown;容忍无名 trigger `cron`
- [x] 2.2d CLI 失败降级**分粒度**:单 app `runs<app>` 失败→只降该员工;顶层 `status`/`doctor` 失败(含 `ok:false`/不可解析)→降页框;不清全屋;两类 unknown UI 可区分(G7/G10)
- [x] 2.3 数据最小化 **default-drop 白名单**:只回 `{seq,kind,at}` + run 生命周期 + 计数,**丢弃全部 payload 值 + approval `args`**(不按字段名裁剪,守 #1);文案标注 `run.failed.error` 亦丢、失败原因回 CLI `hangar trace`(G5,v1 降级)
- [x] 2.4 self-check(覆盖高危分支):①mood 对 `State` 全 7 枚举+无 run+spec_invalid 皆非-undefined ②**超卡死窗的非终态样例报「疑似卡住」⚠️、窗内不报**(G2)③终态长 run(startedAt 老、endedAt 新)不报停摆(G6)④含 payload/args 的 trace 样例输出无 payload/无 args ⑤单 app 失败只降该员工、不清全屋(G7)
- [x] 2.5 view 侧 cron 周期自实现(自带 `node-cron`+`yaml`,含 `string|string[]` union)+ 自测(F10,零 import core)

## 3. 前端「虚拟办公室」(Phase B · 美术叠在数据上)
- [x] 3.1 极简占位页:`fetch('/api/state')` poll(~10s),渲染真实员工卡片(先证「真数据→页面」)
- [x] 3.2 CSS/emoji 角色 + 状态→角色映射(**全 7 枚举 + 无 run + spec_invalid + 中性兜底**:工作中/疑似卡住⚠️/刚搞定/打盹/翻车⚠️/举手⚠️/收工·已驳回/还没上过班/配置坏了⚠️,见 spec)
- [x] 3.3 顶层本体存活三态:**疑似停摆 / 活着 / unknown**(「疑似」非断言);员工级「疑似卡住」独立于顶层;逾期 `waiting_human` 单一「举手·已逾期」不画冲突态
- [x] 3.4 点员工 → 抽屉展开该 pilot 最近一次 run 的事件时间线(**只 `kind`+时间,无 payload/args**)+ 最近几次成败

## 4. 部署 + 远程(`ts.mac-mini`)
- [ ] 4.1 起只读进程(与现有 launchd daemon **同 `HANGAR_APPS`/`HANGAR_DB`**、并列互不影响;view 挂不影响脊柱)
- [ ] 4.2 `cloudflared` tunnel + Cloudflare Access(域名 + Zero Trust,用户已确认就绪);**实测「未通过 Access 的请求确被边缘 403」**(F:CF 断言实现前必验)
- [ ] 4.3 验证:外出用手机打开,3 秒看清 inbox 员工近况 + hangar 活没活,全程不碰 SSH/CLI

## 5. 不变量核对(合并前)
- [x] 5.1 `@hangar/core` 一行未改(无新 HTTP/IPC in core;view 只作 CLI 消费者)
- [x] 5.2 view 不直读 sqlite(只经 CLI `--json` + 只读 `app.yaml`)
- [x] 5.3 v1 无写操作、无 app 级登录(鉴权在 CF 边缘)
- [x] 5.4 数据最小化守 #1:输出无任何 `payload_json` 值/`args`,view 不含任何域字段名(default-drop 而非 denylist)

## 不在本变更(留后续,各自过闸)
- 从页面 approve/reject 写路径(接第一个带审批 pilot 时;届时走 `hangar approve` + app 级身份 + 防误触)
- 多用户/RBAC · 原始进程日志聚合 · WebSocket 实时推送 · 3D/精灵图美术升级
- Telegram `/status` interim(inbox pilot 外部 repo,单列)
