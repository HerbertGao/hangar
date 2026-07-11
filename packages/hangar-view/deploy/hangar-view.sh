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

# node v22 —— view 会 spawn 这个 node 跑 core 的 CLI,better-sqlite3 原生模块要 v22 匹配(与 daemon 同一个)。
if command -v fnm >/dev/null 2>&1; then
  exec fnm exec --using 22 -- node "$SERVER"
else
  # fnm 不可用时:设 NODE=绝对 node v22 路径(与 ~/hangar-inbox-daemon.sh 里的同一个)。
  exec "${NODE:?未找到 fnm;请设 NODE=daemon 所用的绝对 node v22 路径}" "$SERVER"
fi
