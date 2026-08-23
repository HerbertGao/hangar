## Context

参见`proposal.md`。`checkSources()`按manifest顺序同步检查repositories；首个`revision_unavailable`已经使最终kind不可逆地成为`missing_source`，但当前`continue`仍让后续完整member-set扫描发生。高主机负载把该无效工作放大到既有测试timeout。

## Goals / Non-Goals

**Goals:**

- 在首个不可用revision处返回现有typed结果。
- 保留此前SOT digest checks、repository check与`revision_unavailable` finding。
- 用可观察的后续repository未访问/未报告证明fail-fast，而不是用时间阈值证明。

**Non-Goals:**

- 不优化正常成功扫描，不并行化Git，不引入batch/cache。
- 不改变10秒timeout、result schema、primary kind或M0 advisory语义。
- 不处理主机上无关高负载进程。

## Decisions

### 1. 在`revision_unavailable`分支直接构造并返回结果

把当前`continue`替换为`return result("sources", "missing_source", checks, findings)`。这复用已有result构造器，不新增helper、error kind或状态。

替代方案“先设置fatal再跳出，最后继续runtimeApps验证”被拒绝：revision不存在时，依赖该repository member sets的runtime app结论没有额外诊断价值，仍会增加分支与工作。

替代方案“提高timeout或失败后重试”被拒绝：它掩盖无用扫描，且在相同负载下重复同一路径。

### 2. 回归断言后续repository没有被报告

基于现有manifest副本把第一项revision改为不存在值，断言结果为`missing_source`、包含首个`revision_unavailable`，且checks/findings不包含后续repository/source-set/runtime-app id。该断言验证控制流，不依赖主机速度。

不引入runGit注入点或mock registry；现有公开`checkSources(path)`足以观察结果。

### 3. Output manifest只更新两个既有digest

实现与回归属于M0已声明outputs，因此按现有唯一owner更新对应SHA-256。更新前后比较outputs的`path/category`集合与数量完全相等，并断言除这两个`sha256`外无字段变化；不新增manifest生成器。

## Risks / Trade-offs

- [一次调用少报告后续独立source问题] → revision不可用已经阻止接受整个artifact；修复该fatal后下一次正常调用会继续发现后续问题。以确定性fail-fast换取错误路径有界。
- [错误地截断正常路径] → focused正向source-pins与完整M0 suite必须保持通过，fresh CR+RC复核分支只在`revision.status !== 0 || revision.error`触发。
- [高负载仍导致正常扫描慢] → 这不由本change解决；完整suite若仍timeout则保持blocked，不扩大范围。

## Migration Plan

1. 修改单个`revision_unavailable`分支并增加一个结果级负向回归。
2. 只刷新output manifest中上述两个既有digest，并验证结构/成员完全不变。
3. 运行focused source-pins、完整M0 suite、M0 advisory与strict change validation。
4. 对最终diff执行fresh Code Reviewer + Reality Checker；通过后解除`M0-SOURCE-TIMEOUT-001`前置。
5. 任一检查失败则恢复该分支、测试与两条digest，M0/M1继续blocked。
