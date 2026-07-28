# 设计 — inbox 侧 remove(uncool)路径:跨仓交付说明

> ⚠️ **非规范性:一次性跨仓交付输入,不是 hangar 的规范。**
>
> hangar 侧契约的 SOT 是同目录 `specs/hangar-view/spec.md` 的 delta。**其中 view 服务端的 MUST** 由 `packages/hangar-view/src/server.js` + `server.test.js` 在 CI 里执行(mutation 验过:删掉任一守卫测试即挂)。
>
> **另有三类 MUST 不在那道 CI 里,别把「delta 全部可执行」当成前提**:① **pilot 侧义务**(`MUST throw` / `SHALL 已是 canonical` 等)住另一个仓,由 inbox 的 CI 兑现;② **部署纪律**(跨仓部署序)只能人工守,见 tasks 4.3;③ **落在 `public/index.html` 的 view 自身 MUST**(确认层两段呈现、两段皆空不可确认、「可能已生效」文案)—— 本仓前端零 harness,实测把 `hasAll` 改成永真测试仍全绿,已在 tasks §6 逐项登记。canonical 与磁盘一致性另由 tasks 4.6 的人工闸兜。
>
> 本文补的是**delta 没有、也不该有的域细节**(canonical 归一、overlay 集合运算、每腿失败语义、self-check 清单),这些规则 **hangar 仓跑不了** —— 而三轮 review 的最严重缺陷全部出自「写在 markdown 里、没有任何仓内机制会重跑」的规则。
>
> 故其权威归属已移交:**inbox-pilot 仓的 `add-feedback-remove` 变更**已按本文实现并出了自己的 OpenSpec delta(`rules-config` / `processing-pipeline`),self-check 在**那边的 CI** 里跑。本文归档后仅作历史记录,供将来改这条契约时回看当初的域侧约束。两者冲突时以 delta 为准;域细节冲突时以 inbox 的规范为准。

## 目的

让降噪反馈闭环**可逆**。今天只能加:`noise_senders.overlay` 只增不删,误加一个发件人后没有撤销入口,而控制面契约禁止手改机器文件。补 remove 方向后,「加错了」有一条与「加」同形的两阶段确认路径可以退回去。

定位是**低风险、可逆操作的确认 UX**,不是安全边界:人在确认页点确认**即授权**,不经 `ctx.propose`/PARK。

## 0. 一条定型决策:**remove 方向不在 pilot 里建意图解析器**

remove 方向**不在 pilot 里建意图解析器**(不切句、不认关键词、不从句子里扫地址)。方向与地址由**调用方**给结构化 JSON,pilot 只做归一、校验、集合运算。

**为什么。** 命令框后面要接 Pi;NL→结构化那一层归调用方(Pi / Claude Code / CLI),这与 roadmap 的判断一致(「NL 翻译移到 client,pilot 只声明+执行」)。反过来在 pilot 里手写一个中文分词器,实测的代价是:全宽标点在文档往返里被折叠成 ASCII(`；！？，` → `;!?,`)导致「把 a@x 降噪、把 b@y 移出」整句判 remove;裸域名正则的 lookahead 少一个 `@` 导致 `first.last@company.com` 额外抽出 `first.last` 写成域级降噪;`restore@example.com` 因为地址里含 `restore` 被判反向。三条都是「少一个字符」级、都通不过一次真跑,而**没有任何仓内机制会重跑一份 markdown 里的正则**。

**既有 add 路径的匹配逻辑一行不改**:`{text}` 输入继续走 `matchNoiseCandidates` 对 digest TOP-N 的确定性子串匹配,**命中集完全不变**(恒为用户在 digest 看到的那几个)。

**但它的输出要过一遍准入过滤** —— 注意这层**不是**形态转换:候选来自 `countRecentSenders`,已由 `src/repo/mailRepo.ts` 的 `normalizeSenderForCount` 剥 `<>` + `trim` + 小写,所以再过 `canonicalizeEntry` 在**归一维度上是恒等的**(实测 `Ops Team <Root@NAS>` → 候选 `root@nas` → canonicalize 后仍 `root@nas`)。

它的真实作用是**把不合新规的候选挡在提案之外**:`root@nas`(域名无点)、`admin@10.0.0.5`(末段非字母)、`"a,b"@x.com`(local 含 `,"`)在旧世界是合法候选,在新的合法性表下是非法项。不挡的话它们会进确认页,用户确认后**必在 apply 腿抛错**(写腿对非法项 `throw`),而人只会看到「命令失败」。

**这条区别必须写清,否则下一个人会删掉这层** —— 他会发现它在归一维度上什么都没做。它的名字应当读作「准入过滤」,不是「归一化」。

## 1. 跨仓事件契约(逐字满足)

| trigger | input | emit | 写 |
|---|---|---|---|
| `interpret-feedback` | `{ text }`(既有 NL→add 路径)**或** `{ add?, remove? }`(结构化) | `interpretation.proposed { add: string[], remove: string[] }` | 无 |
| `apply-feedback` | `{ add?, remove? }` | `feedback.applied { added, already_present, removed, not_present }` | overlay 一次原子写 |

- **emit 侧字段恒在**:无变更即 `[]`,不得省略。hangar-view 逐字段校验 `string[]`,缺一个 → 整条命令落 `contract_mismatch`。
- **每个命令 run 恰好 emit 一次**该事件,且**一次性携带全部声明字段**。view 机械校验此基数(同 kind 出现 ≠1 → 失败):分两次 emit(如 add 一个、remove 一个)会让确认页/回执只显示一半。
- **input 侧:缺 key 视作 `[]`;key 存在但非 `string[]` 是畸形,不得当空**。部署序是 inbox 先、view 后,那个窗口里旧 view 发的是 `{"add":[...]}` 无 `remove` key —— 把它当非法会让整个窗口的「加」全失败。但 `{add:"x"}` 这类畸形必须响亮,否则「忽略它并回空桶」会被判成功。
- `add`/`remove` 的值是**即将写入 overlay 的 canonical 形态**(见 §2)。view 侧的回执配分校验按**原串**比较,故:
  - `interpret` 的 emit 是 canonical 的唯一产地;`apply` 应当收到 interpret 回的那个值。
  - **`apply` 收到非 canonical 项 → `throw`**(归一化对合规输入是幂等的;不幂等即说明调用方跳过了 interpret,是契约违规)。这条保证的是**写入形态可预期**(写进 overlay 的必然是 canonical 串),**不是**「有人在确认页看过它」—— apply 允许被绕过 UI 直调,一个从未经过确认页的 canonical 串照样写得进去。「确认页显示的 == 实际写入的」仍是纪律 + 人工闸,不是结构保证。
- 未知 trigger 仍 `throw`(现有 `src/pipeline.ts:291` 行为不变)。

## 2. canonical 归一与合法性

**interpret 与 apply MUST 调用同一个 canonicalize 函数**(两个入口各写一份必然漂移,而 view 按原串比较,漂移一个字符就让每条命令都报 `receipt_mismatch`)。

归一(与 inbox `openspec/specs/rules-config/spec.md` 现有 ingest 归一一致,顺序固定):`trim` → 去包裹的 `<>`(**剥一层**)→ **再 `trim`** → `toLowerCase`。

**第二个 `trim` 不是冗余,是幂等性的前提。** §1 用「归一化对合规输入幂等」当作检测非 canonical 的机制,而 `trim → 剥<> → lower` 对 `'< a@x.com >'` 产出 `' a@x.com '` —— 不是不动点,再跑一次还会变。补上第二个 `trim` 后,合法输入集上幂等成立;双重包裹 `'<<a@x.com>>'` 剥一层后仍含 `<`,由下表的 mailbox 规则判非法丢弃,不进入幂等性讨论。

合法性(全部在归一后判):

| 项 | 规则 |
|---|---|
| 空 | 归一后长度 0 → 非法 |
| 控制字符 | 含任一 ASCII 控制字符(码位 U+0000–U+001F 或 U+007F)→ 非法。正则里**用码位转义写**(反斜杠 `u0000` 那种形式),**别把控制字符本身贴进源码或文档** —— 它在编辑器/剪贴板/JSON 往返里会被静默吃掉,这份文档自己踩过一次 |
| 非 ASCII | 含任何码位 > U+007F 的字符 → 非法(见下 IDN 裁决) |
| 域名 | `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/` |
| mailbox | `local@domain`:`local` 非空且不含空白与 `@,;<>"`;`domain` 满足上一行 |

**IDN 裁决:非 ASCII 域名 v1 直接拒绝,不做单侧归一。** 路线 A / A2 的 DoD 写了「IDN 归一化」,但只归一**写入侧**会静默不生效:overlay 存 punycode,而匹配侧 `src/rules/applySafetyRules.ts:203` 比的是 `email.fromEmail`(normalizer 只小写、不转 punycode)→ 用户以为加了降噪、实际永不命中 = false-green。真要支持 IDN 必须两侧同时改(另开一条,含存量 overlay 的迁移)。

## 3. apply 侧集合运算

- **重新归一化 + 重新校验**(apply 是独立入口,可被绕过 UI 直接调用);非法项 → `throw`;非 canonical 项 → `throw`(§1)。
- **`add ∩ remove ≠ ∅` → `throw`**。不得静默任选一边:`(existing ∪ add) \ remove` 会让 remove 悄悄胜出,而回执 `{added:[X], removed:[X]}` 在读者眼里是「加了又移了」,文件里却没有 X —— 回执说谎。这条对应 delta 的「两条腿的失败语义相反,各自成条」需求中的**写腿**那半(干跑腿相反:静默剔除、不 throw)。
- `added` = `add` 中不在现有集的;`already_present` = 已在的;`removed` = `remove` 中真在现有集的;`not_present` = 不在的。
- 一次写:**`(existing ∪ add) \ remove`** 经 tmp+rename 原子发布(括号照写,别让实现者猜;交集已在上面 throw 掉,故此处两种读法等价)。
- add/remove 各自在同一 input 内去重。**「按归一后的值去重」属于 interpret 腿**(它收原始输入):`A@X.com` 与 `a@x.com` 在那里合并成一项。apply 腿收到的已是 canonical,故只需精确去重 —— `A@X.com` 到不了 apply 的去重逻辑,它先被「非 canonical → throw」拦掉。
- **绝不碰人工维护的 `rules.yaml`**。
- **回执必须与请求配分**:`added ∪ already_present` = 去重归一后的 `add`、`removed ∪ not_present` = 去重归一后的 `remove`,**四桶全局互不重叠**(同一地址不得跨桶出现)**且桶内不得重复**,不得出现请求里没有的地址。view 机械校验这条(不符 → `receipt_mismatch`,不当成功;规范条文见 delta)。

**overlay-only 语义必须对用户可见。** 生效的降噪集是 `rules.yaml ∪ overlay`,而本路径只动 overlay。所以一个同时被人工 `rules.yaml` 命中的地址,「移出」后**仍会被降噪**;同理「本不在名单」只是不在机器 overlay,不代表它没被人工规则降噪。两条纪律:① UI 文案与回执一律限定到「机器 overlay」,四个桶**一致**限定(只改 `removed` 而漏掉 `not_present` 就还是在说谎);② inbox 侧的 OpenSpec delta 必须写清「人工规则要人工改」。(不为此加第 5 个回执字段:那要改 view 白名单 + 部署序再来一轮,而问题的实质是措辞诚实,不是缺数据。)

## 4. 失败语义

- **interpret 对非法项不 throw**(保持现有「干跑解析、无任何写、不 throw」契约):非法项的结果是**它不出现在 `add`/`remove` 里**;一项都没有时两侧皆 `[]`,确认页现成的空态文案就是回执,不写、不失败。
  - 为什么不 throw:`hangar-view` 的员工态由**最近一次 run** 派生,一次打错字的 `run.failed` 会把健康的 inbox 画成墙上「翻车 ⚠️」,而抽屉按数据最小化看不到原因。用户输入错误不该污染 liveness 信号。
  - **这是对 A2 DoD「非法 mailbox/domain fail loud」的一处降级**,已在 proposal 登记;fail-loud 由 apply 腿承担。
- **apply 对非法项 / 非 canonical 项 / 同项冲突 `throw`** → `run.failed` → view 报「命令失败」。到 apply 的项是 view 刚回显给人看过的结构化结果,异常即契约漂移,该响亮。

## 5. 要改的位置(已核对 inbox-pilot main;行号会随提交漂移,按符号名找)

- `src/pipeline.ts:282/286` trigger 路由 —— 不新增 trigger,两个分支照旧
- `runInterpretFeedback`(`:320` 起):`{text}` 走既有 `matchNoiseCandidates`(匹配集不变;输出过一遍**准入过滤**,见 §0 —— 归一维度恒等,作用是挡掉不合新规的候选);新增结构化 `{add?, remove?}` 分支 → 归一 + 校验 + **与 overlay 比对并过滤** → emit 两字段
  - **过滤是明确的**:`add` 只提议真会新增的(不在 overlay 里的)、`remove` 只提议真在名单里的。确认页展示的因此就是**实际会发生的变更**。
  - 后果要知道:经确认页的首次提交路径上,`already_present`/`not_present` 两桶恒空。它们**仍然必要** —— 忙后重发、绕过 UI 直调 apply 时,那两桶就是幂等回执。
- `matchNoiseCandidates`(`:349` 起):**一行不改**
- `runApplyFeedback`(`:373` 起):加 §3 的集合运算与四态回执
- `normalizeFeedbackAdd`(`:397`):泛化成读 `add`/`remove` 两个 key(缺 key → `[]`;key 存在但非 `string[]` → throw),并抽出**共用的** canonicalize 供 interpret 复用
- `writeNoiseOverlayAtomic`(`:417`):原子写不变
- `src/rules/rulesConfig.ts:66` `resolveNoiseOverlayPath` / `readNoiseOverlay`:只读复用
- `src/rules/applySafetyRules.ts:203` 匹配侧:**本任务不改**(见 §2 的 IDN 裁决)。注:overlay 允许域名条目是 `rules-config` 规范的**既有**行为,本变更不新增域名入口,故不引入新的匹配侧风险

## 6. self-check(加在 `src/pipeline.test.ts`,不铺新框架)

1. **既有 NL 路径零回退**:`{text}` 输入的 add 结果是改动前结果的 **canonical 子集**(锁 `matchNoiseCandidates` 未被波及)。
   - **不能断言「逐项相同」**:准入过滤(§0)会剔掉不合新合法性规则的候选(`root@nas` 之类),所以是子集而非相同。写成「逐项相同」会得到一条假红的断言。
2. **可逆性(核心)**:从一个**由 `writeNoiseOverlayAtomic` 写出的既有 overlay**(含至少一条别的条目)起 → add `a@x.com` → remove 同一地址 → 文件**字节**回到 add 之前。
   - 初态必须这么定,否则这条会假红:「空 overlay」若指**文件不存在**,而 remove 到空集时 tmp+rename 总会产出一个空文件,字节永不相等。人工编辑过的存量文件同理只保证集合等价。
3. add/add 幂等、remove/remove 幂等;四字段恒在(无变更时也 emit `[]`)。
4. **canonical 是同一个函数**:断言 interpret 的 emit == `canonicalize(原串)`,并静态断言两腿引用的是**同一个导出符号**。
   - 不要写成「interpret 的 emit 与 apply 的归一结果逐字相同」:apply 对未归一串必 throw(见 5),那个观测量不存在;而在测试里直接调共用函数两次则恒真、永远不会挂。
5. **apply 拒非 canonical**:`{add:['  <FOO@Example.COM>  ']}` 直接投给 apply → `throw`,overlay 未变。(interpret 收同一串 → emit `foo@example.com`,不 throw。)
6. **apply 拒同项冲突**:`{add:['a@x.com'], remove:['a@x.com']}` → `throw`,overlay 未变。
7. **apply 拒畸形**:`{add:'x'}` / `{add:[1]}` → `throw`;`{add:['a@x.com']}`(无 `remove` key)→ 正常应用,`removed`/`not_present` 为 `[]`。(经 view 时这类畸形会先被 400 拦、不发起 run;apply 侧仍要拦,因为它可被绕过 view 直调。)
8. **interpret 不 throw**:`foo@`、含控制字符的项、`a@例子.com`、同项两侧冲突 → 相应项不出现在 emit 里、无写、run `completed`。
9. **归一后去重**:`{add:['A@X.com','a@x.com']}` → 只算一项。
10. **remove 不在名单** → `not_present` 命中、`removed` 为空、文件未变。
11. 合成一封非敏感邮件:add 后落 P3;**敏感邮件不被降温**(`sensitiveGuardFired` 门控语义不变)。
12. `rules.yaml` 在所有路径下内容不变。

## 7. 明确不做

不新增 trigger · 不改 hangar core · 不加 Approval/PARK/新 Run 状态 · **不在 pilot 里新建 NL 意图解析器**(§0;既有 `{text}` 匹配保留)· 不做 overlay → `rules.yaml` 固化工具 · 不改「不追溯历史邮件」「敏感邮件不降温」语义 · 不在本任务里支持 IDN。

## 8. 收尾

- inbox 自己出 OpenSpec delta:`openspec/specs/rules-config/spec.md`(overlay 的 set-difference 语义 + canonical 归一与拒绝规则),以及 pipeline/digest 侧涉及反馈 trigger 的条目。
- 上线后通知 hangar 侧放 view(部署序:inbox 先、view 后)。
- 生产验一遍:加一个地址 → 移出同一地址 → overlay 回到原内容;忙时重发 apply 幂等。
