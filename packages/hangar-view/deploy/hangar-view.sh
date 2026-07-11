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

# node v22 —— launchd/非交互 SSH 下 fnm 常不在 PATH,故用**绝对路径**(与 daemon 同法)。
# view 会 spawn 这个 node 跑 core 的 CLI,better-sqlite3 原生模块要 v22 匹配。
# 优先 NODE 覆盖 → 否则 glob fnm 装的最新 v22 → 否则 PATH 上的 node。
NODE="${NODE:-$(ls -d "$HOME"/.local/share/fnm/node-versions/v22*/installation/bin/node 2>/dev/null | sort -V | tail -1)}"
NODE="${NODE:-$(command -v node || true)}"
[ -x "$NODE" ] || { echo "hangar-view: 找不到 node v22;请在 plist EnvironmentVariables 设 NODE=绝对路径(见 ~/hangar-inbox-daemon.sh)" >&2; exit 1; }
exec "$NODE" "$SERVER"
