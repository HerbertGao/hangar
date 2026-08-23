## Why

`checkSources()` 在首个冻结revision已确定不可用后，仍同步扫描其余仓库约300个Git对象；结果早已不可逆地是`missing_source`，多余工作在高负载主机上触发既有10秒负例timeout，并阻断M0/M1验收。

## What Changes

- 在`revision_unavailable`分支立即返回现有typed `missing_source` result，保留此前已累积的checks/findings，不再读取无关后续repositories/runtime apps。
- 增加负向回归：首个revision不可用时，结果包含`revision_unavailable`且没有访问/报告后续repository；不以墙钟时长作为断言。
- 重跑focused source-pins与完整M0 suite，并完成fresh CR+RC；10秒阈值、result schema、正常成功路径与M0 advisory token语义全部不变。
- 仅刷新`oracles/m0/output-manifest.json`中`validate-m0.mjs`与`source-pins.test.mjs`两条既有SHA-256；路径、类别、成员与gate不变。
- 服务阶段：解除M0/M1 acceptance的`M0-SOURCE-TIMEOUT-001`前置阻塞。
- 非目标：不提高/删除timeout，不增加retry、并发扫描、`cat-file --batch`、cache、dependency、daemon、gate或第二真相源；不修改M1代码与acceptance口径。
- 回滚：恢复单个分支的原控制流并删除对应回归；M0/M1继续blocked。
- 止损：若修复需要重构完整source scanner或改变正常路径检查集合，停止并另行设计，不把范围扩成性能项目。

不变量检查：

- 单一owner/event truth/Effect Gateway/typed API/no-dual-write均不受影响；本change只缩短已确定失败的只读诊断路径。
- 不新增核心能力或外部平台，glue、部署与12个月运行TCO均无变化。

## Capabilities

### New Capabilities

无；`.openspec.yaml`设置`skip_specs: true`。

### Modified Capabilities

无。现有`m0o.reproducibility`已要求冻结revision不可用时返回typed missing-source；本change只修复实现未及时终止的问题。

## Impact

- 代码：`scripts/validate-m0.mjs`的`checkSources()`单个失败分支。
- 测试：`tests/m0/source-pins.test.mjs`增加fail-fast观察，既有timeout保持不变。
- 无API、schema、manifest结构/成员、依赖、数据或部署变更；仅有两条既有output digest更新。
