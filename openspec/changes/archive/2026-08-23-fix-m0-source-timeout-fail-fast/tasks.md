## 1. 负向回归与最小修复

- [x] 1.1 在`tests/m0/source-pins.test.mjs`的既有“unavailable pinned revision”场景增加结果级断言：`kind === missing_source`、包含首个`revision_unavailable`，且checks/findings不含后续repository/source-set/runtime-app id；验证：修改实现前该断言失败或既有10秒timeout，且测试不新增wall-clock阈值、mock、注入点或registry。止损：若公开`checkSources(path)`结果无法证明后续扫描停止，暂停并复审，不增加测试专用接口。
- [x] 1.2 将`scripts/validate-m0.mjs`中`revision.status !== 0 || revision.error`分支的`continue`替换为立即返回现有`result("sources", "missing_source", checks, findings)`；验证：实现diff只触及该控制流与1.1回归，不改正常路径、10秒timeout、result schema、dependency或M1文件。止损：若需要重构scanner、并发/batch/cache或新error kind，回退并另开change。
- [x] 1.3 仅更新`oracles/m0/output-manifest.json`中`scripts/validate-m0.mjs`与`tests/m0/source-pins.test.mjs`两条既有SHA-256；验证：用更新前副本归一化这两个`sha256`后与更新后JSON深比较相等，outputs路径/类别/数量不变；止损：出现第三条digest或任一结构/成员变化即回滚。

## 2. 验证与交接

- [x] 2.1 运行`node --test tests/m0/source-pins.test.mjs >/tmp/hangar-source-pins.tap`与`node --test tests/m0/*.test.mjs >/tmp/hangar-m0-preflight.tap`，并解析两份TAP要求`fail/cancelled/skipped/todo`均为0且tests非零；再运行`node scripts/validate-m0.mjs all >/tmp/hangar-m0.out 2>/tmp/hangar-m0.err`并要求stdout精确为`M0 advisory: READY\n`、stderr为空；运行`openspec-cn validate fix-m0-source-timeout-fail-fast --type change --strict --json`与`git diff --check`。任何timeout/cancelled都保持blocked，不重跑覆盖、不提高阈值。
- [x] 2.2 对最终diff执行fresh Code Reviewer + Reality Checker review-loop；两lane须确认：失败分支typed result不变、后续repository不再访问、正常source扫描集合不变、无timeout/retry/gate扩张。只有最新一轮无blocker/major且该轮无修复时，才解除`define-m1-spec-based-acceptance`的`M0-SOURCE-TIMEOUT-001`前置；否则回滚1.1/1.2并继续blocked。
