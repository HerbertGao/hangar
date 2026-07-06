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

