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
- [x] 2.7 **`cli.test.ts` 加 pin 一致性断言**:`.nvmrc` 的 major 与三处 `engines`(须为 `>=<major>` 形式)、与 `MIN_NODE` 的实际行为一致;`packages/notify` 的 `>=22.18.0` 反向钉住(挡「顺手统一版本」);`ci.yml` 用 `node-version-file` 且无第二个版本号;`.nvmrc` 非数字(`lts/*` 别名)也要红。**变异验证过 8 种部分漂移全被抓**;五处一致降级放行(那是刻意决定,不是漂移)
- [x] 2.8 `engines` 用 `>=24` 而非 `^24`:`MIN_NODE` 是无上界的下限,caret 有上界,两者并存 = node 25 上 doctor 报绿而 `engines` 宣称不支持(且 `cli.test.ts` 断言 `nodeSupported('25.0.0') === true`)

## 3. CI

- [x] 3.0 **实测发现(node 22→24 的行为变化,探查时没预料到)**:`node --test` 的默认 reporter 从 TAP 换成 spec(`# pass N` → `ℹ pass N`)。任何 grep `# pass` 的脚本/CI 断言会**静默失效**(grep 无输出 ≠ 测试失败)。本仓不受影响:`pnpm test` 与 CI 都靠**退出码**判,不解析输出。**若日后有人写基于 `# pass` 的断言,这条是原因**
- [x] 3.1 `.github/workflows/ci.yml`:`node-version: 22.18.0` → `node-version-file: .nvmrc`
- [ ] 3.2 CI 全绿(typecheck / test / build),且 `better-sqlite3` 在干净 ubuntu runner 上真被构建(看 install 日志有 build 步,不只看 install 退 0)

## 4. 部署物解钉(仓内)

- [x] 4.1 `packages/hangar-view/deploy/hangar-view.sh` 的 `v22*` glob 改为读 **`$HANGAR/.nvmrc`** 的 major 拼路径(用 `$HANGAR` 而非 `$(dirname "$0")/../../..`:后者会从**脚本所在的 checkout** 读版本、却启动 `$HANGAR` 里的代码,两者不同就白读了;`$HANGAR` 第 9 行已算好、可被 `HANGAR_HOME` 覆盖)。**不解这个钉,升级后 view 与它 spawn 的 CLI 会留在旧 ABI**
- [x] 4.2 `deploy/README.md` 的 node 版本表述同步;顺带修一处**已经陈旧**的说法(`:49` 说 `hangar-view.sh` 默认走 `fnm exec --using 22`,而脚本实际是 glob)
- [x] 4.3 **每个探测命令加 `|| true`**(`.nvmrc` 缺失时的 `sed`、无匹配时的 `ls` glob)—— 不加,它们下面的响亮退出与 PATH 兜底全是死代码。机制见 `hangar-view.sh` 头部注释(唯一副本)
- [x] 4.4 **断言选中的 node 真是那个 major**:`NODE=` 覆盖(README 就教运维设它)与 `command -v node` 兜底都不受 `.nvmrc` 约束,`-x` 连 `/usr/bin/true` 都放行 —— 而选错 major 正是这个脚本唯一要防的事
- [x] 4.5 新增 `deploy/hangar-view.test.sh` 并接进 `packages/hangar-view` 的 `test`(靠 `HANGAR_VIEW_DRY_RUN` 在 `exec` 前停下)。**失败用例断言「非零退出 *且* stderr 非空」** —— 只断言非零的话,静默死亡与响亮退出无法区分,而那正是 4.3 修的 bug。成功用例断言**选中的可执行文件路径**、不只是 major,否则把 glob 写死回 `v24*` 时全部用例照样绿。变异验证覆盖:撤掉 `sed` / `ls glob` / `node -p` 三处 `|| true`、删 major 断言、退回 `tr -dc '0-9'` 全文过滤、把 glob 写死、`$HANGAR` 退回 `$(dirname "$0")`、`process.versions.node` 写成 `process.version`。**唯一测不确定的是 `command -v node` 那处 `|| true`**(理由见测试文件头部注释)。不在此写用例个数——加一个就过期

## 5. 生产切换 runbook(ts.mac-mini;**含一步在仓外**)

- [ ] 5.0 **先 `launchctl bootout` 两个 job**(`com.herbertgao.hangar-inbox` 与 `com.herbertgao.hangar-view`),再动任何别的。5.3 的 `pnpm install` 会把共享 `node_modules` 里那个 `.node` 重编成 ABI 137,而**仍在跑的 node-22 daemon 与 view 会立刻坏**(daemon 在下一次 `*/3` poll、view 在下一次 spawn CLI)。不先停就把一次计划内停机变成「装完是绿的、服务已经死了」
- [ ] 5.1 装 Node 24(fnm)**并在当前 shell 激活** —— `prebuild-install` 按**正在跑的** node 选 ABI,shell 还留在 22 上就会编出错的那个
- [ ] 5.2 `git pull` —— `hangar-view.sh` 现在从 `$HANGAR/.nvmrc` 读 major,不 pull 它读到的还是 22
- [ ] 5.3 **`pnpm rebuild -r better-sqlite3`** —— 换 major 后重编原生模块的命令只有这一条。实测(node 22 ↔ 24 双向)另外两条都**不做事**:`pnpm install` 看到树已装齐,报 "Already up to date" 后 ~300ms 退 0,ABI 不变;`pnpm rebuild better-sqlite3`(**不带 `-r`**)在 workspace 根下是**静默** no-op(连输出都没有,只有一条无关的 engine WARN)。也别用 `pnpm install --force`:它可能从 store 里取到一个**上一个 major 的**已缓存产物,反映的是缓存不是当前运行时。做完按 1.3 的判据核验(**必须开库,`require` 是假绿**)
- [ ] 5.4 `pnpm --filter @hangar/core build`
- [ ] 5.5 改**仓外**的 `~/hangar-inbox-daemon.sh` 里的 node 绝对路径(它不在 `git ls-files` 里,只在 `hangar-view.sh` 与 deploy README 被引用)
- [ ] 5.6 `launchctl bootstrap` 两个 job
- [ ] 5.7 切换后核验,**第一条不能省**:`hangar runs --limit 1 --json` 退 0 —— 它走 `openDbReadonly` → `new Database`,是唯一能证明 ABI 对上的检查。**前置条件必须先确认:`HANGAR_DB` 指向的文件真的存在。** 该命令对「库不存在」的处理是先 `existsSync` 再开,文件缺失时它退 0、输出 `[]`、stderr 空 —— 原生绑定压根没加载,**看起来和成功一模一样**。而 5.5 恰好是手改仓外脚本里的绝对路径,正是错 `HANGAR_DB` 的来源。`hangar doctor --json` 的 `checks.node === 'ok'` 与「view 页面不是降级页框」**在 ABI 不匹配状态下都是绿的**,只能证明版本号对。最后确认 inbox 的下一次 `*/3` poll 真跑过一轮
- [ ] 5.8 回滚路径写清并演练过一次:`bootout` 两个 job → 装回 22 并激活 → **`git revert` 整条变更**(不要按清单逐项手回:除了 `.nvmrc` / 三处 `engines` / `MIN_NODE` / 启动脚本,还有 `SKILL.md` 的 doctor 契约与部署文档,手回必漏;2.7 的 pin 断言只覆盖前四类)→ **`pnpm rebuild -r better-sqlite3`**(理由见 5.3,`pnpm install` 在此无效)→ 改回 `~/hangar-inbox-daemon.sh` → `bootstrap`。**回滚也要重编原生模块**,这是最容易漏的一步(开发机上踩过:切回 22 而 `.node` 仍是 137 → `packages/core` 大部分测试挂、一部分照样过。**部分绿比全挂更危险** —— 容易被当成几个无关的失败。这里不写确切数字:每加一个测试它就过期,本变更前后已经过期两次)
