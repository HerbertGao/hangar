## 0. Apply前置

- [x] 0.1 在本change外完成`M0-SOURCE-TIMEOUT-001`独立root-cause、修复与fresh CR+RC；随后运行`node --test tests/m0/source-pins.test.mjs >/tmp/hangar-source-pins.tap`与`node --test tests/m0/*.test.mjs >/tmp/hangar-m0-preflight.tap`，并用3.1同一TAP解析逻辑证明两者`fail/cancelled/skipped/todo`均为0。当前已知取消不得由重跑、提高/删除10秒阈值或本change内编辑覆盖；前置未通过时MUST NOT执行1.1及后续任务。

## 1. 收敛所有现行验收 SOT

- [x] 1.1 编辑前执行下列仓外逐文件备份；它保存tracked/untracked原始字节与`absent`标记，且不改Git index：

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
export HANGAR_ACCEPT_ROOT="$(pwd -P)"
export HANGAR_ACCEPT_BACKUP="$(mktemp -d /private/tmp/hangar-m1-accept.XXXXXX)"
export HANGAR_ACCEPT_LOCK="/private/tmp/hangar-m1-accept.$(printf '%s' "$HANGAR_ACCEPT_ROOT" | shasum -a 256 | cut -d' ' -f1).lock"
bootstrap_ready=0
lock_owned=0
bootstrap_cleanup() { status=$?; trap - EXIT; if test "$bootstrap_ready" -ne 1; then test "$lock_owned" -eq 0 || rm -rf "$HANGAR_ACCEPT_LOCK"; rm -rf "$HANGAR_ACCEPT_BACKUP"; fi; exit "$status"; }
trap bootstrap_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$HANGAR_ACCEPT_LOCK" || { echo 'another acceptance apply owns this workspace' >&2; exit 1; }
lock_owned=1
printf '%s\n' "$HANGAR_ACCEPT_BACKUP" >"$HANGAR_ACCEPT_LOCK/owner"
printf '%s\n' "$HANGAR_ACCEPT_LOCK" >"$HANGAR_ACCEPT_BACKUP/lock-path"
printf '%s\n' "$HANGAR_ACCEPT_ROOT" >"$HANGAR_ACCEPT_BACKUP/repo-root"
printf 'HANGAR_ACCEPT_BACKUP=%q\n' "$HANGAR_ACCEPT_BACKUP"
cat >"$HANGAR_ACCEPT_BACKUP/paths" <<'PATHS'
DESIGN.md
ROADMAP.md
CLAUDE.md
openspec/config.yaml
openspec/specs/m0-evaluation-oracles/spec.md
openspec/changes/define-v2-control-contracts/proposal.md
openspec/changes/define-v2-control-contracts/design.md
openspec/changes/define-v2-control-contracts/tasks.md
openspec/changes/define-v2-control-contracts/specs/m0-evaluation-oracles/spec.md
openspec/changes/define-v2-control-contracts/specs/v2-control-contracts/spec.md
openspec/changes/define-v2-control-contracts/specs/v2-storage-contract/spec.md
openspec/changes/implement-m1-heartbeat-v2/proposal.md
openspec/changes/implement-m1-heartbeat-v2/design.md
openspec/changes/implement-m1-heartbeat-v2/tasks.md
openspec/changes/implement-m1-heartbeat-v2/specs/m1-heartbeat-runtime/spec.md
openspec/changes/add-mastra-harness-candidate/.openspec.yaml
openspec/changes/add-mastra-harness-candidate/proposal.md
openspec/changes/add-mastra-harness-candidate/design.md
openspec/changes/add-mastra-harness-candidate/tasks.md
openspec/changes/add-mastra-harness-candidate/specs/external-candidate-qualification/spec.md
evidence/m1-heartbeat.json
oracles/m0/sources.json
oracles/m0/output-manifest.json
openspec/changes/define-m1-spec-based-acceptance/.openspec.yaml
openspec/changes/define-m1-spec-based-acceptance/proposal.md
openspec/changes/define-m1-spec-based-acceptance/design.md
openspec/changes/define-m1-spec-based-acceptance/specs/m0-evaluation-oracles/spec.md
openspec/changes/define-m1-spec-based-acceptance/tasks.md
PATHS
: >"$HANGAR_ACCEPT_BACKUP/absent"
while IFS= read -r path; do
  if test -f "$path"; then
    mkdir -p "$HANGAR_ACCEPT_BACKUP/files/$(dirname "$path")"
    cp -p "$path" "$HANGAR_ACCEPT_BACKUP/files/$path"
  elif test -e "$path"; then
    echo "non-file path: $path" >&2; exit 1
  else
    printf '%s\n' "$path" >>"$HANGAR_ACCEPT_BACKUP/absent"
  fi
done <"$HANGAR_ACCEPT_BACKUP/paths"
(cd "$HANGAR_ACCEPT_BACKUP/files" && find . -type f | sort | xargs shasum -a 256) >"$HANGAR_ACCEPT_BACKUP/SHA256SUMS"
(cd "$HANGAR_ACCEPT_BACKUP/files" && shasum -a 256 -c ../SHA256SUMS)
cat >"$HANGAR_ACCEPT_BACKUP/restore.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
: "${HANGAR_ACCEPT_BACKUP:?}"
test "$(cat "$HANGAR_ACCEPT_BACKUP/repo-root")" = "$PWD"
test "$(cat "$(cat "$HANGAR_ACCEPT_BACKUP/lock-path")/owner")" = "$HANGAR_ACCEPT_BACKUP"
shasum -a 256 -c "$HANGAR_ACCEPT_BACKUP/control.SHA256SUMS"
db_drift=0
if test -f "$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS"; then shasum -a 256 -c "$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS" || db_drift=1; else test ! -e hangar.sqlite || db_drift=1; fi
(cd "$HANGAR_ACCEPT_BACKUP/files" && shasum -a 256 -c ../SHA256SUMS)
while IFS= read -r path; do
  if grep -Fxq "$path" "$HANGAR_ACCEPT_BACKUP/absent"; then rm -f "$path"; else mkdir -p "$(dirname "$path")"; cp -p "$HANGAR_ACCEPT_BACKUP/files/$path" "$path"; fi
done <"$HANGAR_ACCEPT_BACKUP/paths"
test "$db_drift" -eq 0
rm -rf "$(cat "$HANGAR_ACCEPT_BACKUP/lock-path")"
SH
chmod 700 "$HANGAR_ACCEPT_BACKUP/restore.sh"
if test -f hangar.sqlite; then shasum -a 256 hangar.sqlite >"$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS"; else : >"$HANGAR_ACCEPT_BACKUP/protected-db.absent"; fi
shasum -a 256 "$HANGAR_ACCEPT_BACKUP/paths" "$HANGAR_ACCEPT_BACKUP/absent" "$HANGAR_ACCEPT_BACKUP/repo-root" "$HANGAR_ACCEPT_BACKUP/lock-path" "$HANGAR_ACCEPT_BACKUP/restore.sh" >"$HANGAR_ACCEPT_BACKUP/control.SHA256SUMS"
for path in "$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS" "$HANGAR_ACCEPT_BACKUP/protected-db.absent"; do if test -f "$path"; then shasum -a 256 "$path" >>"$HANGAR_ACCEPT_BACKUP/control.SHA256SUMS"; fi; done
bootstrap_ready=1
```

  后续任一非shell编辑/tool失败时必须立即执行`HANGAR_ACCEPT_BACKUP="$HANGAR_ACCEPT_BACKUP" "$HANGAR_ACCEPT_BACKUP/restore.sh"`；所有shell mutation/check block安装同一restore trap。禁止`git checkout/reset`整树回退。回滚也可显式执行以下命令：

```bash
set -euo pipefail
: "${HANGAR_ACCEPT_BACKUP:?pass the unique directory printed by task 1.1}"
test "$(cat "$HANGAR_ACCEPT_BACKUP/repo-root")" = "$PWD"
test "$(cat "$(cat "$HANGAR_ACCEPT_BACKUP/lock-path")/owner")" = "$HANGAR_ACCEPT_BACKUP"
shasum -a 256 -c "$HANGAR_ACCEPT_BACKUP/control.SHA256SUMS"
db_drift=0
if test -f "$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS"; then shasum -a 256 -c "$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS" || db_drift=1; else test ! -e hangar.sqlite || db_drift=1; fi
(cd "$HANGAR_ACCEPT_BACKUP/files" && shasum -a 256 -c ../SHA256SUMS)
while IFS= read -r path; do
  if grep -Fxq "$path" "$HANGAR_ACCEPT_BACKUP/absent"; then
    rm -f "$path"
  else
    mkdir -p "$(dirname "$path")"
    cp -p "$HANGAR_ACCEPT_BACKUP/files/$path" "$path"
    cmp -s "$path" "$HANGAR_ACCEPT_BACKUP/files/$path"
  fi
done <"$HANGAR_ACCEPT_BACKUP/paths"
while IFS= read -r path; do test ! -e "$path"; done <"$HANGAR_ACCEPT_BACKUP/absent"
test "$db_drift" -eq 0
rm -rf "$(cat "$HANGAR_ACCEPT_BACKUP/lock-path")"
```

- [x] 1.2 将本change的两个modified requirements，以及已完成未归档的`define-v2-control-contracts`相关proposal/design/tasks/spec，统一为“M0 evaluator universe仅由candidate spec显式opt-in”。同步修订`add-mastra-harness-candidate` proposal/tasks：把“`define-v2-control-contracts`零改动”改为“Requirement/scenario/member ID与数量不变，仅允许本次opt-in语义修订”；不改变Mastra资格赛。验证：`rg -n 'M1\+ candidate SHALL|中立 Heartbeat 以及具名|M1\+ 还必须|M1\+ execution 仍须' openspec/changes/define-v2-control-contracts`在旧change现行规范正文中零命中，并先执行下列before/after身份比较；Mastra strict通过，未来archive不会恢复旧默认分母。

```bash
set -euo pipefail
: "${HANGAR_ACCEPT_BACKUP:?pass the unique directory printed by task 1.1}"
test "$(cat "$HANGAR_ACCEPT_BACKUP/repo-root")" = "$PWD"
test "$(cat "$(cat "$HANGAR_ACCEPT_BACKUP/lock-path")/owner")" = "$HANGAR_ACCEPT_BACKUP"
rollback_on_error() { status=$?; "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit "$status"; }
rollback_on_int() { "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit 130; }
rollback_on_term() { "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit 143; }
trap rollback_on_error ERR
trap rollback_on_int INT
trap rollback_on_term TERM
node - <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const backup = process.env.HANGAR_ACCEPT_BACKUP;
const paths = [
  'openspec/specs/m0-evaluation-oracles/spec.md',
  'openspec/changes/define-v2-control-contracts/specs/m0-evaluation-oracles/spec.md',
  'openspec/changes/define-v2-control-contracts/specs/v2-control-contracts/spec.md',
  'openspec/changes/define-v2-control-contracts/specs/v2-storage-contract/spec.md',
  'openspec/changes/implement-m1-heartbeat-v2/specs/m1-heartbeat-runtime/spec.md',
  'openspec/changes/add-mastra-harness-candidate/specs/external-candidate-qualification/spec.md',
  'openspec/changes/define-m1-spec-based-acceptance/specs/m0-evaluation-oracles/spec.md',
];
const identities = (text) => ({
  requirements: [...text.matchAll(/^\*\*Requirement ID:\*\* `([^`]+)`/gm)].map((match) => match[1]),
  scenarios: [...text.matchAll(/^#### Scenario: (.+)$/gm)].map((match) => match[1]),
});
for (const path of paths) {
  const before = identities(fs.readFileSync(`${backup}/files/${path}`, 'utf8'));
  const after = identities(fs.readFileSync(path, 'utf8'));
  assert.deepEqual(after, before, `${path}:member-identity-drift`);
  if (after.requirements.length === 0 || after.scenarios.length === 0) throw new Error(`${path}:empty-members`);
}
NODE
```

- [x] 1.3 将DESIGN/ROADMAP/CLAUDE、`openspec/config.yaml`与`implement-m1-heartbeat-v2` proposal/design/spec统一为“M1 runtime requirements/scenarios是Heartbeat stage acceptance唯一语义SOT”；把原M1 tasks 6.1改为逐条确认每个requirement/scenario，证据类别限定为：运行时场景=公开API/fresh SQLite/真实process；历史治理场景=原始review return，若原文不可得则必须同时使用冻结entry review summary、stable approvalRef、`measurements/evidence.json`/`measurements/ledger.json` burn ledger与对应制品（仅agent ID或计数不够）；反事实失败分支=负向测试或可审查fail-closed guard及公共路径。任一遗漏或证据不足保持`observation-not-conformance`；6.2仅保留既有checks/review/measurements，不新增6.3、mapping registry、validator、runner、receipt或产品文件，并把stale `6/6`改为从当前ledger推导。

## 2. Evidence、主spec与M0 advisory清单

- [x] 2.1 把`evidence/m1-heartbeat.json`收敛为仅含可执行命令、固定测试文件、限制与informational measurement状态的记录；验证：不含stage acceptance状态、断言值副本、stdout hash、LOC、agent ID、case coverage表或M0 token补票，且`if rg -n 'evidence/m1-heartbeat|M0 advisory: READY' packages apps/heartbeat; then exit 1; fi`通过。
- [x] 2.2 在任何终态声明前调用`openspec-sync-specs`工作流（change=`define-m1-spec-based-acceptance`）同步主`m0-evaluation-oracles` spec。随后用以下stdlib one-shot命令刷新既有M0 owner数据；命令不落仓、不新增生成器：

```bash
set -euo pipefail
: "${HANGAR_ACCEPT_BACKUP:?pass the unique directory printed by task 1.1}"
test "$(cat "$HANGAR_ACCEPT_BACKUP/repo-root")" = "$PWD"
test "$(cat "$(cat "$HANGAR_ACCEPT_BACKUP/lock-path")/owner")" = "$HANGAR_ACCEPT_BACKUP"
rollback_on_error() { status=$?; "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit "$status"; }
rollback_on_int() { "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit 130; }
rollback_on_term() { "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit 143; }
trap rollback_on_error ERR
trap rollback_on_int INT
trap rollback_on_term TERM
node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = process.cwd();
const sha = (value) => createHash('sha256').update(value).digest('hex');
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const writeJson = (path, value) => writeFile(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);
async function filesBelow(path) {
  const files = [];
  for (const entry of await readdir(resolve(root, path), { withFileTypes: true })) {
    const relative = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(relative));
    else files.push(relative);
  }
  return files;
}
const sources = await readJson('oracles/m0/sources.json');
for (const member of sources.v2SotFiles)
  member.sha256 = sha(await readFile(resolve(root, member.path)));
await writeJson('oracles/m0/sources.json', sources);
const manifest = await readJson('oracles/m0/output-manifest.json');
manifest.sourceManifestDigest = sha(await readFile(resolve(root, manifest.sourceManifestPath)));
const paths = [...await filesBelow('contracts/v2'), ...await filesBelow('oracles/m0'), ...await filesBelow('measurements'), ...await filesBelow('tests/m0'), 'scripts/validate-m0.mjs'].sort();
const category = (path) => path.startsWith('contracts/v2/') ? 'contract' : path.startsWith('oracles/m0/') ? 'oracle' : path.startsWith('measurements/') ? 'measurement' : path.startsWith('tests/m0/') ? 'test' : 'validator';
manifest.outputs = await Promise.all(paths.map(async (path) => path === 'oracles/m0/output-manifest.json' ? { path, category: category(path), digestPolicy: 'self-schema-only' } : { path, category: category(path), sha256: sha(await readFile(resolve(root, path))) }));
await writeJson('oracles/m0/output-manifest.json', manifest);
NODE
```

  随后用原始字节而非`git diff`验证两份manifest只改变允许的digest字段：

```bash
set -euo pipefail
: "${HANGAR_ACCEPT_BACKUP:?pass the unique directory printed by task 1.1}"
test "$(cat "$HANGAR_ACCEPT_BACKUP/repo-root")" = "$PWD"
test "$(cat "$(cat "$HANGAR_ACCEPT_BACKUP/lock-path")/owner")" = "$HANGAR_ACCEPT_BACKUP"
rollback_on_error() { status=$?; "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit "$status"; }
rollback_on_int() { "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit 130; }
rollback_on_term() { "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit 143; }
trap rollback_on_error ERR
trap rollback_on_int INT
trap rollback_on_term TERM
node - <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const backup = process.env.HANGAR_ACCEPT_BACKUP;
const read = (path) => JSON.parse(fs.readFileSync(path, 'utf8'));
const beforeSources = read(`${backup}/files/oracles/m0/sources.json`);
const afterSources = read('oracles/m0/sources.json');
const normalizeSources = (value) => ({ ...value, v2SotFiles: value.v2SotFiles.map((member) => ({ ...member, sha256: '<digest>' })) });
assert.deepEqual(normalizeSources(afterSources), normalizeSources(beforeSources));
const beforeOutput = read(`${backup}/files/oracles/m0/output-manifest.json`);
const afterOutput = read('oracles/m0/output-manifest.json');
const normalizeOutput = (value) => ({ ...value, sourceManifestDigest: '<digest>', outputs: value.outputs.map((entry) => 'sha256' in entry ? { ...entry, sha256: '<digest>' } : entry) });
assert.deepEqual(normalizeOutput(afterOutput), normalizeOutput(beforeOutput));
NODE
```

  同步后还必须逐字比较两个modified requirement正文，拒绝同义旧门残留：

```bash
set -euo pipefail
: "${HANGAR_ACCEPT_BACKUP:?pass the unique directory printed by task 1.1}"
test "$(cat "$HANGAR_ACCEPT_BACKUP/repo-root")" = "$PWD"
test "$(cat "$(cat "$HANGAR_ACCEPT_BACKUP/lock-path")/owner")" = "$HANGAR_ACCEPT_BACKUP"
rollback_on_error() { status=$?; "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit "$status"; }
rollback_on_int() { "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit 130; }
rollback_on_term() { "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit 143; }
trap rollback_on_error ERR
trap rollback_on_int INT
trap rollback_on_term TERM
node - <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const files = {
  desired: 'openspec/changes/define-m1-spec-based-acceptance/specs/m0-evaluation-oracles/spec.md',
  main: 'openspec/specs/m0-evaluation-oracles/spec.md',
  legacy: 'openspec/changes/define-v2-control-contracts/specs/m0-evaluation-oracles/spec.md',
};
const titles = ['完整的权威与故障矩阵', 'Harness 归因与 ProcessSpec 证据'];
const block = (text, title) => {
  const start = text.indexOf(`### Requirement: ${title}`);
  const end = text.indexOf('\n### Requirement:', start + 1);
  if (start < 0) throw new Error(`${title}:missing`);
  return text.slice(start, end < 0 ? text.length : end).trim().replace(/[ \t]+$/gm, '');
};
const content = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, fs.readFileSync(path, 'utf8')]));
for (const title of titles) {
  const desired = block(content.desired, title);
  assert.equal(block(content.main, title), desired, `${title}:main-drift`);
  assert.equal(block(content.legacy, title), desired, `${title}:legacy-drift`);
}
NODE
```

  验证：同步后`rg -n 'M1\+ candidate SHALL|中立 Heartbeat 以及具名|M1\+ 还必须|M1\+ execution 仍须' openspec/specs/m0-evaluation-oracles/spec.md openspec/changes/define-v2-control-contracts`零命中；再次原样执行1.2的完整before/after身份比较（此时main sync与M1编辑均已落地）；主spec中`m0o.fault-matrix`和`m0o.harness-attribution`只对显式opt-in candidate启用M0分母；manifest归一化比较通过，且未新增路径、runner或consumer。失败时按1.1恢复。

## 3. 可复现检查与最终关闭

- [x] 3.1 对最终语义字节运行以下命令，并机器校验TAP汇总而不是只看exit code：

```bash
set -euo pipefail
: "${HANGAR_ACCEPT_BACKUP:?pass the unique directory printed by task 1.1}"
test "$(cat "$HANGAR_ACCEPT_BACKUP/repo-root")" = "$PWD"
test "$(cat "$(cat "$HANGAR_ACCEPT_BACKUP/lock-path")/owner")" = "$HANGAR_ACCEPT_BACKUP"
rollback_on_error() { status=$?; "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit "$status"; }
rollback_on_int() { "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit 130; }
rollback_on_term() { "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit 143; }
trap rollback_on_error ERR
trap rollback_on_int INT
trap rollback_on_term TERM
export CHECK_DIR="$HANGAR_ACCEPT_BACKUP/checks"
if test -f "$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS"; then shasum -a 256 -c "$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS"; else test ! -e hangar.sqlite; fi
rm -rf "$CHECK_DIR" && mkdir -p "$CHECK_DIR/results"
{
  cat "$HANGAR_ACCEPT_BACKUP/paths"
  printf '%s\n' tsconfig.json measurements/evidence.json measurements/ledger.json docs/proposals/personal-agent-builder.md docs/proposals/mastra-candidate-evaluation.md docs/proposals/control-core-v2-migration.md openspec/specs/v2-control-contracts/spec.md openspec/specs/v2-storage-contract/spec.md
  node -e "const m=require('./oracles/m0/output-manifest.json');for(const o of m.outputs)console.log(o.path)"
  find packages apps/heartbeat tests/m1 types openspec/changes/define-v2-control-contracts openspec/changes/implement-m1-heartbeat-v2 openspec/changes/add-mastra-harness-candidate openspec/changes/define-m1-spec-based-acceptance -type f
} | sort -u | while IFS= read -r path; do if test -f "$path"; then printf '%s\n' "$path"; fi; done >"$CHECK_DIR/input.paths"
while IFS= read -r path; do shasum -a 256 "$path"; done <"$CHECK_DIR/input.paths" >"$CHECK_DIR/input.SHA256SUMS"
node --test tests/m1/release-lifecycle.test.ts tests/m1/storage-faults.test.ts tests/m1/effect-resume.test.ts tests/m1/process-restore.test.ts >"$CHECK_DIR/results/hangar-m1.tap" 2>"$CHECK_DIR/results/hangar-m1-test.err"
node --test tests/m0/*.test.mjs >"$CHECK_DIR/results/hangar-m0.tap" 2>"$CHECK_DIR/results/hangar-m0-test.err"
node - <<'NODE'
const fs = require('node:fs');
for (const path of [`${process.env.CHECK_DIR}/results/hangar-m1.tap`, `${process.env.CHECK_DIR}/results/hangar-m0.tap`]) {
  const text = fs.readFileSync(path, 'utf8');
  for (const [name, expected] of [['fail', 0], ['cancelled', 0], ['skipped', 0], ['todo', 0]]) {
    const match = text.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
    if (!match || Number(match[1]) !== expected) throw new Error(`${path}:${name}`);
  }
  if (!/^# tests [1-9]\d*$/m.test(text)) throw new Error(`${path}:tests`);
}
NODE
node scripts/validate-m0.mjs all >"$CHECK_DIR/results/hangar-m0.out" 2>"$CHECK_DIR/results/hangar-m0.err"
test "$(cat "$CHECK_DIR/results/hangar-m0.out")" = 'M0 advisory: READY' && test ! -s "$CHECK_DIR/results/hangar-m0.err"
openspec-cn validate --specs --strict --json >"$CHECK_DIR/results/hangar-specs.json" 2>"$CHECK_DIR/results/hangar-specs.err"
for change in define-v2-control-contracts implement-m1-heartbeat-v2 add-mastra-harness-candidate define-m1-spec-based-acceptance; do
  openspec-cn validate "$change" --type change --strict --json >"$CHECK_DIR/results/$change.json" 2>"$CHECK_DIR/results/$change.err"
done
node - <<'NODE'
const fs = require('node:fs');
for (const name of ['hangar-specs','define-v2-control-contracts','implement-m1-heartbeat-v2','add-mastra-harness-candidate','define-m1-spec-based-acceptance']) {
  const path = `${process.env.CHECK_DIR}/results/${name}.json`;
  if (JSON.parse(fs.readFileSync(path, 'utf8')).summary.totals.failed !== 0) throw new Error(path);
}
NODE
node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit >"$CHECK_DIR/results/hangar-tsc.out" 2>"$CHECK_DIR/results/hangar-tsc.err"
git diff --check >"$CHECK_DIR/results/hangar-diff-check.out" 2>"$CHECK_DIR/results/hangar-diff-check.err"
node - <<'NODE' >"$CHECK_DIR/results/hangar-whitespace.out" 2>"$CHECK_DIR/results/hangar-whitespace.err"
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const backup = process.env.HANGAR_ACCEPT_BACKUP;
const listed = fs.readFileSync(`${backup}/paths`, 'utf8').trim().split('\n');
const untracked = execFileSync('git', ['ls-files','--others','--exclude-standard','-z','--','packages','apps/heartbeat','tests/m1','evidence','types','tsconfig.json','openspec/changes/define-v2-control-contracts','openspec/changes/implement-m1-heartbeat-v2','openspec/changes/add-mastra-harness-candidate','openspec/changes/define-m1-spec-based-acceptance','openspec/specs']).toString().split('\0').filter(Boolean);
const paths = [...new Set([...listed, ...untracked])].filter((path) => fs.existsSync(path) && fs.statSync(path).isFile());
for (const path of paths) {
  const lines = fs.readFileSync(path, 'utf8').split(/\n/);
  lines.forEach((line, index) => { if (/[ \t]+$/.test(line)) throw new Error(`${path}:${index + 1}:trailing-whitespace`); });
}
NODE
if rg -n 'openspec|tests/m0|scripts/validate-m0|oracles/m0' packages apps/heartbeat >"$CHECK_DIR/results/hangar-boundary.out" 2>"$CHECK_DIR/results/hangar-boundary.err"; then
  echo 'forbidden product import' >&2; exit 1
else
  status=$?; test "$status" -eq 1
fi
find . -maxdepth 3 \( -name '*.sqlite' -o -name '*.sqlite-wal' -o -name '*.sqlite-shm' \) -not -name hangar.sqlite -print >"$CHECK_DIR/results/hangar-sqlite-residue.out"
test ! -s "$CHECK_DIR/results/hangar-sqlite-residue.out"
set +e
HANGAR_ACCEPT_ROOT="$(cat "$HANGAR_ACCEPT_BACKUP/repo-root")" ps -axo pid=,command= 2>"$CHECK_DIR/results/hangar-process-all.err" | HANGAR_ACCEPT_ROOT="$(cat "$HANGAR_ACCEPT_BACKUP/repo-root")" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const root=process.env.HANGAR_ACCEPT_ROOT;const needles=[["apps","heartbeat","child.ts"],["tests","m1","worker.ts"]].map(parts=>root+"/"+parts.join("/"));const hits=s.split("\n").filter(line=>needles.some(needle=>line.includes(needle)));if(hits.length)process.stdout.write(hits.join("\n")+"\n")})' >"$CHECK_DIR/results/hangar-process-residue.out" 2>"$CHECK_DIR/results/hangar-process-residue.err"
statuses=("${PIPESTATUS[@]}")
set -e
test "${statuses[0]}" -eq 0
test "${statuses[1]}" -eq 0
test ! -s "$CHECK_DIR/results/hangar-process-residue.out"
{
  cat "$HANGAR_ACCEPT_BACKUP/paths"
  printf '%s\n' tsconfig.json measurements/evidence.json measurements/ledger.json docs/proposals/personal-agent-builder.md docs/proposals/mastra-candidate-evaluation.md docs/proposals/control-core-v2-migration.md openspec/specs/v2-control-contracts/spec.md openspec/specs/v2-storage-contract/spec.md
  node -e "const m=require('./oracles/m0/output-manifest.json');for(const o of m.outputs)console.log(o.path)"
  find packages apps/heartbeat tests/m1 types openspec/changes/define-v2-control-contracts openspec/changes/implement-m1-heartbeat-v2 openspec/changes/add-mastra-harness-candidate openspec/changes/define-m1-spec-based-acceptance -type f
} | sort -u | while IFS= read -r path; do if test -f "$path"; then printf '%s\n' "$path"; fi; done >"$CHECK_DIR/current-input.paths"
cmp -s "$CHECK_DIR/current-input.paths" "$CHECK_DIR/input.paths" || { echo 'validation input path set changed' >&2; exit 1; }
shasum -a 256 -c "$CHECK_DIR/input.SHA256SUMS"
if test -f "$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS"; then shasum -a 256 -c "$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS"; else test ! -e hangar.sqlite; fi
(cd "$CHECK_DIR/results" && find . -type f | sort | xargs shasum -a 256) >"$CHECK_DIR/results.SHA256SUMS"
```

  任一timeout/cancelled（包括当前已知的M0 source-pins 10秒取消）都使本次apply失败：立即按1.1恢复并保持`observation-not-conformance`；不得在同一次apply中用后续重跑覆盖，也不得提高阈值。只有独立root-cause处置并复核后才能开始新的apply。

- [x] 3.2 用下列原始字节命令生成terminal patch；不得使用`git diff`：

```bash
set -euo pipefail
: "${HANGAR_ACCEPT_BACKUP:?pass the unique directory printed by task 1.1}"
test "$(cat "$HANGAR_ACCEPT_BACKUP/repo-root")" = "$PWD"
test "$(cat "$(cat "$HANGAR_ACCEPT_BACKUP/lock-path")/owner")" = "$HANGAR_ACCEPT_BACKUP"
rollback_on_error() { status=$?; "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit "$status"; }
rollback_on_int() { "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit 130; }
rollback_on_term() { "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit 143; }
trap rollback_on_error ERR
trap rollback_on_int INT
trap rollback_on_term TERM
export TERMINAL_DIR="$HANGAR_ACCEPT_BACKUP/terminal"
export CHECK_DIR="$HANGAR_ACCEPT_BACKUP/checks"
rm -rf "$TERMINAL_DIR" && mkdir -p "$TERMINAL_DIR/before" "$TERMINAL_DIR/after"
printf '%s\n' openspec/changes/implement-m1-heartbeat-v2/tasks.md openspec/changes/define-m1-spec-based-acceptance/tasks.md >"$TERMINAL_DIR/paths"
while IFS= read -r path; do
  mkdir -p "$TERMINAL_DIR/before/$(dirname "$path")" "$TERMINAL_DIR/after/$(dirname "$path")"
  cp -p "$path" "$TERMINAL_DIR/before/$path"
  cp -p "$path" "$TERMINAL_DIR/after/$path"
done <"$TERMINAL_DIR/paths"
node - <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const root = `${process.env.HANGAR_ACCEPT_BACKUP}/terminal/after/`;
const expected = new Map([
  ['openspec/changes/implement-m1-heartbeat-v2/tasks.md', ['6.1','6.2']],
  ['openspec/changes/define-m1-spec-based-acceptance/tasks.md', ['3.1','3.2']],
]);
for (const [path, ids] of expected) {
  let text = fs.readFileSync(root + path, 'utf8');
  const actual = [...text.matchAll(/^- \[ \] (\d+\.\d+) /gm)].map((match) => match[1]);
  assert.deepEqual(actual, ids, `${path}:unexpected-unchecked-tasks`);
  for (const id of ids) text = text.replace(`- [ ] ${id} `, `- [x] ${id} `);
  fs.writeFileSync(root + path, text);
}
NODE
: >"$TERMINAL_DIR/terminal.patch"
while IFS= read -r path; do
  if diff -u --label "$path" "$TERMINAL_DIR/before/$path" --label "$path" "$TERMINAL_DIR/after/$path" >>"$TERMINAL_DIR/terminal.patch"; then
    echo "missing terminal diff: $path" >&2; exit 1
  else
    test "$?" -eq 1
  fi
done <"$TERMINAL_DIR/paths"
(cd "$TERMINAL_DIR/before" && find . -type f | sort | xargs shasum -a 256) >"$TERMINAL_DIR/before.SHA256SUMS"
(cd "$TERMINAL_DIR/after" && find . -type f | sort | xargs shasum -a 256) >"$TERMINAL_DIR/after.SHA256SUMS"
test -s "$TERMINAL_DIR/terminal.patch"
{
  cat "$HANGAR_ACCEPT_BACKUP/paths"
  printf '%s\n' tsconfig.json measurements/evidence.json measurements/ledger.json docs/proposals/personal-agent-builder.md docs/proposals/mastra-candidate-evaluation.md docs/proposals/control-core-v2-migration.md openspec/specs/v2-control-contracts/spec.md openspec/specs/v2-storage-contract/spec.md
  node -e "const m=require('./oracles/m0/output-manifest.json');for(const o of m.outputs)console.log(o.path)"
  find packages apps/heartbeat tests/m1 types openspec/changes/define-v2-control-contracts openspec/changes/implement-m1-heartbeat-v2 openspec/changes/add-mastra-harness-candidate openspec/changes/define-m1-spec-based-acceptance -type f
} | sort -u | while IFS= read -r path; do if test -f "$path"; then printf '%s\n' "$path"; fi; done >"$TERMINAL_DIR/reviewed.paths"
while IFS= read -r path; do shasum -a 256 "$path"; done <"$TERMINAL_DIR/reviewed.paths" >"$TERMINAL_DIR/reviewed.SHA256SUMS"
cmp -s "$TERMINAL_DIR/reviewed.paths" "$CHECK_DIR/input.paths" || { echo 'review scope differs from validation inputs' >&2; exit 1; }
shasum -a 256 -c "$CHECK_DIR/input.SHA256SUMS"
(cd "$CHECK_DIR/results" && shasum -a 256 -c ../results.SHA256SUMS)
shasum -a 256 "$TERMINAL_DIR/terminal.patch" "$CHECK_DIR/input.paths" "$CHECK_DIR/input.SHA256SUMS" "$CHECK_DIR/results.SHA256SUMS" >>"$TERMINAL_DIR/reviewed.SHA256SUMS"
for path in "$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS" "$HANGAR_ACCEPT_BACKUP/protected-db.absent"; do if test -f "$path"; then shasum -a 256 "$path" >>"$TERMINAL_DIR/reviewed.SHA256SUMS"; fi; done
while IFS= read -r result; do shasum -a 256 "$result"; done < <(find "$CHECK_DIR/results" -type f | sort) >>"$TERMINAL_DIR/reviewed.SHA256SUMS"
test -s "$TERMINAL_DIR/reviewed.paths" && test -s "$TERMINAL_DIR/reviewed.SHA256SUMS"
node - <<'NODE'
const fs = require('node:fs');
const source = fs.readFileSync('openspec/changes/implement-m1-heartbeat-v2/specs/m1-heartbeat-runtime/spec.md', 'utf8');
const requirements = [];
for (const chunk of source.split(/^### Requirement: /m).slice(1)) {
  const newline = chunk.indexOf('\n');
  const title = chunk.slice(0, newline).trim();
  const body = chunk.slice(newline + 1);
  const id = body.match(/^\*\*Requirement ID:\*\* `([^`]+)`/m)?.[1];
  if (!id) throw new Error(`${title}:missing-id`);
  const scenarios = [...body.matchAll(/^#### Scenario: (.+)$/gm)].map((scenario) => scenario[1]);
  if (scenarios.length === 0) throw new Error(`${id}:no-scenarios`);
  requirements.push({ id, title, scenarios });
}
if (requirements.length === 0) throw new Error('no-requirements');
fs.writeFileSync(`${process.env.HANGAR_ACCEPT_BACKUP}/terminal/m1-identities.json`, JSON.stringify(requirements, null, 2) + '\n');
NODE
shasum -a 256 "$TERMINAL_DIR/m1-identities.json" >>"$TERMINAL_DIR/reviewed.SHA256SUMS"
node - <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const dir = `${process.env.HANGAR_ACCEPT_BACKUP}/terminal`;
const sha = (path) => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
fs.writeFileSync(`${dir}/review-context.json`, JSON.stringify({ reviewedSetSha256: sha(`${dir}/reviewed.SHA256SUMS`), terminalPatchSha256: sha(`${dir}/terminal.patch`), identitiesSha256: sha(`${dir}/m1-identities.json`) }, null, 2) + '\n');
NODE
```

  读取`$TERMINAL_DIR/review-context.json`，把`REVIEWED-CONTEXT-SHA256: <reviewedSetSha256>`写入两lane prompt；原始return必须逐字保存为`$TERMINAL_DIR/reviews/cr.md`与`rc.md`。对已同步主spec、最终SOT/config、`define-v2-control-contracts`、`implement-m1-heartbeat-v2`、`add-mastra-harness-candidate`、主`v2-control-contracts`/`v2-storage-contract` specs、M1公开实现/测试、evidence、`measurements/evidence.json`、`measurements/ledger.json`、`$CHECK_DIR/results`及`terminal.patch`执行fresh Code Reviewer + Reality Checker review-loop。两lane原始return必须逐条使用以下格式列出当前每个M1成员：`EVIDENCE | requirement | <id> | satisfied | <runtime|governance|negative> | <exact-ref>`，以及`EVIDENCE | scenario | <requirement-id> | <scenario-title> | satisfied | <runtime|governance|negative> | <exact-ref>`；精确引用必须是测试文件+test名、公开API/fact/process结果、负向guard路径，或历史制品+approvalRef；历史治理项若无原始return，必须同时引用冻结entry review summary、stable approvalRef、两份burn ledger和对应制品，不能只引用agent ID。

  两份return还必须各自包含同一`REVIEWED-CONTEXT-SHA256`与`VERDICT: APPROVE`；保存后执行`shasum -a 256 "$TERMINAL_DIR/review-context.json" "$TERMINAL_DIR/reviews/cr.md" "$TERMINAL_DIR/reviews/rc.md" >"$TERMINAL_DIR/reviews.SHA256SUMS"`。只有最新一轮无blocker/major、无遗漏/`evidence-insufficient`且该轮无修复时，执行以下字节级应用；除此之外按1.1恢复并保持`observation-not-conformance`：

```bash
set -euo pipefail
: "${HANGAR_ACCEPT_BACKUP:?pass the unique directory printed by task 1.1}"
test "$(cat "$HANGAR_ACCEPT_BACKUP/repo-root")" = "$PWD"
test "$(cat "$(cat "$HANGAR_ACCEPT_BACKUP/lock-path")/owner")" = "$HANGAR_ACCEPT_BACKUP"
rollback_on_error() { status=$?; "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit "$status"; }
rollback_on_int() { "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit 130; }
rollback_on_term() { "$HANGAR_ACCEPT_BACKUP/restore.sh"; exit 143; }
trap rollback_on_error ERR
trap rollback_on_int INT
trap rollback_on_term TERM
export TERMINAL_DIR="$HANGAR_ACCEPT_BACKUP/terminal"
export CHECK_DIR="$HANGAR_ACCEPT_BACKUP/checks"
test -f "$TERMINAL_DIR/reviews.SHA256SUMS"
shasum -a 256 -c "$TERMINAL_DIR/reviews.SHA256SUMS"
node - <<'NODE'
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const dir = `${process.env.HANGAR_ACCEPT_BACKUP}/terminal`;
const context = JSON.parse(fs.readFileSync(`${dir}/review-context.json`, 'utf8'));
const sha = (path) => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
assert.equal(sha(`${dir}/reviewed.SHA256SUMS`), context.reviewedSetSha256, 'reviewed-set-drift');
assert.equal(sha(`${dir}/terminal.patch`), context.terminalPatchSha256, 'terminal-patch-drift');
assert.equal(sha(`${dir}/m1-identities.json`), context.identitiesSha256, 'identity-set-drift');
for (const name of ['cr.md','rc.md']) {
  const text = fs.readFileSync(`${dir}/reviews/${name}`, 'utf8');
  const verdicts = [...text.matchAll(/^VERDICT: (APPROVE|CHANGES-REQUESTED)$/gm)].map((match) => match[1]);
  if (!text.includes(`REVIEWED-CONTEXT-SHA256: ${context.reviewedSetSha256}`)) throw new Error(`${name}:unbound-review`);
  if (verdicts.length !== 1 || verdicts[0] !== 'APPROVE') throw new Error(`${name}:verdict`);
  if (/^- (blocker|major) \|/m.test(text) || text.includes('evidence-insufficient')) throw new Error(`${name}:unresolved-finding`);
  const identities = JSON.parse(fs.readFileSync(`${dir}/m1-identities.json`, 'utf8'));
  const expected = new Set();
  for (const requirement of identities) {
    expected.add(`requirement|${requirement.id}`);
    for (const scenario of requirement.scenarios) expected.add(`scenario|${requirement.id}|${scenario}`);
  }
  const actual = new Set();
  for (const line of text.split('\n').filter((value) => value.startsWith('EVIDENCE | '))) {
    const fields = line.split(' | ');
    let key;
    if (fields[1] === 'requirement' && fields.length === 6) key = `requirement|${fields[2]}`;
    else if (fields[1] === 'scenario' && fields.length === 7) key = `scenario|${fields[2]}|${fields[3]}`;
    else throw new Error(`${name}:malformed-evidence-line`);
    const statusIndex = fields[1] === 'requirement' ? 3 : 4;
    if (fields[statusIndex] !== 'satisfied') throw new Error(`${name}:${key}:status`);
    if (!['runtime','governance','negative'].includes(fields[statusIndex + 1]) || !fields[statusIndex + 2]) throw new Error(`${name}:${key}:evidence`);
    if (actual.has(key)) throw new Error(`${name}:${key}:duplicate`);
    actual.add(key);
  }
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${name}:identity-coverage`);
}
NODE
while IFS= read -r path; do cmp -s "$path" "$TERMINAL_DIR/before/$path" || { echo "preimage changed: $path" >&2; exit 1; }; done <"$TERMINAL_DIR/paths"
{
  cat "$HANGAR_ACCEPT_BACKUP/paths"
  printf '%s\n' tsconfig.json measurements/evidence.json measurements/ledger.json docs/proposals/personal-agent-builder.md docs/proposals/mastra-candidate-evaluation.md docs/proposals/control-core-v2-migration.md openspec/specs/v2-control-contracts/spec.md openspec/specs/v2-storage-contract/spec.md
  node -e "const m=require('./oracles/m0/output-manifest.json');for(const o of m.outputs)console.log(o.path)"
  find packages apps/heartbeat tests/m1 types openspec/changes/define-v2-control-contracts openspec/changes/implement-m1-heartbeat-v2 openspec/changes/add-mastra-harness-candidate openspec/changes/define-m1-spec-based-acceptance -type f
} | sort -u | while IFS= read -r path; do if test -f "$path"; then printf '%s\n' "$path"; fi; done >"$TERMINAL_DIR/current-reviewed.paths"
cmp -s "$TERMINAL_DIR/current-reviewed.paths" "$TERMINAL_DIR/reviewed.paths" || { echo 'reviewed path set changed' >&2; exit 1; }
shasum -a 256 -c "$TERMINAL_DIR/reviewed.SHA256SUMS"
if test -f "$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS"; then shasum -a 256 -c "$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS"; else test ! -e hangar.sqlite; fi
node - <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const dir = `${process.env.HANGAR_ACCEPT_BACKUP}/terminal`;
const headers = fs.readFileSync(`${dir}/terminal.patch`, 'utf8').split('\n').filter((line) => line.startsWith('--- ') || line.startsWith('+++ '));
assert.deepEqual(headers, [
  '--- openspec/changes/implement-m1-heartbeat-v2/tasks.md',
  '+++ openspec/changes/implement-m1-heartbeat-v2/tasks.md',
  '--- openspec/changes/define-m1-spec-based-acceptance/tasks.md',
  '+++ openspec/changes/define-m1-spec-based-acceptance/tasks.md',
]);
NODE
patch --forward -p0 <"$TERMINAL_DIR/terminal.patch"
while IFS= read -r path; do cmp -s "$path" "$TERMINAL_DIR/after/$path" || { echo "postimage mismatch: $path" >&2; exit 1; }; done <"$TERMINAL_DIR/paths"
for change in define-v2-control-contracts implement-m1-heartbeat-v2 add-mastra-harness-candidate define-m1-spec-based-acceptance; do openspec-cn validate "$change" --type change --strict --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{if(JSON.parse(s).summary.totals.failed)process.exit(1)})"; done
git diff --check
{
  cat "$HANGAR_ACCEPT_BACKUP/paths"
  printf '%s\n' tsconfig.json measurements/evidence.json measurements/ledger.json docs/proposals/personal-agent-builder.md docs/proposals/mastra-candidate-evaluation.md docs/proposals/control-core-v2-migration.md openspec/specs/v2-control-contracts/spec.md openspec/specs/v2-storage-contract/spec.md
  node -e "const m=require('./oracles/m0/output-manifest.json');for(const o of m.outputs)console.log(o.path)"
  find packages apps/heartbeat tests/m1 types openspec/changes/define-v2-control-contracts openspec/changes/implement-m1-heartbeat-v2 openspec/changes/add-mastra-harness-candidate openspec/changes/define-m1-spec-based-acceptance -type f
} | sort -u | while IFS= read -r path; do if test -f "$path"; then printf '%s\n' "$path"; fi; done >"$TERMINAL_DIR/final-reviewed.paths"
cmp -s "$TERMINAL_DIR/final-reviewed.paths" "$TERMINAL_DIR/reviewed.paths" || { echo 'final reviewed path set changed' >&2; exit 1; }
node - <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const dir = `${process.env.HANGAR_ACCEPT_BACKUP}/terminal`;
const targets = new Set(['openspec/changes/implement-m1-heartbeat-v2/tasks.md','openspec/changes/define-m1-spec-based-acceptance/tasks.md']);
for (const line of fs.readFileSync(`${dir}/reviewed.SHA256SUMS`, 'utf8').trim().split('\n')) {
  const match = line.match(/^([0-9a-f]{64})  (.+)$/);
  if (!match || targets.has(match[2])) continue;
  const actual = crypto.createHash('sha256').update(fs.readFileSync(match[2])).digest('hex');
  if (actual !== match[1]) throw new Error(`final-drift:${match[2]}`);
}
NODE
while IFS= read -r path; do cmp -s "$path" "$TERMINAL_DIR/after/$path" || { echo "final postimage mismatch: $path" >&2; exit 1; }; done <"$TERMINAL_DIR/paths"
if test -f "$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS"; then shasum -a 256 -c "$HANGAR_ACCEPT_BACKUP/protected-db.SHA256SUMS"; else test ! -e hangar.sqlite; fi
rm -rf "$(cat "$HANGAR_ACCEPT_BACKUP/lock-path")"
```

  candidate/production qualification始终为false。
