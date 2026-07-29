## 1. view 契约投影与回执校验(server.js)

- [x] 1.1 `COMMAND_WHITELIST.inbox['interpret-feedback'].fields` → `['add', 'remove']`
- [x] 1.2 `COMMAND_WHITELIST.inbox['apply-feedback'].fields` → `['added', 'already_present', 'removed', 'not_present']`
- [x] 1.3 `projectPayload` / `classifyRunExit` 零改动;`handleCommand` 加两处 gate(input 形状、回执配分)**并由私有改为导出 + 加默认值参数 `cli`**(端到端 self-check 的注入缝,见 3.9)——**不为兼容旧 pilot 把声明字段放宽成 optional**
- [x] 1.4 不新增 trigger、不新增白名单条目(regression:`commandSpec` 仍只认 inbox 的两个 trigger)
- [x] 1.5 `partition` 声明(数据,挨着 `fields`)+ `receiptMismatch`:每个 input key 的集合 == 其两桶之并、**四桶全局互不重叠且桶内不重复**、不含请求外地址 → 否则 `receipt_mismatch`。全局唯一那半为何是独立一条:见 `receiptMismatch` 的 JSDoc(唯一权威处,勿再抄)
- [x] 1.6 `inputShapeError`:缺 key 合法(部署窗口的旧 view),**key 存在但非 `string[]` → 400 `usage`、不发起 run**(否则「pilot 忽略畸形输入并回四个空桶」走成功路径)。**门挂 `spec.inputKeys`(两条 trigger 都声明)而非 `spec.partition`(只有写腿有)**——后者会让干跑腿静默失去校验,而结构化入口正是调用方要用的那个
- [x] 1.7 `pickEventPayload` 要求**恰好一个**同 kind 事件:契约是「每 run 恰好 emit 一次」,取第一个会把「分两次 emit」呈现为成功而只显示一半

## 2. 确认层与回执(public/index.html)

- [x] 2.1 `submitCommand` 对 `res.interpretation` 做 `hasAll(["add","remove"])` **fail closed**(缺字段 → 报错、不进确认层),不把缺字段当空数组
- [x] 2.2 `openConfirm(add, remove)` 分两段渲染:「将加入降噪」/「将移出降噪」,只渲染非空段;两段皆空 → 提示未解析出变更 + 确认按钮 disabled
- [x] 2.3 `applyCommand(add, remove)` 发 `{ add, remove }`;busy 时留弹层可点确认重试(幂等,行为不变)
- [x] 2.4 回执呈四态,**四桶一致限定到「机器 overlay」**并附「人工 rules.yaml 未改」。**全空回执不可达**(`any` 门保证请求非空,`receiptMismatch` 又拒非空请求的全空回执),故无「无变更」分支
- [x] 2.5 确认层地址经既有 `esc()` + innerHTML;回执经 `cmdMsg` 的 `textContent`——两条路径都不引入未转义拼接的新路径
- [x] 2.6 确认弹层默认焦点落**取消**:焦点落确认键会让「打字→Enter→Enter」在没看过列表时完成授权,而这个弹层是本特性唯一的授权点
- [x] 2.7 `contract_mismatch` 给专属文案(部署序错 / pilot 未上线;兜底的「回 CLI trace 看原因」在这里指错方向——那条 trace 里躺着一个成功的 run)
- [x] 2.8 两段之间加间距(`.confirm-list + .sub` 的 `margin-top`):无间距时「将移出」标题紧贴上一段末项,会被读成属于上面那张表
- [x] 2.9 **apply 腿 phase-aware**:run 已发起后,任何非 busy 失败(含 `contract_mismatch` / `trace_*` / `timeout` / 连接失败)一律追加「命令可能已生效」;skew 路径**不清输入框**(去向未知,用户可能要重发)

## 3. self-check(server.test.js,不铺框架)

- [x] 3.1 白名单断言含 `fields` 与 `partition` 字面量;白名单外 pilot/trigger、原型链 key 的既有断言保持
- [x] 3.2 `projectPayload`:四字段齐全 → 成功;**只给旧的 `added`+`already_present` 两字段 → null**(锁「旧 pilot + 新 view = 响亮失败」)
- [x] 3.3 `projectPayload`:`remove` 存在但非 `string[]` → null
- [x] 3.4 既有 `pickEventPayload` fixture 更新到新契约形状(旧形状现在是 `contract_mismatch`)
- [x] 3.5 **mutation 验证断言真会挂**:`fields` 改回旧值 → 挂;`projectPayload` 放宽成「缺字段当 `[]`」→ 挂;改回并核对 diff stat 复原
- [x] 3.6 `receiptMismatch`:配分一致 → 通过;四桶全空 / 只覆盖半边 / 含请求外地址 / 桶内重复 / **跨桶重叠** / 缺 input key / 无 partition —— 逐条断言
- [x] 3.7 `inputShapeError`:缺 key → null;`{add:'x'}`、`{add:[1]}` → 返回该 key
- [x] 3.8 `pickEventPayload`:0 个 / 1 个 / **2 个**同 kind 事件 → `{count:0}` / `{payload}` / `{count:2}`(0 与 ≥2 分开报数,调用方映射成 `missing_event` / `duplicate_event`——两者是相反的诊断)
- [x] 3.9 **`handleCommand` 端到端**(桩 `callCliRun`/`callCliJson`):证明 `receipt_mismatch` 真会被发出、且排在 `projectPayload` 之后、响应形状是 `{ok:false,kind}`。**没有这条,删掉接线那一行测试仍全绿**(实测 M6)
- [x] 3.10 mutation 复验新增守卫:删接线 / 删跨桶查重 / 删 input 形状 gate / `pickEventPayload` 改回 `find` —— 每一条都必须挂

## 3b. 仓级基建(此前无任务、无 Impact —— 补记账)

- [x] 3b.1 新增 `scripts/check-delta-headings.mjs`:`## 修改需求` 下的需求必须按名存在于主规范、`## 新增需求` 下的必须不存在。**理由**:`openspec-cn validate --strict` 对这类错误结构上是瞎的(实测:错放的新需求 validate 全绿而 `archive` 中止,变更永远无法归档),而 `validate-openspec-cn.mjs` 带 1.6.0 版本门、本机常跑不起来,加进去的检查等于永不执行
- [x] 3b.2 接进根 `package.json` 的 `test`(先跑门再 `pnpm -r test`)→ `.github/workflows/ci.yml` 的 `pnpm test` 覆盖它
- [x] 3b.3 门的负向自检:零解析到需求 / 非仓根 cwd / RENAMED 未校验 —— 三条静默放行路已关(见 3b.4)
- [x] 3b.4 `DESIGN.md` + `ROADMAP.md` 的读写边界校正(不变量 #9:`add-view-command-path` 起代码有写路径而架构文档仍写「只读」,是那次留下的账)

## 4. 跨仓与部署序

- [x] 4.0 交付说明落进仓内 `design.md`,不留在临时文件里——那半份跨仓契约必须活得比一次会话久
- [x] 4.1 **定型:remove 方向不在 pilot 里建意图解析器**(`design.md` §0)。方向与地址由调用方给结构化 JSON(Pi / Claude Code / CLI);既有 `{text}`→add 的 TOP-N 子串匹配一行不改。手写中文分词器实测产出三条「少一个字符」级缺陷,且无仓内机制会重跑 markdown 里的正则
- [ ] 4.2 inbox 侧按 delta 的契约 + `design.md` 的域细节实现(inbox 自己出 OpenSpec delta)
- [ ] 4.3 **部署序:inbox 先、view 后**(pilot 多 emit 字段对旧 view 无害;反序 → interpret 阶段即 `contract_mismatch`)
- [ ] 4.4 生产验一遍:加一个地址 → 移出同一地址 → overlay 回到加之前的内容;重发 apply 幂等
- [ ] 4.5 归档时更新 `docs/proposals/followups-command-write-path.md` D 节的「overlay 只增不减、现无工具」;同批修 `docs/proposals/control-plane-channels.md` 的**两处** set-union(`:100` 写侧契约段、`:166` busy 重发段,现均含 set-difference)
- [ ] 4.6 **canonical 闸(view 侧无法机械校验,只能人工过一次)**:手工核对确认页显示的字符串与 overlay 实际增删的 bytes 逐字相同。在 §5 出口闸开始计时前完成
- [x] 4.7 `openspec-cn`(`@studyzy/openspec-cn`)**≥1.6.0** 下 `validate add-view-feedback-remove --strict` 通过。注:**解析到哪个版本取决于当前 node major,不是"全局装了哪个"** —— 1.5.0 装在 fnm 的 **v22 globals** 下并遮蔽 `~/Library/pnpm/bin` 的 1.6.0;`fnm use 24`(仓的 Node 下限,本就该在此干活)后 v24 globals 无此包、PATH 落穿即得 1.6.0,`pnpm openspec:validate`(钉 1.6.0)随之正常。在 v22 下会看到**全仓中文规范/delta 全红**,那是工具版本状况,**不是标题风格问题,勿据此改标题**
- [x] 4.8 三处对路线 A 的偏离已登记(见 proposal「登记三处对路线 A 的偏离」),并**就地在 roadmap A2/A3 逐条标注「v1 偏离,见 add-view-feedback-remove」**——只「另立待办」不够:归档后 roadmap 的原文会成为幸存陈述,与实际上线的东西矛盾。已标进 `docs/proposals/pi-agent-roadmap.md`:A2 节首加偏离横幅 + 三条逐条挂在对应 DoD 条目下;A3 的 `Unicode/IDN` 与裸 `domain` 两项标明 v1 检查的是「被拒绝」而非「被接受」(承 ①③)。三条均已对 `design.md` §2(IDN 裁决)/§4(失败语义)/§0(domain 入口)核对

## 5. 出口闸(路线 A / A4)

- [ ] 5.1 真实使用 7 天:期间无误操作,且真发生过一次 remove 撤销并生效
- [ ] 5.2 `packages/core/**`、Run 状态、SQLite schema 与索引 diff **为零**

## 6. 已知未覆盖(诚实记账,不假装)

- [ ] 6.1 **浏览器 JS 零 harness 覆盖**:`hasAll`、`section()`、`any` 门、四态回执、phase-aware 文案全部只经阅读验证(实测:`hasAll` 改成永真 → 测试仍全绿)。本仓前端从来没有测试框架,本变更不铺;记在此处,接第二个写路径时再评估
