# host-capabilities Specification

## Purpose
TBD - created by archiving change add-run-cancellation. Update Purpose after archive.
## Requirements
### 需求:host 从同一 canonical set 广播版本化能力集
host MUST 维护一组**版本化能力字符串**,每条形如 `hangar.run.<name>/vN`(不可变标识,`N` = 能力语义版本)。该集合 MUST 由脊柱以静态冻结常量(`HOST_CAPABILITIES`)声明(不新增表/库/进程,守 #3),并同时派生出 **`doctor --json` 的 `capabilities[]`** 与每个 run 的 `ctx.capabilities`。能力语义一旦改变 MUST bump 其 `/vN`(旧号消费者据此自动关门)。**#16 拆分后能力集机制归本变更;#19 增加运行期快照**。

**成员(四条,各 attests 一个具体运行时契约):**
- `hangar.run.trigger-kind/v1` —— host 提供不可伪造的 `ctx.triggerKind`(字段由 #16 add-run-trigger-kind 加)。**该成员 MUST NOT 进 `HOST_CAPABILITIES`,除非同一 build 里 `ctx.triggerKind` 真的存在**——否则谎报一个字段不在的能力(#16 拆分后字段与其能力异源,须靠 build 对齐,见 tasks 1.1)。
- `hangar.run.abort-signal/v1` —— `ctx.signal` 真实投递取消(非仅结构性存在字段)。
- `hangar.run.cancelled-terminal/v1` —— 取消经 choke-point 映射到 `run.cancelled` 终态。**范围限「协作路径」**:pipeline **配合** `signal`、在**宽限期内收束**时,取消记 `run.cancelled`。它**不**声称「每个被 abort 的 run 都终于 cancelled」——忽略 signal / 超宽限的 run 由重启期 reaper 记 `run.failed`(见 run-engine「取消」需求与 cli daemon 停机需求;那是被明确接受的降级,非本能力覆盖)。
- `hangar.run.runtime-capabilities/v1` —— host 为每个 `RunContext` 注入从同一 canonical set 派生的、新鲜且冻结的 `ctx.capabilities` 快照;caller 数据不能伪造或替换它。

#### 场景:doctor 广播四个成员
- **当** 一个含本变更的 host 上执行 `hangar doctor --json`
- **那么** 其 `capabilities[]` MUST 含 `hangar.run.trigger-kind/v1`、`hangar.run.abort-signal/v1`、`hangar.run.cancelled-terminal/v1`、`hangar.run.runtime-capabilities/v1`

#### 场景:字段不在则不广播其能力
- **当** `ctx.triggerKind` 字段在该 build 尚未落地(#16 未同期)
- **那么** `HOST_CAPABILITIES` MUST NOT 含 `hangar.run.trigger-kind/v1`(不谎报)

#### 场景:能力号语义变更须 bump 版本
- **当** 某能力的运行时语义改变
- **那么** MUST 以新 `/vN` 标识、MUST NOT 复用旧号

### 需求:消费者按精确版本对 host 提供集 fail closed
脊柱 MUST 提供断言原语 `assertCapabilities(required, have)`:按**精确 `name/vN` 字符串**判 `required ⊆ have`(**无版本大小比较——「更新的未知版本」仅是精确串不命中**),任一缺失即 MUST 抛错(fail closed)。`have` **MUST 由调用方传入真机集**;该原语 **MUST NOT 提供 module-local 常量作默认 `have`**——否则一个 in-process 调用方若 import 了自带(bundle)的 `@hangar/core` 常量,会校验**自己 bundle 的副本**而非运行中 host,判成假绿(C1)。

**两道门禁,adapter 自带要求集:** ① 部署脚本跨进程读**真机 host** 的 `doctor --json`,在部署/启动前校验;② adapter 的 `run(ctx)` 入口读取 host 注入的 `ctx.capabilities`,在自己的 run 内业务副作用前再次校验。两者都使用 adapter 自带的 `required-list`;**脊柱不为 app 存 required 集**(不给 app.yaml 加字段)。

**诚实边界:** 脊柱不能强制 adapter 调断言。`PipelineExecutor` 先 import pilot 模块再调 `run(ctx)`,所以运行期门禁只能保护 adapter 的 **run 内业务副作用**,不能保护模块顶层副作用;pipeline 模块必须 side-effect-free at import。部署期 doctor 门禁保护旧 host/错误制品,运行期快照证明当前 run 的 host 契约,两者互补。部署仍钉在测过的 hangar commit/version。

#### 场景:所需能力齐备 → 放行
- **当** adapter 的 required-list ⊆ 真机 `doctor --json` 广播集
- **那么** `assertCapabilities` 通过,adapter 继续执行

#### 场景:所需能力缺失 → 副作用前 fail closed
- **当** adapter 要求 `hangar.run.abort-signal/v1` 或 `hangar.run.cancelled-terminal/v1`,而真机能力集缺该精确串
- **那么** MUST 在任何业务副作用之前 fail closed(非零退出 / 拒绝启动),不得静默降级

#### 场景:仅有未知更新版本 → fail closed
- **当** 真机集只含 `hangar.run.abort-signal/v2` 而无所要求的 `v1`
- **那么** 精确匹配失败 → fail closed(不假设向前兼容)

### 需求:每个 run 获得不可伪造的新鲜冻结能力快照
executor MUST 在创建 `RunContext` 时从 `HOST_CAPABILITIES` 复制出一个新数组并冻结,作为只读 `ctx.capabilities` 传给 pipeline。该字段 MUST 由 host 写入,不得从 `input`、`config`、trigger 或调用方 `RunRequest` 读取;对某次快照的修改尝试 MUST NOT 改变 canonical set、doctor 输出或后续 run 的快照。

#### 场景:每个 run 获得新鲜快照
- **当** host 连续创建两个 run
- **那么** 两个 `ctx.capabilities` MUST 内容等于 `HOST_CAPABILITIES`、各自已冻结且数组引用不同

#### 场景:caller 不能伪造 host 能力
- **当** input/config/request 携带名为 `capabilities` 的任意值
- **那么** pipeline 看到的 `ctx.capabilities` 仍 MUST 是 host 从 canonical set 生成的快照

#### 场景:修改快照不污染 canonical 输出
- **当** pipeline 尝试修改其 `ctx.capabilities`
- **那么** 修改 MUST 失败或无效,且之后 `doctor --json` 与新 run 的能力集保持不变

### 需求:hard-crash containment 能力闸只在通过 fault test 后广播

`host-capabilities` 机制(版本化能力集 + `assertCapabilities` fail-closed + doctor 广播)由变更 `add-run-cancellation`(#17)引入(代码已在 #17 实现,规范待 #17 归档);本需求在其上定义 `hangar.run.hard-crash-containment/v1` 这一能力的**广播闸**,**依赖 #17 先落地**。`hardcrash` 是一条全新需求,故本 delta 写作 `## 新增需求`(ADDED)--与 host-capabilities 是否已有基线无关。

`doctor` 广播的是一个**静态能力集**(`HOST_CAPABILITIES`,逐字输出);闸不是运行时逻辑,而是 **release-time 纪律**:选定的 containment 实现**只有在通过 daemon-SIGKILL / PID+startTime 指纹 fault test(覆盖 pipeline 与 approve 两面,见 design D5;CI 全绿)后**,其实现变更才可把 `hangar.run.hard-crash-containment/v1` 这个串加入 `HOST_CAPABILITIES`(同能力集「一个成员 MUST NOT 出现,除非同一 build 提供其契约」的既有纪律)。本能力的**覆盖强度按平台、由选定实现的 fault test 界定并披露**(方法无关;**Linux(有 cgroup 委派)= provable + 完整;Linux(无委派)与 macOS = best-effort**,残余与边界见 design D2/D3/D4)--fail-closed 消费者不得据裸能力串假设「一切 OS 子孙必被回收」。**「Hangar 已回收 DB(Run/锁)」单独 MUST NOT 被当作满足本能力**--DB-reaped 与 OS-child-reaped 是两件事,必须分开断言(见 `run-engine`「reaper 回收」需求的边界)。要求本能力的 pipeline adapter **MUST** 在**部署期**(任何业务副作用之前)读真机 `doctor --json` 自比后 fail-closed(#17 的 C2:pipeline 模块顶层副作用先于任何 in-run `assertCapabilities`,故唯一可靠强制点在部署期):当所需能力缺失、或仅存在未知的更高版本(如广播集有 `hangar.run.hard-crash-containment/v2` 而无 `/v1`)时,精确 `name/vN` 匹配不命中 -> 关门(不得假设向后兼容)。

**注:** 本变更是设计-only,只定义闸的**语义契约**;让 doctor 真正广播该能力的**实现**属后续受闸变更(fault test 通过前不广播)。

#### 场景:未过 fault test 不广播
- **当** 选定 containment 实现尚未通过 daemon-SIGKILL / PID+startTime 指纹 fault test(覆盖 pipeline 与 approve 两面,见 design D5;或尚未实现)
- **那么** `doctor` 的能力集 MUST NOT 含 `hangar.run.hard-crash-containment/v1`;要求它的 app adapter 经 `assertCapabilities` 在业务副作用前 fail-closed

#### 场景:DB-reaped 不冒充 OS-child-reaped
- **当** hangar 已把某崩溃孤儿 Run 判 `run.failed`、释放锁,但其 detached OS 子孙进程未被按本平台强度回收(Linux(有 cgroup 委派)须完整回收;Linux(无委派)与 macOS 须 best-effort 回收 + 如实披露残余)
- **那么** 这单独 MUST NOT 满足 `hangar.run.hard-crash-containment/v1`;能力广播必须以「OS 子孙进程树已按本平台强度回收」的独立断言为前提(Linux(有委派)完整、Linux(无委派)与 macOS best-effort + 已披露残余)--不得用 DB 已 reaped 冒充

#### 场景:未知更高版本仍 fail-closed
- **当** app 要求 `hangar.run.hard-crash-containment/v1`,而 doctor 广播集只含 `hangar.run.hard-crash-containment/v2`
- **那么** `assertCapabilities` 精确匹配不命中 -> 在业务副作用前 fail-closed(不假设 v2 向后兼容 v1)

