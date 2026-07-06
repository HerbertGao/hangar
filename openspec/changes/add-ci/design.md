## 上下文

hangar 是 pnpm workspace(`packages/core` 脊柱 + `apps/heartbeat` 玩具),Node ≥22.18.0,已提交 `pnpm-lock.yaml`。`@hangar/core` 有真测试(`node --import tsx --test src/*.test.ts`,依赖原生 `better-sqlite3`)、`typecheck`、`build`(`tsc`)。参考项目 inbox-pilot 的 `.github/` 有三件套:`ci.yml`(build-only)、`eval.yml`(LLM 回归门)、`dependabot.yml`。hangar 无模型,故只借鉴 ci + dependabot 两者的形。默认分支 `main`。

## 目标 / 非目标

**目标:**
- 每个 PR / main push 上有一道机器合并门,`typecheck` + `test` + `build` 全绿才算过。
- 依赖与 GitHub Actions 每周自动跟版。
- 零源码改动、零架构不变量触碰。

**非目标:**
- LLM/eval 工作流(无模型)。多 Node 版本矩阵。发布/publish、覆盖率门、缓存调优、self-hosted runner。

## 决策

**D1 — 跑 typecheck+test+build,而非 inbox-pilot 的 build-only。**
inbox-pilot 的 `ci.yml` 只 build,因其测试需要真 DB(用 `prisma validate` 占位绕开)。hangar 的测试无外部依赖——`better-sqlite3` 是进程内文件库,CI 上开临时库即可真跑。故合并门直接纳入 `test`,把回归挡在源头。三步用根 `package.json` 已有的 `pnpm -r {typecheck,test,build}`,CI 不引入新脚本。

**D2 — Node 版本钉在声明的下限 `22.18.0`,单版本无矩阵。**
`engines.node` 承诺 `>=22.18.0`,CI 就测这个下限——能抓「不小心用了 Node 24+ API」。**`node-version` 写完整的 `22.18.0`、不写裸 `22`**:后者被 `setup-node` 解析成「最新 22.x」,只能抓 24+、抓不到「用了 22.19+ 才有的 API 但用户跑在 22.18」这类下限回归;要「测下限」就得钉下限。inbox-pilot 用 24 是其自身承诺;不照抄版本号。矩阵 [22,24] 对一个 4 表玩具是过度,YAGNI,真需要多版本支持时再加一行。

**D3 — 不移植 `eval.yml`。** hangar 无 prompt/classifier/模型调用,LLM 回归门无对象。

**D4 — dependabot 两生态 + ignore `@types/node` major。**
`npm` + `github-actions` 两条 update,均 weekly、**每条都要 `directory: "/"`**(dependabot schema 要求每条 update 有 `directory`/`directories`,漏了整份配置报错)。**`directory: "/"` 是 pnpm workspace 的正确形**:根有单个 `pnpm-lock.yaml`(v9),dependabot 由此 + `pnpm-workspace.yaml` 的 package globs 发现各 member 的依赖——**不要**换成 `directories:`(那是给多个独立 lockfile 用的)。⚠️ 载荷全压在这条发现路径上:根 `package.json` 零依赖,`better-sqlite3` / `zod` / `pino` 等全在 `packages/core`,若 dependabot 没遍历到 member 就是**静默零 PR、无报错**——故 task 4.1 的验收必须真确认 member 依赖被跟踪(见 tasks),不能只验「YAML 能解析」。
`@types/node` 现为 `^26`、运行时下限 Node 22(此错配是**既有状态**、非本变更引入);ignore 其 major 只是**冻结当前 major、避免 churn**,由人随运行时有计划地手动升——**不宣称「让 types 跟上 Node 22」**(那不成立:真守卫是跑在 Node 22 的 test job)。暂不做依赖分组——hangar 没有 inbox-pilot 那种「CLI/client 必须同主版本」的强耦合对,无分组必要。

**D5 — `--frozen-lockfile` + `corepack enable`。**
lockfile 已提交,CI 用 corepack 锁 `pnpm@10.28.2`(读 `packageManager` 字段),冻结安装拒绝漂移。(已知低概率坑:很旧的 bundled corepack + 明显更新的 pnpm 可能撞 signature-key 校验失败;Node 22.18+ 的 corepack 够新、基本不触发,真触发也是 CI 变红自暴露、非静默。)

**D6 — `permissions: contents: read`,最小权限。** 合并门只读仓库;dependabot PR 由平台侧代跑,无需 workflow 写权限。

**D7 — 「合并门」的强制力靠 branch protection,不靠 workflow 本身。**
workflow 只产生红/绿信号;红 run **仍可被合并**,除非把 `CI` check 设为 `main` 的 **required status check**(branch protection / ruleset)。⚠️ **required check 的 context 名 = job 名(不是 workflow 名)**:job 必须命名为 `CI`(`jobs.CI:`,见 task 1.1),否则设了名为 `CI` 的 required check 却没有 job 报出该 context → **永久 pending、所有 PR 被卡死**(比「红能合」更糟)。所以「合并门」这条 spec 需求要真成立,必须补一步仓库设置(见 tasks,repo-admin 动作、不在 YAML 里)。这一步是**完成用户要的「门」本身**,不是加新特性。

**D8 — 顺带两条便宜硬化(非「花哨」)。** `timeout-minutes`(挡住 hung install/test 烧满默认 360min)+ `concurrency`(取消被顶替的 PR run,省 runner、去噪),均为标准块、非目标未排除。`concurrency` **必须写成 block mapping**(`${{ }}` 里含 `{}`,塞不进 inline flow map `{ }`),canonical 形:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

`cancel-in-progress` 用 `event_name == 'pull_request'` 守住,避免取消 `main` 合并 run。其余(cache/matrix/publish/coverage)仍按非目标排除。

## 风险 / 权衡

- **原生模块在 CI 构建失败** → ubuntu-latest 自带 python3/make/g++,`better-sqlite3 ^12` 有 Node 22 prebuild;`onlyBuiltDependencies` 已白名单放行构建。若真失败,spec 的「原生模块可在 CI 构建」场景会立刻变红暴露。
- **钉 Node 22 漏掉 24-only 回归** → 可接受:我们承诺的就是 22 下限;跑 24 才是测了没承诺的东西。需要时 D2 加版本。
- **dependabot PR 噪音** → weekly(非 daily)已是最低频;无分组时每依赖一 PR,面小可忍,真吵了再加 `groups`。
