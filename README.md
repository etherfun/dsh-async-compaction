# dsh-async-compaction

**后台上下文预压缩 · Background context pre-compaction for DeepSeek Harness**

在原生压缩（`dsh-compaction-basic`）不得不暂停 Agent 之前，把旧历史的后台摘要提前算好，等到安全边界再**原子地**替换进会话。压缩期间新产生的消息不会被覆盖，主循环不再为一次摘要模型调用停顿；原生压缩仍挂载作为最终兜底。

## 安装

要求 DSH **0.2.2-rc.1+**（Node 22+）。在你的 profile 里安装（`web` 换成实际使用的 profile）：

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-async-compaction
```

它会写入 profile 依赖并自动加进 `dsh.profile.bundles`；`web` profile 热加载，无需重启。装好后 **设置 → 插件** 出现「后台预压缩」卡片，会话头部出现「预压缩」按钮。

卸载：`npx @deepseek-ai/dsh plugin --profile web remove dsh-async-compaction`。

## 使用

- **自动**：达到触发点后后台摘要，`applyStrategy` 允许的边界（`safe` = pre-step / idle）自动落地
- **手动**：输入 `/compact`，插件在后台完成摘要并提交，命令不再阻塞输入。**step 正在执行时**，请求会记录 `step/start` 的 seq 作为基线：快照保留该 step 起的全部 surface 节点、只压缩更早历史；摘要若在 `step/end` 前就绪，可在 `step-boundary` 边界原子落地（`queueMicrotask` 避开 append 重入），否则仍等下一个 `pre-step`。基线在 `step/end`/`turn/start`/`turn/end` 清空；没有 in-flight step 时保持原生手动语义（`retainTokens=0`）。若基线之前没有可压缩历史 → `no-compactable-range`（手动 resolve `null`）；tool-pair 平衡必要时会把 cutoff 往前回退。
- **面板**：会话头部「预压缩」→ 右侧边栏，查看上下文趋势（按 step）、压缩记录、累计节省时间
- **指示器**：composer token 环旁显示 空闲/后台压缩中/已就绪/完成/失败

### `/precompact` 命令

```
/precompact status       # 当前会话状态
/precompact list         # 所有被跟踪会话
/precompact logs [n]     # 最近 n 条插件日志（默认 30）
/precompact pause|resume # 暂停/恢复自动触发
/precompact dry-run|live # 只演练/正常执行
/precompact now          # 立即尝试一次
/precompact compact      # 同手动压缩
```

## 配置

16 个键，均可在插件设置卡片中修改；每个键的含义、默认值与取值范围都在卡片内就地说明。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `triggerMode` | `fixed` | `fixed` 固定阈值 / `adaptive` 自适应预测 |
| `fixedThreshold` | `0.70` | 固定模式触发比例 |
| `nativeThreshold` | `auto` | 原生压缩阈值（`auto` = 读后端；也可给比例/绝对 tokens） |
| `autoAdjustFixedThreshold` | `true` | 固定阈值高于原生时自动压到原生下方 |
| `minThreshold` / `maxThreshold` | `0.50` / `0.75` | 自适应触发区间夹取 |
| `fallbackThreshold` | `0.65` | 自适应数据不足时的回退阈值 |
| `minInterval` | `60000` | 两次启动的最小间隔（ms，仅自动） |
| `applyStrategy` | `safe` | 落地边界：`safe`（pre-step/idle）/ `end-of-turn` / `idle-only` |
| `minShadowedTokens` | `1024` | 自动触发的最小收益门（被替换区间的路由价） |
| `hookManualCompact` | `true` | 接管手动 `/compact` |
| `dryRun` | `false` | 只算不落地 |
| `logLevel` | `info` | 日志级别 |
| `logBufferSize` | `500` | 内存日志环形缓冲 |
| `statusCommand` | `true` | 是否注册 `/precompact` 命令 |

## 架构

```
session/event · agent/pre-step · turn-stopping · idle · 5s timer
        │
        ▼
 src/coordinator.js ──► src/policy.js / src/native-policy.js   （何时压缩）
        │
        ▼
 src/snapshot.js ──► src/summarizer.js                         （后台算）
        │
        ▼
 src/commit.js ──► 4 条事件原子落地                              （何时落地）
        │
        ├── src/history-endpoint.js / visual-status.js / logs-endpoint.js
        └── src/manual-hook.js（接管 /compact）
```

## 开发

```bash
npm test                 # node --test：284 个用例
node scripts/smoke.mjs   # 真实 host 语义下的端到端 smoke
node scripts/smoke-manual.mjs
node scripts/smoke-config-live.mjs
node scripts/smoke-client.mjs
```

不依赖构建步骤，改 `client.js` 后刷新页面即可生效。

### 发布到 npm

npm 账号的写操作要求 2FA；用 passkey 时终端里拿不到 OTP，`npm publish` 会以 `EOTP` 失败，所以走 **staged publishing**（需要 npm >= 11.15.0）：

```bash
npm login --auth-type=web                    # 浏览器里用 passkey 登录
npm stage publish                            # 上传到暂存区，不需要 2FA
npm stage view <stage-id>                    # status 从 validating 变 staged 后才能批准
npm stage approve <stage-id>                 # 打印 auth/cli/<uuid> 链接，浏览器 passkey 确认
```

首次发布会先落一个占位版本 `0.0.0-stage`；批准 0.1.0 后用 `npm unpublish dsh-async-compaction@0.0.0-stage` 清掉（72 小时内可撤）。若 `approve` 返回 `E409 ... automated review hasn't finished`，等一两分钟再批。

## 已知限制

- `steps`（按步序列）全量保留、`samples`（120）/`history`（30）有界；均为内存态，插件重载/重启清空，面板只统计本次加载以来
- 侧边栏依赖 `sidebarRight` 服务；未打开面板时不轮询
- 手动请求没有插件级超时（生命周期交给原生压缩语义）
- 运行中的手动压缩只保证 **step 基线**：不保证当前 step 内已产生的模型流/工具结果可被替换；若插件中途加载、没观察到 `step/start`，`currentStepStartSeq` 为空，会回退到原生 `retainTokens=0` 语义
- 三个 HTTP 端点无统一鉴权（仅同源校验），只暴露聚合状态，不返回会话内容
- 自适应 warm start 会沿用“上一次完整预测”的目标；配置或模型变化后可能短暂停留在旧阈值（仍受 min/max 夹取）
- 与其它压缩插件共存时只负责调度；若后端已同步压缩，本插件会按 generation 校验放弃过期结果

## License

MIT
