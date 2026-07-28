// delta 标题归属检查:`## 修改需求` 下的需求必须已存在于主规范,`## 新增需求` 下的必须不存在。
//
// 为何独立成一个零依赖脚本、而不是加进 validate-openspec-cn.mjs:
//   ① `openspec-cn validate --strict` 对这类错误**结构上是瞎的** —— 它只查需求文本与 SHALL/MUST 的存在性,
//      从不把 MODIFIED 的标题拿去主规范里解析。实测:一个把新需求填进 `## 修改需求` 的 delta,validate 全绿,
//      而 `archive` 直接中止(「MODIFIED 失败,标题 … 未找到」),变更永远无法归档、spec 那半进不了 SOT。
//   ② validate-openspec-cn.mjs 是 openspec-cn 的包装器,带 1.6.0 版本门;本机常是 1.5.0,那条路径跑不起来,
//      加进去的检查等于永不执行。本检查只读 markdown,故能真接进 `pnpm test` 与 CI。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CHANGES = 'openspec/changes';
const SPECS = 'openspec/specs';

// 必须在仓根跑:两个路径是相对 cwd 的,从子目录跑会两个都不存在 → 循环空转 → 静默 rc=0。
if (!existsSync(CHANGES) || !existsSync(SPECS)) {
  console.error(`必须在仓根运行(找不到 ${CHANGES}/ 或 ${SPECS}/;当前 cwd=${process.cwd()})`);
  process.exit(2);
}
// openspec-cn 认中英两套结构标题(内容仍中文),两套都要认,否则换风格就绕过检查。
const SECTION = {
  modified: [/^##\s+修改需求\s*$/, /^##\s+MODIFIED\s+Requirements\s*$/i],
  added: [/^##\s+新增需求\s*$/, /^##\s+ADDED\s+Requirements\s*$/i],
  removed: [/^##\s+删除需求\s*$/, /^##\s+REMOVED\s+Requirements\s*$/i],
  renamed: [/^##\s+重命名需求\s*$/, /^##\s+RENAMED\s+Requirements\s*$/i],
};
const REQ = /^###\s+(?:需求|Requirement)[::]\s*(.+?)\s*$/;

/** 把一份 delta 解析成 `{ section → [需求名] }`;未落在任何 `## ` 小节下的需求归 orphan。 */
function parseDelta(text) {
  const out = { modified: [], added: [], removed: [], renamed: [], orphan: [], renamedFrom: [] };
  let current = 'orphan';
  for (const line of text.split('\n')) {
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      current = Object.keys(SECTION).find((k) => SECTION[k].some((re) => re.test(line))) ?? 'orphan';
      continue;
    }
    const m = REQ.exec(line);
    if (m) out[current].push(m[1]);
    if (current === 'renamed') {
      const f = /^\s*-\s*FROM[::]\s*(?:`)?(?:###\s*(?:需求|Requirement)[::]\s*)?(.+?)(?:`)?\s*$/.exec(line);
      if (f) out.renamedFrom.push(f[1]);
    }
  }
  return out;
}

/** 主规范里的需求名集合;规范不存在(全新 capability)→ 空集。 */
function baseRequirements(capability) {
  const p = join(SPECS, capability, 'spec.md');
  if (!existsSync(p)) return new Set();
  const names = new Set();
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = REQ.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

const problems = [];
for (const change of existsSync(CHANGES) ? readdirSync(CHANGES) : []) {
  if (change === 'archive') continue; // 不可变历史,不体检
  const specsDir = join(CHANGES, change, 'specs');
  if (!existsSync(specsDir)) continue;
  for (const capability of readdirSync(specsDir)) {
    const file = join(specsDir, capability, 'spec.md');
    if (!existsSync(file)) continue;
    const delta = parseDelta(readFileSync(file, 'utf8'));
    const base = baseRequirements(capability);
    const where = `${change}/specs/${capability}`;
    const n = delta.modified.length + delta.added.length + delta.removed.length + delta.renamed.length + delta.orphan.length;
    if (n === 0) {
      // 一份 delta spec 零需求 = 解析器与文档格式脱节(实测:`### 需求:` 换成 `### 需求 - ` 后本门曾报「通过」)。
      // 必须 per-file 判:用全局总数会被同仓其它变更的需求掩盖,那正是这个门第一版栽的地方。
      problems.push(`${where}: 没解析到任何 \`### 需求:\` —— 该文件为空,或解析器与文档格式已脱节`);
    }

    for (const name of delta.orphan) {
      problems.push(`${where}: 需求「${name}」不在任何 ## 小节下(需 修改/新增/删除/重命名 之一)`);
    }
    // RENAMED 的 FROM 侧同样必须在主规范里存在,否则 archive 一样中止。它用 `- FROM:`/`- TO:` 列表项,
    // 故 `### 需求:` 解析器抓不到——用行内 FROM 提取补上,别让整类对门不可见。
    for (const name of delta.renamedFrom) {
      if (!base.has(name)) {
        problems.push(`${where}: RENAMED 的 FROM「${name}」在主规范里不存在 → archive 会中止`);
      }
    }
    for (const name of [...delta.modified, ...delta.removed]) {
      if (!base.has(name)) {
        problems.push(
          `${where}: 「${name}」列为 修改/删除,但主规范里没有同名需求 → archive 会中止。新需求应放 ## 新增需求 下`,
        );
      }
    }
    for (const name of delta.added) {
      if (base.has(name)) {
        problems.push(`${where}: 「${name}」列为 新增,但主规范里已存在 → archive 会报已存在。应放 ## 修改需求 下`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('delta 标题归属检查失败:\n' + problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(1);
}
console.error('delta 标题归属检查通过');
