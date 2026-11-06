# 05 · 已知限制与后续优化

> 这份文档的目标不是"免责声明"，而是把**设计边界**写清楚：哪些是平台硬限制、哪些是我们主动的取舍、哪些是当前版本的真缺陷、以及各自怎么规避。
>
> 每条都标注了代码位置与依据；"后续优化"给出可执行方向与优先级，不代表已经实现。

---

## 目录

- [1. 平台/API 层限制](#1-平台api-层限制)
  - [1.1 依赖 deprecated 的 `session.eventAt()`](#11-依赖-deprecated-的-sessioneventat)
  - [1.2 依赖非契约钩子 `ctx.compaction.summarize()`](#12-依赖非契约钩子-ctxcompactionsummarize)
  - [1.3 linked 安装下裸 import 与 Config 解析](#13-linked-安装下裸-import-与-config-解析)
  - [1.4 原生阈值只能"读后端实例"](#14-原生阈值只能读后端实例)
  - [1.5 服务软取与"静默惰性"](#15-服务软取与静默惰性)
  - [1.6 手动压缩 hook 依赖后端实例方法（monkey-patch）](#16-手动压缩-hook-依赖后端实例方法monkey-patch)
- [2. 行为边界](#2-行为边界)
  - [2.1 每会话单任务](#21-每会话单任务)
  - [2.2 插件不做全局节流：多会话可并行摘要](#22-插件不做全局节流多会话可并行摘要)
  - [2.3 只在四个边界落地](#23-只在四个边界落地)
  - [2.4 无法压缩单条超大消息](#24-无法压缩单条超大消息)
  - [2.5 与图像 offload / 消息投影的交互](#25-与图像-offload--消息投影的交互)
  - [2.6 与 tool-result pruner 的关系](#26-与-tool-result-pruner-的关系)
  - [2.7 KV cache 代价](#27-kv-cache-代价)
  - [2.8 自动路径提交后不 flush（手动已补）](#28-自动路径提交后不-flush手动已补)
  - [2.9 固定阈值的自动下调会覆盖用户意图](#29-固定阈值的自动下调会覆盖用户意图)
  - [2.10 保留尾部跟随其后端（不可由本插件配置）](#210-保留尾部跟随其后端不可由本插件配置)
  - [2.11 最小收益门的副作用](#211-最小收益门的副作用)
  - [2.12 抗抖动下限（retrigger floor）](#212-抗抖动下限retrigger-floor)
  - [2.13 手动请求与自动调度的交互](#213-手动请求与自动调度的交互)
  - [2.14 自适应预测只剩 3 个可调项](#214-自适应预测只剩-3-个可调项)
- [3. 成本与计量](#3-成本与计量)
- [4. 可观测性缺口](#4-可观测性缺口)
- [5. 兼容性与共存](#5-兼容性与共存)
- [6. 当前实现中的已知瑕疵](#6-当前实现中的已知瑕疵)
- [7. 后续优化路线](#7-后续优化路线)

---

## 1. 平台/API 层限制

### 1.1 依赖 deprecated 的 `session.eventAt()`

**现状**：`src/surface.js` 的 `eventAt()`、平衡折叠、`buildSummarizationInput()` 全都通过 `session.eventAt(seq)` 取事件，再 `session.deriveEventMessage(event)` 得到消息。这套 API 在宿主里已被标注 **deprecated（新代码禁止调用）**（`research/extracted/.../dsh-session/lib/index.js:1433-1459`，`dsh-session/README.md:63`）。

**为什么还是用了**：没有非废弃的等价替代。

| 候选替代 | 为什么不行 |
|---|---|
| `session.deriveMessages()` | 只返回消息数组，**丢失 seq 映射**；而压缩需要"seq ↔ 被 shadow 节点"的精确对应 |
| 用 surface 下标推算 | 空内容的 `system/developer/assistant` 节点投影为 `null`（`dsh-session/lib/types/surface.js:88-97`），下标无法可靠对齐 |
| 读 `snapshotEvents()` | 同样是 deprecated 家族，语义更重 |

官方包自己也在用同一 API（`dsh-compaction-basic`、`pruner`、`token-meter` 内部），所以短期内移除的概率不高；但这是**跨版本最脆弱的一处**。

**影响面**：快照构造与提交校验；如果未来 `eventAt` 被移除，插件会在第一个需要压缩的会话上抛错（被 `evaluate()` 的 try/catch 兜住 → warn + 不压缩），**不会损坏会话**，但功能失效。

**规避/优化方向**：
- 只依赖 `session.surface.nodes` + `session.surface.contentGeneration` 做变化检测（已是现状），把 `eventAt` 的调用限制在"确实要构造摘要输入"的那一刻；
- 若未来宿主提供带 seq 的派生 API，替换 `src/surface.js` 中 2 个函数即可（`buildSummarizationInput`、`extendBalanceCache`）；
- 在 `docs/06-verification.md` 中保留"DSH 升级后先跑一次 dry-run"的验收项。

### 1.2 依赖非契约钩子 `ctx.compaction.summarize()`

**现状**：首选摘要路径是 `engine.summarize(snapshot.input, agent, signal)`（`src/summarizer.js`）。这个方法在官方 README 里被描述为"子类定制钩子"，**不是公共 API**（`dsh-compaction-basic/lib/index.js:900-904`、`README:110,138`）。它能工作，是因为 `ctx.compaction` 恰好就是 `BasicCompactionEngine` 实例。

**好处**：复用原生提示词、模型路由、输出上限、`usage` 记账、KV 前缀意图，产物与原生**同构**。

**风险**：跨版本可能改名/改签名/变私有；某些后端（非 basic）可能没有它。

**已实现的降级**：`runSummarization()` 检测不到钩子时，退回 `ctx.llm.stream()` + 逐字复制的 `COMPACTION_INSTRUCTION`（`src/surface.js`）+ 自己聚合 text 块、自己判 `finish.kind`。降级路径的差异：

| 项 | 后端钩子 | 回退路径 |
|---|---|---|
| 提示词 | 后端自带（与原生逐字一致） | 本项目复制的常量（当前同样逐字一致，但**版本升级后可能漂移**） |
| 路由 | 后端决定（后端 `summarize()` 用自己的路由/配置） | 会话自身路由（`routedTargetOf`），无 provider/model 覆盖 |
| 输出上限 | 后端 `config.maxTokens`（默认 65536） | 常量 `FALLBACK_MAX_TOKENS=65536`（不可配置） |
| 空摘要/截断处理 | 后端抛错 | 本项目抛错（`MAX_TOKENS` 视为失败） |
| `usage` 记账 | 有 | 有（取最后一帧 `usage`） |
| `rawOutput`/`llmStreamCall` | 有 | 只有 `llmStreamCall:true` |

**影响**：降级路径功能等价，但提示词与行为存在长期漂移风险；日志会打一条 warn `mounted backend has no summarize() hook`。

**优化方向**：定期用 `docs/06-verification.md` 的对照项检查"复制常量 vs 后端常量"是否仍逐字一致（可以从 `purpose`/首个摘要质量间接判断，或直接读后端 `COMPACTION_INSTRUCTION` 导出——目前未导出）。

### 1.3 linked 安装下裸 import 与 Config 解析

**现状**：`src/config-schema.js` 是顶层 `await loadConfigSchema()`：

1. 先 `import('@deepseek-ai/schemastery')`；
2. 失败则用 `createRequire(join(DSH_PROFILE_DIR|DSH_HOME, 'noop.cjs'))` 解析 `@deepseek-ai/schemastery`；
3. 仍失败 → 导出 `undefined`。

`src/config.js` 的 `resolveConfig()` 始终做完整的手写校验（默认值、类型、区间、互斥规则），**不依赖** schemastery。

**为什么会这样**：linked 安装（`pnpm add link:...`）时，插件的模块解析根是**它自己的仓库目录**，那里没有 `node_modules/@deepseek-ai/schemastery`；只有 profile 的 `node_modules` 或 DSH 安装目录里才有。这是官方文档明确的现象（`host-plugin.md`，以及 `dsh-read-image-compress/index.js:57-77` 的同类处理）。

**后果**：

| 安装形态 | `Config` | 设置 UI（自动表单 / 设置卡片） | 校验 |
|---|---|---|---|
| linked checkout（当前本机形态） | 若能从 `DSH_PROFILE_DIR`/`DSH_HOME` 解析到 schemastery 则为 schema，否则 `undefined` | 有 schema 时插件页出现设置卡片；解析不到时**没有自动表单/卡片**，只能改 profile 的 `cordis.patch.yml` | `resolveConfig()` 手写校验 + warning |
| 复制/发布安装（`npm`/tarball） | schemastery schema | 有 | Loader + 手写校验双保险 |

**其它相关限制**：

- **所有行为字段都声明了 `.volatile()`**（`statusCommand` 除外）：插件页保存后经 `loader/volatile-update` 原地更新，不重启插件；`apply()` 拿到的是 Cordis 引用对象，由 `unwrapConfigRefs()` 解包；
- **未知配置键**：18 个历史 legacy 键静默忽略；其它未知键会打 warning `unknown config key "<key>" was ignored`（不阻断启动，但也**不会**生效）；
- `/precompact pause|resume|dry-run|live` 改的是**运行期内存**，不写回配置；重启后回到配置文档的值（与插件页保存不同，后者持久化）；
- `DSH_PROFILE_DIR` / `DSH_HOME` 环境变量缺失时，第 2 步兜底无效（仍然是 `undefined`，功能不受影响，只是没有设置卡片/自动表单）。

**优化方向**：把第 2 步扩展为"从 `process.resourcesPath/app.asar` 与 `node_modules` 邻居逐级探测"（read-image-compress 的四级候选写法），可显著提高 linked 安装下拿到 schema 的概率。

### 1.4 原生阈值只能"读后端实例"

原生 `resolveCompactSpec()` 是模块私有函数（未导出）。本插件读 `engine.config.thresholdRatio / headroomTokens / retainRatio / retainTokens / auto`（`src/native-policy.js` 的 `readBackendPolicy`），再按同一公式复算。

**风险**：

- 后端换实现或把策略藏进私有字段 → 读不到 → `source='defaults'`（0.8 / 65536 / 0.16）；
- 后果一：自适应模式 `dataComplete=false`，优先复用上一次**完整预测**（warm start）；没有历史完整预测时才**走 `fallbackThreshold`（65%）**，直到你显式配置 `nativeThreshold`；
- 后果二：固定模式不受影响（只与 `contextWindow × fixedThreshold` 比较）。

**规避**：显式 `nativeThreshold: 0.8`（或你的后端真实比例）。这会同时把 headroom 视为 0，即 `threshold = min(C×R, C−O)`。

### 1.5 服务软取与"静默惰性"

插件**不声明硬 `inject`**（这是刻意的：否则缺服务的 profile 直接不加载，见 `practices.md:20`）。代价是：所有依赖都靠**调用点软取**，缺失时只表现为"不工作"。

| 缺失服务 | 表现 | 日志 |
|---|---|---|
| `ctx.tokenMeter` | **首次评估即自我禁用**（`config.enabled=false`），此后不再工作，直到 `/precompact resume` 或重启 | warn `no token meter is mounted; pre-compaction is inactive` |
| `ctx.compaction` 且无 `agentPresets` | 永不启动后台任务 | debug `trigger deferred: no compaction backend mounted` |
| `ctx.llm`（回退摘要时） | 任务失败 | warn `fallback` 相关错误 |
| `commands` | 不注册 `/precompact` | debug `command registry unavailable` |

> 最容易踩的坑：如果插件在 token meter 就绪之前就被某个事件触发评估，会**永久自禁用**（直到 resume）。多见于启动初期或服务装载顺序变化。见 [§6](#6-当前实现中的已知瑕疵)。

### 1.6 手动压缩 hook 依赖后端实例方法（monkey-patch）

**做了什么**：`src/manual-hook.js` 在 `agent/created`（并在 `agent/pre-step` 兜底）按 agent 解析压缩后端实例（`compactionServiceOf`：host `ctx.get('compaction')` 优先，preset 隔离组用 `agentPresets.serviceFor(agent,'compaction')`），把实例上的 `compactNow` 换成本插件的 wrapper，并在插件卸载时还原（`ctx.effect` 的 disposer 先 `manualHook.restore()` 再 `runtime.dispose()`）。

**为什么必须这么做**：宿主命令按名称唯一注册、没有替换他人命令的 API（`dsh-commands` 的重名错误见 [docs/02 §3.4](02-design.md#34-手动路径为什么包装-compactnow而不是注册一个-compact)），而 `/compact` 的 handler 只有一句 `ctx.compaction.compactNow(agent, signal, commandId)`。不 patch 实例方法就只能替换整个 `CompactionEngine`（方案 C，侵入性更大）。

**这不是契约 API**，边界如下：

| 场景 | 行为 |
|---|---|
| 实例没有 `compactNow` | `patch()` 直接返回 `false`，**不接管、不告警**；`/compact` 走后端自己的实现（`status` 的 `Manual /compact hook:` 保持 `unknown`/`no-backend`） |
| 实例/方法是只读或冻结，赋值抛错 | warn `cannot hook the manual compaction entry point; /compact keeps its native behavior`，状态 `patch-failed`，`/compact` 保持原生 |
| 后端跨版本改名（`compactNow` 不存在） | 同上（静默不接管 / 原样 delegate） |
| 后端在 patch 之后被替换（新实例） | 新实例首次 `agent/created`/`pre-step` 时会被重新 patch；旧实例随卸载/还原 |
| 包装器内部抛错 | warn `manual compaction hook failed; falling back to the mounted backend`，本次**原样 delegate** |
| `enabled=false` / `dryRun=true` / `hookManualCompact=false` | wrapper 仍存在但直接 delegate（不需要重载插件即可恢复原生语义） |
| `/precompact pause` | 取消排队/在途的手动请求（reject `cancelled`、abandoned、丢弃手动 READY）；自动任务继续 |
| 插件卸载 | `restore()` 把原方法写回；即使写回失败，wrapper 也会因 `active=false` 而 delegate；状态 `restored` |
| 多 preset 隔离组 | 每个后端实例各包装一次（`WeakMap<engine, original>`）；`restore()` 遍历已包装列表 |

> 状态可见性：`/precompact status` 会输出 `Manual /compact hook: <state> (detail)`；状态由 `runtime.setManualHookState()` 维护（`unknown / active / patch-failed / no-backend / restored`），debug 日志 `manual compaction hook state`。

**其它语义差异**（详见 [§5.6](#56-与原生-compact-的行为差异)）：`busy` 文本由宿主 `/compact` 命令渲染；本插件抛出的错误只是 `name/code` 形状相同的**普通 Error**（不是宿主 `ManualCompactionError` 类实例），因此命令侧以 `error.message` 冒泡显示；`turn` 可能非 `null`。

---

## 2. 行为边界

### 2.1 每会话单任务

`state.active`（在途）+ `state.ready`（就绪）各最多一个；`evaluate()` 在任一非空时直接返回（`src/coordinator.js`）。含义：

- 同一会话不会并行两个摘要，也不会"一边压缩一边再压"；
- 新结果产生前，旧结果必须被消费（落地/丢弃/取消）；
- **代价**：如果某个会话的 ready 结果因 `applyStrategy`（如 `idle-only`）长期无法落地，该会话在结果被丢弃前不会启动新任务。缓解：`invalidate`（原生压缩/surface 替换）会丢弃旧结果，`/precompact` 状态里可见 `readyResult`。

### 2.2 插件不做全局节流：多会话可并行摘要

并发模型只有一条硬规则：**每个会话最多 1 个在途任务 + 1 个待落地结果**（状态机保证，同会话串行）。插件**没有全局并发闸门、没有 `maxConcurrent` 配置、没有 `activeTasks` 计数**；不同会话可以同时摘要、互不阻塞。

- 多会话/子代理同时逼近阈值时，会**各自**发起摘要请求；插件不排队、不限流、没有优先级。
- 该模型**不包含**原生压缩的任务。
- 成本/限流交给模型服务侧：多会话高峰期可能同时出现多个摘要请求，provider 的配额、429、排队都由模型服务决定，插件不会替你削峰。

**取舍**：删掉全局闸门换来了"跨会话不互相饿死"（原先一个长会话的摘要会让其他会话一直等），代价是成本峰值更直接地传导到模型服务。需要控成本时用 `minInterval`（每会话）或从后端侧限制。

### 2.3 只在四个边界落地

| 边界 | 语义 | 限制 |
|---|---|---|
| `pre-step` | 当前 turn 内、step 前 | 与原生压缩同一事件，靠事件注册顺序决定先后（未实测，见 06）；若本插件先落地，原生在同一 step 内会看到新的更低占用 |
| `step-boundary` | `session/event` 的 `step/end`（`queueMicrotask`） | **仅手动**；自动不用。摘要未就绪则等下一个 `pre-step`；当前 step 的模型流/工具结果仍在进行中，不能替换 |
| `turn-stopping` | turn 即将关闭 | 只在 agent 正常收尾时触发；异常/崩溃路径不触发 |
| `idle` | agent 空闲 | `status === 'idle'`；若 agent 一直 running（长任务），`idle-only` 策略下永远不会落地 |

**不能做什么**：

- 不能在"用户发来新消息但 agent 尚未 start"的窗口里落地（没有对应事件）；
- 不能在请求进行中（stream 期间）落地——那会破坏 KV 前缀与消息一致性（平台也不允许中途改 surface）；`step-boundary` 只在 step **结束**后、且只保留该 step 起的节点，不触碰仍在进行的模型流；
- 不能保证在 `turn/end` 之后、`agent/status(idle)` 之前落地（时间窗取决于宿主）。

### 2.4 无法压缩单条超大消息

`selectCompactableRange()` 从尾部按路由价累加保留（由后端 `retainTokens`/16% 默认值决定）；如果**最大的节点就在保留尾部**（一条 20 万 token 的工具结果、一张高分辨率图像），压缩不会碰它：

- 单节点超过阈值时：区间可能 `null`（`keepFromIdx <= firstIdx`）→ `lastSkip = 'no-compactable-range'`，永不压缩；
- 区间能选出来时：省下的量受限于"被遮蔽区间"大小，压缩后仍可能逼近阈值；
- 不能把一条 `tool-call`/`tool/result` 对拆开（平台语义 + 平衡校验），所以"单条超大工具结果"只能靠 `dsh-compaction-tool-result-pruner` 那类**裁剪**手段处理。

**规避**：改后端的保留策略（例如调小后端 `retainTokens`，让尾部的超大节点进入可压缩区）——但那会牺牲近因上下文；或对超大工具输出用 pruner 先裁剪。

### 2.5 与图像 offload / 消息投影的交互

- `image offload` 插件通过**消息投影**改写节点内容（`dsh-compaction-image-offload` 注册 `ctx.sessions.registerMessageProjection`），而**任何消息投影都会让 `contentGeneration` 递增**（`dsh-session/lib/types/surface.js:438,444`）。
- 本插件的快照同时记录 `contentGeneration` 与 `replaceGeneration`。因此：
  - 图像被 offload/替换后，后台准备好的结果会判 `surface-rewritten` → 丢弃（**安全但不经济**，白算一次）；
  - 若 offload 周期性发生（例如大图不断被换成本地引用），可能反复打断预压缩。
- 计费上：`measure().nodes[i].tokens` 是**路由价（含图像视觉 token）**，所以有图像的会话阈值计算是正确的；`heuristicTokens` 用于 `compaction/summary.shadowedTokenCount`（与原生一致）。
- 图像 **不是**本插件处理的：我们不生成、不压缩、不 offload 图像。

**优化方向**：对"仅投影变化、被遮蔽区间实际内容未变"的情况放宽为"允许落地"（需要能拿到投影后的消息比较，而不是只看 generation）；或在 offload 之后的一小段时间内暂停预压缩（`minInterval` 已有部分效果）。

### 2.6 与 tool-result pruner 的关系

原生自动压缩在比较阈值后会先调用挂载的 pruner（`prune.pruneSession`）再重测（`dsh-compaction-basic` 的 `compactIfNeeded` 循环）。本插件**不主动调用 pruner**：

- 优点：不改动工具结果、不为"省 token"承担额外语义；
- 缺点：当"可裁剪的工具结果"占大头时，原生可能用一次 pruner 就把占用压回阈值以下，而本插件已提前烧了一次摘要 → 结果在落地时可能已不满足"仍比区间小/仍有必要"？（实际上 `framedTokens < shadowedRouteTokens` 仍成立，但收益变小）。
- 由于 pruner 会 append `compaction/prune` 事件（不是 replace），它**不会**触发 `surface-replaced` 失效（`compaction/prune` 是 log-only，`isSurfaceEventType` 为 false）；但如果 pruner 同时 replace 了 `tool/result`，`replaceGeneration` 变化 → 失效。

**优化方向**：在评估阶段读取 `ctx.get('toolResultPruner')` 并复用其"影子定价"来判断"先裁还是先压"；当前不做，以避免依赖第二个可选服务。

### 2.7 KV cache 代价

替换会让"从第一个被遮蔽消息起"的 provider 前缀缓存失效（`dsh-session/README.md:166`；调研明细 §9.3）。本插件的缓解：

- 只在**确实提前**（早于原生）时替换一次，且区间与原生算法一致（尾部保留）；
- 不频繁小规模压缩（`minInterval` + 收缩率门槛）；
- 但**无法消除**这次缓存失效——这是"压缩"本身的代价，原生压缩同样要付。

**推论**：如果你的 provider 对缓存命中非常敏感、上下文增长又不快，把 `triggerMode` 设为 `fixed` 且阈值贴近原生（如 0.75）比激进的自适应更划算。

### 2.8 自动路径提交后不 flush（手动已补）

原生手动路径在 `compaction/end` 之后会 `await sessions.flush(session)`（`dsh-compaction-basic/lib/index.js:509-513,999-1001`）。本插件现在：

- **手动 `/compact`**：提交成功后 `applyReady()` fire-and-forget 调 `ctx.get('sessions').flush(session)`（不阻塞命令 resolve，失败只 warn `manual compaction flush failed`）——对齐原生手动路径的持久化检查点；
- **自动路径**：仍不显式 flush。正常情况下宿主会按自己的节奏持久化，影响可忽略；若进程在 flush 前崩溃，这次压缩可能只存在于内存（会话恢复时看不到），表现为"上下文又变大了"；
- 不能在 `pre-step` 里 await flush（会阻塞主循环，违背核心目标）。

**优化方向**：自动路径也采用 fire-and-forget flush（当前只对手动做）；或在 `session/flush` 事件里补挂。

### 2.9 固定阈值的自动下调会覆盖用户意图

`autoAdjustFixedThreshold`（默认 `true`）在"用户阈值 ≥ 原生阈值"时把触发点压到原生阈值下方（`gap = max(4096, 2%·N)`，且不低于 `5%·C`，见 `src/policy.js` 固定分支）。

- **为什么要这么做**：原生阈值不只看比例，还被"输出预留 + 后端 headroom（默认 65536）"压低；小窗口模型上 `N/C` 可能只有 30%~45%。用户配 `fixedThreshold: 0.7` 时预压缩永远晚于原生 → 一次也不会成功。
- **副作用**：实际触发点可能远低于用户配置（例如 70% → 39%），表现为"上下文还很空就压缩了"；`/precompact status` 的 `Pre-compaction trigger` 显示的是**实际比例**（`triggerTokens/C`），`derivation.requestedTriggerTokens` 才是用户原值。
- **什么时候该关**：你明确知道 `N/C` 很高（例如显式 `nativeThreshold: 0.9` 且窗口足够大），或你宁愿"永不提前"也要守住 70%。关掉后如果 `F ≥ N/C`，插件基本不会工作——这不是 bug。
- **可观测性**：`reason = fixed-adjusted-trigger` 只在**达标时**出现；未达标时是 `below-threshold`，但 `derivation.clamps` 里仍有 `fixed-adjusted-below-native`（当前 `renderStatus` 不打印 `derivation`）。

### 2.10 保留尾部跟随其后端（不可由本插件配置）

保留策略属于**压缩语义**，已从本插件配置中移除（`retainRatio`/`retainTokens`/`manualCompactRetainTokens` 三个键被删除，旧值静默忽略）：

- 自动路径：`resolveNativePolicy()` 读当前后端的 `retainTokens`；读不到时用 `DEFAULT_NATIVE_RETAIN_RATIO=0.16` 按 `messageBudget × 0.16` 推导，并夹到 `≤ 90% × 原生阈值`。
- 手动 `/compact`：默认 `retainTokens=0`——只保留最后一个 surface 节点（工具对自动展开），与原生 `compactNow` 语义一致；**运行中 step 则以 `currentStepStartSeq` 为基线保留整步**。
- 好处：换后端/升级后端时保留行为自动跟随，不会与后端或其它压缩插件"两套策略打架"。
- 代价：**不能**再单独把预压缩调得比后端更激进/更保守；要改保留区间，请改后端的 `retainRatio`/`retainTokens`（或换后端）。若后端没有暴露策略（`source=defaults`），自动路径会退回 16% 默认值。
- **保留策略完全复用后端的 per-target 合并顺序**（已按 `dsh-compaction-basic` 的 `resolveRetention` 对齐）：目标 `retainTokens` → 目标 `retainRatio`（`floor(messageBudget×ratio)`）→ 全局 `retainTokens` → 全局 `retainRatio` → 内置默认 16%，最后 `min(raw, floor(thresholdTokens×0.9))`。即"显式 token 优先于比例、目标优先于全局"。
- **`floor(thresholdTokens×0.9)` 是插件自保取舍**：宿主在"保留量 ≥ 阈值"时会直接抛配置错误；本插件选择夹到 ≤90% 阈值，宁可少保留/本次不压，也不让预压缩越界。这与"完全照搬后端"不同，但保证不会因保留量过大而提交失败。
- **阈值/headroom 也跟随后端 per-target 策略**：`readBackendPolicy()` 解析后端 `modelPolicies`（按 provider/model 覆盖 `thresholdRatio`/`headroomTokens`/`retainRatio`/`retainTokens`）；阈值/headroom 优先级：显式 `nativeThreshold` 覆盖 > 目标策略 > 全局策略 > 内置默认 0.8/65536，返回值带 `targetPolicy`。手动 `/compact` 默认仍 `retainTokens=0`（运行中 step 用基线）。

### 2.11 最小收益门的副作用

**最小收益门**（`minShadowedTokens`，默认 1024）会在区间太小时直接跳过（`range-too-small`）。它对"尾部巨大节点导致可压缩区间很小"的场景是好心的，但在"频繁小幅裁剪"的会话里可能让插件显得从不工作；如果确实希望小步压缩，把它调小（例如 256）。它只按**路由价**判断，不按启发式价，且**只作用于自动触发**（手动 `/compact` 不受限）。

> 模型白/黑名单已完全移除：不再有 `modelAllowlist`/`modelDenylist`，也不会产生 `model-not-allowed`；`src/policy.js` 只保留判断路由非空的 `routeUsable()`（运行时未使用）。旧 profile 中残留的名单键会被忽略。

### 2.12 抗抖动下限（retrigger floor）

成功落地（或 dry-run）后，`src/coordinator.js` 会设置一个**运行时下限**：

```text
retriggerFloor = 落地后估算占用 + max(2048, round(C × 1%))     # dry-run 用快照时的 totalTokens
```

下一次评估若已达标，但 `U < retriggerFloor`，则跳过并记 `lastSkip='retrigger-floor'`（debug `trigger deferred: anti-thrash floor`）；当 `U < triggerTokens`（占用真的降回去了）或发生 `invalidate` 时清零。

**为什么需要**：如果一次压缩只能把占用从 78% 压到 76%，而阈值是 75%，没有下限就会"每 60 秒压一次、每次都只省一点"，白烧摘要且反复让 KV 缓存失效。

**限制/副作用**：

- 它**不是配置项**，不能直接调；影响它的只有"落地后估算占用"与 `C×1%`（下限 2048 兜底）。
- 压缩后如果模型确实又快速涨回阈值附近，插件会先等占用**超过落地后占用 + 1%** 才再次动手——对"压缩后立刻继续猛吃上下文"的场景，可能比预期更晚第二次压缩（此时原生仍是兜底）。
- dry-run 也会设置下限（因为干跑同样付了一次摘要）——想连续干跑观察，需等占用增长或重启/失效。
- 状态对象里有 `retriggerFloor` 字段，但 `renderStatus()` 未打印；只能从 `Last skip: retrigger-floor` 或 debug 日志推断。

### 2.13 手动请求与自动调度的交互

手动请求（`/compact` hook、`/precompact compact`）与自动预压缩**在同一会话内**共用 `state.active`/`state.ready`，但**不复用自动结果**：进入手动路径时先 `supersedeAutomaticWork()`，再启动全新的手动摘要。不同会话之间互不影响（可并行摘要）。

| 交互 | 行为 |
|---|---|
| 同会话已有 manual 请求 | 第二个请求立即 `reject(busy)`，不排队 |
| 已有自动任务在途 | 标记 `abandoned`、`generation++`、`abort`；随后**启动全新手动摘要**（运行中 step 用基线保留整步，否则 `retainTokens=0`、只要求更小）。自动任务被取消，手动会多付一次摘要 |
| 已有自动 READY | `discard(reason='manual-request-supersedes')`，不落地、不复用；随后启动全新手动摘要 |
| step 执行中发起 | 记录 `currentStepStartSeq`（`step/start` 的 seq）作基线：保留该 step 起全部 surface 节点、只压更早历史；**不等待回合结束**，摘要就绪可在 `step/end` 的 `step-boundary` 落地（`queueMicrotask`），否则等下一个 `pre-step` |
| 基线过窄/无更早历史 | `skip='no-compactable-range'` → 手动 resolve `null`；tool-pair 平衡必要时 cutoff 前移 |
| 未观察到 `step/start` | `currentStepStartSeq` 为空 → 回退原生 `retainTokens=0`（插件中途加载时可能发生） |
| 日志 | 取代发生时打 info `manual request superseded automatic pre-compaction work` |
| 手动是否占全局名额 | **不存在全局名额**：手动只占本会话的槽位；不同会话的自动摘要不受影响 |
| `minInterval` / `retriggerFloor` | 手动请求**不检查**；可以在冷却期内立即压缩 |
| `applyStrategy` | 手动请求**绕过**（`manualPending`），但 `idle` 边界的"agent 必须 idle"仍生效 |
| 内部 5% 收缩门槛 | 手动请求**跳过**（`/compact` 语义只要求"更小"） |
| `minShadowedTokens` | 手动请求**不检查**（只有自动触发才过这道门）；无区间时仍 resolve `null` |
| skip + 无 attached agent | 快照 skip 且会话没有 attached agent → reject `summary`（不悬挂） |
| 落盘 flush | 手动提交后 fire-and-forget `sessions.flush(session)`；不阻塞命令 resolve，失败只 warn |
| `enabled` / `dryRun` / `hookManualCompact` | 任一关闭 → 不接管，`/compact` 走原生；排队后被打开 dry-run → reject `cancelled` 并丢弃手动 READY |
| 超时 | **没有插件级 deadline**：等待安全边界/原生结束不设上限；`manualCompactTimeoutSeconds` 已删除。只有 abort/暂停/会话或插件 dispose 会提前收敛 |
| 会话/agent/插件 dispose | reject `cancelled` |
| `/precompact pause` | reject 排队/在途的手动请求（`cancelled`）、丢弃手动 READY、abort 在途手动摘要；自动任务继续 |
| 调用方 abort | 中止在途手动摘要（`abandoned` + `generation++`，晚到结果作废）并 reject `cancelled` |
| 摘要期间 invalidate（native 压缩/surface 替换） | reject `changed` 并**自动重试一次**；第二次仍失败才 reject；不留下半落地事件 |
| 提交阶段 `changed` | 自动重试一次（重新测量+快照）；第二次仍 `changed` 才 reject |

**副作用**：`/compact` 命令在等待期间一直是"运行中"状态；如果模型长时间不产生新的安全边界（例如一个很长的工具调用），命令会一直等到原生压缩/边界出现——**本插件不设超时**，只能由调用方 abort、`/precompact pause`、dispose 或会话失效收敛。这与原生"立刻在维护窗口中压缩"的体验不同，但换取的是**不阻塞主循环**。

### 2.14 自适应预测只剩 3 个可调项

第二轮收敛把自适应公式的 7 个内部调参（安全余量、耗时系数、增长/耗时默认值、突发系数、EMA、采样间隔、统计窗口）移入 `src/internal-policy.js`，配置面只剩 `minThreshold`/`maxThreshold`/`fallbackThreshold`：

- 好处：公式行为不变但参数固定，少一类"调参后触发点不可解释"的问题，也避免与后端阈值策略重复；
- 代价：过去可以按模型/负载调 `safetyMarginTokens`、`burstGrowthFactor` 等；现在需要改代码（`src/internal-policy.js`）并重新发布；
- 旧配置里的 8 个自适应键（`safetyMarginTokens`、`compressionTimeMultiplier`、`defaultCompressionSeconds`、`defaultGrowthTokensPerSecond`、`burstGrowthFactor`、`emaAlpha`、`growthSamplingInterval`、`growthWindow`）会被静默忽略，不会报错。

| 常量 | 值 |
|---|---|
| `SAFETY_MARGIN_TOKENS` | `4096` |
| `COMPRESSION_TIME_MULTIPLIER` | `1.3` |
| `DEFAULT_COMPRESSION_SECONDS` | `45` |
| `DEFAULT_GROWTH_TOKENS_PER_SECOND` | `200` |
| `BURST_GROWTH_FACTOR` | `2` |
| `EMA_ALPHA` | `0.3` |
| `GROWTH_SAMPLING_INTERVAL_MS` | `5000` |
| `GROWTH_WINDOW_MS` | `60000` |

---

## 3. 成本与计量

| 事实 | 说明 |
|---|---|
| **摘要调用真实计费** | 后台摘要走 `ctx.llm.stream()` / 后端钩子，是一次真实模型调用；不计入主上下文（`llm.stream` 不 append session 事件），但会计入 provider 账单 |
| **可能白算** | 触发后结果可能因"过期/校验失败/用户手动 /compact 抢先"被丢弃，那次调用就白花 |
| **一道门先帮忙省钱** | `minShadowedTokens`（区间太小不摘要）在**调用 LLM 之前**就短路；模型作用域已移除，不再按模型过滤 |
| **可能双算** | 若预压缩没能在原生阈值前落地，原生还会再压一次 → 同一段历史被摘要两次 |
| **无法精确计量** | 没有 tokenizer、没有 `cost` 字段；`framedTokens` 来自 `estimateMessage()` 的启发式（4 字符/token + 结构开销），与实际 token 有偏差 |
| **收益是时延不是 token** | 设计目标是把摘要耗时移出关键路径；**不承诺**节省 token（甚至可能多花一次） |
| **失败无退避** | 失败后会等到下一次满足 `minInterval`（默认 60 s）+ 阈值才会重试；`minInterval=0` 时可能反复重试烧 token |
| **回退路径上限固定** | 没有后端 `summarize()` 时用会话路由 + 常量 `FALLBACK_MAX_TOKENS=65536`；不可配置 |

**建议**：先用 `/precompact dry-run` 观察 24 小时的真实触发次数与体量，再决定是否长期开启；对成本敏感的场景把 `triggerMode` 设为 `fixed`（不预测、不提前太多）。

---

## 4. 可观测性缺口

### 4.1 只有设置卡片，没有状态面板

现在有 client 半（`client.js`），但它**只做设置**：在 `plugins.bundle.config`（Plugins → bundle 详情页）注册一张配置卡片，绑定 `pre-compact` 配置命名空间。它**不展示运行状态**：

- 卡片只读写配置（基础/固定/自适应/调度/手动 **五个分组、14 个字段**），运行状态仍只能通过 `/precompact status|list` 文本或日志查看；
- 没有"最近一次节省了多少 token / 下一次预计何时触发 / 当前 EMA"的常驻指示；
- 没有 `settings.section` 独立页、没有 `conversation.composer.dock` 状态条、没有历史/统计视图。

**优化方向（按成本）**：① `conversation.composer.dock` 小状态条（宿主已有 `ContextMeter`，只做增量信息，如"预压缩就绪/节省量"）；② `settings.section` 整页（状态 + 历史列表 + 手动触发）；③ host-only 投影 + `wire.view` 把派生值推给浏览器（`dsh-context` 的模式）。

### 4.2 `status` 不打印数据完整度与固定模式的下调信息

`statusOfState()` 里有 `dataComplete`、`derivation`、`retriggerFloor` 字段，但 `renderStatus()` 没有渲染它们（**`manualRequest` 与 `manualHook` 已渲染**：排队时多一行 `Manual request: queued <id>[ (retried once)]; waiting for a safe boundary`，另有 `Manual /compact hook: <state> (detail)`）。诊断"自适应是否在降级"看 `triggerRatio`：等于 65%（`fallbackThreshold`）才是纯 fallback，等于上一次完整预测（如 75%）可能是 warm start（`derivation.warmStartTokens` 可确认）；诊断"固定模式是否被自动下调"只能看实际 `triggerRatio` 是否明显低于 `fixedThreshold`；诊断"是否被抗抖动下限挡住"只能看 `Last skip: retrigger-floor`。`triggerReason` 在**未达标**时恒为 `below-threshold`，不会显示 `adaptive-fallback-no-data`/`adaptive-warm-start` 或 `fixed-adjusted-trigger`。

**优化方向**：在 `status` 里加一行 `Data: complete|incomplete (growth=N samples, duration=M, native=source)`，再加一行 `Fixed: requested=… trigger=… clamps=[…]`；手动请求补 `sourceCommandId`/已等待时长。

### 4.3 dry-run 的 `lastOutcome.totalBefore` 是节点数

`src/coordinator.js` 的 dryRun 分支把 `totalBefore` 写成 `session.surface.nodes.length`（节点数），而正常提交分支写的是 `validation.currentTotalTokens`（token 数）。**同名不同义**；`renderStatus()` 不展示该字段，所以只影响日志/自定义消费者。

**优化方向**：dryRun 也记录 token 数（用最近一次 `measure` 的 `totalTokens`），并另设 `nodesBefore`。

### 4.4 pause/resume/dry-run/live 不持久化

四个子命令都只改内存里的 `config`（`setEnabled`、`config.dryRun = ...`），重启即恢复配置文档的值；也没有"仅对当前会话"的粒度（全局生效）。**与插件页保存不同**：卡片写入 profile 的配置文档（持久化），命令只是临时运维开关。

**优化方向**：接 `ctx.get('configEditor').edit(...)` 做持久化（注意：官方禁止插件自己改 profile 的 patch 文件，只允许通过 configEditor），或明确保持"临时运维开关"的定位。

### 4.5 没有"预压缩已发生"的用户可见提示

`smart-compaction` 会 append 一条 `form:'notice'` 的旁白消息；本插件**不写任何非压缩事件**，所以用户在对话里看不到"刚刚做过后台预压缩"。是否要加是一条产品取舍（通知会进入 surface，占用 token，且需要与 UI 的折叠规则配合）。

### 4.6 插件页设置卡片的限制

| # | 限制 | 说明 / 规避 |
|---|---|---|
| 1 | **新增/更新 client half 后必须刷新页面** | `client.js` 是浏览器模块，只在页面 boot 或 bundle 重新加载时加载；已打开的页面不会自动出现卡片。刷新 Web 页面，或在 Plugins 页把 bundle 关闭再打开 |
| 2 | **linked bundle 的 manifest 变更需要重载条目** | `package.json` 的 `exports["./client"]`/`dsh.client` 是 Host 侧读取的 bundle 清单；链接安装下改了清单通常需要重启/重载该 bundle 行（entry restart），之后仍要刷新页面 |
| 3 | 卡片**不展示运行状态** | 卡片只改配置；状态看 `/precompact status`（触发点、占用、phase、`Last skip`、`Manual request`、`Manual /compact hook`） |
| 4 | `logLevel`、`statusCommand` 不在卡片 | 两者都只改配置文件；`logLevel` 是 volatile 且 logger 每次调用读值（改配置文件/更新后热生效），`statusCommand` 变更会重启插件（命令注册在 `apply()`） |
| 5 | 卡片字段集是**固定清单** | `FIELD_SPECS` 与 `DEFAULTS` 对齐（client 测试会断言"除 logLevel/statusCommand 外全覆盖"）；将来新增配置字段必须同步 `client.js`，否则只能改配置文件 |
| 6 | 卡片**没有压缩语义字段** | 保留区间、摘要模型、质量门槛、模型名单都由后端决定；卡片固定 **13 字段**（自适应只剩 3 个阈值、调度只剩 2 个），只做时机与异步调度（并有顶部边界说明） |
| 7 | 前端只挡明显错误 | 数值可解析/范围、`minThreshold ≤ maxThreshold`、provider/model 成对；其它 schema 规则由 Host 校验（失败时显示 `saveFailed` 或宿主错误文本） |
| 8 | 保存提交**整份卡片字段** | 每次保存为每个卡片字段生成 `set` op（不是只提交脏字段），并用 `snapshot.revision` 做并发栅栏；期间若配置文档被别处修改，`mutate` 返回 `false` 或抛错，卡片提示保存失败，刷新/重试 |
| 9 | 卡片可能根本不出现 / 只读 / 不可用 | 注册被 `ctx.configForms.whileServed(['pre-compact'])` 包裹；Host 不提供该命名空间（schema 不可解析、行被禁用/锁定）时无卡片；`getSnapshot().status` 为 `loading`/`unavailable` 或 `writable:false` 时显示占位 |
| 10 | 中英双语，主题色取自 `--dsw-*` token | 文案来自 `ctx.locale.register('preCompact', DICT)`；不覆盖宿主主题，也不 import 宿主 UI 包 |

### 4.7 状态提示（token 指示器旁）的限制

- **轮询接口没有 webserver 统一鉴权**：`GET /api/pre-compact/status` 与 DSH 既有 `webServer` 资源一样不做统一鉴权（宿主设计如此）。插件只保证**只读、聚合、同源、无缓存**：响应不含消息内容，`sessionId` 必须匹配 `[A-Za-z0-9_-]{1,128}`，带 `Origin` 且与 Host 不同源返回 403。不要把该接口当敏感数据接口。
- **固定时延/窗口**：浏览器每 **1200ms** 轮询；`done` / `failed` 只显示最近 **8s**（`DONE_WINDOW_MS`/`FAILED_WINDOW_MS`），之后回 `idle` 并**不占位**；隐藏标签页跳过请求；非 2xx/网络错误保留最后状态。
- **需要刷新页面**：新/更新 client half 后，已打开的页面不会自动出现指示器；刷新页面（或重开 bundle）后才会加载。
- **不替代完整诊断**：指示器只有 `working/ready/done/failed/idle` 五态；触发阈值、漂移、失败原因、manual hook 状态仍要看 `/precompact status`。两者数据同源（`runtime.statusFor`）。
- **依赖 Host 的 `webServer`**：没有该服务时路由不注册（debug `web server unavailable; the context-meter indicator stays hidden`），指示器自然不显示；不影响压缩。
- **表达式/可见性**：`prefers-reduced-motion` 下脉冲关闭；`role="status"`/`aria-live="polite"` 已加，但读屏器对高频轮询的提示效果未实机验证。

### 4.8 调试日志（环形缓冲 + /precompact logs + HTTP）的限制

- **缓冲不持久化**：只存在于进程内存，重启/重载插件即丢失；`logBufferSize`（默认 500）之外的最旧记录会被淘汰；缓冲清空后 `seq` 仍单调递增（不会重置）。
- **`logLevel` 只控制控制台**：缓冲记录**所有级别**（含 debug）；因此"console 没看到 debug"与"缓冲里没有"是两件事。反过来，想减少缓冲开销只能调 `logBufferSize`（`0` = 关闭并清空），不能靠 `logLevel`。
- **`logBufferSize` 负数回退默认 500，不夹 0**：负数走 non-negative 校验，warning 后用默认值；想关闭必须显式写 `0`。
- **sanitize 后不适合审计/取证**：字符串截断到 300 + `…`、数组最多 20 项、对象深度 3、Error 只留 `{name,message,code}`、`undefined` 属性丢弃。它保证内存有界，但日志不完整。
- **端点无统一鉴权**：`GET /api/pre-compact/logs` 与 DSH 其它 webserver 资源一致，不做统一鉴权；只暴露日志文本（无消息内容），参数非法 400、跨源 403、无 `webServer` 不注册。不要把端点当敏感数据接口。
- **格式/范围固定**：命令 `/precompact logs [n]` 默认 30、范围 1..200；端点默认 limit 100、范围 1..500；`level` 是**最低级别**；`sessionId` 精确匹配 `fields.session`；`sinceSeq` 排他。超出范围会被 400 或钳制（命令）。
- **调试便利不等于诊断替代**：`/precompact logs` 给结构化轨迹，但"现在到底在干什么"仍应看 `/precompact status`（阈值/漂移/phase），两者互补。

### 4.9 右侧边栏「预压缩」面板的限制

- **依赖 `sidebarRight`/`sidebarRightTabs` 服务**：服务缺失时按钮与 tab 都不注册（设置卡片/composer 指示器不受影响）；无 session 时按钮静默 no-op；**未打开 tab 时不轮询**（省请求，但也意味着打开前没有数据）。
- **入口只有会话头部按钮**：不再注册 `conversation.view`，会话视图标签栏没有「预压缩」；需要刷新页面加载新 client。
- **内存态**：`samples`（原始采样 120）/`history`（30）有界；**`steps` 全量不设上限**。都只在进程内存，插件重载/重启后清空，面板"仅统计本次加载以来"。不要把它当历史审计。
- **图表主数据是 `steps`（全量）**：每步 upsert 最后一条、按 step 升序、保留本次加载以来全部步骤；`samples` 只作旧 Host 回退。代价：长会话的内存与 `/api/pre-compact/history` 响应体会随步数持续增长；打开 tab 后每 2.5s 传输全量（未打开 tab 不轮询）。这是用户明确要求的取舍。
- **warm start 只保留最后一次完整预测**：数据不完整时复用它，但模型/窗口/`minThreshold`/`maxThreshold`/后端策略变化后可能短暂沿用旧阈值（仍受 min/max 夹取）；没有历史完整预测时才会回 `fallbackThreshold`。fixed 模式不受影响。
- **步骤只从插件加载后的 `step/start` 开始**：启动前已经发生的步骤没有记录；早期采样可能 `step=null`，面板会归入「未知步骤」或退回采样序号（`chartStepUnknown` 注释）。
- **只记录成功提交**：`history` 只在四连写成功后写入；dry-run/失败/取消不产生记录。因此"图里没有"可能只是"没成功过"。`history.step` 是**快照开始时的步骤**（不是完成时）。
- **“累计节省时间”是估算**：= Σ `history[].durationMs`（后台摘要实际耗时），含义是“这些摘要若同步执行会阻塞主 Agent 的累计时间”；**不含排队/等安全边界/轮询等待**，也不等于墙钟总收益。平均摘要耗时同源；释放 tokens = Σ max(0, shadowed−framed)。
- **窄栏布局**：面板根全宽（`width:100%; minWidth:0; padding:12px`），图表 viewBox 720×168、`width:100%; height:auto`；表格 `overflowX:auto`、状态条/统计 chips 换行。真实右侧栏宽窄/主题/读屏未实机验证。
- **固定轮询**：2500ms 一次（tab 打开/挂载立即）；隐藏标签页跳过；非 2xx/网络错误保留最后数据并显示静默错误点；不提供手动刷新按钮（刷新页面即可）。
- **依赖 Host `webServer`**：`GET /api/pre-compact/history` 与 status/logs 共用 `ctx.inject(['webServer'])`；无 `webServer` 时不注册，面板请求失败（不影响压缩）。
- **端点无统一鉴权**：与 DSH webserver 同一边界；只返回白名单聚合字段与 samples/history，不含消息内容；`sessionId` 非法 400、跨源 403。
- **有界/顺序**：超出容量淘汰最旧；同一步多次采样只画最后一条，步骤类别最多 6 个刻度；记录表只显示最近 10 条（Host 最多保留 30）。
- **图表未实机验证**：SVG 布局、窄屏、主题 token、读屏 `aria-label` 均只经离线模型测试，真实浏览器渲染未验证。

---

## 5. 兼容性与共存

### 5.1 跨版本兼容风险清单

| 依赖 | 类型 | 失效后果 | 缓解 |
|---|---|---|---|
| `session.eventAt()` / `deriveEventMessage()` | deprecated API | 无法构造区间/摘要输入 → 功能失效（不损坏会话） | 已列为首要升级检查项 |
| `ctx.compaction.summarize()` | 非契约钩子 | 自动退化为 `llm.stream()` | 内置回退 |
| 后端实例 `compactNow`（manual hook） | monkey-patch，非契约 | 冻结/改名/无该方法 → 不接管，`/compact` 走原生 | wrapper 始终 delegate + 卸载还原 |
| `engine.config.thresholdRatio/headroomTokens` | 后端实现细节 | 退化为 0.8/65536 默认值 → 自适应降级、固定模式无法自动下调 | `nativeThreshold` 显式覆盖 |
| `compaction/*` 事件 payload | 运行时无 schema 校验 | 字段写错静默失效 | 对齐原生 payload（已做） |
| `schemastery` 解析路径 | 环境相关 | 无设置表单/设置卡片（功能不受影响） | 手写校验 |
| `exports["./client"]` / `dsh.client` 清单 | bundle manifest 契约 | 缺 client half → 插件页无卡片（功能不受影响） | 刷新页面/重载 bundle；见 §4.6 |
| `plugins.bundle.config` 槽与 `configForms` 服务 | client 侧契约 | 槽/服务缺失或命名空间未 served → 卡片不注册/显示占位 | 刷新页面；检查 Host 是否提供该配置 |
| `ctx.tokenMeter.measure().nodes` 与 surface 一一对应 | 契约 | 若错位，区间选择会抛错 → 跳过压缩 | `selectCompactableRange` 显式校验 |
| `surface.contentGeneration/replaceGeneration` | 契约 | 无法检测失效 | 提交前还有 seq/定价双重校验 |

**升级 DSH 后最小验收清单**：

1. `npm test` 全绿；
2. 开 `logLevel: debug` + `dryRun: true`，跑一个真实长会话，确认出现 `background pre-compaction ready` 且 `reduction` 合理；
3. 关 dry-run，确认 `background pre-compaction applied` 的 `seqs` 连续、`total_after_estimate < total_before`；
4. 跑一次 `/compact`，确认不出现 `locked`/`busy` 竞争异常；
5. 确认 `session` 能正常重启恢复（日志不含未知事件类型错误）。

### 5.2 与 `smart-compaction` 共存

**必须二选一**。原因：

- 它无条件注册 `compact_now`/`context_status` 工具，并在 `agent/pre-step` 用 safe-point 触发 `compactRegion`；
- 本插件也在同一个事件上触发落地 → 同一 step 可能压缩两次（双倍摘要成本 + 双份 surface 替换）；
- 原生 `compactRegion` 有"同会话不允许并发压缩"的断言，两者会在锁上互相 `busy`/`REJECTED`；
- 两者的保留尾部策略可能不同（它只保留最后一个节点，等价 `retainTokens=0`；本插件的自动路径跟随当前后端策略、默认 16%），产物形态也可能不同。

当前实现**不做检测**（不读 `ctx.get('tools')` 找 `compact_now`、不告警）。避免方式：在 profile 里 `disabled: true` 掉其中一个（README 已写）。

### 5.3 多插件写压缩事件的边界

只要每个写入方都遵守四件事，多个压缩类插件可以共存：

1. 用 `compaction/start`…`compaction/end` 配对（即尊重持久锁）；
2. 提交前检查 `inspectEntryState` 的活锁；
3. replace 的 `sourceEventSeqs` 覆盖全部被遮蔽节点；
4. 不跨越 tool-pair 平衡切点。

本插件全部满足；但**它假设其它写入方也满足**。若某个插件只写 `compaction/start` 而不闭合，本插件会把它当活锁（这正确），直到 `session/end-seed` 出现才放行。

### 5.4 preset 隔离 profile

本机 profile 把压缩后端挂在 `cordis:group` + `isolate:{compaction:true}` 的 preset 组里（`C:\Users\<user>\.dsh\profiles\web\cordis.patch.yml` 的 `preset-*` 段）。本插件是**宿主平面**行：

- `ctx.get('compaction')` 在宿主平面返回 `undefined`；
- `compactionServiceOf()` 自动退到 `ctx.agentPresets.serviceFor(agent, 'compaction')`（`src/native-policy.js`）；
- 若某个 profile 既没有宿主平面 compaction、也没有 `agentPresets` 服务 → 插件保持惰性（debug 日志）。

**注意**：`agentPresets.serviceFor` 是同步调用、可能返回不同 preset 的不同实例（每个 preset 一份 `compaction-basic`），因此 `capacityCache` 与后端策略读取都要按"当前 agent"来，本插件已是这样（`resolveNativePolicy({agent})`）。

### 5.5 重启后的语义

运行时状态（增长 EMA、耗时 EMA、`ready` 结果、`lastOutcome`）**全部不持久化**：

- 重启后第一次触发一定走降级路径（`fallbackThreshold`），直到攒够 2 个增长样本 + 1 次耗时样本；
- 重启前已经准备好但未落地的摘要会丢失（下次重新摘要）；
- `pause`/`dry-run` 等运行期开关恢复为配置值；
- 排队中的**手动请求**也会丢失（Promise 随进程结束；宿主命令随之失败）。

### 5.6 与原生 `/compact` 的行为差异

| 维度 | 原生 `/compact`（`compactNow`） | 本插件接管后 |
|---|---|---|
| 摘要位置 | `agent.runMaintenance()` 内**同步**跑完 | **后台**（与自动预压缩同一流水线） |
| 对主循环/新输入 | 占用维护窗口，新输入等待；运行中 turn 报 `busy` | 不占用维护窗口；命令等待，agent 可继续工作 |
| 前置条件 | agent 必须 **idle**；`runMaintenance` 独占；`openTurn === null` | 不要求 idle；可在 turn 内落地（`turn` 可能非 `null`） |
| 同会话并发 | `assertNoActiveCompaction` / `busy` | 已有 manual → `busy`；已有自动任务/结果 → **取代**（丢弃 READY / abandon+abort 在途），按手动语义重新摘要 |
| 保留尾部 | 内部 `retainTokens=0`（只保留最后一个节点） | 默认同（固定 `retainTokens=0`，语义一致；运行中 step 以基线保留整步；无配置项） |
| 收缩门槛 | 只要求 `estimateMessage < shadowedRouteTokens` | 同（**不**额外要求内部 5% 常量，也**不**检查 `minShadowedTokens`） |
| 结果 | `CompactionResult`（`turn:null`） | 同形状 + `manual:true`（`turn` 视边界而定） |
| `sourceCommandId` | 写进 `compaction/start|end`（手动路径） | 写进 `start|summary|end` |
| 失败文案 | 宿主 `expectedFailure(error.code)` 的固定文案（`busy`/`cancelled`/`changed`/`summary`/`commit`/`persistence`） | 我们是**形状相同但不是宿主类实例**的普通 Error → 宿主 `instanceof` 判定失败，直接以 `error.message` 冒泡并记入 `command/done` |
| 超时 | 无（同步跑完） | **无插件超时**：等待安全边界/原生结束不设上限；abort/pause/dispose/会话失效才收敛 |
| 取消 | 命令 signal 中断维护任务 | 命令 signal abort → reject `cancelled`、中止在途摘要（abandoned），结果不会迟到落地；`/precompact pause` 同样取消手动请求 |
| 摘要期间被替换 | 维护窗口中同步摘要，不存在"摘要期间并发替换" | snapshot 失效 → reject `changed` 并自动重试一次；无半落地事件 |
| 关闭/降级 | — | `hookManualCompact:false` / `enabled:false` / `dryRun:true` / 实例不可写 → **原样 delegate**，行为回到原生 |

> 结论：**默认路径下 `/compact` 的"用户可见结果"不变（先阻塞等待、再看到压缩完成）**；变化的是"等待期间发生了什么"（不再占用维护窗口、不再 busy、agent 可继续工作），以及错误/无超时/`turn` 这些边角语义。

---

## 6. 当前实现中的已知瑕疵

> 这些是"可以改、当前没改"的点，不是平台限制。列出来是为了不被当成预期行为。

| # | 现象 | 位置 | 影响 | 处理建议 |
|---|---|---|---|---|
| 1 | token meter 缺失时**永久自禁用** | `coordinator.js` 的 `evaluate()`：`config.enabled = false` | 启动顺序不利时插件静默失效，`/precompact status` 显示 paused | `resume` 或重启；更好的做法是"只跳过本轮、不写 enabled" |
| 2 | 用 `error.name === 'AbortError'` 判定"取消" | `startTask()` 的 catch：`const aborted = task.signal?.aborted === true \|\| error?.name === 'AbortError'` | 若摘要器自身抛 `AbortError` 而信号并未 abort，会被记成 `CANCELLED` 而不是 `FAILED`（排查时容易误判） | 只信 `signal.aborted`；或在 `lastOutcome` 里同时记 `error.name` |
| 3 | dry-run 的 `totalBefore` 是节点数 | `applyReady()` dryRun 分支 | 字段语义不一致（见 4.3） | 改为 token 数 + 另设 `nodesBefore` |
| 4 | `status` 不展示 `dataComplete` / `derivation` | `index.js` 的 `renderStatus()` | 自适应降级、固定阈值自动下调都不直观 | 增加一行数据完整度/`clamps` |
| 5 | 失败后无专门的退避计数 | `minInterval` 只从 `lastStartAt` 起算 | 60 s 后可重试，成本可控但不够精细 | 失败时写 `lastFailureAt` 并做指数退避 |
| 6 | 自动路径提交后不 flush（手动已补） | `applyReady()` → `appendCompaction()` | 自动压缩的崩溃窗口可能丢压缩（见 2.8）；手动路径已 fire-and-forget flush | 自动路径也补 flush |
| 7 | `evaluate()` 里 `evaluateSequence` 只写不读 | `coordinator.js`（`void sequence`） | 无害的死代码 | 删除或用于乱序检测 |
| 8 | 只把 `frame` 的 `rawOutput` 透传到 `compaction/summary` | `commit.js` | 与原生保持一致；若 UI 期望其它字段需扩展 | 以原生 payload 为准 |
| 9 | 激活探针只在 info 级打一次 | `coordinator.js` 建 runtime 时的 `plugin active …` | `logLevel: warn/error` 时看不到，只能靠 `fiberPhase` 判断 | 调试期用 info/debug；或把探针改为 debug+info 双写 |
| 10 | `lastSkip` 只在"开始新任务"时清空 | `startTask()` 开头 `state.lastSkip = null`；成功评估但未启动任务的路径不清 | `/precompact status` 仍可能显示陈旧 `Last skip`（例如曾经 `range-too-small`），让人误以为当前仍被拦 | 在成功评估后也清空，或在 `status` 里带 `lastSkip.at` 时间戳 |
| 11 | 手动请求日志里的 `transport` 恒为 `'async'` | `tryManualCompaction()` 的 `transport: config.dryRun ? 'dry-run' : 'async'` | `shouldHookManual()` 已排除 dryRun，`'dry-run'` 分支不可达（无害死分支） | 删除该字段或改为真实传输信息 |
| 12 | `pruneStates()` 不把手动请求算作"活跃" | `pruneStates()` 只过滤 `active/ready/evaluating` | 超大会话集合中，仅排队手动请求的状态可能被移出 `states`（Promise 仍由 abort/dispose settle，`status` 丢失该行） | 把 `state.manual !== null` 加入保留条件 |
| 13 | manual hook 的 `ensure()` 只在 `agent/created`/`pre-step` 触发 | `src/manual-hook.js` | 若首个 `/compact` 早于这两个事件（理论边界），本次不会被接管，走原生 | 在 `compactNow` 调用点或 `agent/status` 再补一次 `ensure()` |

> **已修复（本次迭代，REPORT #1–#5 + 两轮收敛 + 独立审查，2026-11-05/06）**：① 回退摘要 payload 不再含 `undefined`；② `manualFailureOf()` 增加 `changed` 恒等映射；③ 新增 `cancelActiveManualTask()` + `state.generation` + `task.abandoned` 守卫；④ 保留策略按后端 `resolveRetention` 合并顺序对齐；⑤ 手动请求先 `supersedeAutomaticWork()`（不再复用自动 READY/在途；丢弃记 `manual-request-supersedes`），按手动语义重新摘要；⑥ checkpoint source 带 `sourceCommandId`；⑦ skip + 无 attached agent reject `summary`；⑧ 手动提交后 fire-and-forget `sessions.flush`；⑨ 未知键 warning（19 个 legacy 键静默，含 `maxConcurrent`）；⑩ 并发改为单会话固定 1/跨会话并行。另：手动 deadline 已移除、`minShadowedTokens` 对手动不生效、`DEFAULTS` 深拷贝。用例以 `npm test` 实跑为准。

> 已修复的旧瑕疵：在途任务因失效被中止时，最终 phase 现在是 `STALE` 并保留失效原因（`invalidatedReason`），不再被覆盖成 `CANCELLED`。

---

## 7. 后续优化路线

按"收益 / 成本"排序的建议路线（**均未实现**）：

### P0（稳定与自证）

1. **修正 token meter 缺失时的自禁用**（§6-1）：改为仅跳过本轮 + 连续 N 次才自禁用。
2. **升级验收自动化**：把 §5.1 的 5 条做成 `test/` 里的 headless 冒烟（需要宿主支持；`dsh-Survival-mode` 的 `headless.*.yml` 是现成范式）。
3. **自动路径也 fire-and-forget flush**（手动已做，见 §2.8）。
4. **状态补 `dataComplete`/`derivation` 一行**（§4.2）——诊断成本最低、收益最直接；同时展示固定模式的 `requestedTriggerTokens` 与 `clamps`。
5. **manual hook 缺陷修复**（§6 已修复项）——`changed` 恒等映射、abort/暂停/dispose 中止在途摘要、generation 守卫、无插件 deadline；对应回归用例见测试。

### P1（效果与体验）

6. **可选旁白**：提交成功后 append 一条 `form:'notice'` 的用户消息（照抄 `smart-compaction` 的 `source:{kind,form:'notice'}` 写法），让用户知道"刚刚发生了后台预压缩"；默认关闭。
7. **UI 状态条**：`conversation.composer.dock` 小条（就绪度/预计节省/上次结果/手动 hook 状态），不重复宿主已有的 ContextMeter。
8. **pruner 协同**（§2.6）：评估时先问 pruner "能不能无模型调用地降到阈值以下"，能则不做摘要（省一次 LLM）。
9. **图像 offload 协同**（§2.5）：投影变化但内容等价时允许落地；或 offload 后短暂静默。
10. **失败退避**（§6-5）：指数退避 + `lastFailureAt` 状态。

### P2（架构与规模化）

11. **多会话成本可视化**（§2.2）：插件不再做全局节流，可在 `/precompact status` 里显示当前进程内并发摘要数（诊断用，不作为闸门）；或在 README 给出 provider 侧限流建议。
12. **投影持久化统计**：用 `ctx.sessionProjections.register` 存"触发次数/节省 token/命中率/手动请求数"，跨 resume 累积（服务面已具备）。
13. **`ctx.jobs` 承载摘要任务**：让后台任务（含手动请求）出现在宿主的作业列表里（可查询/可取消/可读输出），而不是只存在于本插件状态。
14. **可选 `CompactionEngine` 后端**（[docs/02-design.md](02-design.md) 方案 C）：仅在用户明确要求"原生触发也不卡"时提供 preset 片段，默认不启用。
15. **阈值公式配置化**：把 `G = V·T·K + S` 的项拆成可选开关（例如禁用峰值保护、禁用耗时 EMA），便于按模型调参。
16. **继续跟随后端策略字段**：`modelPolicies` 目前只使用阈值/headroom/保留四类字段；若后端未来把更多语义放进该结构，需要同步解析（当前其它字段不参与调度）。
17. **手动 hook 的契约化替代**：改用"注册可被子类化的 compaction 后端"或向宿主提案"可注入的压缩入口"，彻底摆脱 monkey-patch（同时解决 `turn`/错误文案差异）。

---

## 附：限制速查

| 限制 | 一句话 | 规避 |
|---|---|---|
| `eventAt` deprecated | 唯一能拿 seq↔消息的 API，官方标记禁用 | 升级前跑 dry-run，见 06 |
| `summarize` 非契约 | 有回退，但提示词会漂移 | 关注 warn `no summarize() hook` |
| 手动 hook 是 monkey-patch | 包装实例方法，非契约；冻结/改名即退化为原生 | `hookManualCompact:false` 可退回原生；关注 `cannot hook …` |
| `/compact` 等待形态变化 | 不再 busy/占维护窗口，但要等安全边界；**无插件超时** | 用 abort / `/precompact pause` / dispose 收敛，或接受等待 |
| 自适应可调项收缩 | 只剩 3 个阈值；安全余量/耗时/增长/EMA/采样窗口都是内部常量 | 需要调这些只能改代码（`src/internal-policy.js`） |
| 未知配置键 | 18 个 legacy 键静默；其它未知键 warning 且不生效 | 看 `unknown config key` 警告；改回已知键 |
| 手动错误文案 | 不是宿主类实例 → 显示本插件 message | 以 `Last failure`/`command/done` 文本为准 |
| 不 flush | 手动已补；自动路径仍可能丢压缩窗口 | 等自动 flush（P0） |
| 手动取代自动 | 自动 READY 被丢弃、在途自动任务被取消，手动重新摘要 | 自动任务在跑时会多一次摘要（成本） |
| 保留量 90% clamp | 插件自保：宿主在保留 ≥ 阈值时抛错，本插件夹到 ≤90% 阈值 | 属"宁可不压也不越界"的取舍 |
| linked 无表单 | Config 只在能解析 schemastery 时生效 | 改 profile patch，或复制安装 |
| 每会话单任务 | ready 不消费就不开新任务 | `/precompact status` 看 `readyResult`，调 `applyStrategy` |
| 无全局节流 | 多会话可同时摘要；插件不排队/不限流 | 成本交给模型服务；用 `minInterval` 或后端侧限流 |
| 单条超大消息 | 尾部保留区里的巨节点压不掉 | 改后端保留策略（`retainTokens`）或用 pruner |
| 图像投影失效 | offload 会让快照作废 | 接受白算，或等 P1 协同 |
| KV 缓存 | 替换必然命中失效 | 固定模式 + 贴近原生阈值 |
| 成本 | 可能白算/双算，收益是时延 | dry-run 观察后再长期开 |
| 固定阈值自动下调 | 配置 70% 可能实际在 39% 触发 | 想严格按配置就 `autoAdjustFixedThreshold: false`（但可能来不及） |
| 白/黑名单匹配简单 | 已移除 | 模型名单不再存在；旧键静默忽略 |
| 最小收益门 | 区间 < `minShadowedTokens` 直接跳过（**仅自动**；手动不检查） | 调小该值 |
| 抗抖动下限 | 压缩后需再增长 `max(2048, 1%×C)` 才再触发 | 等增长；无配置可调（dry-run 也会设下限；手动绕过） |
| 压缩语义不可配 | 保留/摘要模型/质量门槛/模型作用域归后端；本插件不提供配置 | 改后端；内部 5% 门槛不可调 |
| 只跟随四类策略字段 | `modelPolicies` 的其它字段不参与调度决策 | 需要更多字段时补解析 |
| 无策略时回退默认 | 后端未暴露策略按 0.8/65536/16% | 与原生默认一致；可用 `nativeThreshold` 覆盖阈值 |
| 设置卡片需刷新页面 | 新装/更新 client half 后卡片不会自动出现 | 刷新页面或重开 bundle（§4.6） |
| 卡片只管配置 | 没有状态/历史视图；`logLevel`/`statusCommand` 不暴露 | 状态用 `/precompact status`；这两个字段改配置文件 |
| 卡片整份保存 | 每次保存提交全部卡片字段，revision 冲突会失败 | 刷新后重试；避免多人同时改同一行 |
| 日志缓冲不持久 | 重启/重载即丢；只保留最近 `logBufferSize` 条 | 需要留存就外部抓 `/api/pre-compact/logs` |
| 日志端点无鉴权 | 同 DSH webserver；只读日志文本 | 不要暴露到不可信网络 |
| sanitize 不完整 | 截断/深度/数组/Error 压缩，不适合审计取证 | 需要证据时另存原始控制台/外部日志 |
| `logBufferSize` 负数 | warning 后回退默认 500（不夹 0） | 想关闭写 `0` |
| 侧边栏面板内存态 | samples 120/history 30 有界；steps 全量，重载清空 | 需要长期记录就外部抓 `/api/pre-compact/history` |
| 长会话 steps 增长 | 内存与端点响应随全部步骤增长；打开 tab 后 2.5s 传全量 | 用户取舍；不需要时关闭 tab（不轮询）或重载清空 |
| warm start 沿用旧阈值 | 只存最后一次完整预测；配置/模型变化后可能短暂沿用（受 min/max 夹取） | 等新数据重建，或接受短暂旧值；fixed 不受影响 |
| 侧边栏依赖 | `sidebarRight`/`sidebarRightTabs` 缺失则不注册按钮/tab | 只影响面板；卡片/指示器照常 |
| 可视面板轮询 | 2500ms；未打开 tab 不轮询；隐藏页跳过；错误保留旧数据 | 刷新页面/等下一次轮询 |
| 图表未实机 | SVG/窄栏布局/主题/读屏仅离线测试 | 以真实浏览器为准 |
| 节省时间是估算 | Σ 摘要耗时，不含排队/等边界/轮询 | 当“等价同步阻塞时间”看，不当墙钟收益 |
| 步骤轴缺 step | 启动前步骤无记录；全无 step 时按序号/「未知步骤」 | 等下一次 `step/start`；不影响压缩 |
| 运行中手动压缩 | 只保证 **step 基线**（保留当前 step 起的节点），不保证当前 step 内已产生的模型流/工具结果可替换；step 事件缺失时回退原生 retain-0 | 用户显式请求；需要更强语义时等原生/回合结束 |
| 同步多采样 | 只画该步最后一条 | 需要完整序列用 samples 接口原始数据 |
| 设置卡片 | 只改配置、无状态面板；新装/更新后需刷新页面 | 刷新页面或重开 bundle；状态看 `/precompact status` |
| 激活不可见（低日志级） | 只有 info 探针 + `fiberPhase` | 用 info/debug 或无头 inspect 看 `include:pre-compact` |
| 跨版本 | 三处非强契约（eventAt / summarize / compactNow） | 升级验收清单 |
| smart-compaction | 必须二选一 | 停用其一 |
