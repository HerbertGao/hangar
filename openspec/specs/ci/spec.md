# ci 规范

## 目的
待定 - 由归档变更 add-ci 创建。归档后请更新目的。
## 需求
### 需求:每个 PR 与 main push 必须过 typecheck + test + build 合并门
CI 必须在 `pull_request` 与 `push` 到 `main` 时,以冻结的 lockfile 安装依赖并依次跑 `typecheck` / `test` / `build`;任一步失败必须使该次 run 变红。lockfile 与 `package.json` 不一致时安装必须直接失败(禁止 CI 悄悄改写 lockfile 后放行)。**「合并门」的强制力必须由 `main` 的 required status check(branch protection / ruleset)提供**——仅有 workflow 不阻止合并,红 run 在未设 required check 时仍可被合入,故该设置是本需求的一部分。

**CI 的 Node 版本必须来自仓内单一来源。** workflow 必须以 `.nvmrc` 为版本来源(`node-version-file`),不得在 workflow 里另写一个版本号——两个独立 pin 会漂移,而漂移的方向恰好是「CI 绿而本机坏」或反之。

**代价必须记账,MUST NOT 声称有替代品。** `.nvmrc` 里是裸 major,CI 与主机都解析到该 major 的最新版,故**「代码在下限那个确切补丁版上真能跑」这项覆盖不再存在** —— 本仓刻意接受该损失(唯一消费者是一台自己跟随 `.nvmrc` 的主机)。`MIN_NODE` 的单元断言只证明**比较函数**正确,MUST NOT 被表述为该运行时覆盖的替代:一个「用了下限之后才加入的 API」的回归,任何常量断言都抓不到。

**「单一来源」必须由一个自检强制,而不是仅由文档声明。** 必须有一个跑在 `pnpm test` 里的断言核对:`.nvmrc` 的 major 与**三个运行时包**(仓根 / `packages/core` / `packages/hangar-view`)的 `engines`、与 `MIN_NODE` 的**实际行为**一致,且 workflow 里没有第二个 node 版本 pin(任何形式,不限数字——`lts/*` 同样禁止,且注释掉的键不得满足该断言)。**发布到 npm 的包不在此列**:`packages/notify` 的下限刻意更低,该断言必须**反向钉住**它,好让「统一版本」的顺手改动撞上红测试。`engines` 自身只是 advisory(不匹配是 pnpm WARN + 退 0),没有该断言时改一处漏其余不会让任何测试变红。**把所有声明一起改到另一个 major 是刻意决定,SHALL 允许通过**;该断言只挡「改了一处、漏了其余」,那才是 ABI 不匹配的成因。

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
- **那么** `better-sqlite3` 必须成功构建(其 build 脚本须被 pnpm 的 build 批准名单放行),使 `test` 能真正打开 SQLite。**批准名单的配置位置随 pnpm 版本变化**(`pnpm-workspace.yaml` 在 10 与 11 上都生效;`package.json` 的 `pnpm` 字段自 **11** 起不再被读取),故本场景 MUST NOT 点名某个具体配置键——**判据是「build 真的发生了」,不是「某个 key 存在」**;一个写在已废位置的名单会让 install 照样退 0,而产物缺失只在运行时暴露

#### 场景:Node 版本只有一个来源
- **当** 需要知道 CI 用哪个 Node 跑
- **那么** 答案只能来自 `.nvmrc`;workflow 内不得出现第二个版本号,`engines` 与 `MIN_NODE` 必须与之同 major

#### 场景:声明漂移会让测试变红
- **当** 只改了 `.nvmrc`、某一处 `engines` 或 `MIN_NODE` 中的一个,其余未同步
- **那么** `pnpm test` 必须变红并指出不一致的那一处;`.nvmrc` 若被换成 `lts/*` 之类无法 glob 出 major 的别名,同样必须变红(部署脚本按 major glob 选运行时)

### 需求:依赖必须由 dependabot 每周跟版
仓库必须配置 dependabot 每周为 `npm`(workspace 根 `/`)与 `github-actions` 生态提交更新 PR;由于根 `package.json` 零依赖,npm 更新必须覆盖 `packages/core` / `apps/heartbeat` 等 workspace member 的依赖(经根 `pnpm-lock.yaml` + `pnpm-workspace.yaml` 发现)。`@types/node` 的 major 升级必须被 ignore——冻结当前 major 避免 churn、随运行时有计划地手动升,禁止把 ignore 说成「让 types 跟上运行时」。

#### 场景:每周 npm 更新覆盖 member 依赖
- **当** 某个 workspace member 的 npm 依赖(如 `packages/core` 的 `zod`)有新版本
- **那么** dependabot 必须(至多每周)开一个升级 PR,并因此触发 CI 合并门;禁止只因该依赖不在根 `package.json` 就静默漏跟

#### 场景:@types/node major 不抢跑
- **当** `@types/node` 发布了新的 major 版本
- **那么** dependabot 禁止为该 major 自动开 PR(须随运行时有计划地手动升)

