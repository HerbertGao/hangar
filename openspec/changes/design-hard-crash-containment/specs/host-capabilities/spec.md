## 新增需求

### 需求:hard-crash containment 能力闸只在通过 fault test 后广播

`host-capabilities` 机制(版本化能力集 + `assertCapabilities` fail-closed + doctor 广播)由变更 `add-run-cancellation`(#17)引入(代码已在 #17 实现,规范待 #17 归档);本需求在其上定义 `hangar.run.hard-crash-containment/v1` 这一能力的**广播闸**,**依赖 #17 先落地**。`hardcrash` 是一条全新需求,故本 delta 写作 `## 新增需求`(ADDED)——与 host-capabilities 是否已有基线无关。

`doctor` 广播的是一个**静态能力集**(`HOST_CAPABILITIES`,逐字输出);闸不是运行时逻辑,而是 **release-time 纪律**:选定的 containment 实现**只有在通过 daemon-SIGKILL / PID-oracle fault test(CI 全绿)后**,其实现变更才可把 `hangar.run.hard-crash-containment/v1` 这个串加入 `HOST_CAPABILITIES`(同能力集「一个成员 MUST NOT 出现,除非同一 build 提供其契约」的既有纪律)。本能力的**覆盖强度按平台、由选定实现的 fault test 界定并披露**(方法无关;**Linux(cgroup)= provable + 完整,macOS = best-effort**,残余与边界见 design D2/D4)——fail-closed 消费者不得据裸能力串假设「一切 OS 子孙必被回收」。**「Hangar 已回收 DB(Run/锁)」单独 MUST NOT 被当作满足本能力**——DB-reaped 与 OS-child-reaped 是两件事,必须分开断言(见 `run-engine`「reaper 回收」需求的边界)。要求本能力的 pipeline adapter **MUST** 在**部署期**(任何业务副作用之前)读真机 `doctor --json` 自比后 fail-closed(#17 的 C2:pipeline 模块顶层副作用先于任何 in-run `assertCapabilities`,故唯一可靠强制点在部署期):当所需能力缺失、或仅存在未知的更高版本(如广播集有 `hangar.run.hard-crash-containment/v2` 而无 `/v1`)时,精确 `name/vN` 匹配不命中 → 关门(不得假设向后兼容)。

**注:** 本变更是设计-only,只定义闸的**语义契约**;让 doctor 真正广播该能力的**实现**属后续受闸变更(fault test 通过前不广播)。

#### 场景:未过 fault test 不广播
- **当** 选定 containment 实现尚未通过 daemon-SIGKILL/PID-oracle fault test(或尚未实现)
- **那么** `doctor` 的能力集 MUST NOT 含 `hangar.run.hard-crash-containment/v1`;要求它的 app adapter 经 `assertCapabilities` 在业务副作用前 fail-closed

#### 场景:DB-reaped 不冒充 OS-child-reaped
- **当** hangar 已把某崩溃孤儿 Run 判 `run.failed`、释放锁,但其 detached OS 子孙进程未被证明回收
- **那么** 这单独 MUST NOT 满足 `hangar.run.hard-crash-containment/v1`;能力广播必须以「OS 子孙进程树已被回收」的独立断言为前提

#### 场景:未知更高版本仍 fail-closed
- **当** app 要求 `hangar.run.hard-crash-containment/v1`,而 doctor 广播集只含 `hangar.run.hard-crash-containment/v2`
- **那么** `assertCapabilities` 精确匹配不命中 → 在业务副作用前 fail-closed(不假设 v2 向后兼容 v1)
