# Agents in Discord

在 Discord 线程里运行 Codex CLI、Claude Code、Cursor Agent、Grok Build、Antigravity CLI、ZCode CLI、Pi Agent 和 Oh My Pi 的 bot。

它是一个独立 bridge，不是 OpenClaw 插件，也不需要 OpenClaw。

[English](./README.en.md)

维护者：[ATou](https://github.com/atou42) 与 [Lark](https://github.com/Larkspur-Wang)

ZCode CLI 支持从 [v0.13.0](https://github.com/atou42/agents-in-discord/releases/tag/v0.13.0) 开始提供。

## 核心模型

一个 Discord 频道或线程，对应一条 provider 会话。

你可以在同一个 Discord 服务器里使用共享 bot，也可以把 Codex、Claude、Cursor、Grok、Antigravity、ZCode、Pi、OMP 拆成独立 bot。每个 provider 有自己的 session、workspace、模型和运行配置，不会混在一起。Cursor 和 Grok 使用原生 JSON 流与真实 session id；安全模式把文件操作限制在当前 workspace。Pi 和 OMP 共用兼容层，但会分别读取 `~/.pi` 和 `~/.omp`，恢复参数和权限参数也按各自 CLI 处理。ZCode 使用 headless JSON runner。Antigravity 的模型菜单会合并当前设置、官方 reasoning model 列表和本机日志里出现过的模型。

长任务不会一直刷屏。bot 会更新进度卡，也可以按频道设置成持续发送过程消息。最终回复是否 @ 发起人，也可以在设置里选。

Codex 的安全模式现在使用 workspace-write 沙盒，并把需要审批的动作交给 Codex 的 auto review reviewer。危险模式仍然是完全绕过 sandbox 和 approval，只适合受控的个人环境。

## 你能做什么

- 在 Discord 里发任务，让 CLI agent 在指定 workspace 里工作
- 按频道保存会话，下次继续同一条上下文
- 用设置面板切换 provider、model、effort、fast、compact、reply、workspace
- 查看实时进度、队列、运行状态、quota、账号和当前配置来源
- 对同一个 workspace 做串行保护，避免多个频道同时改同一份代码
- 通过 `/cancel` 或文本命令中断当前任务并清空队列
- 在长任务里选择只看进度卡，或让过程消息持续流出

## 准备

需要 Node.js 18+，一个 Discord Bot Token，以及你要使用的 CLI。

本项目不管理各个 CLI 自己的登录状态。请先在本机 CLI 里完成登录，并确认命令能直接运行。

```bash
codex --version
claude --version
agent --version
grok --version
agy --version
zcode --version
pi --version
omp --version
```

如果 CLI 不在 bot 进程的 PATH 里，可以在 `.env` 里写绝对路径。

```env
CODEX_BIN=/opt/homebrew/bin/codex
CLAUDE_BIN=/opt/homebrew/bin/claude
CURSOR_BIN=/Users/you/.local/bin/agent
GROK_BIN=/Users/you/.grok/bin/grok
ANTIGRAVITY_BIN=/opt/homebrew/bin/agy
ZCODE_BIN=/Users/you/.local/bin/zcode
PI_BIN=/Users/you/.local/bin/pi
OMP_BIN=/Users/you/.local/bin/omp
```

## 安装

```bash
git clone https://github.com/atou42/agents-in-discord.git
cd agents-in-discord
cp .env.example .env
npm install
npm run setup-hooks
npm start
```

`npm run setup-hooks` 只需要在 clone 后执行一次。它会启用本仓库的提交前检查。

## Discord 里怎么用

默认 shared bot 的 slash 前缀是 `cx_`。独立 Claude、Cursor、Grok、Antigravity、ZCode、Pi 和 OMP bot 默认使用 `cc_`、`cursor_`、`grok_`、`ag_`、`zc_`、`pi_` 和 `omp_`。

最常用的入口是这些。

```text
/cx_onboarding     首次引导，设置语言、provider、workspace
/cx_settings       打开交互式设置面板
/cx_status         查看当前配置、运行状态、quota、账号信息
/cx_progress       查看当前任务进度
/cx_queue          查看当前频道队列
/cx_cancel         中断当前任务并清空队列
/cx_new            开一个新会话，但保留频道配置
/cx_resume         绑定已有 provider 会话
/cx_sessions       查看最近会话
/cx_setdir         设置当前频道 workspace
/cx_compact        配置 compact 策略和阈值
/cx_goal          查看或设置当前 Codex session 的持久目标
```

文本命令主要作为兜底。常用的是 `!cancel`、`!c`、`!progress`、`!status`、`!resume`、`!sessions`、`!goal status`。

`/cx_goal action:set objective:<目标>` 或 `!goal <目标>` 会把当前 Codex session 的目标设为 active，并在 runner 空闲时继续执行。目标需要带图片或文件时，用普通消息 `!goal <目标>` 发送，附件会一起进入 goal 上下文。`/cx_status` 和 `!status` 会显示当前 goal；只查 goal 可以用 `/cx_goal action:status` 或 `!goal status`。`pause` 会停止续跑，`resume` 会恢复续跑，`clear` 会清除 goal。

## 微信入口（可选）

微信入口是独立进程，不修改 Discord bot 的启动路径、token、频道 session 或交互组件。两边复用同一套 Codex runner，并共享 workspace 文件锁，所以同一个项目正在 Discord 中执行时，微信任务会等待而不是并发修改。

先在 `.env` 配置允许的 workspace。扫码登录所使用的微信账号默认加入白名单，也可以显式增加 iLink user ID。

```env
WECHAT_WORKSPACE_ROOTS=~/GitHub,~/Lark_Project
WECHAT_DEFAULT_WORKSPACE_DIR=~/GitHub
WECHAT_ALLOWED_USER_IDS=
WECHAT_CODEX_RUNTIME_MODE=long
WECHAT_ALLOW_DANGEROUS=false
```

启动微信入口：

```bash
npm run start:wechat
```

首次启动会在终端显示二维码。微信入口当前支持文本和语音转写，不接收图片或文件。常用命令：

```text
/sessions                 浏览本机 Codex 历史会话
/resume 2                 绑定列表中的第 2 条会话
/resume <thread-id>       绑定指定 Codex thread
/session                  查看当前绑定
/new                      下一条消息新建会话
/status                   查看 workspace、model、effort 和运行状态
/cancel                   取消当前任务
/dir <路径>               切换 workspace，同时解除旧 session
```

微信 session 映射和 iLink 凭据分别保存在 `data/wechat/`，不会写入 Discord 的 `data/sessions*.json`。真实 Codex 会话仍来自同一个 `~/.codex/sessions`。

iLink 登录和消息协议实现参考了 MIT 项目 [sgaofen/cli-in-wechat](https://github.com/sgaofen/cli-in-wechat)，但没有采用它的 CLI adapter 或 `resume --last` 会话模型。

### macOS 长期运行 Discord 和微信

两个入口使用独立的 `launchd` 服务，登录后自动启动，异常退出后自动拉起：

```bash
# 1. 先配置 .env，至少填写 CODEX__DISCORD_TOKEN
cp .env.example .env

# 2. 微信首次前台扫码，看到 Agents in WeChat started 后按 Ctrl-C
npm run start:wechat

# 3. 安装并启动两个后台服务
npm run services:install
```

常用维护命令：

```bash
npm run services:status
npm run services:logs
npm run services:restart
npm run services:stop
npm run services:start
npm run services:uninstall
```

只操作一个入口时，直接调用管理脚本并传 `discord` 或 `wechat`：

```bash
bash scripts/manage-channel-services-macos.sh restart wechat
bash scripts/manage-channel-services-macos.sh logs discord
```

Discord 日志写入 `logs/discord.service*.log`，微信日志写入 `logs/wechat.service*.log`。微信凭据保存在本机忽略提交的 `data/wechat/credentials.json`；如果凭据过期，先停止微信服务，再前台运行 `npm run start:wechat` 重新扫码。

## 设置面板

推荐优先用 `/cx_settings`。它比记命令更稳，也会显示当前值来自哪里。

设置有继承关系。线程里的显式设置优先，其次是父频道默认，再其次是 provider 或环境默认。`/cx_status` 会显示当前实际生效值和来源。

Codex 默认设置会直接修改 `~/.codex/config.toml`。频道或线程里的覆盖仍然优先，只有在跟随默认时才会吃到这里。

## Workspace

workspace 是 CLI 真正执行任务的目录。

推荐给每个 provider 设置一个默认 workspace。线程可以继续继承默认，也可以单独覆盖。子线程默认继承父频道 workspace，也可以配置成独立 workspace。

同一个 workspace 同一时间只允许一个任务执行。其他任务会排队或提示 workspace 正忙，避免并发改同一份代码。

## 运行模式

本地开发可以直接跑 shared bot。

```bash
npm start
```

如果想把 provider 拆成独立 bot，可以在同一个 `.env` 里写分组配置，然后分别启动。

```bash
npm run start:codex
npm run start:claude
npm run start:antigravity
npm run start:zcode
npm run start:pi
npm run start:omp
```

分组配置还支持 `PI__*` 和 `OMP__*`。通常只需要各自的 `DISCORD_TOKEN`，再按需填默认模型、默认 workspace 和 CLI 路径。

## 关键配置

完整配置看 `.env.example`。README 只列最常改的项。

```env
DISCORD_TOKEN=...
ALLOWED_CHANNEL_IDS=...
ALLOWED_USER_IDS=...
WORKSPACE_ROOT=/Users/you/workspaces
DEFAULT_WORKSPACE_DIR=/Users/you/project
DEFAULT_MODE=safe
DEFAULT_UI_LANGUAGE=zh
```

常见 provider 分组配置如下。

```env
CODEX__DISCORD_TOKEN=...
CODEX__DEFAULT_WORKSPACE_DIR=/Users/you/codex-work
CODEX__SLASH_PREFIX=cx

CLAUDE__DISCORD_TOKEN=...
CLAUDE__DEFAULT_WORKSPACE_DIR=/Users/you/claude-work
CLAUDE__SLASH_PREFIX=cc

CURSOR__DISCORD_TOKEN=...
CURSOR__DEFAULT_WORKSPACE_DIR=/Users/you/cursor-work
CURSOR__SLASH_PREFIX=cursor
CURSOR_BIN=/Users/you/.local/bin/agent

GROK__DISCORD_TOKEN=...
GROK__DEFAULT_WORKSPACE_DIR=/Users/you/grok-work
GROK__SLASH_PREFIX=grok
GROK_BIN=/Users/you/.grok/bin/grok

ANTIGRAVITY__DISCORD_TOKEN=...
ANTIGRAVITY__DEFAULT_WORKSPACE_DIR=/Users/you/antigravity-work
ANTIGRAVITY__SLASH_PREFIX=ag

ZCODE__DISCORD_TOKEN=...
ZCODE__DEFAULT_WORKSPACE_DIR=/Users/you/zcode-work
ZCODE__SLASH_PREFIX=zc
ZCODE_BIN=/Users/you/.local/bin/zcode

PI__DISCORD_TOKEN=...
PI__DEFAULT_WORKSPACE_DIR=/Users/you/pi-work
PI__SLASH_PREFIX=pi
PI_BIN=/Users/you/.local/bin/pi

OMP__DISCORD_TOKEN=...
OMP__DEFAULT_WORKSPACE_DIR=/Users/you/omp-work
OMP__SLASH_PREFIX=omp
OMP_BIN=/Users/you/.local/bin/omp
```

访问控制建议至少设置 `ALLOWED_CHANNEL_IDS` 或 `ALLOWED_USER_IDS`。多人服务器里不要默认使用 dangerous mode。

compact 相关配置可以在 `.env` 里设默认，也可以在 Discord 里按频道覆盖。
压缩阈值按 provider 隔离。Codex 使用 `CODEX__MAX_INPUT_TOKENS_BEFORE_COMPACT`；其他 provider 未配置时保持未设置，交给各自 CLI 的默认行为。需要覆盖时使用对应的 `<PROVIDER>__MAX_INPUT_TOKENS_BEFORE_COMPACT`。

```env
COMPACT_STRATEGY=native
COMPACT_ON_THRESHOLD=true
CODEX__MAX_INPUT_TOKENS_BEFORE_COMPACT=272000
# Optional: ask Codex to use a larger native context window. The active CLI
# route may clamp this to the model catalog maximum.
CODEX__MODEL_CONTEXT_WINDOW=1050000
CODEX__MODEL_CONTEXT_MODEL=gpt-5.6-sol
CODEX__MODEL_CONTEXT_WINDOWS={"gpt-5.6-sol":1050000,"gpt-5.6-luna":1050000}
CODEX__MODEL_AUTO_COMPACT_TOKEN_LIMITS={"gpt-5.6-sol":400000,"gpt-5.6-luna":40000}
```

进度卡默认只展示 agent 自己的过程叙述，不展示模型的 reasoning 摘要。想开的话设 `SHOW_REASONING=true`，同时 CLI 那边也要产出 reasoning 事件——Codex 需要在 `~/.codex/config.toml` 里设 `model_reasoning_summary = "detailed"`。

注意 codex-cli 0.144.0 下 `gpt-5.6` 系列（sol/terra/luna）不产出 reasoning 事件，因为它们在 `~/.codex/models_cache.json` 里缺少 CLI 要求的 `supports_reasoning_summaries` 字段；`gpt-5.4` 可以正常产出。另外 reasoning 是摘要而非完整思维链，内容通常比过程叙述短。

```env
SHOW_REASONING=false
```

## thread 里的过程消息

卡片和 thread 承担的信息量不一样。命令、工具调用这类明细留在卡片上滚动，thread 里只放任务级信号——因为 thread 每条都是一条独立消息，会产生未读。

Codex 本身几乎不产出任务级信号：实测一个 802 事件的会话里工具调用 179 条、agent 消息 3 条、`update_plan` 0 条；`update_plan` 在一个月 1300+ 会话里只出现过 23 次。所以「这个任务还在跑」是从 turn 边界推出来的，而不是靠模型主动说。

thread 只会收到三类消息：阶段性答复、超时未结束的 turn 标记和保活、最终 at 回复。turn 开始后 90 秒内结束的不发标记（实测 3026 个 turn 里 83.6% 在 1 分钟内结束，全标记等于给每个琐碎问答刷一对消息）。保活衡量的是 thread 的静默时长，真实输出会顺延下一次保活，不会叠着发。

```env
# 工具调用是否也进 thread（默认 false，只留在卡片上）
PROGRESS_STREAM_TOOL_ACTIVITY=false
# turn 超过多久才值得播报（默认 90 秒）
PROGRESS_TURN_MARK_DELAY_MS=90000
# 已播报的 turn 静默多久补一条保活（默认 4 分钟）
PROGRESS_HEARTBEAT_INTERVAL_MS=240000
```

## 代理

如果 Discord 或 CLI 需要走代理，可以设置：

```env
HTTP_PROXY=http://127.0.0.1:7890
SOCKS_PROXY=socks5h://127.0.0.1:7891
```

`npm install` 会自动运行 `npm run patch-ws`，让 Discord Gateway WebSocket 可以使用自定义 agent。

## 本地服务

macOS 上推荐用仓库自带脚本重启 bot 服务。

```bash
scripts/restart-discord-bot-service.sh codex
scripts/restart-discord-bot-service.sh claude
scripts/restart-discord-bot-service.sh cursor
scripts/restart-discord-bot-service.sh grok
scripts/restart-discord-bot-service.sh antigravity
scripts/restart-discord-bot-service.sh zcode
scripts/restart-discord-bot-service.sh pi
scripts/restart-discord-bot-service.sh omp
scripts/restart-discord-bot-service.sh all
```

这个脚本会使用受保护的 launchd label，避免误用危险的 `launchctl` 操作。

## 项目升级

Bot 会检查 `agents-in-discord` 自己是否落后远端，默认只提示，不会自动改文件。可以在 Discord 里用 `/cx_upgrade action:status` 或 `!upgrade status` 查看本地版本、远端版本、落后提交数和更新说明。

手动升级：

```bash
npm run upgrade:project -- status
npm run upgrade:project -- apply
```

Discord 里也可以用 `/cx_upgrade action:apply` 或 `!upgrade apply`。升级只会在工作区干净、当前分支能 fast-forward 到远端时执行；本地有改动、分支分叉、远端不可达都会停止。执行前会先在临时 worktree 里安装依赖并跑验证，验证通过后才修改主工作区。

升级模式：

```bash
npm run upgrade:project -- notify
npm run upgrade:project -- auto
npm run upgrade:project -- off
```

`notify` 是默认值，只提示。`auto` 会在检测到安全升级且所有活跃 bot 进程都空闲时自动执行验证并请求重启。项目升级默认重启 `all`，因为多个 provider bot 通常共用同一个仓库。Discord 里的 `apply` 和 `mode` 需要 `AGENTS_IN_DISCORD_UPGRADE_ADMIN_USER_IDS`，未配置时只能查状态。常用环境变量：

```bash
AGENTS_IN_DISCORD_UPGRADE_MODE=notify
AGENTS_IN_DISCORD_UPGRADE_ADMIN_USER_IDS=123,456
AGENTS_IN_DISCORD_UPGRADE_NOTIFY_CHANNEL_IDS=123,456
AGENTS_IN_DISCORD_UPGRADE_CHECK_INTERVAL_MS=21600000
AGENTS_IN_DISCORD_UPGRADE_STATUS_CACHE_MS=600000
AGENTS_IN_DISCORD_UPGRADE_VERIFY_COMMAND="npm run test:progress"
AGENTS_IN_DISCORD_UPGRADE_RESTART_TARGET=all
```

## Codex CLI 自动升级

仓库内置一个可选的 Codex CLI 升级器。它可以定时检查 Codex 更新，升级成功后重启 bot 服务。

```bash
npm run install:auto-upgrade
npm run run:auto-upgrade
```

只想 dry-run：

```bash
CODEX_UPGRADE_DRY_RUN=1 npm run run:auto-upgrade
```

## 发布

[v0.13.0](https://github.com/atou42/agents-in-discord/releases/tag/v0.13.0) 是首个支持 ZCode CLI 的版本。

常规改动先跑测试。

```bash
npm run test:progress
```

切版本使用项目脚本。

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

## 故障排查

如果 `/cx_status` 显示 CLI 不存在，先在同一个机器上确认路径。

```bash
which codex
which claude
which agent
which agy
which zcode
which pi
which omp
```

然后把绝对路径写进 `.env`，重启 bot。

如果 settings 里看到某个值和预期不同，先看 `/cx_status`。status 会显示当前生效值，也会显示它来自当前线程、父频道、全局配置还是环境默认。

如果任务一直不开始，先看 `/cx_queue` 和 `/cx_progress`。同一个 workspace 正在被其他频道使用时，任务会等待锁释放。

## 本地主动发消息

可以用 bot token 从本机向指定频道发消息。

```bash
npm run send:channel -- --channel 1487823042121040036 --content "部署完成"
cat notice.md | npm run send:channel -- --channel 1487823042121040036 --stdin
```
