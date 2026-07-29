// workspace 成员归属检查:被 git 忽略的目录**不得**是 pnpm workspace 成员。
//
// 不变量:`.gitignore` 里的 `apps/<id>` = 一个外部 pilot checkout(symlink 进来的独立 repo,自带
// package.json + pnpm-lock.yaml + node_modules,依赖由它自己管)。它一旦被 `apps/*` 收进本仓
// workspace,pnpm 就会把**它的**依赖算进本仓 lockfile 的校验里,而本仓 lockfile 是在 CI/dependabot
// 上生成的 —— 那里 symlink 目标不存在、该 pilot 压根不可见。于是提交的 lockfile 永远记录着
// 「没有外部 pilot」的拓扑,而任何能解析到 symlink 的机器(开发机、生产机)都处在「有外部 pilot」
// 的拓扑里,`pnpm install --frozen-lockfile` 必然报它十几个依赖对不上、装不动。
//
// 为何要一个脚本、而不是只在 pnpm-workspace.yaml 留注释:**这条在 CI 上永远不会自己暴露**,
// 正因为 CI 就是那个看不见 symlink 的地方。CI 全绿而开发机/生产机装不动,是它的**正常表现**,
// 不是异常 —— 上一次是在生产机两个服务已经 bootout 之后才撞上的。Phase 2 接第二个 pilot 时
// 会原样再来一次(它同样会 symlink 进 apps/),故把判据钉成可跑的检查。
//
// 注意本检查的**作用域**:在 CI 上它恒过(那里没有 symlink、无成员可查),它保护的是**本地与生产机**。
// 这不是缺陷,是这条不变量的形状 —— 谁能看见 symlink,谁才需要被拦。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const ROOT = process.cwd();

// 必须在仓根跑:成员路径按仓根算相对路径,且 git check-ignore 要在工作树内。
if (!existsSync('pnpm-workspace.yaml')) {
  console.error(`必须在仓根运行(找不到 pnpm-workspace.yaml;当前 cwd=${ROOT})`);
  process.exit(2);
}

let members;
try {
  const out = execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  members = JSON.parse(out);
} catch (err) {
  // 拿不到成员列表就不能假装通过 —— 那正是本检查存在的失败形状(静默绿)。
  console.error(`无法枚举 workspace 成员(pnpm ls 失败):${err.message}`);
  process.exit(2);
}

const offenders = [];
for (const m of members) {
  const rel = relative(ROOT, resolve(m.path));
  if (!rel || rel.startsWith('..')) continue; // 仓根自身
  try {
    execFileSync('git', ['check-ignore', '-q', '--', rel], { stdio: 'ignore' });
    offenders.push({ name: m.name, rel });
  } catch {
    // 退出码 1 = 未被忽略 = 正常的仓内包
  }
}

if (offenders.length > 0) {
  console.error('被 git 忽略的目录不得是 pnpm workspace 成员:');
  for (const o of offenders) console.error(`  - ${o.rel}(${o.name})`);
  console.error('');
  console.error('它是外部 checkout,依赖由它自己的 repo 管。收进 workspace 会让本仓 lockfile 的');
  console.error('校验拓扑与 CI 不一致,导致开发机/生产机 `pnpm install --frozen-lockfile` 永久失败。');
  console.error('修法:在 pnpm-workspace.yaml 的 packages 里加一行排除,如 `- \'!apps/<id>\'`。');
  process.exit(1);
}

console.log(`workspace 成员检查通过(${members.length} 个成员,无被忽略目录)`);
