# app-registry 规范

## 目的
待定 - 由归档变更 phase-0-skeleton 创建。归档后请更新目的。
## 需求

### 需求:从 apps 目录发现并注册 app
系统必须扫描 `apps/*/app.yaml`,把每个含合法 `app.yaml` 的目录注册为一个 app;app 的 `id` 必须等于目录名。

#### 场景:发现玩具 app
- **当** `apps/heartbeat/app.yaml` 存在且合法
- **那么** registry 必须注册一个 `id=heartbeat` 的 app

#### 场景:apps 目录缺失
- **当** `apps/` 目录不存在
- **那么** `doctor` 必须报 `apps_dir_missing`,且不注册任何 app

### 需求:app.yaml 必须通过 zod 校验
系统必须用 zod 校验每个 `app.yaml`;缺少必填字段(`id` / `executor` / `triggers`)、类型不符、或 `executor` 为**已知枚举之外的未知值**的,必须拒绝加载并报 `spec_invalid`,禁止注册非法 app。

#### 场景:非法 spec 被拒
- **当** 某 `app.yaml` 缺少 `executor` 字段
- **那么** 加载该 app 必须失败并报 `spec_invalid`,该 app 禁止进入 registry

#### 场景:id 与目录名不一致
- **当** `app.yaml` 的 `id` 与其所在目录名不同
- **那么** 加载必须失败并报 `spec_invalid`

### 需求:executor 字段决定加载方向
`executor` 字段必须决定 app 的执行方向。`executor: pipeline` 时,系统必须能按约定加载同目录 `pipeline.ts`;不引入第二种 app 定义入口。

#### 场景:pipeline 型缺代码
- **当** 某 app 的 `executor: pipeline` 但同目录不存在 `pipeline.ts`
- **那么** `doctor` 必须报 `pipeline_missing`

#### 场景:已知但未实现的 executor
- **当** 某 app 的 `executor` 为 `llm-direct` / `claude-code` / `codex`(已知枚举、v0 未实现)
- **那么** spec 校验可通过,但触发 run 时必须报 `executor_unsupported`,禁止静默成功

#### 场景:未知的 executor 值
- **当** 某 app 的 `executor` 是已知枚举之外的值(如 `banana`)
- **那么** zod 校验必须在**加载期**即报 `spec_invalid`,不进入 run 期

### 需求:app 可经 enabled 字段禁用
`app.yaml` SHALL 支持可选布尔字段 `enabled`(**缺省或留空(`enabled:`→null)均 default `true`**——两者都算「未设置」)。registry 的 `SpecSchema` MUST 解析它并透传到 `Spec.enabled`。`enabled: false` 的 app **仍被加载与注册**(disabled ≠ 未注册),但携带该禁用标记;该标记由 daemon **调度决策**(disabled ⇒ 不排期)、`doctor` 上报、hangar-view 呈现三处按各自规范消费。缺省或 `enabled: true` 的 app 行为 MUST 与本变更前完全一致(向后兼容)。**YAML 布尔词字符串**(`no`/`off`/`yes`/`on`,以及引号形式 `"true"`/`"false"`——YAML 1.2 core 把它们解析为字符串)MUST 大小写不敏感 coerce 成布尔(`no`/`off`→`false`,`yes`/`on`→`true`);**其余非布尔取值**(如 `maybe`/数字)MUST 走既有 `spec_invalid` 路径被拒。**hangar-view 因零 import core 自行 parse `app.yaml`,其 beacon 路径 MUST 用同一 coerce**(否则 `enabled: no` 逃过 beacon 排除、复现 F1 误报)。

#### 场景:缺省或留空即启用
- **当** 某 `app.yaml` 未写 `enabled`,或写了 `enabled:` 但值为空(→ null)
- **那么** registry 解析出 `Spec.enabled === true`(两者都算「未设置」),该 app 行为与历史完全一致

#### 场景:enabled:false 仍注册但标记禁用
- **当** 某 `app.yaml` 写 `enabled: false`
- **那么** 该 app 仍出现在 `loadApps().apps`(id 与目录名一致等约束不变),且其 `Spec.enabled === false`

#### 场景:YAML 布尔词被 coerce(两侧、大小写不敏感)
- **当** `app.yaml` 写 `enabled: no`/`off`/`OFF`(或 `yes`/`on`——YAML 1.2 core 把它们解析成字符串)
- **那么** registry MUST 大小写不敏感 coerce 成对应布尔(`no`/`off`→`false`、`yes`/`on`→`true`),按操作者直觉启停,而非误判 `spec_invalid`

#### 场景:真非布尔 enabled 被拒
- **当** `app.yaml` 的 `enabled` 是非布尔词的非法值(如 `enabled: maybe`)
- **那么** zod 校验失败 → 该 app 记为 `spec_invalid`(与其它非法字段同)
