## 新增需求

### 需求:app 可经 enabled 字段禁用
`app.yaml` SHALL 支持可选布尔字段 `enabled`(缺省 `true`)。registry 的 `SpecSchema` MUST 解析它并透传到 `Spec.enabled`。`enabled: false` 的 app **仍被加载与注册**(disabled ≠ 未注册),但携带该禁用标记;该标记由 daemon **调度决策**(disabled ⇒ 不排期)、`doctor` 上报、hangar-view 呈现三处按各自规范消费。缺省或 `enabled: true` 的 app 行为 MUST 与本变更前完全一致(向后兼容);非布尔取值 MUST 走既有 `spec_invalid` 路径被拒。

#### 场景:缺省即启用
- **当** 某 `app.yaml` 未写 `enabled`
- **那么** registry 解析出 `Spec.enabled === true`,该 app 行为与历史完全一致

#### 场景:enabled:false 仍注册但标记禁用
- **当** 某 `app.yaml` 写 `enabled: false`
- **那么** 该 app 仍出现在 `loadApps().apps`(id 与目录名一致等约束不变),且其 `Spec.enabled === false`

#### 场景:非布尔 enabled 被拒
- **当** `app.yaml` 的 `enabled` 不是布尔(如 `enabled: "no"`)
- **那么** zod 校验失败 → 该 app 记为 `spec_invalid`(与其它非法字段同)
