#!/usr/bin/env bash
# ============================================================================
# panhub_praser backend launcher（docs/backend-wrangler-plan.md §5，v1.2.2）
#
#   用法：./backend/launcher.sh {setup|start|stop|status|restart|debug|logs|build|backup|reset}
#         也接受 -- 前缀（./backend/launcher.sh --stop 等价 stop）
#         无参数 = 打印用法 + 当前状态
#
#   setup   首次/重置初始化：检测 node/wrangler → 装依赖 → 生成端口+双令牌
#           （写 backend/data/period/config.json）→ 生成根 .dev.vars → 打印摘要
#   start   后台启动：wrangler（127.0.0.1 回环）→ backend（nohup）→ PID 落 data/run/
#   stop    按 PID 文件停全部（SIGTERM → 超时 SIGKILL）
#   restart 重启（restart 而非 stop+start）
#   status  进程 / 端口 / URL / 令牌摘要（从 config.json 读）
#   debug   前台排查：wrangler 真 TTY 零管道交互面板占主终端（b/d/e/t/c/x），
#           backend 后台（nohup → backend.log）；有 tmux 自动分窗（左面板右日志）
#   logs    tail -f backend.log + wrangler.log（data/logs/）
#   build   重建 backend webui dist（可选；wrangler pages dev 默认不需要 build）
#   backup  打包 data/period 整包 + secret.key → data/backups/
#   reset   备份 + 停服 + 清空 data/ → 重新 setup（全新令牌）
#
#   设计约束（设计稿 §2.2/§5，v1.2.2 微调——拍板之二）：
#   - 一把令牌：PROXY_TOKEN 只生成一次（backend config.json 是权威），
#     launcher 自动写根 .dev.vars（PROXY_TOKEN + TRACE_D1=0，权限 600），
#     wrangler pages dev 从 cwd 的 .dev.vars 读取 —— 不再 --binding，避免漂移
#   - 绑定：PANHUB_BIND 默认 0.0.0.0，同时作用于 wrangler --ip 与 backend listener
#     （企业内网 wrangler 全接口可达）；webui 只放行回环 + 固定内网 IP（Host 检查），
#     B 端部署管理面板需显式 PANHUB_BIND=<服务器固定内网 IP>
#   - 完全离线：wrangler pages dev 本地运行，不需要 CF 账号/登录
# ============================================================================
set -euo pipefail

# ---------------- 路径（launcher 在 backend/，仓库根是上一级） ----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$BACKEND_DIR/data"
PERIOD_DIR="$DATA_DIR/period"
RUN_DIR="$DATA_DIR/run"
LOG_DIR="$DATA_DIR/logs"
BACKUP_DIR="$DATA_DIR/backups"
CONFIG_FILE="$PERIOD_DIR/config.json"

WRANGLER_BIN="$ROOT_DIR/node_modules/.bin/wrangler"
BACKEND_ENTRY="$BACKEND_DIR/src/index.js"

# ---------------- 输出 ----------------
C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'

info()  { echo "${C_CYAN}[launcher]${C_RESET} $*"; }
ok()    { echo "${C_GREEN}[launcher]${C_RESET} $*"; }
warn()  { echo "${C_YELLOW}[launcher]${C_RESET} $*" >&2; }
fail()  { echo "${C_RED}[launcher]${C_RESET} $*" >&2; exit 1; }

# ---------------- 工具 ----------------

need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1（请先安装，或确认 PATH）"; }

require_bash4() {
  [ "${BASH_VERSINFO[0]:-0}" -ge 4 ] || fail "需要 bash ≥ 4（当前 $BASH_VERSION）"
}

# 端口是否空闲（用 node 探测，避免依赖 ss/netstat）
port_free() {
  node -e "
    const net = require('node:net');
    const p = Number(process.argv[1]);
    const s = net.createServer();
    s.once('error', () => { process.exit(1); });
    s.listen(p, '127.0.0.1', () => { s.close(() => process.exit(0)); });
  " "$1" >/dev/null 2>&1
}

# 找下一个空闲端口（从 base 起递增）
next_free_port() {
  local base="$1" p="$1"
  while ! port_free "$p"; do p=$((p + 1)); [ "$p" -le 65535 ] || fail "端口区间耗尽（从 $base 起）"; done
  echo "$p"
}

# 读 config.json 某字段（node 解析，避免 jq 依赖）
cfg_get() {
  node -e "
    const fs = require('node:fs');
    const c = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const v = process.argv[2].split('.').reduce((o, k) => o?.[k], c);
    process.stdout.write(v === undefined || v === null ? '' : String(v));
  " "$CONFIG_FILE" "$1"
}

# config.json 是否存在且已初始化（有 token）
config_ready() {
  [ -f "$CONFIG_FILE" ] && [ -n "$(cfg_get webui.token)" ] && [ -n "$(cfg_get proxy.token)" ]
}

# ---------------- node / wrangler 检测 ----------------

check_node() {
  need_cmd node
  local ver major
  ver="$(node --version | sed 's/^v//')"
  major="${ver%%.*}"
  [ "$major" -ge 22 ] || fail "node ≥ 22.5 才内置 node:sqlite（当前 v$ver）——请升级：https://nodejs.org"
  node -e "require('node:sqlite')" >/dev/null 2>&1 \
    || fail "当前 node v$ver 没有 node:sqlite（需 ≥ 22.5）"
  ok "node v$ver（node:sqlite ✓）"
}

check_wrangler() {
  if [ -x "$WRANGLER_BIN" ]; then
    ok "wrangler：$("$WRANGLER_BIN" --version 2>/dev/null | head -1)（root node_modules）"
    return 0
  fi
  if command -v wrangler >/dev/null 2>&1; then
    warn "root node_modules 没有 wrangler，但 PATH 里有：$(command -v wrangler)（版本可能不一致）"
    return 0
  fi
  fail "未找到 wrangler —— 请先 npm install（或 ./backend/launcher.sh setup 会自动装）"
}

# ---------------- 依赖安装 ----------------

install_deps() {
  local need=0
  if [ ! -d "$ROOT_DIR/node_modules/wrangler" ]; then
    warn "root 依赖未装（缺 wrangler），npm install 中…"
    need=1
  fi
  if [ ! -d "$BACKEND_DIR/node_modules" ]; then
    warn "backend 依赖未装，npm install 中…"
    need=1
  fi
  if [ "$need" -eq 1 ]; then
    need_cmd npm
    (cd "$ROOT_DIR" && npm install --no-fund --no-audit)
    (cd "$BACKEND_DIR" && npm install --no-fund --no-audit)
  fi
}

# ---------------- config 初始化（生成端口+双令牌） ----------------

init_config() {
  # 调用 backend 的 loadConfig：首启生成随机端口 + 双令牌并写回 config.json
  node --input-type=module -e "
    import { loadConfig } from '${BACKEND_DIR}/src/config.js';
    loadConfig();
  "
}

# ---------------- .dev.vars 自动生成（设计稿 §5，setup/start/debug 均调用） ----------------

ensure_dev_vars() {
  config_ready || fail "未初始化（无 config.json 或缺令牌）→ ./backend/launcher.sh setup"
  local token dev_vars cur proxy_port
  token="$(cfg_get proxy.token)"
  proxy_port="$(cfg_get proxy.port)"
  dev_vars="$ROOT_DIR/.dev.vars"
  # pipefail 下 sed 读不存在的文件会带非零退出，加 || true 兜底（首次运行 .dev.vars 不存在）
  cur="$(sed -n 's/^PROXY_TOKEN=//p' "$dev_vars" 2>/dev/null | head -1 || true)"
  if [ -f "$dev_vars" ] && [ "$cur" = "$token" ] && grep -qx 'TRACE_D1=0' "$dev_vars" \
    && grep -qx "BACKEND_URL=http://127.0.0.1:${proxy_port}" "$dev_vars"; then
    ok ".dev.vars 已同步：$dev_vars（PROXY_TOKEN 与 config.json 一致）"
  else
    # v1.2.2（wip2 修正）：BACKEND_URL 让本地 functions 也能走 cookie-pick 取号（云端分支同一路径）；
    # 云端部署时由部署者把该值改为公网 backend 地址（本机回环仅 B 端本机形态有效）
    printf 'PROXY_TOKEN=%s\nTRACE_D1=0\nBACKEND_URL=http://127.0.0.1:%s\n' "$token" "$proxy_port" > "$dev_vars"
    chmod 600 "$dev_vars"
    ok ".dev.vars 已生成/更新：$dev_vars（600；PROXY_TOKEN 与 config.json 同一把 + TRACE_D1=0 + BACKEND_URL）"
  fi
}

# ---------------- 摘要 / 文档 ----------------

print_summary() {
  local proxy_port webui_port proxy_tail webui_tail wrangler_port wrangler_bind
  proxy_port="$(cfg_get proxy.port)"; webui_port="$(cfg_get webui.port)"
  proxy_tail="$(cfg_get proxy.token | tail -c 7)"; webui_tail="$(cfg_get webui.token | tail -c 7)"
  wrangler_port="$(cfg_get wrangler.port)"; wrangler_bind="$(cfg_get wrangler.bind || echo 0.0.0.0)"
  echo ""
  echo "  ${C_BOLD}panhub 指挥中心已就绪${C_RESET}"
  echo "  ─────────────────────────────────────────────"
  echo "  管理面板 / 指挥中心 : ${C_CYAN}http://${wrangler_bind}:${proxy_port:-?}${C_RESET}（WebUI 令牌 …${webui_tail}；回环/固定内网 IP 可进）"
  echo "  增强 hop  /api/proxy : ${C_CYAN}http://${wrangler_bind}:${proxy_port:-?}/api/proxy${C_RESET}（X-Proxy-Token …${proxy_tail}）"
  echo "  wrangler（转发引擎）: ${wrangler_bind}:${wrangler_port:-8787}（PANHUB_BIND=${wrangler_bind}，企业内网可直连）"
  echo "  完整令牌            : backend/data/period/config.json（600）"
  echo "  wrangler 环境       : 根 .dev.vars（PROXY_TOKEN + TRACE_D1=0，600，自动同步）"
  echo "  ─────────────────────────────────────────────"
  echo "  文档: docs/backend-wrangler-plan.md（设计稿 v1.2.2）| README.md（使用）"
  echo "  日志: data/logs/backend.log + wrangler.log（./backend/launcher.sh logs）"
  echo "  排查: ./backend/launcher.sh debug（wrangler 真 TTY 面板 + backend 后台日志）"
  echo ""
}

print_doc_hint() {
  info "使用文档：${C_BOLD}$ROOT_DIR/docs/backend-wrangler-plan.md${C_RESET} §5 / README.md"
  info "常用：./backend/launcher.sh start | stop | status | restart | logs | debug"
}

# ---------------- 进程管理 ----------------

pid_file() { echo "$RUN_DIR/$1.pid"; }

pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

is_our_pid() { # 校验 PID 属于本仓库进程（防误杀被复用的 PID）
  local pid="$1" exe
  exe="$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)"
  case "$exe" in
    *node*) return 0 ;;
    *) return 1 ;;
  esac
}

save_pid() { echo "$2" > "$RUN_DIR/$1.pid"; }

kill_pidfile() {
  local name="$1" pid
  [ -f "$RUN_DIR/$name.pid" ] || return 0
  pid="$(cat "$RUN_DIR/$name.pid" 2>/dev/null || true)"
  rm -f "$RUN_DIR/$name.pid"
  [ -n "$pid" ] || return 0
  if pid_alive "$pid"; then
    info "停止 $name（PID $pid）…"
    kill "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 20); do pid_alive "$pid" || break; sleep 0.3; done
    if pid_alive "$pid"; then
      warn "$name 未响应 SIGTERM，SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
      sleep 0.3
    fi
  fi
}

stop_all() {
  kill_pidfile backend
  kill_pidfile wrangler
  # debug 的 tmux 会话：pane 里是前台 wrangler（无 PID 文件），stop 时一并关掉
  if command -v tmux >/dev/null 2>&1 && tmux has-session -t panhub 2>/dev/null; then
    info "关闭 debug tmux 会话 panhub（含 pane 内 wrangler）"
    tmux kill-session -t panhub
  fi
  ok "全部已停止"
}

wait_http_ok() {
  # 等单 listener 就绪（最多 ~15s）
  local port="$1" i
  for i in $(seq 1 50); do
    if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/api/proxy-config" 2>/dev/null; then
      return 0
    fi
    sleep 0.3
  done
  return 1
}

wait_inspector() {
  # 等 wrangler inspector 就绪（最多 ~30s），期间显示 wrangler 日志尾部便于排查
  local port="$1" i line
  for i in $(seq 1 100); do
    if curl -s --max-time 1 "http://127.0.0.1:$port/json" 2>/dev/null | grep -q '^\['; then
      return 0
    fi
    if [ $((i % 10)) -eq 0 ] && [ -f "$LOG_DIR/wrangler.log" ]; then
      line="$(tail -1 "$LOG_DIR/wrangler.log" 2>/dev/null || true)"
      [ -n "$line" ] && warn "wrangler 启动中… 最新日志：$line"
    fi
    sleep 0.3
  done
  return 1
}

# ---------------- 启动 ----------------

ensure_runtime() {
  [ -d "$RUN_DIR" ] || mkdir -p "$RUN_DIR"
  [ -d "$LOG_DIR" ] || mkdir -p "$LOG_DIR"
}

# 端口避让结果写回 config.json（backend 的 wrangler.port / inspectorPort 与实际一致）
set_wrangler_ports() {
  node -e "
    const fs = require('node:fs');
    const p = process.argv[1];
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    c.wrangler = c.wrangler || {};
    c.wrangler.port = Number(process.argv[2]);
    c.wrangler.inspectorPort = Number(process.argv[3]);
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
  " "$CONFIG_FILE" "$1" "$2"
}

# PANHUB_BIND → config.json proxy.host / webui.host / wrangler.bind（wrangler --ip 同源，拍板之二）
# 0.0.0.0（默认）= 企业内网全接口；webui.host=0.0.0.0 永不匹配真实 Host → 管理面板仍仅回环可进
# 具体内网 IP = B 端固定地址：webui Host 检查放行该 IP（员工可直连管理面板）
prepare_bind() {
  local bind="${PANHUB_BIND:-0.0.0.0}"
  if [ "$bind" = "0.0.0.0" ]; then
    warn "PANHUB_BIND=0.0.0.0（默认）—— wrangler 转发端口全接口监听（企业内网可达）；管理面板仍仅本机（/api/web/* Host 检查）"
    warn "  → 要开放管理面板请设 PANHUB_BIND=<服务器固定内网 IP>（如 192.168.1.10），webui 只允许该 IP 绑定"
  elif [ "$bind" = "127.0.0.1" ]; then
    info "PANHUB_BIND=127.0.0.1 —— 仅本机（wrangler + backend 均回环）"
  else
    warn "PANHUB_BIND=$bind —— backend/webui 与 wrangler 均绑 $bind（企业固定内网 IP；webui Host 检查放行该 IP）"
  fi
  node -e "
    const fs = require('node:fs');
    const p = process.argv[1];
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    c.proxy = c.proxy || {}; c.webui = c.webui || {}; c.wrangler = c.wrangler || {};
    c.proxy.host = process.argv[2];
    c.webui.host = process.argv[2];
    c.wrangler.bind = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
  " "$CONFIG_FILE" "$bind"
}

start_wrangler() {
  local wport iport bind
  wport="$(next_free_port "$(cfg_get wrangler.port || echo 8787)")"
  iport="$(next_free_port "$(cfg_get wrangler.inspectorPort || echo 9229)")"
  bind="$(cfg_get wrangler.bind || echo 0.0.0.0)"
  set_wrangler_ports "$wport" "$iport"   # 写回：backend 转发目标/健康监听与实际一致
  info "启动 wrangler pages dev（:${wport}，inspector :${iport}，绑 ${bind}）…"
  # cwd=ROOT_DIR：wrangler pages dev . 的托管目录 + .dev.vars 读取位置（launcher 在 backend/ 下必须显式 cd）
  # 令牌经 .dev.vars 自动注入，不再 --binding
  (cd "$ROOT_DIR" && exec nohup "$WRANGLER_BIN" pages dev . \
    --port "$wport" \
    --inspector-port "$iport" \
    --ip "$bind" \
    --show-interactive-dev-session=false \
    --log-level info) >"$LOG_DIR/wrangler.log" 2>&1 &
  save_pid wrangler $!
  if ! wait_inspector "$iport"; then
    warn "wrangler inspector 未就绪，看日志：tail -f $LOG_DIR/wrangler.log"
    return 1
  fi
  ok "wrangler 已就绪（:${wport}，inspector :${iport}）"
}

# backend 后台启动（nohup → backend.log；等待方负责先让 wrangler 就绪，保证 attach）
launch_backend_detached() {
  local bport bind
  bport="$(cfg_get proxy.port)"
  [ -n "$bport" ] || fail "config.json 缺少 proxy.port，请先 ./backend/launcher.sh setup"
  # prepare_bind 已由 cmd_start/cmd_debug 在 wrangler 启动前调用（避免重复警告）
  bind="$(cfg_get proxy.host)"
  info "启动 backend（${bind}:${bport}，nohup → backend.log）…"
  # 不设 PANHUB_NO_SPAWN：launcher 已先等 wrangler inspector 就绪，backend 探测到会 attach
  # （保留 wrangler 健康监听 + stdout 解析）；仅当 wrangler 没起来才自动 spawn 兜底
  (cd "$BACKEND_DIR" && exec nohup node "$BACKEND_ENTRY") >"$LOG_DIR/backend.log" 2>&1 &
  save_pid backend $!
}

start_backend() {
  launch_backend_detached
  local bport; bport="$(cfg_get proxy.port)"
  if ! wait_http_ok "$bport"; then
    warn "backend 未就绪，看日志：tail -f $LOG_DIR/backend.log"
    return 1
  fi
  ok "backend 已就绪（http://127.0.0.1:${bport}）"
}

# ---------------- 命令实现 ----------------

cmd_setup() {
  echo ""
  echo "${C_BOLD}══ panhub 指挥中心 setup（首次/重置初始化）══${C_RESET}"
  check_node
  check_wrangler
  install_deps
  echo ""
  info "初始化 config.json（随机端口 + 双令牌）…"
  init_config
  config_ready || fail "config 初始化异常：$CONFIG_FILE"
  ok "config.json 已生成：$CONFIG_FILE（权限 600）"
  ensure_dev_vars
  print_summary
  echo "  下一步："
  echo "    首次排查  : ./backend/launcher.sh debug（wrangler 真 TTY 面板 + backend 后台日志）"
  echo "    日常启动  : ./backend/launcher.sh start"
  echo "    停止      : ./backend/launcher.sh stop"
  echo ""
}

cmd_start() {
  config_ready || { warn "未初始化，先跑 setup"; cmd_setup; }
  ensure_runtime
  ensure_dev_vars
  stop_all   # 幂等：先清理旧 PID（restart 语义安全）
  prepare_bind   # 必须先写 wrangler.bind，start_wrangler 才拿得到 --ip（v1.2.2 微调）
  start_wrangler || { cmd_status; exit 1; }
  start_backend || { cmd_status; exit 1; }
  echo ""
  print_summary
  ok "服务已后台运行（PID 见 data/run/）。停止：./backend/launcher.sh stop"
}

cmd_stop() { stop_all; }

cmd_status() {
  local bport proxy_tail wrangler_pid backend_pid wrangler_port
  bport="$(cfg_get proxy.port)"; proxy_tail="$(cfg_get proxy.token | tail -c 7)"
  wrangler_port="$(cfg_get wrangler.port)"
  echo ""
  echo "${C_BOLD}══ panhub 指挥中心状态 ══${C_RESET}"
  if ! config_ready; then
    warn "未初始化（无 config.json 或缺令牌）→ ./backend/launcher.sh setup"
    return 0
  fi
  backend_pid="$(cat "$RUN_DIR/backend.pid" 2>/dev/null || true)"
  wrangler_pid="$(cat "$RUN_DIR/wrangler.pid" 2>/dev/null || true)"
  if pid_alive "$backend_pid"; then
    ok "backend   运行中  PID $backend_pid  http://127.0.0.1:${bport}（WebUI 令牌 …${proxy_tail}）"
  else
    warn "backend   未运行（PID 文件 $RUN_DIR/backend.pid）"
  fi
  if pid_alive "$wrangler_pid"; then
    ok "wrangler  运行中  PID $wrangler_pid  :${wrangler_port}"
  else
    warn "wrangler  未运行（PID 文件 $RUN_DIR/wrangler.pid）"
  fi
  echo "  日志: ${C_DIM}$LOG_DIR/backend.log + wrangler.log${C_RESET}（./backend/launcher.sh logs）"
  echo ""
}

cmd_restart() {
  cmd_stop
  cmd_start
}

cmd_debug() {
  config_ready || { warn "未初始化，先跑 setup"; cmd_setup; }
  ensure_runtime
  ensure_dev_vars
  stop_all
  local wport iport bind
  wport="$(next_free_port "$(cfg_get wrangler.port || echo 8787)")"
  iport="$(next_free_port "$(cfg_get wrangler.inspectorPort || echo 9229)")"
  set_wrangler_ports "$wport" "$iport"
  prepare_bind
  bind="$(cfg_get wrangler.bind || echo 0.0.0.0)"

  if command -v tmux >/dev/null 2>&1; then
    info "检测到 tmux，分窗启动（左：wrangler 交互面板 / 右：backend 实时日志）"
    : > "$LOG_DIR/backend.log"   # 右 pane 的 tail -f 立即有文件可跟
    tmux new-session -d -s panhub
    # 左 pane：wrangler 前台，零管道（真 TTY，b/d/e/t/c/x 面板可用）；cwd=ROOT_DIR 读 .dev.vars
    tmux send-keys -t panhub "cd '$ROOT_DIR' && '$WRANGLER_BIN' pages dev . --port $wport --inspector-port $iport --ip $bind --log-level info" Enter
    tmux split-window -h -t panhub
    tmux send-keys -t panhub "tail -f '$LOG_DIR/backend.log'" Enter
    tmux select-pane -t panhub.0
    # 等 wrangler 面板就绪再起 backend → 探测成功即 attach（不会自己 spawn 抢面板端口）
    info "等待 wrangler inspector 就绪（:${iport}）…"
    if wait_inspector "$iport"; then
      ok "wrangler 面板已就绪"
    else
      warn "wrangler inspector 未就绪（面板可能启动失败）；backend 将按 autoSpawn 自行拉起（若面板其实活着会抢端口，退出后检查面板输出）"
    fi
    launch_backend_detached
    echo ""
    info "已进入 tmux 会话 panhub（Ctrl+B 再按 D 退出；停止：./backend/launcher.sh stop）"
    tmux attach -t panhub
    return 0
  fi

  warn "未检测到 tmux：wrangler 前台 + backend 后台（backend.log 实时看用 ./backend/launcher.sh logs）"
  # backend 等 wrangler 面板就绪后再起（attach，不抢面板端口）：detached 等待子进程
  (
    i=0
    while [ $i -lt 60 ]; do
      curl -s --max-time 1 "http://127.0.0.1:$iport/json" 2>/dev/null | grep -q '^\[' && break
      i=$((i + 1)); sleep 0.5
    done
    launch_backend_detached
  ) &
  info "backend 将在 wrangler 面板就绪后自动后台启动（nohup → backend.log）"
  echo ""
  info "wrangler 交互面板占主终端（b/d/e/t/c/x 快捷键；Ctrl+C 退出 wrangler 与本次会话）"
  cd "$ROOT_DIR"
  exec "$WRANGLER_BIN" pages dev . \
    --port "$wport" \
    --inspector-port "$iport" \
    --ip "$bind" \
    --log-level info
}

cmd_logs() {
  # debug 模式 wrangler 输出在交互面板（无 wrangler.log）；start 模式有。缺文件则建空文件跟随
  if [ ! -f "$LOG_DIR/backend.log" ]; then
    warn "backend.log 还不存在（先 start/debug），建空文件跟随"
    : > "$LOG_DIR/backend.log"
  fi
  if [ ! -f "$LOG_DIR/wrangler.log" ]; then
    warn "wrangler.log 还不存在（debug 模式 wrangler 输出在面板），建空文件跟随"
    : > "$LOG_DIR/wrangler.log"
  fi
  info "Ctrl+C 退出。backend + wrangler 双日志（data/logs/；debug 时 wrangler 看面板）"
  tail -f "$LOG_DIR/backend.log" "$LOG_DIR/wrangler.log"
}

cmd_build() {
  info "重建 backend webui dist…"
  (cd "$BACKEND_DIR" && npm run build:webui)
  ok "webui dist 已重建（$BACKEND_DIR/webui/dist）"
  info "提示：wrangler pages dev 直接托管源码树，通常不需要 build；仅手动部署时才需要"
}

cmd_backup() {
  [ -d "$PERIOD_DIR" ] || fail "没有可备份的数据（$PERIOD_DIR 不存在）"
  [ -d "$BACKUP_DIR" ] || mkdir -p "$BACKUP_DIR"
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  local tarball="$BACKUP_DIR/panhub-period-$stamp.tar.gz"
  (cd "$DATA_DIR" && tar czf "$tarball" period)
  ok "已备份 → $tarball"
  info "恢复：tar xzf <备份> -C backend/data/（含 secret.key 必须一起，否则 cookie 密文无法解密）"
}

cmd_reset() {
  warn "重置管理系统：备份现有 data/ → 停服 → 清空 → 全新 setup（旧令牌作废）"
  read -r -p "确认重置？[y/N] " ans
  case "$ans" in
    y|Y|yes|YES)
      cmd_backup || true
      stop_all
      rm -rf "$PERIOD_DIR"
      ok "旧配置已清除，重新 setup"
      cmd_setup
      ;;
    *) info "已取消" ;;
  esac
}

usage() {
  cat <<'EOF'
panhub_praser backend launcher（docs/backend-wrangler-plan.md §5，v1.2.2）

用法: ./backend/launcher.sh {命令}      （也接受 -- 前缀：--stop 等价 stop）

命令:
  setup    首次/重置初始化：检测 node/wrangler → 装依赖 → 生成端口+双令牌 + 根 .dev.vars
  start    后台启动 wrangler + backend（PID 落 data/run/）
  stop     停止全部（SIGTERM → 超时 SIGKILL）
  status   进程 / 端口 / URL / 令牌摘要
  restart  重启
  debug    前台排查：wrangler 真 TTY 交互面板（零管道）+ backend 后台日志；有 tmux 自动分窗
  logs     实时看 backend.log + wrangler.log（debug 时 wrangler 输出在面板）
  build    重建 backend webui dist（可选）
  backup   打包 data/period + secret.key → data/backups/
  reset    备份 → 停服 → 清空 → 重新 setup（全新令牌）

环境变量:
  PANHUB_BIND=0.0.0.0   默认：wrangler 转发端口全接口监听（企业内网可直连），webui 仍仅回环可进
  PANHUB_BIND=<内网IP>   B 端固定地址：wrangler + backend/webui 均绑该 IP，webui Host 检查放行（管理面板可直连）
  PANHUB_NO_SPAWN=1     backend 跳过 spawn 但允许 attach（测试用；探测失败自然降级 off）
EOF
}

# ---------------- 分发 ----------------

main() {
  require_bash4
  # 无参数或 -h/--help → 用法 + 状态
  if [ $# -eq 0 ]; then usage; echo ""; cmd_status; return 0; fi
  local cmd="${1#--}"   # 兼容 -- 前缀
  case "$cmd" in
    setup)   cmd_setup ;;
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    status)  cmd_status ;;
    restart) cmd_restart ;;
    debug)   cmd_debug ;;
    logs)    cmd_logs ;;
    build)   cmd_build ;;
    backup)  cmd_backup ;;
    reset)   cmd_reset ;;
    help|-h) usage ;;
    *) warn "未知命令：$1"; usage; exit 1 ;;
  esac
}

main "$@"
