## 1. 把 build 批准名单迁到对 pnpm 10/11 都生效的位置(升级必然触发原生模块重编,故同变更做)

- [x] 1.1 `onlyBuiltDependencies: [better-sqlite3, esbuild]` 从根 `package.json` 的 `pnpm` 字段迁到 `pnpm-workspace.yaml`;删掉旧字段
- [x] 1.2 验证迁移真生效。**判据不能是「不再打印 `The "pnpm" field ... is no longer read`」** —— 那条警告在被 `packageManager` 钉住的 pnpm 10.28.2 上根本不打印(它由 PATH 上外层的 homebrew pnpm 11 打出后再委派),拿它当判据等于没测。正确做法:隔离目录三臂对照,且**直接跑被钉的那个 bundle**(`node ~/.cache/node/corepack/v1/pnpm/10.28.2/bin/pnpm.cjs`,不要用 PATH 上的 `pnpm`),断言「名单缺失 → `Ignored build scripts` 且无 `.node`」「只在旧位置 → 有 `.node`(pnpm 10 仍读旧位置)」「只在新位置 → 有 `.node`」。注意 pnpm 的隔离布局:`.node` 在 `node_modules/.pnpm/**` 下,`find` 必须带 `-L` 才跟得到
- [x] 1.3 **ABI 判据必须构造 `new Database(':memory:')`;`require()` 单独测不出来。** 实测:node 22 上 `require` 一个 ABI-137 的 `better-sqlite3` **退 0**(原生绑定是惰性加载的),只有开库才抛 `ERR_DLOPEN_FAILED: NODE_MODULE_VERSION 137 ... 127`。也不能用文件 mtime —— `prebuild-install` 解包保留归档时间戳,mtime 不变而二进制已换。核验命令(在 `packages/core` 下跑,better-sqlite3 链在那里):`node -e "new (require('better-sqlite3'))(':memory:').close()"`

## 2. 版本声明与运行时门

- [x] 2.1 `.nvmrc`:`22` → `24`
- [x] 2.2 `engines.node` → `>=24`(开放下限,理由见 2.8):根 `package.json`、`packages/core`、`packages/hangar-view`。**`packages/notify` 不动**(已发布到 npm,抬下限是下游 breaking;它零原生模块,22 上继续可用)
- [x] 2.3 `packages/core/src/cli.ts` 的 `MIN_NODE = { major: 22, minor: 18 }` → `{ major: 24, minor: 0 }`,并改上方解释 22.18 由来的注释(免 flag `.ts` 类型剥离在 24 仍默认开启,故原理由不失效、只是不再是下限的决定因素)
- [x] 2.4 `packages/core/src/cli.test.ts` 的版本断言改写:`23.x → false`、`24.0.0 → true`、`24.18.0 → true`、`22.18.0 → false`(方向反转,别只改数字)
- [x] 2.5 **确认 `doctor` 链路**:`MIN_NODE` → `doctorReport().checks.node` → `hangar-view` 的 `buildState()` 在 `checks.node !== 'ok'` 时整页降级(`hangar-view` spec 的 normative 行为)。已做的是**手工端到端核验**:同一份 `node_modules`,node 24 下 `checks.node === 'ok'`、node 22 下 `=== 'unsupported'` 并确认页面转成降级页框。**这不是一个测试** —— 仓里没有任何断言覆盖 `checks.node`,该链路目前靠 `nodeSupported` 的单元断言 + 这次一次性核验,断了不会变红
- [x] 2.6 `SKILL.md` 的 doctor 契约 `node`≥22.18 → ≥24
- [x] 2.7 **`cli.test.ts` 加 pin 一致性断言**:`.nvmrc` 的 major 与三处 `engines`(须为 `>=<major>` 形式)、与 `MIN_NODE` 的实际行为一致;`packages/notify` 的 `>=22.18.0` 反向钉住(挡「顺手统一版本」);`ci.yml` 用 `node-version-file` 且无**任何形式**的第二个 pin;`.nvmrc` 非数字(`lts/*` 别名)也要红。ci.yml 那两条要**先剥注释再匹配**,且负向检查不能只拒数字 —— 把真 key 注释掉换成 `node-version: lts/jod`、或并存一个 `lts/*` / `'>=24'`,「必须是数字」的检查全放行,而 setup-node 在两键都在时**优先** `node-version`。**变异验证:8 种部分漂移 + 3 种 ci.yml 绕过全被抓**;一致降级放行(那是刻意决定,不是漂移),而它要**六处**一起改才全绿(含 `cli.test.ts` 里那几条带方向的字面量),只改五处仍然红
- [x] 2.8 `engines` 用 `>=24` 而非 `^24`:`MIN_NODE` 是无上界的下限,caret 有上界,两者并存 = node 25 上 doctor 报绿而 `engines` 宣称不支持(且 `cli.test.ts` 断言 `nodeSupported('25.0.0') === true`)

## 3. CI

- [x] 3.0 **实测发现(node 22→24 的行为变化,探查时没预料到)**:`node --test` 的默认 reporter 从 TAP 换成 spec(`# pass N` → `ℹ pass N`)。任何 grep `# pass` 的脚本/CI 断言会**静默失效**(grep 无输出 ≠ 测试失败)。本仓不受影响:`pnpm test` 与 CI 都靠**退出码**判,不解析输出。**若日后有人写基于 `# pass` 的断言,这条是原因**
- [x] 3.1 `.github/workflows/ci.yml`:`node-version: 22.18.0` → `node-version-file: .nvmrc`
- [x] 3.2 CI 全绿(typecheck / test / build),且 `better-sqlite3` 在干净 ubuntu runner 上真被构建。**按日志判,不按退出码判**:`Ignored build scripts` 命中 0;install 日志有 `better-sqlite3 install$ prebuild-install || node-gyp rebuild --release` → `install: Done`;`packages/core` 99 个测试全过(名单若失效这里会是 `Could not locate the bindings file`)。run 只用 35s 是因为 `prebuild-install` 取到预编译包——**取到 prebuild 也算 build 发生了**,判据是 install 脚本被放行并执行,不是必须从源码编
- [x] 3.3 顺带在真 runner 上验掉一个仓内证不了的隐患:`hangar-view.test.sh` 的「fnm 无该 major」用例曾用 major 24,而被测脚本把 PATH 硬设成 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` —— ubuntu 镜像在 `/usr/bin` 自带 node,若它某天等于本仓 major,该用例会**在没人改一行代码的情况下**让 CI 变红。改用 major `99`(环境命不中)后,CI 上四组自检全过

## 4. 部署物解钉(仓内)

- [x] 4.1 `packages/hangar-view/deploy/hangar-view.sh` 的 `v22*` glob 改为读 **`$HANGAR/.nvmrc`** 的 major 拼路径(用 `$HANGAR` 而非 `$(dirname "$0")/../../..`:后者会从**脚本所在的 checkout** 读版本、却启动 `$HANGAR` 里的代码,两者不同就白读了;`$HANGAR` 第 9 行已算好、可被 `HANGAR_HOME` 覆盖)。**不解这个钉,升级后 view 与它 spawn 的 CLI 会留在旧 ABI**
- [x] 4.2 `deploy/README.md` 的 node 版本表述同步;顺带修一处**已经陈旧**的说法(`:49` 说 `hangar-view.sh` 默认走 `fnm exec --using 22`,而脚本实际是 glob)
- [x] 4.3 **每个探测命令加 `|| true`**(`.nvmrc` 缺失时的 `sed`、无匹配时的 `ls` glob)—— 不加,它们下面的响亮退出与 PATH 兜底全是死代码。机制见 `hangar-view.sh` 头部注释(唯一副本)
- [x] 4.4 **断言选中的 node 真是那个 major**:`NODE=` 覆盖(README 就教运维设它)与 `command -v node` 兜底都不受 `.nvmrc` 约束,`-x` 连 `/usr/bin/true` 都放行 —— 而选错 major 正是这个脚本唯一要防的事
- [x] 4.5 新增 `deploy/hangar-view.test.sh` 并接进 `packages/hangar-view` 的 `test`(靠 `HANGAR_VIEW_DRY_RUN` 在 `exec` 前停下)。**失败用例断言「非零退出 *且* stderr 非空」** —— 只断言非零的话,静默死亡与响亮退出无法区分,而那正是 4.3 修的 bug。成功用例断言**选中的可执行文件路径**、不只是 major,否则把 glob 写死回 `v24*` 时全部用例照样绿。变异验证覆盖:撤掉 `sed` / `ls glob` / `node -p` 三处 `|| true`、删 major 断言、退回 `tr -dc '0-9'` 全文过滤、把 glob 写死、`$HANGAR` 退回 `$(dirname "$0")`、`process.versions.node` 写成 `process.version`。**唯一测不确定的是 `command -v node` 那处 `|| true`**(理由见测试文件头部注释)。不在此写用例个数——加一个就过期
- [x] 4.6 `docs/proposals/followups-command-write-path.md` 解钉:它原本硬钉 `v22.23.1` 的 fnm 绝对路径并让人把它固化进构建命令 —— 照它做会为**旧 ABI** 编译原生模块,正是本变更要防的那件事。改成指向 `.nvmrc` 的 major。**此前这条只写在 proposal 的 Impact 里、没进清单**,而切换时照着走的是清单

## 5. 生产切换 runbook(ts.mac-mini;**含一步在仓外**)

- [x] 5.0 **先 `launchctl bootout` 两个 job**(`com.herbertgao.hangar-inbox` 与 `com.herbertgao.hangar-view`),再动任何别的。5.3 的重编会把共享 `node_modules` 里那个 `.node` 换成 ABI 137,而**仍在跑的 node-22 daemon 与 view 会立刻坏**(daemon 在下一次 `*/3` poll、view 在下一次 spawn CLI)。不先停就把一次计划内停机变成「装完是绿的、服务已经死了」
- [x] 5.1 装 Node 24(fnm)**并在当前 shell 激活** —— `prebuild-install` 按**正在跑的** node 选 ABI,shell 还留在 22 上就会编出错的那个
- [x] 5.2 `git pull` —— `hangar-view.sh` 现在从 `$HANGAR/.nvmrc` 读 major,不 pull 它读到的还是 22
- [x] 5.2b **⚠️ 真跑时发现:`pnpm install --frozen-lockfile` 在生产机上跑不通,而本清单原本没提这一步会失败。** 报错是「specifiers in the lockfile don't match specifiers in package.json」,缺的 16 个依赖全是 **inbox-pilot 的**(`prisma`/`googleapis`/`imapflow`/`openai`…)。原因:`apps/inbox` 是 symlink 出去的**外部 checkout**,而 `apps/*` 在 workspace 里 —— 提交的 lockfile 是照**开发机上那个 checkout 的状态**生成的,生产机上那个 checkout 内容不同,于是永远对不上。**CI 反而能过**,因为 runner 上 symlink 目标不存在、`apps/inbox` 压根不进 workspace。
  - 本次的处理:**跳过 install**。daemon 跑的是 `packages/core/dist/`,view 跑 `src/server.js`,两者的依赖早已装好;新包 `pgconfig` 谁也没用到。只做重编 + build 即可恢复服务
  - **但这条会在 `add-shared-postgres` 上线时变成真障碍** —— 那时 inbox 要以 `file:` 依赖 pgconfig,生产机必须成功 install 一次。已记到那个变更的 §5
  - 教训与 RC 那条 blocker 同形:**清单里写着的命令,在真机上会失败,而运维是在两个服务已经停机之后才发现的**
- [x] 5.3 **`pnpm rebuild -r better-sqlite3`** —— 换 major 后重编原生模块的命令只有这一条。实测(node 22 ↔ 24 双向)另外两条都**不做事**:`pnpm install` 看到树已装齐,报 "Already up to date" 后 ~300ms 退 0,ABI 不变;`pnpm rebuild better-sqlite3`(**不带 `-r`**)在 workspace 根下是**静默** no-op(连输出都没有,只有一条无关的 engine WARN)。也别用 `pnpm install --force`:它可能从 store 里取到一个**上一个 major 的**已缓存产物,反映的是缓存不是当前运行时。做完按 1.3 的判据核验(**必须开库,`require` 是假绿**)
- [x] 5.4 `pnpm --filter @hangar/core build`
- [x] 5.5 改**仓外**的 `~/hangar-inbox-daemon.sh` 里的 node 绝对路径(它不在 `git ls-files` 里,只在 `hangar-view.sh` 与 deploy README 被引用)
- [x] 5.6 `launchctl bootstrap` 两个 job
- [x] 5.7 切换后核验,**第一条不能省**:`hangar runs --limit 1 --json` 退 0 —— 它走 `openDbReadonly` → `new Database`,是唯一能证明 ABI 对上的检查。**前置条件必须先确认:`HANGAR_DB` 指向的文件真的存在。** 该命令对「库不存在」的处理是先 `existsSync` 再开,文件缺失时它退 0、输出 `[]`、stderr 空 —— 原生绑定压根没加载,**看起来和成功一模一样**。而 5.5 恰好是手改仓外脚本里的绝对路径,正是错 `HANGAR_DB` 的来源。`hangar doctor --json` 的 `checks.node === 'ok'` 与「view 页面不是降级页框」**在 ABI 不匹配状态下都是绿的**,只能证明版本号对。最后确认 inbox 的下一次 `*/3` poll 真跑过一轮
- [x] 5.8 **切完补装 npm 全局 CLI**(仓外、只影响你的交互 shell,不影响服务——daemon 与 view 都用绝对 node 路径)。fnm 的 global `node_modules` 是**按 major 分开**的:切到 24 后,装在 node 22 下的全局 CLI 会从 PATH 消失。**开发机与生产机的清单不同,别照抄** —— 开发机 node 22 下装着 `@studyzy/openspec-cn`(归档变更要用它)、`@earendil-works`、`@fission-ai`;**生产机(ts.mac-mini)实测只有 `freshquota` 一个**,与 hangar 无关,切到 24 后为空。所以切完必须**在那台机器上**跑 `npm ls -g --depth 0` 对一遍再决定补装什么
- [x] 5.9 回滚路径写清。**演练:决定不做**(2026-07-29)—— 它要求再停一次生产机,而切换本身已经验证通过。**代价要说清楚:下面这条路径是推演出来的,没有跑过。** 真需要回滚时,最可能出问题的是「装回 22 之后忘了重编原生模块」那一步(开发机上踩过),以及 `git revert` 之后 `pnpm rebuild -r` 仍然是唯一有效的重编命令(见 5.3)。路径本身:`bootout` 两个 job → 装回 22 并激活 → **`git revert` 整条变更**(不要按清单逐项手回:除了 `.nvmrc` / 三处 `engines` / `MIN_NODE` / 启动脚本,还有 `SKILL.md` 的 doctor 契约与部署文档,手回必漏;2.7 的 pin 断言只覆盖前四类)→ **`pnpm rebuild -r better-sqlite3`**(理由见 5.3,`pnpm install` 在此无效)→ 改回 `~/hangar-inbox-daemon.sh` → `bootstrap`。**回滚也要重编原生模块**,这是最容易漏的一步(开发机上踩过:切回 22 而 `.node` 仍是 137 → `packages/core` 大部分测试挂、一部分照样过。**部分绿比全挂更危险** —— 容易被当成几个无关的失败。这里不写确切数字:每加一个测试它就过期,本变更前后已经过期两次)
