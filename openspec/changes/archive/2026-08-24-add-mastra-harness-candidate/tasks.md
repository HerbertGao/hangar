## 1. 冻结候选取证

- [x] 1.1 保持 `docs/proposals/mastra-candidate-evaluation.md` 的取证日期、来源链接与 `未查实` 清单完整；验证：`grep -n "取证：2026-08-21" docs/proposals/mastra-candidate-evaluation.md && grep -c "^- " docs/proposals/mastra-candidate-evaluation.md`；预期：取证行存在，§8 待查项非空；止损：无法为某条判定给出可复核来源时，把该条降级为 `未查实`，不写进裁决依据。
- [x] 1.2 逐条核对附录 §3 对照表的每个「缺口」判定均有官方文档出处，且未把「文档未提及」表述为「不存在」；验证：人工复核 §3/§4 与 §9 引用一一对应；预期：三条决定性缺口各有原文引用；止损：出处不可复核即删除该行，不保留无源判定。

## 2. 更新候选名单

- [x] 2.1 在 `docs/proposals/personal-agent-builder.md` §4 增加 Mastra 小节，说明它为何比现有候选更接近目标形态、以及三条决定性缺口；验证：`grep -n "Mastra" docs/proposals/personal-agent-builder.md`；预期：§4 出现 Mastra 且引用附录；止损：不重写 §4 既有候选段落，只新增。
- [x] 2.2 在 `personal-agent-builder` §6 的候选平台选择规则列表中加入 `Mastra + 最小可用控制层`，与其它完整方案同权重参赛；验证：同上 grep 命中 §6 列表；预期：候选项声明「必须把为补齐控制产品而写的代码和运维全部计入」；止损：不得为 Mastra 单列 rubric 或降低硬门。
- [x] 2.3 在 `DESIGN.md` §6 的外部 SDK adapter 句中并列 Mastra，并在 §15 增加附录指针；验证：`grep -n "Mastra" DESIGN.md`；预期：两处命中，且 §6 保留「若采用其完整 Service，就必须替代对应 Control owner」的原有约束；止损：不改动 §2 不变量与 §13 非目标。

## 3. 冻结边界与资格赛条款

- [x] 3.1 实现 `xcq.candidate-registry`：名录必须记录候选、取证日期、来源、`已实证 | 未查实` 与缺证据计 0 的口径；验证：`openspec-cn validate add-mastra-harness-candidate --strict`；预期：requirement 与 scenario 全部通过；止损：口径无法闭合时缩回「只记录候选与来源」，不写评分规则。
- [x] 3.2 实现 `xcq.owner-boundary`：冻结 Mastra 接入时的四条拒绝与「替代而非并存」规则；验证：同上；预期：四条拒绝逐项有 scenario；止损：任一条无法表述为可拒绝的具体配置时，标为未冻结并阻塞 M2 spike。
- [x] 3.3 实现 `xcq.qualification-gate`：冻结 §6.3 七项硬门前置、与 `harness-pi` 同一组 fixture、成本记录项与反向止损；验证：同上；预期：fixture 清单与 `ROADMAP.md` M2 出口闸无冲突，`define-v2-control-contracts` Requirement/scenario/member ID与41/244/233/88数量不变，仅允许本次opt-in语义修订；止损：出现与M0冻结分母重叠的新gate即删除该条，不改变Mastra资格赛。

## 4. 一致性检查

- [x] 4.1 确认本 change 未增删 `define-v2-control-contracts` 的任何 spec 成员；验证：`git status --porcelain openspec/changes/define-v2-control-contracts`；预期：无输出；止损：出现改动即回退，另开 change。
- [x] 4.2 确认 `DESIGN.md`、`ROADMAP.md`、`CLAUDE.md`、`openspec/config.yaml` 与本 change 相互无冲突；验证：`openspec-cn validate add-mastra-harness-candidate --strict && grep -n "Mastra" DESIGN.md docs/proposals/personal-agent-builder.md`；预期：validate 通过，文档引用一致；止损：冲突时先改 SOT 再改本 change，不得反向。
