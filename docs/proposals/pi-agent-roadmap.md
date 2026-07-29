# 路线 — Pi / MCP 探索后的三条独立工作流

> ⚠️ **讨论与决策记录,不是 SOT。** 架构以仓根 `DESIGN.md`、次序以 `ROADMAP.md` 为准;每条路线落地前各开 OpenSpec change。
>
> **状态:** 未动工。本文取代此前把 inbox、MCP、Pi 控制面和 auto-developer cutover 串成 Pi-0…Pi-7 的单一路线。

## 0. 结构性结论

此前路线把四件不同的事塞进一个“通用 intent 授权”抽象:

1. inbox 低风险操作的确认 UX;
2. 对不可信 client 的授权;
3. auto-developer 的高风险公网发布;
4. Pi 沙箱与 scheduler cutover。

这迫使一个可逆的 inbox 操作承担 `awaiting_authorization`、nonce、双索引、durable proposal 与第二个切点,违反 seed-then-generalize,也把 #8 的枚举破坏扩成了事实上的通用 durable 机制。

**改为三条互不依赖的路线:**

```text
A. inbox 命令种子             B. auto-developer 迁移
   现有 view 两阶段确认           Pi 隔离 → 发布 manifest → 原子 cutover → soak
   不接 Pi / MCP / core            不依赖 MCP / Pi-as-client

C. MCP 互操作(延期、独立赌注)
   第二个真实 pilot/use case 出现,或 owner 明确决定破 #6/#7 后才立项
```

---

# 路线 A — inbox 命令种子

## A1. 目标与边界

沿用已经落地的窄路径:

```text
interpret-feedback → view 显示 canonical diff → 人确认 → apply-feedback
```

这是**低风险、可逆操作的确认 UX**,不是防同 uid 恶意 shell 的安全边界。控制面仍受 `CLAUDE.md`/`SKILL.md` 约束:通过 hangar CLI 操作,不直改 DB 或域文件。

**本路线不做:** MCP · Pi · `intents:` · core 改动 · 新 Run 状态 · Approval · nonce · durable proposal · 通用 registry。

## A2. DoD

> **v1 实际落地与本节有三处偏离,见 `add-view-feedback-remove`(逐条标在下面)。** 本节写于动工前;真正上线的是带偏离的版本,读本节时以标注为准。

- `interpret-feedback` 接受显式 mailbox 或 domain,做 trim/lowercase/IDN 归一化与格式校验;空值、控制字符、非法 mailbox/domain fail loud。
  - **⚠️ v1 偏离①(IDN):不做 IDN 归一化,改为拒绝非 ASCII 域名。** 只归一写入侧(overlay 存 punycode)而匹配侧仍比原始 `fromEmail`,会让用户以为加了降噪而实际永不命中(false-green)。两侧同时改另开一条。
  - **⚠️ v1 偏离②(fail loud):`interpret` 腿降级为静默丢弃**(非法项不出现在结果里),`fail loud` 由 `apply` 腿承担。理由:一次打错字的 `run.failed` 会把健康的 inbox 画成监控墙上的「翻车 ⚠️」,而抽屉里看不到原因。
  - **⚠️ v1 偏离③(domain 入口):不新增裸域名显式入口。** 裸域名扫描是那批「少一个字符」级缺陷的来源之一;overlay 允许域名条目本就是 `rules-config` 的既有行为,能力未丢。
- 确认页展示**将实际写入的 canonical add/remove diff**,不是复述原话。
- `apply-feedback` 保持原子写;重复 add/remove 幂等。
- 增加 `uncool`/remove 路径,使用 set-difference,与 add 共用同一 allowlisted 两阶段确认流。
- 执行后显示可见回执;敏感邮件和“不追溯历史邮件”的既有语义不变。
- 保持 view 的显式白名单;不把“声明即自动暴露”引入现有路径。

## A3. 可跑检查

- mailbox/domain:正例、空白、Unicode/IDN、控制字符、非法 domain。
  - **⚠️ v1 偏离(承 A2 的①③):`Unicode/IDN` 与裸 `domain` 两项在 v1 检查的是「被拒绝」而非「被归一化/被接受」** —— 因为那两个入口 v1 不提供。见 `add-view-feedback-remove`。
- interpret 输出 canonical diff;apply 收到的 bytes 与确认页展示一致。
- add/add、remove/remove 幂等;add→remove 可逆。
- 合成一封非敏感邮件证明 add 后落 P3;敏感邮件不被降温。
- `packages/core/**`、Run 状态、SQLite schema 与索引 diff 必须为零。

## A4. 出口闸

真实使用 7 天后仍愿意保留;期间无误操作且 `uncool` 能恢复。失败只回改 inbox/view,不因此启动 MCP 或通用 registry。

---

# 路线 B — auto-developer 独立迁移

## B0. 不变量

- 与 MCP、Pi-as-client、inbox 路线无依赖。
- auto-developer 域表留自己的 DB;hangar 仍只有 App/Run/RunEvent/Approval 四表。
- Pi 可以在 app 沙箱内 read/write/edit/bash;逃出沙箱的公网发布必须走现有 `ctx.propose → waiting_human → hangar approve → handler`。
- **不新增 pre-run 授权状态,不重入 pipeline,不声称通用 durable replay。**
- publish 是 pipeline 的终点;批准后 handler 必须仅凭 immutable manifest 重建动作。

## B1. 事实与宿主前置

落地 OpenSpec 前复核:

- auto-developer 当前 `app.yaml`、compiled pipeline、scheduler owner/cutover guard、全部发布别名与 Pi 版本。
- 目标 host 的 OrbStack/Docker、launchd 配置、`HANGAR_APPS`/`HANGAR_DB`、shutdown grace。
- 当前发布入口矩阵至少覆盖:正常 AD-P5、resume、republish-from-disk、regen-metrics、final index republish、导出 API。

所有 `[探子报告]` 结论必须变成带 file:line 的直接证据。

## B2. Pi 隔离(launchd 仍可当生产 owner)

### 机制

- Pi 容器只接 internal network,无默认外网路由。
- 双网卡 egress proxy 是唯一出口;只允许钉版 provider 的明确 host/path/method。
- 模型 credential 留在 proxy,不进入 Pi 容器;proxy 注入 Authorization,拒绝 client 自带认证头,限制请求体、并发、速率和单 run 用量。
- CF token、发布配置、浏览器/session 凭据均不挂载、不进 env。
- demo workdir 是唯一可写 bind mount;rootfs 只读。
- 每 phase 有 deadline/AbortSignal;正常结束和异常退出都 TERM→grace→KILL 全部后代。
- 未知 Pi RPC event 必须使该 phase fail loud,不能静默 drop 或仅 warn。

### 父死回收

容器 PID1 监视专用 control FD/attach EOF;driver 死亡后杀 Pi 进程组并退出容器。若目标 runtime 的 fault test 证明 EOF 不可靠,改用 host-external supervisor 或已落地的 hard-crash-containment;没有 daemon/launchd 死后仍存在的 actor就不得过闸。

### 检查

- 容器外同一路径/网络探针成功,容器内失败(阳性+阴性成对)。
- proxy 拒绝非 allowlist 域、路径、方法、自带 auth 与超预算请求。
- 记录 container id;先证明 PID1/Pi child 存活,再 kill driver,断言二者在明确窗口内消失。
- 正常 phase 结束后 detached/background child 也清零。

## B3. Publish manifest 与 handler(仍不要求生产经 hangar)

launchd 仍是 owner 时先构建并用 fake provider 验证新路径;**这一阶段不谎称生产发布已受 hangar 审批。**

### Immutable manifest

pipeline 先完成全部构建/验证,产生内容寻址 manifest:

```json
{
  "operation_id": "stable-id",
  "targets": [{"kind":"slot|index","artifact_sha256":"...","destination":"..."}],
  "p4_evidence_sha256": "..."
}
```

manifest 一旦提出不得改。进入 Hangar 模式后,pipeline 调 `ctx.propose({tool:'publish', args:{manifest}})` 后立即 return;不得再 deploy、写“已发布”或发成功通知。

### Handler

- auto-developer 按现有 `tools.ts` 契约提供根 handler loader,由它加载编译后的 app handler;除非 inbox 也真实需要,不为此扩展 core resolver(守 #2)。
- `app.yaml.tools` 与 `permissions.approval` 都声明 `publish`。
- handler 重算 manifest/artifact/P4 摘要,然后按 manifest 执行 slot/index 发布、成功域回写与通知。
- reject = 零 deploy、零成功回写、零成功通知。

### 交付语义(不声称 exactly-once)

每个 Approval 最多发起一次自动 provider submission。结果只能是:

- `succeeded`;
- `failed-before-submit`(可在同一批准策略允许的范围内安全重试);
- `outcome-unknown`(provider 可能已接收,**禁止自动重放**)。

`outcome-unknown` 必须先查 provider 可观察状态;无法 reconciliation 时由人决定接受现状或以**新的显式批准**重试。auto-developer 可在自己的域 DB 保存 manifest/step/result/notification 去重状态;这不是 hangar 的通用 replay。

### 检查

fake provider 注入:提交前失败、provider 接收后断线、单 target 成功后崩溃、域 DB 写失败、通知失败。每一处都必须落到上述三态之一,不得双通知或自动重复未知提交。

## B4. 原子 scheduler cutover

生产发布受 Hangar 审批和 scheduler owner 切换必须是同一 runbook,不能要求在 cutover 前证明真实 Hangar 发布。

1. 停 launchd,确认旧 driver/child 全清零。
2. 门住所有 direct publish alias;Hangar 模式下 normal/resume/republish/regen-metrics/export API 只能产 manifest→propose,否则 fail closed。
3. 启用 hangar app 与 scheduler owner。
4. 跑一次合成任务到 PARK,人工 approve,fake/隔离目标验证 handler。
5. 再允许第一个真实 manifest;审批后发布。

回滚必须反序:先停 Hangar owner并确认清零,再恢复 legacy owner。任何时刻最多一个 owner。

## B5. Soak 出口

- 连续 7 天 Hangar owner,无双 driver、孤儿、静默 event 丢失或未授权 deploy。
- 至少一次真实 approve/reject;reject 零外部效果。
- 至少一次 lost-response fault 被判 `outcome-unknown`,没有自动重放。
- trace 可还原 run→publish Approval→handler 结果;域细节留 auto-developer DB/RunEvent payload。

失败则按原子 runbook 回滚 owner,不影响路线 A。

---

# 路线 C — MCP 互操作(延期、独立赌注)

## C0. 启动条件

满足任一条件才开独立 OpenSpec:

1. **第二个真实 pilot** 声明了真实、非 inbox 特化的可调用动作;或
2. owner 明确把“外部 MCP client 驱动 pilots”升级为独立产品赌注,接受先修改 `DESIGN.md`/根 `ROADMAP.md` 来破 #6/#7。

在此之前不加 `intents:`、不加 `hangar mcp`、不改 core 状态机。

## C1. 重新立项时必须重答

- 声明契约是否真的被两个 pilot 共用,而不是从 inbox 一个例子抽象。
- MCP 只做 discovery/proposal,还是具备执行权;若执行,真正的 trust boundary 在哪里。
- 多 writer SQLite、provenance、schema dialect、error matrix 与禁用 app 的语义。
- 是否需要 privilege-separated broker。若 threat model 包含恶意同 uid/tool-enabled client,答案必须是独立 UID/ACL/broker,不能靠 CLI 约定或 user-presence token 假装封住文件系统。
- 若 Pi 当 client:使用 `--no-builtin-tools`,只启用精确 MCP extension allowlist并自检;若保持 `--no-tools`,则 Pi 只能输出结构化数据,由 host bridge 调 MCP,不得再称 Pi 为 MCP client。

## C2. 明确不继承的旧设计

此前文档中的 `awaiting_authorization`、pre-run Approval、nonce、双 partial index、共享 intent seam、Risk-B 与 Pi-0…Pi-7 依赖图**全部作废**,未来不得复制粘贴为既定答案。

---

# 全局次序

```text
A 可独立立即立项

B1 事实复核 → B2 Pi 隔离 → B3 manifest/handler(fake provider)
                              → B4 原子 cutover → B5 soak

C 无入边;只由 C0 的真实触发条件解锁
```

A/B 的实现仍分别服从仓根 `ROADMAP.md`;若与其当前阶段闸冲突,先在各自 OpenSpec/架构决策中修改 SOT,再写代码。
