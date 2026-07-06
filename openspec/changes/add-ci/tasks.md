## 1. CI 合并门

- [x] 1.1 新增 `.github/workflows/ci.yml`:`on` = `push: branches: [main]`(**用 `main`,别照抄 inbox-pilot 的 `master`)+ `pull_request`;`permissions: contents: read`;`concurrency` 写 **block mapping**(见 design D8 的 canonical 形,**别用 inline `{ }`**——`${{ }}` 含 `{}` 会破 flow map);**job 命名 `CI`**(`jobs.CI:`,ubuntu-latest,`timeout-minutes: 15`)——required status check 的 context 名 = job 名,必须恰为 `CI` 才能被 §3 的分支保护选中(否则永久 pending 卡死所有 PR);步骤 = `actions/checkout@v7`(`with: persist-credentials: false`)→ `actions/setup-node@v6`(`node-version: 22.18.0` 钉下限,**别写裸 `22`**,**别加 `cache: pnpm`**——`corepack enable` 前 pnpm 不在 PATH)→ `corepack enable` → `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm test` → `pnpm build`
- [x] 1.2 本地按 CI 同序 dry-run:`pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build` 全绿——注意这是 macOS/arm64 的**冒烟**,linux/x64 原生路径(`better-sqlite3` 的 linux prebuild、`tsx` 拉的 `@esbuild/linux-x64`)的真验收在 task 4.1 的 ubuntu run

## 2. Dependabot 跟版

- [x] 2.1 新增 `.github/dependabot.yml`:`version: 2`;两条 update 各带 `directory: "/"`——`npm`(`directory: "/"`,weekly)+ `github-actions`(`directory: "/"`,weekly,**别漏 directory**,每条 update 必填否则整份报错);`@types/node` ignore `version-update:semver-major`

## 3. 强制力设置(repo-admin,不在 YAML 里)

- [x] 3.1 把名为 `CI` 的 check 设为 `main` 的 required status check(context 名必须等于 task 1.1 的 job 名 `CI`)——`\gh api ... required_status_checks.contexts=["CI"]` 或 Rulesets 可**直接填名**;仅 classic Settings → Branches 的下拉需该 check **先跑过一次**才可选。不做这步则红 run 仍可合入、「合并门」名不副实(见 spec R1)

## 4. 验证

- [ ] 4.1 开一个 no-op PR,确认 ci job 触发并变绿,且 required check 生效;确认 dependabot **真跟到 member 依赖**:Insights → Dependency graph → Dependabot 触发 "Check for updates",确认 `packages/core` 的某依赖(如 `zod`/`pino`)被列入/开出 PR——**不能只验「YAML 无解析错误」**(根零依赖时静默零 PR 也能通过纯解析检查)
- [ ] 4.2 self-check:在一次性分支引入一个类型错误(或让某测试失败),推上去确认 CI **变红**且 PR 因 required check 无法合并——证明门非摆设;确认后丢弃该分支
