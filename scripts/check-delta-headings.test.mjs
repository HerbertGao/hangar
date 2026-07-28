// check-delta-headings 的负向自检。存在理由:那个门是「防没人重跑的规则」的机制,而它自己
// 第一版有三条静默放行路(零解析到需求 / 非仓根 cwd / RENAMED 未校验),全部 rc=0 通过。
// 一个自己会空过的门比没有门更糟——它制造了检查存在的假象。
//
// 跑法:node --test scripts/check-delta-headings.test.mjs(仓根)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = fileURLToPath(new URL('./check-delta-headings.mjs', import.meta.url));

/** 造一个最小 openspec 树:主规范含 baseReqs,变更的 delta 内容为 deltaBody。 */
function fixture({ base = ['已存在的需求'], deltaBody }) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  mkdirSync(join(dir, 'openspec/specs/cap'), { recursive: true });
  mkdirSync(join(dir, 'openspec/changes/chg/specs/cap'), { recursive: true });
  writeFileSync(
    join(dir, 'openspec/specs/cap/spec.md'),
    '## 需求\n\n' + base.map((n) => `### 需求:${n}\n正文。\n\n#### 场景:s\n- **WHEN** w\n- **THEN** t\n`).join('\n'),
  );
  writeFileSync(join(dir, 'openspec/changes/chg/specs/cap/spec.md'), deltaBody);
  return dir;
}
const run = (cwd) => spawnSync(process.execPath, [GATE], { cwd, encoding: 'utf8' });
const REQ = (n) => `### 需求:${n}\n正文。\n\n#### 场景:s\n- **WHEN** w\n- **THEN** t\n`;

test('通过:MODIFIED 名字在主规范里存在、ADDED 不存在', () => {
  const d = fixture({ deltaBody: `## 修改需求\n\n${REQ('已存在的需求')}\n## 新增需求\n\n${REQ('全新需求')}` });
  try {
    const r = run(d);
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('抓:MODIFIED 名字在主规范里不存在(archive 会中止)', () => {
  const d = fixture({ deltaBody: `## 修改需求\n\n${REQ('主规范没有这条')}` });
  try {
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /主规范里没有同名需求/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('抓:ADDED 名字在主规范里已存在(archive 会报已存在)', () => {
  const d = fixture({ deltaBody: `## 新增需求\n\n${REQ('已存在的需求')}` });
  try {
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /主规范里已存在/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('抓:需求不在任何 ## 小节下(orphan)', () => {
  const d = fixture({ deltaBody: REQ('无主的需求') });
  try {
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /不在任何 ## 小节下/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// 下面三条是那个门第一版**静默通过**的三种输入 —— 每条都曾 rc=0。
test('抓(曾静默):一份 delta spec 零解析到需求', () => {
  const d = fixture({ deltaBody: '## 修改需求\n\n### 需求 - 标题格式变了\n正文。\n' });
  try {
    const r = run(d);
    assert.equal(r.status, 1, '零需求必须响亮,不能因为别的变更有需求就被掩盖');
    assert.match(r.stderr, /没解析到任何/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('抓(曾静默):从非仓根跑 → rc=2,不是「通过」', () => {
  const d = fixture({ deltaBody: `## 修改需求\n\n${REQ('已存在的需求')}` });
  try {
    const r = run(join(d, 'openspec'));               // 子目录:两个相对路径都不存在
    assert.equal(r.status, 2, '错 cwd 必须报错退出,而不是空转后报通过');
    assert.match(r.stderr, /必须在仓根运行/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('抓(曾静默):RENAMED 的 FROM 在主规范里不存在', () => {
  const d = fixture({
    deltaBody: '## 重命名需求\n\n- FROM: `### 需求:主规范没有这条`\n- TO: `### 需求:新名字`\n',
  });
  try {
    const r = run(d);
    assert.equal(r.status, 1, 'RENAMED 的 FROM 同样会让 archive 中止,不能对门不可见');
    assert.match(r.stderr, /RENAMED 的 FROM/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('不误报:英文结构标题(openspec-cn 两套都认)', () => {
  const d = fixture({ deltaBody: `## MODIFIED Requirements\n\n${REQ('已存在的需求')}` });
  try {
    const r = run(d);
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
