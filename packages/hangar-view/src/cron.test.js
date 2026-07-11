// Self-check for view-side cron period(F10,零 import core)。需 node-cron(本包自带依赖)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronPeriodMs } from './cron.js';

test('cronPeriodMs: 单表达式周期', () => {
  assert.equal(cronPeriodMs('*/3 * * * *'), 180_000, '*/3 → 3 分');
  assert.equal(cronPeriodMs('*/1 * * * *'), 60_000, '*/1 → 1 分');
});

test('cronPeriodMs: string[] union 取最频繁(最小周期)', () => {
  // 混合频率数组 → min 周期(最激进)。
  assert.equal(cronPeriodMs(['0 0 * * *', '*/5 * * * *']), 300_000, '取 */5 的 5 分');
  // inbox digest 三个每日 cron 时刻 → 每日周期 24h(合法、非 null)。
  assert.equal(cronPeriodMs(['0 6 * * *', '30 12 * * *', '0 19 * * *']), 86_400_000);
});

test('cronPeriodMs: 非法表达式 → null(不抛)', () => {
  assert.equal(cronPeriodMs('not a cron'), null);
  assert.equal(cronPeriodMs([]), null);
});
