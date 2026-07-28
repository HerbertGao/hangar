## Why

inbox-pilot 已要求 Node `^24`,而本仓声明 `>=22.18.0`。因为 `apps/inbox` 是指向那个 checkout 的 symlink 且被 `pnpm-workspace.yaml` 的 `apps/*` 收进 workspace,每次 `pnpm install` 都会用本机 Node 22 去校验它的 `^24` → 一条常驻的 engine 警告。**这不是噪音,是一个真实的版本分叉**:同一台生产主机上,daemon 跑 hangar 的 CLI、pilot 是 inbox 的编译产物,两边对运行时的承诺不一致。

**本变更反转一个有论证的既有决定。** 归档的 `add-ci` 明确写过「inbox-pilot 用 24 是其自身承诺;不照抄版本号」「矩阵 `[22, 24]` 对一个 4 表玩具是过度」。那个论证在当时成立:22.18 的下限是为了拿到**免 flag 的 `.ts` 类型剥离**(外部 pilot 的 `pipeline.ts` 回退路径依赖它),而钉住确切下限是为了「测下限」。现在推翻它的理由不是「24 更新」,而是**两个仓共用一台主机、共用一个 pnpm workspace,版本分叉的管理成本已经真实发生**;而 24 同样满足类型剥离,原论证的技术前提没有失效、只是不再是决定性的。

顺带把 `onlyBuiltDependencies` 从根 `package.json` 的 `pnpm` 字段迁到 `pnpm-workspace.yaml`。**这是向前兼容的搬迁,不是在修一个正在发生的故障**:新位置对 pnpm 10 与 11 都生效,而 `package.json` 的 `pnpm` 字段自 **pnpm 11** 起才不再被读取——被 `packageManager` 钉住的 10.28.2 仍然读旧位置(隔离环境三臂实测:名单缺失 → `Ignored build scripts` 且无 `.node`;只在旧位置 → build 被放行、`.node` 产出;只在新位置 → 同样产出)。

**这条极易误判**:PATH 上外层 pnpm 11 打出的 `The "pnpm" field ... is no longer read` 不代表被 `packageManager` 钉住的那个版本的行为(陷阱与正确的核验命令见 `pnpm-workspace.yaml` 的注释,唯一副本)。它与 Node 升级无关,但升级必然触发原生模块重编,故同变更做掉。

## What Changes

- **Node 下限从 `>=22.18.0` 抬到 `>=24`**,四处声明与一处运行时门同步:`.nvmrc`、根 + `packages/core` + `packages/hangar-view` 的 `engines`,以及 `packages/core/src/cli.ts` 的 `MIN_NODE`。**只有 `MIN_NODE` 是门**——它喂 `doctor.checks.node`,而 `hangar-view` 在该 check 非 `ok` 时整页降级(`hangar-view` spec 里 normative 的行为;写错会让生产 dashboard 变白);三处 `engines` 全是 advisory,不匹配只是 pnpm 的 WARN + 退 0。用 `>=24` 而非 `^24`:`MIN_NODE` 无上界,caret 有,两者并存就是「node 25 上 doctor 报绿而三处 engines 宣称不支持」。**一个下限,写成下限。**
- **CI 收成单一版本来源**:`node-version: 22.18.0` 硬编码 → `node-version-file: .nvmrc`(与外部 pilot 同法)。**这是对 `add-ci` 「钉确切下限以测下限」的第二处反转,而它并未驳倒原论证。** 原论证要买的是「用了下限之后才加入的 API」这类回归,`.nvmrc` 里的裸 major 解析到该 major 最新版,该覆盖**就此消失**;`MIN_NODE` 的单元断言只证明比较函数正确,抓不到那一类,不能算替代(此前本变更如此声称,是范畴错误)。另外那两个 pin 并非「意外漂移」而是**刻意的不对称**(`.nvmrc` = 开发用当前版,CI = 下限),各有职责。真正的取舍是:唯一消费者是一台自己跟随 `.nvmrc` 的主机,单一来源的收益超过该覆盖的价值,**故接受这项损失并记账**。无损方案(`.nvmrc` 写 `24.0.0`,仍是单一来源)被否决:那会把生产主机钉在该 major 最老的补丁上,拿不到安全修复,代价高于所买的覆盖。
- **「单一来源」由一个自检强制,不只写在文档里**:`cli.test.ts` 核对 `.nvmrc` 的 major 与三处 `engines`、与 `MIN_NODE` 的实际行为一致,且 workflow 里没有第二个版本号。所有声明一起改 major 是刻意决定、放行;该断言只挡漂移。**放行的门槛比看起来高**:实测要**六处**一起改才全绿(`.nvmrc` + 三处 `engines` + `MIN_NODE` + `cli.test.ts` 里那几条带方向的字面量),只改五处仍然红;而那三条方向断言(`nodeSupported('22.18.0') === false`)必须由降级者亲手翻转 —— 「重新钉一个确切版本」那部分覆盖其实以**方向**的形式活了下来。另外还有一条没人写下来的约束:一致降级只在 minor 为 0 时被放行,回到本变更的前身 `22.18` 是**红**的(`MIN_NODE must admit 22.0.0`),所以它没法被悄悄半回滚。
- **`onlyBuiltDependencies` 迁到 `pnpm-workspace.yaml`**(对 10 与 11 都生效的位置),并出 `ci` spec delta 把那条 normative 场景的措辞从「按 `onlyBuiltDependencies` 白名单」改成不点具体配置键名的表述——**点名一个键正是它悄悄失效时没人发现的原因**。
- **`packages/notify` 的 `engines` 保持 `>=22.18.0` 不动。** 它是发布到 npm 的包(`@herbertgao/hangar-notify`),抬下限是对下游消费者的 breaking change,而它是纯配置解析器(`yaml` + `zod`,零原生模块),在 22 上继续可用(已实测其 13 个测试在 22 上全过)。**版本对齐的理由到仓边界为止,不延伸到已发布的库。** 但要记一笔代价:旧 CI 钉的正好是 `22.18.0`,`pnpm -r test` 因此每个 PR 都在它宣称的下限上真跑一次 notify;CI 改跟 `.nvmrc` 后,**该下限只剩声明、不再被任何东西执行**。它当前零原生依赖、只 import `node:{fs,os,path,child_process}`,故风险低;若它日后长出非平凡运行时面,要么抬下限、要么给它单独加一个 22 的 job。此处不做(YAGNI),但 `cli.test.ts` 的 pin 断言把这个 `>=22.18.0` 钉住了,好让下一次「统一版本」的顺手改动撞上一个红测试。
- **部署脚本解钉并补自检**:`packages/hangar-view/deploy/hangar-view.sh` 的 `v22*` glob 改为读 `$HANGAR/.nvmrc` 的 major(否则升级后它仍选 22,view + 它 spawn 的 CLI 会留在旧 ABI),并**断言选中的 node 真是那个 major**——`NODE=` 覆盖(README 就教运维设它)与 PATH 兜底都不受 `.nvmrc` 约束,而 `-x` 连 `/usr/bin/true` 都放行。新增 `hangar-view.test.sh` 接进 `pnpm test`:每条守卫一个用例,失败用例断言**非零退出且 stderr 非空**——静默死亡与响亮退出都非零,只有后半句能分辨(为什么会静默死亡见 `hangar-view.sh` 头部注释)。`deploy/README.md` 的 node 版本表述同步。

## 非目标

- **不引入 Node 版本矩阵。** CI 仍只跑一个版本。`add-ci` 判过「矩阵对一个 4 表玩具是过度」,这条**不反转**。
- **不抬 `packages/notify` 的 engines**(见上)。
- **不动 `apps/inbox/**`** —— 它是 symlink 出去的外部 checkout,`git ls-files` 为空,`.gitignore` 显式排除。那边的 `^24` 是它自己的承诺。
- **不升 `@types/node`**(已是 `^26`,超前于两个运行时;dependabot 对其 major 的 ignore 保持)。
- **不改 `tsconfig`** 的 target/lib(`ES2022`/`NodeNext` 在 24 上不变)。
- **不做「同时支持 22 和 24」的兼容层。** 抬下限就是抬下限;要回退就整条变更回退。
- **不给 `doctor` 加原生绑定/ABI 检查**(理由见 Impact 的「已知未覆盖」)。
- **不升 `packageManager` 到 pnpm 11。** 迁走 `onlyBuiltDependencies` 后两个版本都能用,升级 pnpm 是独立赌注。

## Impact

- 受影响规范:`ci`(一处 MODIFIED —— 原生模块构建场景不再点名具体配置键;单一来源须由自检强制;新增一条漂移必须变红的场景)。
- 受影响代码:`packages/core/src/cli.ts`(`MIN_NODE` + 其上的说明注释)、`packages/core/src/cli.test.ts`(版本断言 + 新增 pin 一致性断言)。
- 新增文件:`packages/hangar-view/deploy/hangar-view.test.sh`(启动脚本自检,接进该包的 `test`)。
- 受影响配置:`.nvmrc`、根 `package.json`(`engines` + 删除死的 `pnpm` 字段)、`pnpm-workspace.yaml`(接收 `onlyBuiltDependencies`)、`packages/core` 与 `packages/hangar-view` 的 `engines`、`.github/workflows/ci.yml`。
- 受影响部署物:`packages/hangar-view/deploy/hangar-view.sh`、`deploy/README.md`、`SKILL.md`(doctor 契约里的 node 下限,由 ≥22.18 改成 ≥24)、`docs/proposals/followups-command-write-path.md`(它硬钉了一个 `v22.23.1` 的 fnm 绝对路径并让人把它固化进构建命令——照它做会造出本变更要防的那个 ABI 不匹配)。
- **不受影响**:`packages/notify`(engines 与 README 都不动)、`apps/inbox`(外部 checkout)、`tsconfig.base.json`、SQLite schema、Run 状态机。**脊柱零新增能力**——不变量 #2 在此已被满足而非绕过:本变更的全部理由都是那个外部 pilot 的运行时承诺,没给脊柱加任何东西。
- **需要协调的生产步骤(不是仓内编辑能完成的)**:切换序列见 `tasks.md` §5(唯一副本,别在这里复述——一个有序过程两份权威副本必然漂移)。唯一要在此强调的机制:跨 major 坏在**共享的那一个 `.node`** 上,**不是 `hangar.sqlite`**(SQLite 文件格式与运行时无关,DB 文件跨 major 兼容);详见 `cli.ts` 头部注释。

### 已知未覆盖(不假装)

- **`doctor` 查不出 ABI 不匹配。** `checks.sqlite_writable` 只做 `accessSync(W_OK)`,从不开库(刻意:doctor 必须非破坏、且首次运行前 DB 尚不存在),所以在 straddle 状态下它照样报 `ok`、view 页面照样正常。故 `tasks.md` §5.7 的核验**不能**只看 `doctor`,必须跑一条真开库的只读命令。**检测钩子其实已经在那儿了**:`doctor` 为算 `blocked` 已经 `openDbReadonly` 开过库,`ERR_DLOPEN_FAILED` 被它自己的 try/catch 吞掉、报 `blocked: []`(那个 try/catch 是刻意的——doctor 必须永远返回一份报告)。所以成本不在「加检测」,而在**报告形状**:多一个 check 键要同时改 `SKILL.md` 与 `hangar-view` 两处 normative 的 doctor 契约。仍不塞进一次版本抬升;而 straddle 在它发生的地方是响亮的(off-major 那侧直接起不来),不是静默损坏。
- **「代码在 24.0.0 上真能跑」无人验证**(理由与取舍见上文 CI 那条)。
- **`@types/node` 是 `^26`,高于运行时下限 `>=24`,故 typecheck 不是兼容性门。** 一个只在 Node 26 才有的 API 能通过类型检查、却在生产的 24 上炸。这是全仓既有状态(`core`/`notify`/`pgconfig` 一致)且上面的非目标明确不动它——记在这里只为一件事:**别把「typecheck 绿」当成「在下限上能跑」**。
