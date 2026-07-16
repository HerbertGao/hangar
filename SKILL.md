---
name: hangar
description: 通过 CLI 驱动 hangar(无头 AgentOS 脊柱)——触发/审批/巡检运行在其上的 pilot agent。控制面 SOT。
min_binary_version: "0.1.0"
---

# hangar — 控制面契约

本文件是 **契约(design-first)**:CLI 实现必须满足这里的 I/O 形状,不是反过来。字段标 `(v0 待定)` 的在 Phase 0 定稿后回填。

**约定:** 所有命令 `--json` 输出结构化结果到 stdout;日志到 stderr;退出码 `0` 成功 / `1` 业务失败 / `2` 参数错误。写操作拒绝 root。任何命令的**非预期错误**(如无法解析进程指纹)→ 通用兜底 error kind `internal`(退出码 1),不再逐条列在每命令下。

---

## `hangar doctor [--json]`

**用途:** 会话起始 ping,把环境前置检查显式化。
**参数:** 无。
**返回:**
```json
{ "ok": true,
  "capabilities": [ "hangar.run.trigger-kind/v1", "hangar.run.abort-signal/v1", "hangar.run.cancelled-terminal/v1", "hangar.run.runtime-capabilities/v1" ],
  "checks": { "node": "ok", "pnpm": "ok", "sqlite_writable": "ok", "apps_dir": "ok",
              "apps": [ { "id": "inbox", "spec": "ok", "pipeline": "ok", "enabled": true } ],
              "blocked": [] } }
```
**健康经 `ok` 表达(退出码恒 0、doctor 不抛 error kind):** 任一 check(`node`≥22.18 / `sqlite_writable` / `apps_dir` / 某 app 的 `spec`\|`pipeline`)非 `ok` → 顶层 `ok:false`。`checks.apps[]` 每项的 `enabled` = 该 app 是否启用(取自 `app.yaml`,缺省 `true`);**注册失败分支(无解析 spec)省略此键,消费方缺字段视作 `true`**(hangar-view 花名册排除据此字段——见 hangar-view spec)。`checks.blocked` = 被过期 parked run 阻塞的 app id 列表(派生、非持久化;**`enabled:false` 的 app 除外——不派生阻塞**)。`pnpm` 仅报形、不计入 `ok`。
**`capabilities[]`(顶层、独立于 `ok`/`checks`,不计入健康):** 真机 host 二进制的版本化能力集(`hangar.run.<name>/vN`),现含 `hangar.run.trigger-kind/v1` + `hangar.run.abort-signal/v1` + `hangar.run.cancelled-terminal/v1` + `hangar.run.runtime-capabilities/v1`。它是给**外部 adapter** 的部署期契约广播:部署脚本在启动前读它并对自带 required 集做精确匹配(`/v2` 不满足 `/v1`),缺任一即 fail closed。host 在每次 `run(ctx)` 时还会从同一 canonical set 注入新鲜冻结的 `ctx.capabilities`;adapter 应在 run 内业务副作用前再校验该快照。模块 import 必须无业务副作用,因为运行期快照只能从 `run(ctx)` 入口开始保护。**广播闸语义(release-time 纪律):** 一个能力串 MUST NOT 出现在集合里,除非同一 build 真提供其契约——特别地,`hangar.run.hard-crash-containment/v1`(OS 子孙进程回收)**只有其实现通过 fault test(CI 全绿)后才会出现**;它当前未广播 = 该实现尚未落地,要求它的 adapter 会 fail closed(设计见 openspec/specs/host-capabilities)。
**Agent 约定:** 任一 check 非 `ok` 时,先修环境,别急着 `run`。

## `hangar status [--json]`

**用途:** 所有 app 当前状态一览(读 SQLite,只读)。
**返回:** `[{ "app": "inbox", "lastRun": "run_a3f", "state": "waiting_human", "since": "<iso>", "blocked": false }]`(`blocked` = 被过期 parked run 阻塞,派生)
**state 取值:** `queued|running|waiting_human|executing|completed|failed|cancelled`(由 RunEvent 推导)。
**Agent 约定:** 看到 `waiting_human` → 该 run 在等人拍板,引导用户去 `trace` 看待批动作。

## `hangar runs [<app>] [--limit N] [--json]`

**用途:** run 历史(可按 app 过滤)。`--limit N`(正整数,否则退出码 2)只取最近 N 条(started_at DESC)——管道消费者(如 hangar-view)据此把输出收小,避开大历史下写完即 `process.exit` 截断管道 stdout 的坑,并防无界增长。
**返回:** `[{ "id": "run_a3f", "app": "inbox", "state": "completed", "trigger": "cron", "startedAt": "<iso>", "endedAt": "<iso>" }]`

## `hangar trace <run> [--json]`

**用途:** 某 run 的完整事件时间线 + 待批动作。
**返回:**
```json
{ "run": "run_a3f", "app": "inbox", "state": "waiting_human",
  "events": [ { "seq": 1, "kind": "run.started", "at": "<iso>", "payload": {} },
              { "seq": 2, "kind": "approval.requested", "at": "<iso>",
                "payload": { "approvalId": "apr_1", "tool": "gmail.send", "args": { } } } ],
  "pendingApprovals": [ { "id": "apr_1", "tool": "gmail.send", "args": { } } ] }
```
**Agent 约定:** 向用户复述 `pendingApprovals` 的 `tool` + `args` 摘要,让其决定 approve/reject。

## `hangar run <app> [--input <json>] [--json]`

**用途:** 手动触发一次 run(绕过 cron)。**写操作,拒绝 root。** 运行中按 Ctrl-C(SIGINT)→ abort 该 run、配合的 pipeline 经 choke-point 记 `run.cancelled`;第二次 Ctrl-C 回落 Node 默认强杀。
**返回:** `{ "run": "run_a3f", "state": "waiting_human|completed|failed|cancelled" }`(`state:"failed"` 或 `state:"cancelled"`(被 SIGINT/abort 取消)→ 退出码 1;`waiting_human`(停泊等审批)/ `completed` → 0)
**错误 kind:** `app_not_found` · `spec_invalid` · `already_running`(run 锁)· `pipeline_missing`(run 时缺 `pipeline.ts`)· `executor_unsupported`(已知但未实现的 executor)· `internal`(如无法解析进程指纹时 fail loud)。

## `hangar approve <run> [--json]`

**用途:** 执行该 run 的全部待批动作,续跑至 `completed`。**写操作,拒绝 root。**
**返回:** `{ "run": "run_a3f", "state": "completed", "executed": [ { "tool": "gmail.send", "ok": true } ] }`。**某动作重试耗尽 → run 收束 `state:"failed"`、该动作 `ok:false`、退出码 1**(明细仍在 JSON;失败不是单独的 error kind)。
**错误 kind:** `run_not_found` · `app_not_found`(run 的 app 已注销)· `not_waiting`(run 非 `waiting_human`)· `no_pending_approval`。(动作/handler 执行失败**不是 error kind**——折成 `state:"failed"`,见上。)
**Agent 约定:** 高危动作 approve 前**务必向人确认**动作内容,不代人拍板;**退出码 1 或 `state:"failed"` = 动作没成功**,别当已完成。

## `hangar reject <run> [--reason <text>] [--json]`

**用途:** 驳回待批动作,run 收束(不执行)。**写操作,拒绝 root。**
**返回:** `{ "run": "run_a3f", "state": "cancelled", "rejected": ["apr_1"] }`(用户主动驳回、语义上成功 → 退出码 `0`;与 `hangar run` 被 SIGINT/abort 取消的 `cancelled`(退出码 1)靠命令来源区分,同为 `cancelled` 态不同码)
**错误 kind:** `run_not_found` · `app_not_found`(run 的 app 已注销)· `not_waiting`(run 非 `waiting_human`)。

---

## 不暴露给 Agent 的能力(别调)

- **`hangar daemon`** —— 长驻 cron 进程,会挂住会话。由用户/系统在自己终端或容器里跑,Agent 不碰。**停机语义(优雅取消 vs 硬杀):** 收 SIGINT/SIGTERM → 优雅停机:置 `shuttingDown`(停机窗口内 cron 不再 fire)→ abort 全部 active run → 宽限期(`HANGAR_SHUTDOWN_GRACE_MS`,默认 ~5s)内等配合 signal 的 pipeline 收束记 `run.cancelled`(非盲 sleep)后退出;宽限内未收束者(忽略 signal / cleanup 过久)留非终态,由下次启动的 reaper 判 `run.failed`(cleanup-timeout)。二次信号(SIGINT 后 SIGTERM)幂等、不重入。硬杀(SIGKILL / 掉电)不走此路径——同样留非终态、靠 reaper 回收。
- **直接读写 `hangar.sqlite`** —— 一切经 CLI。绕过 = 破坏 run 锁与事件时序。
- **`hangar run` 的无限循环重试** —— `already_running` 时不要盲目重试,先 `status`/`trace` 看清。

---

## 备注

多 host 打包(`packaging/<host>/…`、marketplace.json)属「给别人用」赌注,**当前不做**(见 ROADMAP「明确不在路线图上」)。本 SKILL.md 现阶段只服务你自己的 Claude Code 驱动。
