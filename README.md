# Hangar v2

这个分支（`v2`）是从空树重建的 Hangar v2 起点，不携带 v0 的任何实现代码或提交历史。

## 读之前

1. `DESIGN.md` —— 架构 SOT
2. `ROADMAP.md` —— 阶段、预算、出口闸与止损
3. `docs/proposals/control-core-v2-migration.md` —— 完整迁移论证
4. `docs/proposals/personal-agent-builder.md` —— 产品方向与外部候选验证依据（历史背景，非当前 SOT）
5. `openspec/config.yaml` —— OpenSpec 生成上下文
6. `CLAUDE.md` —— 在本分支工作的护栏

这六份文件是 `DESIGN.md` §15「SOT 关系」定义的 v2 文档集合，本分支原样带来。

## 老分支只作参考，不是迁移路径

v0 的完整实现、四表 SQLite、CLI、`SKILL.md`、`openspec/specs/`（v0 行为 oracle）与
`docs/archive/v0-sot-2026-08-04/`（v0 版 DESIGN/ROADMAP/CLAUDE 归档）都保留在本仓库的既有分支上
（如 `main`、`hard-crash-containment`），可以用

```bash
git log main
git show main:openspec/specs/<spec>.md
git show main:docs/archive/v0-sot-2026-08-04/DESIGN.md
```

之类的命令随时查阅，作为行为参照。**本分支不会从这些分支合并或变基**——v2 是按 `ROADMAP.md` 的
`contracts -> v2 state machine -> v2 SQLite -> fake runtime -> heartbeat` 顺序从零搭建，不做 v0
strangler cutover 本身（cutover 仍会按 `DESIGN.md` §11 逐 Agent 进行，但迁移的是运行中的 Agent，不是这份代码树）。

## 当前进度

M0 尚未完成——按 `ROADMAP.md`，M0 未通过前不实现与 SOT 冲突的大规模 v2 代码。
