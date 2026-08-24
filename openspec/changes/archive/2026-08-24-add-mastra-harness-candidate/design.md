## Context

Mastra 的公开形态已经从 agent/workflow SDK 扩展到 durable agents、schedules、server/client SDK、auth、sandbox 与 Studio，但当前候选名录仍按其早期形态遗漏它。与此同时，官方材料明确暴露跨副本恢复竞争、恢复重发 LLM/tool call，以及凭据/containment 依赖 provider 的边界。此 change 只修正候选治理记录；Hangar 的 runtime owner、M0/M1 分母与阶段顺序保持不变。

## Goals / Non-Goals

**Goals:**

- 把 Mastra 作为完整组合与受限 Harness adapter 候选补入 §4/§6 名录，使用与其它候选相同的七项透明控制硬门。
- 冻结候选记录的日期、来源、`已实证 | 未查实` 与缺证据计 0 口径。
- 冻结四项接入拒绝：候选 auto recovery、schedules trigger owner、tool approval 治理受控 mutation、候选进程持有高风险业务提交凭据。
- 冻结完整 Service 的替代规则和三项能力同时补齐时的反向归档止损。

**Non-Goals:**

- 不安装 Mastra package，不实现 adapter/spike，不新增 runtime 接口或 owner。
- 不修改 M0 requirement/scenario/race 分母，不改变 M1/M2 出口闸。
- 不以第三方材料或功能数量替代官方证据与硬门。
- 不裁决 M2 API/Web/Telegram 是否复用 Mastra；该裁决由 M2 具名 spike 和证据拥有。

## Decisions

### 1. 候选记录与裁决证据分层

候选名录记录取证日期、官方来源与每项结论状态。官方文档未提及的能力一律标为 `未查实`，在硬门和评分中计 0。第三方材料只允许作背景交叉检查，不进入裁决依据。这样避免把“没找到”误写成“不存在”，也避免用社区规模或功能列表补安全证据。

### 2. Mastra 只能作为受限 adapter，或完整替代对应 owner

默认接入形态是受边界 Harness adapter 与可选 client/telemetry 依赖。Control 继续拥有 admission、outer Attempt、terminal、Approval、Effect commit、restore authority 与 whole-tree containment。若采用 Mastra 完整 Service，它必须替代并归档对应 Hangar owner；双 session/schedule/effect 状态机不可并存。

备选方案“先安装 runtime 再通过配置约束”被拒绝，因为资格门失败时会留下依赖和 owner residue，且把治理判断推迟到运行时。

### 3. 四项配置在实现前即默认拒绝

`recovery.durableAgents: 'auto'` 类自动恢复、Mastra schedules 直触发 Hangar Agent、Mastra tool approval 决定受控 mutation，以及 Mastra 进程持有推送/发信/发布凭据，均在 adapter 创建之前拒绝。候选内部 approval 只可治理可逆且未提交的 Harness action。

### 4. 资格赛先硬门、后同 fixture、再成本

Mastra 先跑 §6.3 七项硬门；任一缺证据或失败即淘汰，不进入加权排名。通过后才运行与 Pi 相同的 release identity、grant、effect-unknown、cancel/checkpoint、retry-owner、whole-tree reap fixture，并记录 glue LOC、部署、许可证、退出与 12 个月 TCO。此 change 不创建新的 M0 gate。

### 5. 反向止损按三项同时实证触发

只有跨副本 fencing/单调 epoch、带 claim/unknown/reconciliation 且不重发 unknown 的受控提交层、以及默认凭据剥离并可 hard-reap whole tree 的子进程边界三项同时成立，才触发归档 Hangar 对应 runtime 的独立裁决。功能面扩张不触发迁移。

## Risks / Trade-offs

- **文档时效性：** Mastra 仍在快速演进；记录保留日期，形态变化后重新取证而不覆盖旧结论。
- **官方文档空白：** 可能存在未文档化能力；按 `未查实` 计 0 会偏保守，但不会制造安全 false green。
- **候选评估成本：** 七硬门可能在安装前就淘汰 Mastra，牺牲功能比较深度以保护 owner 边界与预算。
- **完整 Service 机会成本：** “替代而非并存”提高迁移门槛，但避免无法判定的双写与双恢复。
- **第三方材料偏差：** 只作背景，不进入裁决；决定性结论必须能回到官方来源。
