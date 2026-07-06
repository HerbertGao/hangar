## 为什么

仓库目前没有任何 CI：PR 能在 `typecheck` / `test` / `build` 全绿之前就合并,回归只能靠人肉本地跑;依赖也无人跟版,`better-sqlite3` / `zod` / `node-cron` 这类会静默落后并攒安全补丁。Phase 0 骨架刚落地、面还小,正是把「合并门」和「依赖跟版」固化成机器守卫的最省成本时机。

## 变更内容

- 新增 `.github/workflows/ci.yml`:`push`(main)与所有 `pull_request` 触发,跑 `pnpm install --frozen-lockfile` → `typecheck` → `test` → `build`。任一失败即红。**红 run 要真挡住合并,还需把 `CI` 设为 `main` 的 required status check(branch protection,repo-admin 一步)——workflow 只给信号、不给强制力。**
- 新增 `.github/dependabot.yml`:每周为 `npm`(workspace 根 `/`,dependabot 由根 `pnpm-lock.yaml` + `pnpm-workspace.yaml` 发现各 member 依赖)与 `github-actions` 提更新 PR;`@types/node` 的 major 被 ignore——**冻结当前 major、避免 churn**,随运行时有计划地手动升(不宣称「让 types 跟上 Node 22」)。
- **不移植** inbox-pilot 的 `eval.yml`——那是 LLM 评级回归门,hangar 无模型、无 prompt,不适用。

## 功能 (Capabilities)

### 新增功能
- `ci`: 仓库层面的合并门与依赖跟版守卫(不是脊柱能力,是 repo 治理的 fitness function)。

### 修改功能
<!-- 无:CI 不改任何已有 spine 规范的行为。 -->

## 影响

- 新增两个文件,均在 `.github/`;**零源码改动**,不碰 `@hangar/core` / `apps/`,不动 9 条架构不变量。
- 不变量 #2「inbox 用不到 = 不许进脊柱」不 gate 本变更——CI 是给**仓库**加守卫,不是给**脊柱**加能力,故无需回答「inbox-pilot 哪一行用它」。
- 依赖 CI 的现有脚本:`pnpm -r typecheck` / `pnpm -r test`(core 用 `node --import tsx --test`)/ `pnpm -r build`。原生模块 `better-sqlite3` 在 ubuntu-latest 上由 pnpm 按 `onlyBuiltDependencies` 白名单构建。

## 非目标

- **不做** LLM/eval 回归工作流(无模型)。
- **不做** 多 Node 版本矩阵——只测声明的运行时下限(Node 22),一个 job 够。
- **不做** 发布/publish 自动化、覆盖率门、badge、self-hosted runner、缓存调优——面小,先要「有门」而非「门花哨」。
