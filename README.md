# dsh-pre-compact

**后台上下文预压缩 · Background context pre-compaction for DeepSeek Harness**

在原生压缩（`dsh-compaction-basic`）不得不暂停 Agent 之前，把旧历史的后台摘要提前算好，等到安全边界再**原子地**替换进会话。压缩期间新产生的消息不会被覆盖，主循环不再为一次摘要模型调用停顿；原生压缩仍挂载作为最终兜底。

> **契约边界**：本插件只接管 **“何时压缩 + 异步执行”**——触发判定、快照、后台摘要调度、安全边界原子提交，以及手动 `/compact` 的异步化。**“如何压缩”仍归当前压缩后端**：保留区间、摘要模型、质量门槛、参与压缩的模型范围都由后端决定。这样不会和其它压缩插件/后端升级冲突。

- 包名：`@local/dsh-pre-compact`（本地 bundle，不发布 npm）
- 形态：Host 插件 + bundle（`cordis.patch.yml`）+ 浏览器端三个界面（设置卡片 / composer token 旁指示器 / 右侧边栏「预压缩」面板）
- 运行时依赖：**无**（Host 只用 `node:` 内置与自身文件；client 只 `require('react')`）

## 特性

- **提前触发**：固定阈值（默认 70%）或自适应预测（按增长速率 + 压缩耗时，压缩后 warm start 保持上次目标）
- **异步摘要**：复用后端 `summarize()` 钩子（拿不到时退回 `ctx.llm.stream()`），不阻塞主循环
- **原子落地**：`compaction/start → summary → user/message(replace) → compaction/end`，快照后新增的消息原样保留
- **手动接管**：`/compact` / `compactNow()` 也走后台上报 + 安全边界提交（`hookManualCompact: false` 可退回原生）
- **可视化**：composer 指示器 + 右侧边栏面板（按 step 全量趋势、压缩记录、节省时间统计）
- **可观测**：`/precompact` 命令、结构化日志、三个只读 HTTP 端点
- **安全阀**：`dryRun`、`applyStrategy`、抗抖动地板、最小收益门、失败自动回退原生

## 安装

要求 DSH **0.2.2-rc.1+**（Node 22）。

1. 把本目录放到 DSH profile 可访问的位置（或 `link:` 到 profile）。
2. 在 profile 的 `cordis.patch.yml` 里用 bundle 引入：

```yaml
- include: pre-compact
```

或在 profile `package.json` 中把本包作为依赖并让 bundle 的 patch 生效：

```json
{ "dependencies": { "@local/dsh-pre-compact": "link:F:/path/to/dsh-pre-compact" } }
```

3. 重启 / 重载 DSH，打开 **设置 → 插件** 即可看到「后台预压缩」卡片；会话头部出现「预压缩」按钮。

## 使用

- **自动**：达到触发点后后台摘要，`applyStrategy` 允许的边界（`safe` = pre-step / idle）自动落地
- **手动**：输入 `/compact`，插件在后台完成摘要并提交，命令不再阻塞输入
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

### HTTP 端点（同源、`no-store`）

| 端点 | 用途 |
|---|---|
| `GET /api/pre-compact/status?sessionId=` | composer 指示器用的轻量状态 |
| `GET /api/pre-compact/logs?limit=&level=&sessionId=&sinceSeq=` | 结构化日志 |
| `GET /api/pre-compact/history?sessionId=` | 侧边栏数据：`current` + `steps`（全量）+ `samples`（120）+ `history`（30） |

## 配置

16 个键，均可在插件设置卡片中修改；完整语义见 [docs/02-design.md](docs/02-design.md)。

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

并发：**单会话固定最多 1 个在途任务 + 1 个待落地结果**；跨会话无全局上限，可并行摘要。

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

目录：`index.js`（Host 入口）、`src/`（Host 实现）、`client.js`（浏览器 half）、`test/`（273 个用例）、`docs/`（设计/算法/限制/验证）、`research/`（调研）。

## 开发

```bash
npm test                 # node --test：273 个用例
node scripts/smoke.mjs   # 真实 host 语义下的端到端 smoke
node scripts/smoke-manual.mjs
node scripts/smoke-config-live.mjs
node scripts/smoke-client.mjs
```

不依赖构建步骤，改 `client.js` 后刷新页面即可生效。

## 已知限制

- `steps`（按步序列）全量保留、`samples`（120）/`history`（30）有界；均为内存态，插件重载/重启清空，面板只统计本次加载以来
- 侧边栏依赖 `sidebarRight` 服务；未打开面板时不轮询
- 手动请求没有插件级超时（生命周期交给原生压缩语义）
- 三个 HTTP 端点无统一鉴权（仅同源校验），只暴露聚合状态，不返回会话内容
- 自适应 warm start 会沿用“上一次完整预测”的目标；配置或模型变化后可能短暂停留在旧阈值（仍受 min/max 夹取）
- 与其它压缩插件共存时只负责调度；若后端已同步压缩，本插件会按 generation 校验放弃过期结果

## 文档

- [docs/01-research.md](docs/01-research.md) 调研
- [docs/02-design.md](docs/02-design.md) 设计（数据契约、UI、端点）
- [docs/03-adaptive-algorithm.md](docs/03-adaptive-algorithm.md) 自适应算法
- [docs/04-testing.md](docs/04-testing.md) 测试
- [docs/05-limitations.md](docs/05-limitations.md) 限制与取舍
- [docs/06-verification.md](docs/06-verification.md) 验证与未验证项
- [review/REVIEW-glm-5.3f.md](review/REVIEW-glm-5.3f.md) 独立审查

## License

MIT
