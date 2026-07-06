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
  "checks": { "node": "ok", "pnpm": "ok", "sqlite_writable": "ok", "apps_dir": "ok",
              "apps": [ { "id": "inbox", "spec": "ok", "pipeline": "ok" } ],
              "blocked": [] } }
```
**健康经 `ok` 表达(退出码恒 0、doctor 不抛 error kind):** 任一 check(`node`≥22.18 / `sqlite_writable` / `apps_dir` / 某 app 的 `spec`\|`pipeline`)非 `ok` → 顶层 `ok:false`。`checks.blocked` = 被过期 parked run 阻塞的 app id 列表(派生、非持久化)。`pnpm` 仅报形、不计入 `ok`。
**Agent 约定:** 任一 check 非 `ok` 时,先修环境,别急着 `run`。

## `hangar status [--json]`

**用途:** 所有 app 当前状态一览(读 SQLite,只读)。
**返回:** `[{ "app": "inbox", "lastRun": "run_a3f", "state": "waiting_human", "since": "<iso>", "blocked": false }]`(`blocked` = 被过期 parked run 阻塞,派生)
**state 取值:** `queued|running|waiting_human|executing|completed|failed|cancelled`(由 RunEvent 推导)。
**Agent 约定:** 看到 `waiting_human` → 该 run 在等人拍板,引导用户去 `trace` 看待批动作。

## `hangar runs [<app>] [--json]`

**用途:** run 历史(可按 app 过滤)。
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

**用途:** 手动触发一次 run(绕过 cron)。**写操作,拒绝 root。**
**返回:** `{ "run": "run_a3f", "state": "waiting_human|completed|failed" }`(`state:"failed"` → 退出码 1;`waiting_human`(停泊等审批)/ `completed` → 0)
**错误 kind:** `app_not_found` · `spec_invalid` · `already_running`(run 锁)· `pipeline_missing`(run 时缺 `pipeline.ts`)· `executor_unsupported`(已知但未实现的 executor)· `internal`(如无法解析进程指纹时 fail loud)。

## `hangar approve <run> [--json]`

**用途:** 执行该 run 的全部待批动作,续跑至 `completed`。**写操作,拒绝 root。**
**返回:** `{ "run": "run_a3f", "state": "completed", "executed": [ { "tool": "gmail.send", "ok": true } ] }`。**某动作重试耗尽 → run 收束 `state:"failed"`、该动作 `ok:false`、退出码 1**(明细仍在 JSON;失败不是单独的 error kind)。
**错误 kind:** `run_not_found` · `app_not_found`(run 的 app 已注销)· `not_waiting`(run 非 `waiting_human`)· `no_pending_approval`。(动作/handler 执行失败**不是 error kind**——折成 `state:"failed"`,见上。)
**Agent 约定:** 高危动作 approve 前**务必向人确认**动作内容,不代人拍板;**退出码 1 或 `state:"failed"` = 动作没成功**,别当已完成。

## `hangar reject <run> [--reason <text>] [--json]`

**用途:** 驳回待批动作,run 收束(不执行)。**写操作,拒绝 root。**
**返回:** `{ "run": "run_a3f", "state": "cancelled", "rejected": ["apr_1"] }`
**错误 kind:** `run_not_found` · `app_not_found`(run 的 app 已注销)· `not_waiting`(run 非 `waiting_human`)。

---

## 不暴露给 Agent 的能力(别调)

- **`hangar daemon`** —— 长驻 cron 进程,会挂住会话。由用户/系统在自己终端或容器里跑,Agent 不碰。
- **直接读写 `hangar.sqlite`** —— 一切经 CLI。绕过 = 破坏 run 锁与事件时序。
- **`hangar run` 的无限循环重试** —— `already_running` 时不要盲目重试,先 `status`/`trace` 看清。

---

## 备注

多 host 打包(`packaging/<host>/…`、marketplace.json)属「给别人用」赌注,**当前不做**(见 ROADMAP「明确不在路线图上」)。本 SKILL.md 现阶段只服务你自己的 Claude Code 驱动。
