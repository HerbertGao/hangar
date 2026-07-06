# ci 规范

## 目的
待定 - 由归档变更 add-ci 创建。归档后请更新目的。
## 需求
### 需求:每个 PR 与 main push 必须过 typecheck + test + build 合并门
CI 必须在 `pull_request` 与 `push` 到 `main` 时,以冻结的 lockfile 安装依赖并依次跑 `typecheck` / `test` / `build`;任一步失败必须使该次 run 变红。lockfile 与 `package.json` 不一致时安装必须直接失败(禁止 CI 悄悄改写 lockfile 后放行)。**「合并门」的强制力必须由 `main` 的 required status check(branch protection / ruleset)提供**——仅有 workflow 不阻止合并,红 run 在未设 required check 时仍可被合入,故该设置是本需求的一部分。

#### 场景:破坏性改动被合并门挡下
- **当** 一个 PR 引入了类型错误或使测试失败的改动
- **那么** CI run 必须变红(非 0 退出),对应 typecheck 或 test 步骤必须报失败

#### 场景:红 run 必须真正阻止合并
- **当** `CI` 已被设为 `main` 的 required status check、且某 PR 的 CI run 为红
- **那么** 该 PR 必须无法合并(GitHub 依 required check 拦截),使「门」有强制力而非仅有信号

#### 场景:lockfile 漂移被拒
- **当** `package.json` 改了依赖但 `pnpm-lock.yaml` 未同步更新
- **那么** `pnpm install --frozen-lockfile` 必须失败,禁止继续后续步骤

#### 场景:原生模块可在 CI 构建
- **当** CI 在干净的 ubuntu runner 上安装依赖
- **那么** `better-sqlite3` 必须按 `onlyBuiltDependencies` 白名单成功构建,使 `test` 能真正打开 SQLite

### 需求:依赖必须由 dependabot 每周跟版
仓库必须配置 dependabot 每周为 `npm`(workspace 根 `/`)与 `github-actions` 生态提交更新 PR;由于根 `package.json` 零依赖,npm 更新必须覆盖 `packages/core` / `apps/heartbeat` 等 workspace member 的依赖(经根 `pnpm-lock.yaml` + `pnpm-workspace.yaml` 发现)。`@types/node` 的 major 升级必须被 ignore——冻结当前 major 避免 churn、随运行时有计划地手动升,禁止把 ignore 说成「让 types 跟上运行时」。

#### 场景:每周 npm 更新覆盖 member 依赖
- **当** 某个 workspace member 的 npm 依赖(如 `packages/core` 的 `zod`)有新版本
- **那么** dependabot 必须(至多每周)开一个升级 PR,并因此触发 CI 合并门;禁止只因该依赖不在根 `package.json` 就静默漏跟

#### 场景:@types/node major 不抢跑
- **当** `@types/node` 发布了新的 major 版本
- **那么** dependabot 禁止为该 major 自动开 PR(须随运行时有计划地手动升)

