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

> core(`packages/core/dist`)本次零改,不用重编;daemon 照常。

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

## 4. Cloudflare Tunnel

```bash
brew install cloudflared                    # 若未装
cloudflared tunnel login                    # 浏览器授权(需 `! cloudflared tunnel login` 在本会话跑,或你终端跑)
cloudflared tunnel create hangar-view       # 生成 UUID + ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns hangar-view hangar.<你的域名>
```

写 `~/.cloudflared/config.yml`:

```yaml
tunnel: hangar-view
credentials-file: /Users/herbertgao/.cloudflared/<上一步的 UUID>.json
ingress:
  - hostname: hangar.<你的域名>
    service: http://127.0.0.1:8787      # cloudflared 从本机连 view 的 loopback
  - service: http_status:404
```

跑(持久化,与 view 一致走用户 launchd agent、免 sudo):

```bash
cloudflared tunnel run hangar-view          # 前台先测通
# 持久化二选一:
#   a) brew services start cloudflared      # brew 管的用户服务(免 sudo)
#   b) sudo cloudflared service install      # 系统服务(要 sudo,你自己在终端跑)
```

## 5. Cloudflare Access(边缘鉴权 —— 这一步不做 = 页面裸奔公网)

Zero Trust 面板(UI,非 CLI):

1. **Access → Applications → Add an application → Self-hosted**。
2. Application domain = `hangar.<你的域名>`。
3. Policy:**Allow**,Include → **Emails** → `heapcn@gmail.com`(你的 Google 账号)。
4. Session duration 按需(如 24h)。保存。

## 6. 验收(spec task 4.2 / 4.3)

```bash
# 4.2:未授权必须被边缘拦截(302 去 CF Access 登录 / 403),不能直接返回页面
curl -sI https://hangar.<你的域名> | head -3
#  → 见 302 → *.cloudflareaccess.com 或 403 = Access 生效;若直接 200 返回 office = Access 没保护住,回第 5 步
```

- **4.3**:手机浏览器开 `https://hangar.<你的域名>` → CF Access 登 Google → 3 秒看清
  inbox 员工近况 + hangar 活没活,全程不碰 SSH/CLI。翻车时该员工 💥⚠️、等你拍板 🙋⚠️。

## 回滚

```bash
launchctl bootout gui/$(id -u)/com.herbertgao.hangar-view
rm ~/Library/LaunchAgents/com.herbertgao.hangar-view.plist
# cloudflared:brew services stop cloudflared(或 launchctl bootout 对应 agent);
#   删 route:cloudflared tunnel route dns 反向操作 / 面板删 Access app + DNS。
```

view 与 daemon 完全解耦:停 view 不影响 `com.herbertgao.hangar-inbox` 与脊柱状态。

## 已披露约束(spec 里已锁,部署时留意)

- **只读**:v1 无 approve/reject 写路径(接第一个带审批 pilot 时才做,届时引 app 级身份)。
- **数据最小化**:`/api/state`、trace 抽屉只回派生态,零 `payload`/`args`。
- **本体存活是启发式**:UI 呈「疑似」,不精确判死;手动 `hangar run --trigger` replay
  与 daemon 存活在读模型不可区分(已披露盲区)。
- **per-app runs 无界**:~400+ 天历史会撑爆 maxBuffer,到时给 core 加 `runs --limit`(Phase C)。
