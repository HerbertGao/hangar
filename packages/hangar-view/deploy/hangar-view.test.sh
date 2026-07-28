#!/bin/bash
# hangar-view.sh 的自检 —— 只测 node 选择那一段(靠 HANGAR_VIEW_DRY_RUN 在 exec 前停下)。
#
# 每个失败用例断言「非零退出 **且** stderr 非空」,不只是非零:静默死亡与响亮退出**都**非零,
# 只有「stderr 非空」能分辨这两者(为什么会静默死亡,见 hangar-view.sh 头部注释)。
#
# 覆盖边界(别以为四处 `|| true` 都被钉住了):`command -v node || true` 那一处**测不确定**。
# 它只在 `${NODE:-…}` 求值、即 fnm glob 落空时才跑,而此时若环境里恰有 ambient node,
# `command -v` 就会成功、该处的缺失不可见。要让它确定可测,得给生产脚本加一个只为测试存在的
# PATH 旋钮 —— 不值得。其余三处(sed / ls glob / node -p)在任何环境下都能被抓。
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/hangar-view.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/repo" "$T/home"
fail=0

stub () { mkdir -p "$1"; printf '#!/bin/sh\necho %s\n' "$2" > "$1/node"; chmod +x "$1/node"; }
FNM="$T/home/.local/share/fnm/node-versions/v24.18.0/installation/bin"

run () { # $1 = .nvmrc 内容(`@MISSING` = 删掉文件);$NODE_OVERRIDE 可选
  if [ "$1" = "@MISSING" ]; then rm -f "$T/repo/.nvmrc"; else printf '%b' "$1" > "$T/repo/.nvmrc"; fi
  OUT="$(HANGAR_HOME="$T/repo" HOME="$T/home" HANGAR_VIEW_DRY_RUN=1 \
         NODE="${NODE_OVERRIDE:-}" bash "$SCRIPT" 2>"$T/err")"; EC=$?
  ERR="$(cat "$T/err")"
}
major () { run "$1"
  if [ "$EC" -eq 0 ] && [ "${OUT##*NODE_MAJOR=}" = "$2" ]; then echo "  ok   $3"
  else echo "  FAIL $3: 期望 exit 0 且 NODE_MAJOR=$2,实得 exit=$EC [$OUT]"; fail=1; fi; }
# 断言**选中的可执行文件本身**,不只是 major —— 否则把 glob 写死回 `v24*` 时,所有用例
# (全都问 24)照样全绿,而动态取 major 正是这个脚本要修的东西。
selects () { run "$1"
  if [ "$EC" -eq 0 ] && [ "$OUT" = "NODE=$2 NODE_MAJOR=$3" ]; then echo "  ok   $4"
  else echo "  FAIL $4: 期望 [NODE=$2 NODE_MAJOR=$3],实得 exit=$EC [$OUT]"; fail=1; fi; }
loud () { run "$1"
  if [ "$EC" -ne 0 ] && [ -n "$ERR" ]; then echo "  ok   $2"
  else echo "  FAIL $2: exit=$EC stderr=[${ERR:-<空>}] —— 静默死亡正是那个 bug"; fail=1; fi; }

echo "hangar-view.sh: .nvmrc major 解析"
stub "$FNM" 24
major '24\n'                          24 '裸 major'
major 'v24\n'                         24 'v 前缀(合法 nvm 内容)'
major '24.18.0\n'                     24 '完整版本'
major '24\r\n'                        24 'CRLF'
major '  24\n'                        24 '前导空白'
major '24'                            24 '无末尾换行'
major '# node 22 was the floor\n24\n' 24 '注释在前 —— 含数字的注释不得跨行拼进 major'
major '24\n# keep 22 for reference\n' 24 '注释在后 —— 同上'

echo "hangar-view.sh: major 必须真的取自 .nvmrc(不是写死的)"
FNM20="$T/home/.local/share/fnm/node-versions/v20.19.0/installation/bin"; stub "$FNM20" 20
selects '20\n' "$FNM20/node" 20 '换一个 major → 必须选那个 major 的 node(glob 写死回 v24* 时此例变红)'
selects '24\n' "$FNM/node"   24 '换回来 → 选 24 那个(两例合起来才钉住「动态」)'

# 上面所有 stub 都无视参数、照打一个固定数字,所以**取版本那个表达式本身**没被测到:
# 把 `process.versions.node` 手滑写成 `process.version` 会返回 `v24`、恒不等于 `24`,
# 于是 view 永久拒启动,而自检全绿。这一例喂真 node,是唯一能钉住那个表达式的。
REAL="$(command -v node || true)"
if [ -n "$REAL" ]; then
  REAL_MAJOR="$("$REAL" -p 'process.versions.node.split(".")[0]')"
  NODE_OVERRIDE="$REAL" selects "$REAL_MAJOR\n" "$REAL" "$REAL_MAJOR" '喂真 node → 版本提取表达式必须真的产出裸 major'
else
  echo "  跳过 真 node 用例(PATH 上没有 node)"; fail=1
fi

echo "hangar-view.sh: 读不出 major 必须响亮"
loud '@MISSING'            '.nvmrc 缺失(sed 非零 → 曾在守卫前静默终止)'
loud ''                    '.nvmrc 空'
loud 'lts/jod\n'           '.nvmrc 是 nvm 别名'
loud '# only a comment\n'  '.nvmrc 只有注释'

echo "hangar-view.sh: 选不出正确 major 的 node 必须响亮"
# 这里的 major 用 99 而不是 24:被测脚本把 PATH 硬设成 /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin,
# 本测试控制不了它。若 CI runner 的镜像在 /usr/bin 里带一个**恰好等于本仓 major** 的 node,
# 用 24 会让这条用例意外成功(exit 0)→ 套件在没人改一行代码的情况下变红。99 环境命不中。
loud '99\n' 'fnm 无该 major(= 装 node 前的生产态,glob 非零 → 曾在兜底与守卫前静默终止)'
NODE_OVERRIDE=/usr/bin/true  loud '24\n' 'NODE= 指向非 node 可执行文件(-x 单独会放行)'
NODE_OVERRIDE=/usr/bin/false loud '24\n' 'NODE= 指向会失败的可执行文件(坏 node 装:缺 dylib / 错架构 / 半删的 fnm 版本)'
stub "$T/wrong" 22
NODE_OVERRIDE="$T/wrong/node" loud '24\n' 'NODE= 指向错 major(README 教运维设这个变量)'

[ "$fail" -eq 0 ] && echo "hangar-view.sh: 全部通过" || echo "hangar-view.sh: 有失败"
exit "$fail"
