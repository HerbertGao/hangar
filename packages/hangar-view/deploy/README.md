# hangar-view 部署(Phase 4 · ts.mac-mini)

只读监控前端。与脊柱 daemon 并列(view 挂不影响 daemon)。绑 `127.0.0.1`,
经 Cloudflare Tunnel + Access 远程,边缘鉴权、不裸露公网。**命令在 ts.mac-mini 上跑。**

前提:`~/hangar`(脊柱 git main)已在跑 `com.herbertgao.hangar-inbox` daemon;
node v22 经 fnm 已装;你控制一个域名 + Cloudflare Zero Trust 已开通。

---

## 1. 取代码 + 装依赖

```bash
cd ~/hangar
git pull                      # 取到 packages/hangar-view(#6 已合并 + 已归档)
pnpm install                  # 装 @hangar/view 的 deps(node-cron + yaml)
chmod +x packages/hangar-view/deploy/hangar-view.sh
```

> core 有 `runs --limit`(#7)时需重编:`pnpm --filter @hangar/core build`(node 在 PATH);
> daemon 无需重启(其行为不受 `--limit` 影响,view 会 spawn 新 dist 的 CLI)。

## 2. 本机 smoke(暴露前先确认能跑)

```bash
# 用与 daemon 相同的 HANGAR_APPS/HANGAR_DB(G1:必须对齐,否则画「全员没上过班」假象)
eval "$(fnm env)"
HANGAR_APPS=~/hangar/apps HANGAR_DB=~/hangar/hangar.sqlite PORT=8787 \
  node packages/hangar-view/src/server.js &
sleep 1
curl -s http://127.0.0.1:8787/api/state | head -c 400; echo
#  → 应见真实 office(inbox 按 poll 节奏、liveness 大概率「活着」);启动日志会回显解析到的 HANGAR_APPS/HANGAR_DB,核对与 daemon 一致
kill %1
```

**若 `/api/state` 的 `config` 回显路径与 daemon 不一致**:改 `deploy/hangar-view.sh`
里的 `HANGAR_APPS`/`HANGAR_DB` 为 daemon 实际所用(见 `~/hangar-inbox-daemon.sh`)。

## 3. 装 launchd agent(开机自启 + 崩溃拉起)

```bash
cp packages/hangar-view/deploy/com.herbertgao.hangar-view.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.herbertgao.hangar-view.plist
launchctl list | grep hangar-view          # 有 PID = 起来了
tail -f ~/hangar-view.err.log              # 看启动日志(端口 / 路径回显 / 未对齐告警)
```

> plist 里路径按 `home=/Users/herbertgao` 写死;若用户名/路径不同,改 plist 的绝对路径。
> `hangar-view.sh` 默认 node 走 `fnm exec --using 22`;若 launchd 下 fnm 不可用,
> 在 plist 的 `EnvironmentVariables` 加 `<key>NODE</key><string>daemon 所用的绝对 node v22 路径</string>`。

## 4. Cloudflare Tunnel(agent-hangar,仓内 config)

**tunnel 名 = `agent-hangar`**;ingress 走**仓内** `deploy/cloudflared/config.yml`(权威、提交进仓,
照 ai-radar/model-radar 范式);凭据 JSON 留 `~/.cloudflared/`(secret、不进仓)。**专用 tunnel、
与 ai-radar 的 model-radar 及 daemon 隔离**——一条挂不牵连其它。

```bash
brew install cloudflared                     # 若未装(2026.6.1+)
cloudflared tunnel login                     # 浏览器授权;cert.pem 已在则跳过
cloudflared tunnel create agent-hangar       # 生成 UUID + ~/.cloudflared/<UUID>.json
```

把生成的 **UUID 填进 `deploy/cloudflared/config.yml`** 的 `tunnel:` 与 `credentials-file:`
(该文件已锁 `protocol: http2`——本机 UDP/QUIC 被 WARP/utun 拦,QUIC 会一直超时重试)。
装专用 launchd agent(用户域、免 sudo、崩溃拉起):

```bash
cp packages/hangar-view/deploy/com.herbertgao.agent-hangar-tunnel.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.herbertgao.agent-hangar-tunnel.plist
cloudflared tunnel info agent-hangar         # 见 darwin_arm64 connector + 边缘 = 连上
```

**Access 配好前不要路由 DNS**(见第 5 步顺序);Access 就位后再:

```bash
cloudflared tunnel route dns agent-hangar agent.heapcn.dev
```

## 5. Cloudflare Access(边缘鉴权 —— 这一步不做 = 页面裸奔公网)

**顺序:先配 Access,再 `route dns`**(第 4 步已把 DNS 路由留到最后)——这样 agent.heapcn.dev
从第一个请求起就有鉴权,无裸奔窗口。Zero Trust 面板(UI,非 CLI):

1. **Access → Applications → Add an application → Self-hosted**。
2. Application domain = `agent.heapcn.dev`。
3. Policy:**Allow**,Include → **Emails** → `heapcn@gmail.com`(你的 Google 账号)。
4. Session duration 按需(如 24h)。保存。
5. 回第 4 步末尾 `cloudflared tunnel route dns agent-hangar agent.heapcn.dev` 点亮。

## 6. 验收(spec task 4.2 / 4.3)

```bash
# 4.2:未授权必须被边缘拦截(302 去 CF Access 登录 / 403),不能直接返回页面
curl -sI https://agent.heapcn.dev | head -3
#  → 见 302 → *.cloudflareaccess.com 或 403 = Access 生效;若直接 200 返回 office = Access 没保护住,回第 5 步
```

- **4.3**:手机浏览器开 `https://agent.heapcn.dev` → CF Access 登 Google → 3 秒看清
  inbox 员工近况 + hangar 活没活,全程不碰 SSH/CLI。翻车时该员工 💥⚠️、等你拍板 🙋⚠️。

## 回滚

```bash
# view:
launchctl bootout gui/$(id -u)/com.herbertgao.hangar-view
rm ~/Library/LaunchAgents/com.herbertgao.hangar-view.plist
# tunnel(agent-hangar):
launchctl bootout gui/$(id -u)/com.herbertgao.agent-hangar-tunnel
rm ~/Library/LaunchAgents/com.herbertgao.agent-hangar-tunnel.plist
cloudflared tunnel delete -f agent-hangar     # 删 tunnel + 凭据
# DNS/Access:面板删 agent.heapcn.dev 的 CNAME + Access app。
```

view 与 daemon 完全解耦:停 view 不影响 `com.herbertgao.hangar-inbox` 与脊柱状态。

## 已披露约束(spec 里已锁,部署时留意)

- **命令写路径(`add-view-command-path`)**:页面有一条**受白名单约束**的写路径 `POST /api/command`——仅 `(inbox, interpret-feedback|apply-feedback)`、confirm-before-apply,用于向 inbox 下达降噪命令;**从页面 approve/reject 审批**仍无(接第一个带审批 pilot 时才做,届时引 app 级身份)。
- **⚠️ `HANGAR_VIEW_HOST` 必须保持 `127.0.0.1`(有了写端点后尤其关键)**:鉴权在 Cloudflare Access 边缘终结、tunnel 只连 loopback;**误绑 `0.0.0.0` 会让 LAN/公网直连绕过 Access**,后果从「泄露只读监控」升级为「**无鉴权任意人可写 inbox 降噪名单**」。`deploy/hangar-view.sh`/plist 里不要改绑。
- **数据最小化**:`/api/state`、trace 抽屉只回派生态,零 `payload`/`args`。
- **本体存活是启发式**:UI 呈「疑似」,不精确判死;手动 `hangar run --trigger` replay
  与 daemon 存活在读模型不可区分(已披露盲区)。
- **per-app runs 已收口**:core `runs [--limit N]` 已落地(#7),view 调 `runs <app> --limit 50`
  ——既避大历史下 `process.exit` 截断管道 stdout(生产 inbox ~300KB 曾截在 64KB),也防无界增长。
