## Why

`add-view-command-path`(#10)上线的降噪反馈闭环**只能加、不能减**:`interpretation.proposed {add}` → `feedback.applied {added, already_present}`,overlay 机器文件只增不删(见 `docs/proposals/followups-command-write-path.md` D 节)。误加一个发件人后**没有任何撤销入口**——只能手改 overlay 文件,而 `CLAUDE.md` 的控制面契约要求经 CLI/pilot 操作。

`docs/proposals/pi-agent-roadmap.md` 的**路线 A(inbox 命令种子)**把「`uncool`/remove 路径,与 add 共用同一 allowlisted 两阶段确认流」列为 DoD,并把它作为这一阶段唯一可立即立项的工作。remove 是这个闭环成为**可逆**操作的前提,也是「低风险确认 UX」这一定位成立的根据(不可逆的写不该只靠一次点击授权)。

本变更**只做 hangar 仓那一半**:命令契约扩成 add/remove 对称、view 的白名单投影与确认层跟上、view 侧加回执自洽性校验。inbox 侧实现(canonical 归一、overlay 的 set-difference、四态回执)在 inbox 外部 repo 对着本契约做。

## What Changes

- **不新增 trigger、不新增白名单条目**(规范化陈述与理由见 delta 的「confirm-before-apply 两阶段」需求)。
- **`interpretation.proposed` 契约:`{add:string[], remove:string[]}`**,两字段**恒在**(空即 `[]`),值为 **canonical**(即将写入 overlay 的归一化形态,不是复述原话)。
- **`feedback.applied` 契约:`{added, already_present, removed, not_present}`**,四字段**恒在**。`removed` = 本次真从 overlay 删掉的、`not_present` = 请求删但本就不在的(set-difference 幂等的两半,对称于 `added`/`already_present`)。
- **view 白名单 `fields` 跟上**(`server.js` 的 `COMMAND_WHITELIST`):interpret 声明 `['add','remove']`、apply 声明 `['added','already_present','removed','not_present']`。`projectPayload` 的「声明字段必须是 `string[]`,否则 `contract_mismatch`」一行不改——它继续 fail loud。
- **确认层两段渲染**:「将加入降噪」/「将移出降噪」各一段,两段皆空 → 确认按钮保持 disabled;回执呈四态。
- **零改 `@hangar/core`**(不加 trigger 概念、不加状态、不碰 gateway/Approval)。remove 与 add 同属「本质无害、可逆的域副作用」,继续不经 propose/PARK。

- **pilot 不新建 NL 意图解析器**(既有 `{text}` → digest TOP-N 匹配的 add 路径**保留**,只把输出转成 canonical 形态)。remove 方向的地址与方向由**调用方**给结构化 JSON(Pi / Claude Code / CLI);`interpret-feedback` 的 input 从「只有 `{text}`」扩成「`{text}`(既有 add 路径,一行不改)或 `{add?, remove?}`」。命令框后面要接 Pi,NL→结构化那层归调用方,与 roadmap 的「NL 翻译移到 client,pilot 只声明+执行」一致。反向做过一版(pilot 内手写中文切句 + 关键词定向 + 扫描抽取),实测产出三条「少一个字符」级缺陷,且**没有任何仓内机制会重跑一份 markdown 里的正则**——已整节删除,理由留在 `design.md` §0「remove 方向不在 pilot 里建意图解析器」。
- **view 侧新增回执自洽性校验**:`partition` 声明 + `receiptMismatch` + `receipt_mismatch` kind。`string[]` 形状校验挡不住**内容说谎**的回执(四桶全空、只报一半、含请求外地址、同一地址既 `added` 又 `removed`),而那些都会让前端呈「已应用」。同时 `pickEventPayload` 收紧为**恰好一个**同 kind 事件(契约要求每 run 恰好 emit 一次,取第一个会把「分两次 emit」呈现为成功而只显示一半)。
- **canonical 规则、overlay 集合运算** 落在本变更的 `design.md`。它是**域细节**,不进 delta;delta 只定跨仓契约。
- **登记三处对路线 A 的偏离**:① A2 的 DoD 写了「IDN 归一化」,v1 **不做**,改为拒绝非 ASCII 域名——只归一写入侧(overlay 存 punycode)而匹配侧仍比原始 `fromEmail`,会让用户以为加了降噪而实际永不命中(false-green);两侧同时改另开一条。② A2 的「非法输入 fail loud」在 **interpret 腿降级为静默丢弃**(非法项不出现在结果里),因为一次打错字的 `run.failed` 会把健康的 inbox 画成监控墙上的「翻车 ⚠️」而抽屉看不到原因;fail-loud 由 apply 腿承担。③ A2 的「接受显式 mailbox 或 **domain**」中的 domain 入口 v1 **不新增**——裸域名扫描是上面那批缺陷的来源之一;overlay 允许域名条目是 `rules-config` 的既有行为,能力未丢。理由分别见 `design.md` 的「canonical 归一与合法性」/「失败语义」/§0 三节。

**BREAKING(跨仓部署序)**:`projectPayload` 要求声明字段**全部**存在,故 **inbox 必须先上线**、view 后上线(完整规则与反序的真实行为见 delta 的「跨仓部署序」——要点:反序时 interpret 阶段即失败且无写,但直接调 `apply-feedback` 会让旧 pilot 写下 `add` 半边而 view 仍报失败)。

## 非目标

- **不新增 trigger、不抽 typed intent 注册表、不加 `app.yaml` `intents:`**(撤销是同一意图的反向,不是第 2 个 intent;注册表等第 2 个**真实** intent)。
- **不接 Pi / 不接 MCP**、不加 Approval/PARK/新 Run 状态、不改 `packages/core`(remove 与 add 同属「本质无害、可逆的域副作用」)。
- **不做页面 approve/reject**(审批处置写路径仍留待第一个带高危动作的 pilot)。
- **不给 remove 加浏览器入口。** 命令框仍只发 `{text}`,而 `{text}` 腿是既有的 digest TOP-N 匹配(add-only),故 v1 的 remove 调用方是 **Pi / Claude Code / CLI 的结构化 `{remove:[…]}`**。view 侧的两段确认层与四态回执**已就绪**(`remove` 恒为 `[]` 时第二段自然不渲染),接入结构化调用方后无需再改 view。**这不是能力缺失**——remove 已在 pilot 侧实现并通过其对抗测试;缺的只是浏览器这一张脸。要现在就要浏览器面,最省的诚实版本是给已渲染的 overlay 条目加逐项「移出」按钮(零 NL、零幻觉),但那需要一条新的 overlay 只读数据通路 + 又一轮白名单扩张与部署序,应另开变更。
- **不在本变更支持 IDN**、不新增裸域名显式入口(两项均见上「登记三处对路线 A 的偏离」);不做 overlay → `rules.yaml` 固化工具。
- **不在 pilot 里新建 NL 意图解析器**(不切句、不认关键词、不从句子里扫地址)——那一层归调用方。**注意不是「pilot 不碰 NL」**:既有 `{text}` → `matchNoiseCandidates` 的 TOP-N 子串匹配保留、不得删除。
- **不为兼容旧 pilot 把 `projectPayload` 放宽成 optional 字段**——响亮失败是这条路径的设计,不是待修的粗糙。

## Impact

- 受影响规范:`hangar-view` —— 命令/事件契约、confirm-before-apply 两阶段、命令路径数据最小化放宽、busy 重发的幂等理由、**「只读呈现层」需求的读写边界校正**(五处 MODIFIED)+ **回执自洽性由 view 机械校验** 与 **两条腿的失败语义相反,各自成条**(两处 ADDED)。
- 受影响的**仓级基建**(此前漏记):新增 `scripts/check-delta-headings.mjs`(零依赖 delta 标题归属门)并接进根 `package.json` 的 `test` 脚本 → 进 CI 关键路径;`DESIGN.md` 与 `ROADMAP.md` 的 hangar-view 读写边界措辞校正(兑现不变量 #9:代码有写路径而架构文档写着「只读」)。
- 受影响代码:`packages/hangar-view/src/server.js`(白名单 `fields` + `partition`、`receiptMismatch`、`inputShapeError`、`pickEventPayload` 收紧、`handleCommand` 加两处 gate 并导出+加可注入 `cli` 参数(端到端 self-check 的注入缝)、`inputKeys` 与 `partition` 解耦)、`packages/hangar-view/public/index.html`(确认层 + apply input + 四态回执 + phase-aware 文案 + 焦点/间距)、`packages/hangar-view/src/server.test.js`。
- 不受影响:`packages/core/**`(零改动)、`/api/state` 与 trace 抽屉的 default-drop(一行不改)、Run 状态机、SQLite schema。
- 跨仓:inbox 外部 repo 需按本契约实现 remove。契约 SOT = 本变更的 `specs/hangar-view/spec.md` delta;域细节实施说明 = 本变更的 `design.md`(**在仓内**,不是临时文件——那半份契约要活得比一次会话久)。
