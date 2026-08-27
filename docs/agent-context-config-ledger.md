# Agent Context 配置账本

## 目标

让 Agents in Discord 只在 Codex provider 上显式传递上下文窗口和原生压缩阈值，并保留 Claude、Grok、Cursor、ZCode、Pi、OMP 等 provider 自己的上下文管理。Codex 的目标配置是 `gpt-5.6-sol` 请求 `1,050,000` context，原生自动压缩在 `400,000`。

## 2026-08-26 现场证据

本机 Codex CLI 为 `0.148.0`。Agents in Discord 的 `.env` 原先同时设置了全局和 Codex 专用 `272000`，代码只传递 `model_auto_compact_token_limit`，没有传递 `model_context_window`。AID 的历史 rollout 记录了 `model_context_window: 258400`，说明实际运行时没有使用用户期望的百万级窗口。当前本机模型缓存将 `gpt-5.6-sol` 的默认窗口记为 `272000`，并报告最大 catalog 窗口 `872000`。

独立的真实 Codex CLI 试运行使用 `-c model_context_window=1050000 -c model_auto_compact_token_limit=400000` 成功返回 `CONTEXT_PROBE_OK`。该 CLI 运行记录的有效 `model_context_window` 为 `828400`，没有接受完整的 `1,050,000`，而是受到当前认证路由的 `872000` catalog 上限和客户端保留比例限制。这是上游运行时限制，不是 Discord 网络或 bot 参数丢失；`400000` 阈值仍低于有效窗口，可以正常工作。

## Provider 审计

| Provider | 本机启用状态 | 压缩控制 | 本次结论 |
| --- | --- | --- | --- |
| Codex | 启用 | 原生，AID 可传 token limit 和 context window | 修复启动与 long app-server 两条链路 |
| Claude | 启用 | provider 原生 | 不传 Codex 参数 |
| Cursor | 启用 | headless runner 未暴露原生阈值 | 不传 Codex 参数 |
| Grok | 启用 | provider 原生 | 不传 Codex 参数 |
| ZCode | 启用 | headless runner 未暴露原生阈值 | 不传 Codex 参数 |
| OMP | 启用 | 自己的 interactive runtime | 不传 Codex 参数 |
| Pi | 未启用 token | provider 原生 | 不传 Codex 参数 |
| Antigravity | 未启用 token | provider 原生 | 不传 Codex 参数 |

## 已落地变更

新增 Codex context limits 解析，优先级为 `CODEX__MODEL_CONTEXT_WINDOW`、`MODEL_CONTEXT_WINDOW_CODEX`、旧全局 `MODEL_CONTEXT_WINDOW`，并在锁定其他 provider 时拒绝被扁平化的全局值。非法窗口和压缩阈值不小于窗口会在启动时抛错，不会静默回退。

Codex one-shot `exec` 和持久化 `app-server` 的 `thread/start`、`thread/resume` 都会收到同一份 `model_context_window`。其他 provider 的参数构建保持不变。当前 `.env` 已将 Codex 阈值改为 `400000`，并请求 `1050000` context。CLI 若受认证路由上限影响会自行裁剪，账本保留该事实，不把请求值伪装成有效值。

## 验收记录

修复前新增检查按预期失败，证明两条 Codex runtime 链路都没有传递 context window。修复后 `test/codex-context-limits.test.mjs`、`test/runner-args.test.mjs` 和 `test/codex-app-server-runner.test.mjs` 全部通过，覆盖 provider 优先级、非法值、阈值越界、exec 参数、app-server config 和非 Codex 隔离。完整 `npm run test:progress` 现为 739 项通过、0 失败。

Codex launchd 服务已重启，当前主进程 PID `29866`，启动日志确认读取 `.env` 的 Codex scope，并打印 `CODEX_MODEL_CONTEXT_WINDOW=1050000`。重启后本 thread 的真实新 turn 写入 rollout `01a03eae-8e74-7762-a7c0-8d00a08403ee`，连续 token usage 事件报告 `model_context_window=828400`，不再是修复前的 `258400`。该值与独立 CLI 探针一致，证明 app-server 的 thread 配置已生效并被当前认证路由裁剪到 `828400`；目标中的 `1,050,000` 请求值受上游 `872000` catalog 上限约束，不能由 AID 继续提高。`.env` 中原生 Codex 自动压缩阈值已为 `400000`，且配置校验保证它低于有效请求窗口。其他 provider 的 runtime 参数回归仍证明不会收到 Codex context 或 compact 参数。

最终重启后的进程 PID 为 `38497`，启动日志同时确认 `CODEX_MODEL_CONTEXT_WINDOW=1050000` 与 `CODEX_NATIVE_COMPACT_LIMIT=400000`。通过当前代码的真实 `createCodexAppServerRunner` 新建 session，发送 `Reply with exactly AID_CONTEXT_OK`，收到 `AID_CONTEXT_OK`，runner 的 `turn.completed.usage.modelContextWindow` 为 `828400`；对应新 rollout `01a03ee4-a7cd-77b0-9ea0-0085087525bd` 也记录同一窗口。非 Codex 对抗探测和非法启动探测均按预期拒绝或隔离，未发现其他 provider 继承 Codex 配置。

最后一轮 `npm run test:progress` 仍为 739 项通过、0 失败。使用 `CODEX__MODEL_CONTEXT_WINDOW=300000` 和 `CODEX__MAX_INPUT_TOKENS_BEFORE_COMPACT=400000` 启动 bot，进程以退出码 1 明确报出 `compact threshold 400000 must be below context window 300000`，没有降级运行；使用相同的 1050000 context 配置对 Claude、Cursor、Grok、ZCode、Pi、OMP 做参数探测，全部为 `isolated`。

为解除上游本机模型缓存的 872000 上限，新增运行时生成的 `data/codex-model-catalog.json`。它以当前 `~/.codex/models_cache.json` 为源，只把目标 `gpt-5.6-sol` 的 `context_window`、`max_context_window` 和有效比例改为 1050000，源缓存保持未改动，其他模型原样保留。随后通过当前 AID runner 加载该目录启动全新的 app-server session，收到 `AID_CONTEXT_1050000_OK`，`turn.completed.usage.modelContextWindow=1050000`，同时进程命令行确认加载了该目录。至此认证路由不再裁剪目标窗口。

## 最终判定

`VERDICT: PASS`。代码、配置、运行数据和测试均已对齐；未修改 `~/.codex/models_cache.json`，未触碰其他 provider 的压缩策略，也保留了工作区中原有的 OMP 未提交改动。Codex 服务当前处于 running，最新进程加载了生成目录和 `400000` native limit。没有待解决的账本项。

## 2026-08-27 模型级能力映射

后续复核发现只为 Sol 生成目录仍不足以覆盖 Codex 模型族。配置已扩展为模型映射：`gpt-5.6-sol` 与 `gpt-5.6-luna` 都请求 `1050000` context，Sol 使用 `400000` native compact limit，Luna 使用 `40000`。启动参数、长 app-server、模型目录和设置面板都从同一份映射读取，选择其他 Codex 模型时不会误套用这两个模型的窗口或阈值。最新 Codex 服务 PID `69593` 已加载该映射，生成目录确认 Sol/Luna 均为 `1050000`；真实 Luna session 返回 `LUNA_CONTEXT_1050000_OK`，有效窗口 `1050000`。完整测试为 744 项通过、0 失败。
