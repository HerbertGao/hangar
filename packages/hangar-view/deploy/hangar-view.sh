#!/bin/bash
# hangar-view 只读监控前端 —— launchd 启动脚本(ts.mac-mini)。
# 与脊柱 daemon 并列、互不干扰;view 挂了不影响 daemon。绑 127.0.0.1(cloudflared 走 localhost)。
set -euo pipefail

# launchd 不继承登录 shell 的 PATH —— 显式补 homebrew/fnm。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

HANGAR="${HANGAR_HOME:-$HOME/hangar}"
SERVER="$HANGAR/packages/hangar-view/src/server.js"

# ── 与 daemon 对齐(G1:view MUST 用与 daemon 相同的绝对 HANGAR_APPS/HANGAR_DB)──
# 若你的 daemon 用别的路径,改这两行为 daemon 实际所用(见 ~/hangar-inbox-daemon.sh)。
export HANGAR_APPS="${HANGAR_APPS:-$HANGAR/apps}"
export HANGAR_DB="${HANGAR_DB:-$HANGAR/hangar.sqlite}"

# 绑 loopback(B2:不裸露公网,鉴权全靠 cloudflared 前的 Cloudflare Access)。
export HANGAR_VIEW_HOST="${HANGAR_VIEW_HOST:-127.0.0.1}"
export PORT="${PORT:-8787}"

# node —— launchd/非交互 SSH 下 fnm 常不在 PATH,故用**绝对路径**(与 daemon 同法)。
# view 会 spawn 这个 node 跑 core 的 CLI;better-sqlite3 的原生绑定是**共享 node_modules 里
# 单一个 .node**,与运行时 ABI 不匹配即 `ERR_DLOPEN_FAILED`,故 major 取自 `$HANGAR/.nvmrc`
# ——与 $SERVER 同一个 checkout,不是脚本自身所在的那个。
# 优先 NODE 覆盖 → 否则 glob fnm 装的该 major 最新版 → 否则 PATH 上的 node。
#
# 每个探测命令都必须带 `|| true`:本脚本是 `set -e` + `pipefail`,失败的命令替换会在赋值处
# 就终止脚本,让它下面的响亮退出变成**死代码**,stderr 全空(`2>/dev/null` 吃掉了原始报错)。
# launchd 的 `KeepAlive` 下那就是一个静默重启循环,而 README 让运维去 tail 的正是那个空日志。
# 自检:`hangar-view.test.sh`(每条守卫都有一个必须打印消息的用例)。
die () { echo "hangar-view: $1" >&2; exit 1; }

NODE_MAJOR="$(sed -nE 's/^[[:space:]]*v?([0-9]+).*/\1/p' "$HANGAR/.nvmrc" 2>/dev/null | head -1 || true)"
# 读不出数字 major(文件缺失/空/只有 nvm 别名如 lts/*)→ 响亮退出,不猜:猜一个默认值
# 会静默选错运行时,而这个脚本的全部风险就是选错 node。
# 修复建议**不能**说「设 NODE=」:本脚本先解析 .nvmrc 再看 NODE(NODE 要拿这个 major 做校验),
# 所以这一步失败时 NODE 还没被读到,设它无效。
[ -n "$NODE_MAJOR" ] || die "无法从 $HANGAR/.nvmrc 解析 node major(缺失/空/nvm 别名如 lts/*)—— 把 .nvmrc 改成数字 major(如 24);在此设 NODE= 无效,本脚本先解析 .nvmrc"

NODE="${NODE:-$(ls -d "$HOME"/.local/share/fnm/node-versions/v"$NODE_MAJOR"*/installation/bin/node 2>/dev/null | sort -V | tail -1 || true)}"
NODE="${NODE:-$(command -v node || true)}"
[ -x "$NODE" ] || die "找不到 node v$NODE_MAJOR;请在 plist EnvironmentVariables 设 NODE=绝对路径(见 ~/hangar-inbox-daemon.sh)"

# 选出来的 node 必须真是那个 major。`NODE=` 覆盖(README 就教运维这么设)与 PATH 兜底
# 都不受 `.nvmrc` 约束,而选错 major 正是本脚本唯一要防的事;`-x` 连 /usr/bin/true 都放行。
ACTUAL_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
[ "$ACTUAL_MAJOR" = "$NODE_MAJOR" ] || die "选中的 node 是 major '${ACTUAL_MAJOR:-非 node}'($NODE),而 $HANGAR/.nvmrc 要 $NODE_MAJOR —— 拒绝以错 ABI 启动"

if [ -n "${HANGAR_VIEW_DRY_RUN:-}" ]; then echo "NODE=$NODE NODE_MAJOR=$NODE_MAJOR"; exit 0; fi
exec "$NODE" "$SERVER"
