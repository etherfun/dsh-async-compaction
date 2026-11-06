# 01 · 阶段一调研总报告：DSH 插件平台、会话事件模型与原生压缩

> 本文是阶段一的**结论性交付**：把 `research/02-plugin-platform.md`、`research/03-prior-art.md`、`research/04-native-compaction.md`、`research/05-session-token.md` 四份行号级明细收敛为"能/不能/怎么做"，并给出三张清单（直接可用 / 需适配 / 不可实现）。
>
> 证据约定：`别名:行号` 均可复核，别名到完整路径见 [§1.2](#12-证据路径别名)。源码来自本机 DSH 安装 `D:/SOFT/tools/dsh/resources/app.asar` 解包到 `research/extracted/`。调研工具的两个缺陷（`cordis_inspect_query` 的 `input` 序列化问题、client 探针无在线页面）见 [§1.3](#13-工具限制与未验证项)，受影响的结论本文一律标注。
>
> 与实现的关系：本文只回答"平台允许什么"；"我们怎么做"见 [docs/02-design.md](02-design.md)，"阈值怎么算"见 [docs/03-adaptive-algorithm.md](03-adaptive-algorithm.md)。

---

## 目录

- [1. 调研范围与证据](#1-调研范围与证据)
- [2. 结论速览](#2-结论速览)
- [3. 插件 API 与 bundle](#3-插件-api-与-bundle)
- [4. 配置（Config）与多会话隔离](#4-配置config与多会话隔离)
- [5. 会话事件模型与 surface](#5-会话事件模型与-surface)
- [6. 原生压缩实现](#6-原生压缩实现)
- [7. token 计量与上下文容量](#7-token-计量与上下文容量)
- [8. 快照 / 替换 / 原子提交接口](#8-快照--替换--原子提交接口)
- [9. 后台任务能力](#9-后台任务能力)
- [10. 既有先例与空白](#10-既有先例与空白)
- [11. 三张能力清单](#11-三张能力清单)
- [12. 本项目对调研结论的落地对照](#12-本项目对调研结论的落地对照)
- [13. 未验证项与风险](#13-未验证项与风险)

---

## 1. 调研范围与证据

### 1.1 范围

| 主题 | 要回答的问题 | 明细文档 |
|---|---|---|
| 插件平台 | Host 插件怎么装、`Config` 怎么声明/校验/持久化、`ctx` 有哪些能力、事件调度模式、后台任务怎么做、旁路 LLM 怎么调、日志/UI 落点 | `research/02-plugin-platform.md` |
| 既有先例 | `smart-compaction` 是否已实现"后台预压缩"、能否复用、证明了哪些接口可行 | `research/03-prior-art.md` |
| 原生压缩 | 触发点在谁身上、阈值公式、区间选择、提示词、事件序列、锁语义、成本、第三方能否复用 | `research/04-native-compaction.md` |
| 会话与 token | 事件信封/类型/surfaceOp 校验、surface 节点与 generation、派生历史读取、tool-pair 平衡、`tokenMeter` 字段、容量权威来源、投影 | `research/05-session-token.md` |

### 1.2 证据路径别名

| 别名 | 完整路径（相对仓库根） |
|---|---|
| `BASIC` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js` |
| `CORE` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-compaction/lib/index.js` |
| `BASIC_README` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/README.md` |
| `CORE_README` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-compaction/README.md` |
| `CMD` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-command-compact/lib/index.js` |
| `COMMANDS` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-commands/lib/index.js` |
| `SESS` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js` |
| `SESS_README` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-session/README.md` |
| `SURF` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js` |
| `PERSIST` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-session-persistence/lib/index.js` |
| `METER` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js` |
| `METER_README` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-token-meter/README.md` |
| `LOOP` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js` |
| `AGENT` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js` |
| `LLM` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js` |
| `PRUNER` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js` |
| `IMGOFF` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-compaction-image-offload/lib/index.js` |
| `FMT` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js` |
| `CTX` | `research/extracted/dsh/node_modules/@deepseek-ai/cordis/src/context.ts` |
| `EV` | `research/extracted/dsh/node_modules/@deepseek-ai/cordis/src/events.ts` |
| `FIBER` | `research/extracted/dsh/node_modules/@deepseek-ai/cordis/src/fiber.ts` |
| `LOG` | `research/extracted/dsh/node_modules/@deepseek-ai/cordis/src/logger.ts` |
| `TIMER` | `research/extracted/dsh/node_modules/@deepseek-ai/cordis-plugin-timer/src/index.ts` |
| `HOST_PLUGIN` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md` |
| `PRACTICES` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md` |
| `PKG_MGR` | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/README.md` |

### 1.3 工具限制与未验证项

1. **`cordis_inspect_query` 的 `input` 参数不可用**：任何带 `input` 的调用被序列化为字符串并报 `"input" must be an object`。因此 `Service.listService(service:'llm')` 的精确类型展开拿不到；本文的 `GenerateOptions` 字段表来自**两个真实调用点**（`BASIC:313-322`、`dsh-session-title-llm/lib/index.js:160-227`），不是官方类型。
2. **client 探针超时**：`client/Slots.listSubTree`、`client/Theme.listTokens` 均 10 s 超时（无在线页面）。UI 相关结论全部来自 asar 内 client bundle 源码（实现级证据），**不等于**当前页面实测 slot 树。
3. 本构建只发布 `lib/*.js`，无 `.d.ts`、无 `src/`、无 `docs/subsystems/compaction.md`。凡属"由构造点反推"的类型（`CompactionResult`、`compaction/*` payload）在明细里已标 `[推断]`。

---

## 2. 结论速览

| 问题 | 结论 | 关键证据 |
|---|---|---|
| Host 插件能纯 JS 零依赖发布吗 | ✅ 能；`apply(ctx, config)` + `dsh.bundle.patch` 是官方一等公民 | `HOST_PLUGIN:5-64` |
| 能声明 `Config` 并自动获得设置表单吗 | ✅ 能（但需要能解析 `@deepseek-ai/schemastery`） | `HOST_PLUGIN:64`、`BASIC:807-819` |
| 能读上下文用量与容量吗 | ✅ `ctx.tokenMeter.measure()`（同步、无模型调用）+ `ctx.llm.resolveModelInfo()` | `METER:723-766`、`LLM:2112-2139` |
| 能在后台跑摘要吗 | ✅ `ctx.llm.stream()` / 定时器 / `ctx.effect`；⚠️ 但不能"真正并行地打前台请求" | `LLM:2310-2399`、`TIMER:28-54` |
| 能自己做压缩的"落地"吗 | ✅ `session.append` + `surfaceOp.replace` 是公开 API；`compaction/*` 是已知事件类型 | `SESS:1518-1539`、`SESS:90-93`、`SURF:293-375` |
| 原生有"prepare/commit 分离"吗 | ❌ 没有；`compactRegion` 内部固定 `await summarize` | `BASIC:451-523`、`BASIC:972-977` |
| 原生阈值能直接读吗 | ❌ 没有导出；⚠️ 可读后端实例的 `config`（`thresholdRatio/headroomTokens/retain*`）自算 | `BASIC:125-148`、`BASIC:821` |
| 能自造会话事件类型吗 | ❌ 不能（持久化读路径拒绝未知类型） | `PERSIST:180-185`、`SESS:80-143` |
| 能替换 surface 节点 0（system）吗 | ❌ 不能，除非替换体是"只覆盖该节点的 `system/message`" | `SURF:382-391` |
| 能阻止/否决已提交事件吗 | ❌ `session/event` 是 emit（fire-and-forget） | `SESS:1586-1593` |
| 有现成的"后台预压缩"先例吗 | ❌ 没有；`smart-compaction` 只是把压缩搬到更合适的时机，仍在关键路径同步 await | `smart-compaction/index.js:196-212` |
| 第三方插件能直接写压缩事件吗 | ✅ 能，且已有生产先例（pruner 插件自己写 `compaction/prune` + replace） | `PRUNER:138-192` |
| 压缩摘要调用会计入主上下文吗 | ❌ 不计入（`llm.stream` 不 append session 事件；压力只来自 header/usage 锚点） | `LLM` 全文无 `.append(`、`METER:723-766` |

---

## 3. 插件 API 与 bundle

### 3.1 最小清单与 patch 方言

- 包清单最小形态：`name` / `version` / `type:"module"` / `exports["."]` / `dsh.bundle.patch`（`HOST_PLUGIN:5-55`，与官方模板 `templates/decoration/package.json:1-21` 一致）。
- 可选但推荐：`exports["./locale/*.json"]` 与 `exports["./icon"]` 供插件管理页在**不激活插件**时显示 `meta.title`/`meta.description`/图标（`HOST_PLUGIN:31-51`）；`files` 是打包必需，但**链接目录安装时 `files` 不生效**（`HOST_PLUGIN:35`）——本仓库 `package.json` 已按此保留 `files` 且不依赖它。
- patch 层语法（本机 profile 的 `cordis.patch.yml` 实况）：`insert` 新增行、按 `id` 覆盖 config（**整体替换**）、`disabled: true/false`、`!!js` 表达式、`cordis:group` + `isolate` 分组、`isolate: { compaction: true }` 建立独立服务作用域。层序：bundle 层 → profile patch 层 → home/invocation patch 层，后层覆盖前层（`PKG_MGR:40`）。

### 3.2 插件生命周期与 ctx 能力

| 能力 | 结论 | 证据 |
|---|---|---|
| `ctx.on` 返回 disposer、随 fiber 自动注销 | ✅ | `EV:89-96`、`FIBER:203,235` |
| `waterfall` 的嵌套顺序由注册顺序决定，`{prepend:true}` 可排到最外层 | ✅ | `EV:236-282` |
| `ctx.effect(cb, label)` 是资源归属的正确姿势 | ✅（在已停用 ctx 上建 effect 抛 `INACTIVE_EFFECT`） | `FIBER:69-101,171,355-359` |
| 可选服务用 `ctx.get()` 软取，**不要**写进硬 `inject` | ✅（硬 inject 的插件在缺服务 profile 上直接不加载） | `PRACTICES:20`、`smart-compaction/index.js:33-40` |
| `ctx.interval/timeout`（替代裸 `setTimeout`） | ✅；`ctx.setTimeout` 已 deprecated | `TIMER:4-54,18-26` |
| `ctx.logger` 四级、自动命名空间 | ✅ | `LOG:13,183-186,256-267` |
| 命令注册 | ✅ `commands.register({definitionId,name,description,handler})`（命令服务可能不存在 → 软取） | 运行时服务目录；`CMD` 同款注册 |
| 后台作业登记 | ✅ `ctx.jobs.start/list/get/read/wait/kill`（可查询、可取消） | 服务目录 `jobs` |

### 3.3 旁路模型调用（`ctx.llm`）

- **没有 `complete()`**，只有流式 `stream(options)`；服务面还有 `prepareCall/resolveModelInfo/resolveCallConfig/listModels`（服务目录 `llm`）。
- 生产级范式 A（**压缩后端自己**）：`summarizeWithLlm` 组装 `{provider, model, messages, toolHistory, tools?, maxTokens, sessionId, purpose:'compaction', signal}`，`for await (const chunk of ctx.llm.stream(options))`（`BASIC:293-345`）。
- 生产级范式 B（**纯旁路**，session 标题生成）：`ctx.llm.prepareCall({...route, maxTokens}, deadline(signal, timeoutMs))` → `call.stream({...call.config, messages, system, sessionId, purpose, signal})` → `BlockAssembler` 聚合（`dsh-session-title-llm/lib/index.js:160-227`，deadline 在 `:179`）。
- 取消语义：`finish.kind === 'aborted'` + 每 chunk `signal.throwIfAborted()`；组合取消用 `AbortSignal.any([...])`（`BASIC:990`）。
- `ctx.llm.stream` 会被 `llm/stream` waterfall 拦截 → 走官方 stream 才吃得到 retry/路由策略。

### 3.4 日志与 UI

- 日志：`ctx.logger.info/warn/error/debug`，命名空间自动加；本插件统一前缀 `[pre-compact]` + 单行 `key=value`（`src/log.js`）。
- **设置 UI 的落点（实现后更新）**：宿主为 bundle 详情页提供 `plugins.bundle.config` 槽，client 半可用 `ctx.configForms` 绑定该插件行的配置命名空间，放一张配置卡片；这比"独立 Settings 分区/自绘面板"侵入性低得多（不用 `settings.section`、不写 React 页面路由）。独立**状态**面板仍需要 `settings.section`（list/root）或 `conversation.composer.dock`（list/session），且要自带 crash 兜底、不能 import primitives、不能 iframe（`PRACTICES:33-38`）。`conversation.composer.dock` 里宿主已渲染 `ContextMeter`（`dsh-client-ui-conversation/lib/client.js:22219-22222`），做状态条要做**增量信息**。当前实现只做了配置卡片（见 `client.js`），状态仍用 `/precompact status`。
- 另：声明 `Config` 时，Plugins 页本来就会有宿主生成的配置表单（`dsh-client-ui-settings/README.md:34`）；本插件的卡片是"同一份配置文档"的另一种编辑界面，而不是第二份配置。

---

## 4. 配置（Config）与多会话隔离

| 事实 | 结论 | 证据 |
|---|---|---|
| 三种声明形态 | `export const Config`（函数插件）/ `static Config`（Service 类）/ **不声明、自己 `resolveConfig`**（零依赖，但设置页无自动表单） | `HOST_PLUGIN:57-64`、`BASIC:807-819`、`smart-compaction/index.js:179-183` |
| 校验时机 | 该行**激活时**由 Loader 校验；插件拿到的是原始值（默认值由 schemastery 填） | `HOST_PLUGIN:64` |
| 运行期持久化 | `ctx.get('configEditor').edit(ctx.fiber.entry, cur => ...)`；**插件不得读写 profile 的 `cordis.patch.yml`** | `HOST_PLUGIN:68-77` |
| 改配置会重启插件 | 普通字段改 → 插件重启；`.volatile()` 字段 → 原地更新（用 `config.x.get()` 读） | `HOST_PLUGIN:77` |
| 会话级隔离 | `Config` 是**入口级**（一行一个 config），不是会话级；per-session 状态必须自己按 `session.id` 建表，或挂 `agent.ctx` / preset `isolate` 组 | `CTX:121-125`、`PRACTICES:19` |
| 外部包解析 schemastery | 链接安装时裸 import 可能失败；需从 profile 目录/安装路径 `createRequire` 兜底 | `dsh-read-image-compress/index.js:57-77` |

**对本项目的推论**：配置保持"入口级 + 全默认值写在 bundle patch 里"；每会话状态由 coordinator 自己维护（`Map<sessionId, state>`，超过 32 个会话裁剪最久未活动的）；`Config` 采取"能解析 schemastery 就导出、否则 `undefined` + 手写校验"的双轨（`src/config.js` 的 `resolveConfig` 与 `loadConfigSchema`），这样 linked checkout 与发布安装都能工作。

---

## 5. 会话事件模型与 surface

### 5.1 事件信封与类型

- `SessionEvent = { type, seq, time, data, ignorable? }`；`seq` 恒等于日志下标（`SESS:1529-1535`、`:1531`）。
- `KNOWN_SESSION_EVENT_TYPES` 共 60 项（`SESS:80-143`）。与本项目相关：5 种 surface 事件（`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`）、`turn/*`、`step/*`、`request/header`、`request/context`、`compaction/start|summary|end|prune`。
- `append` 在提交前跑 `surfaceManager.validateNext`，提交后同步派发 `session/event`；监听器抛错被逐个捕获、不影响其他监听器、不回滚已提交事件（`SESS:1580-1600`、`:1228-1240`）。

### 5.2 `surfaceOp` 校验矩阵（写之前必须知道）

| 规则 | 证据 |
|---|---|
| 只有 5 种 surface 类型可带 `surfaceOp`，且**必须**带 | `SURF:13-19,207-218` |
| log-only 类型带 `surfaceOp`/`sourceEventSeqs` 直接抛 | `SURF:207-213` |
| `replace` 必须**恰好** 3 个键 `{op,startSeq,endSeq}` | `SURF:190-199` |
| `startSeq/endSeq` 必须指向更早事件，且在**当前 surface** 上、start ≤ end | `SURF:299-308,310-327` |
| `sourceEventSeqs` 非空、无重复、严格更早，且**必须覆盖全部被遮蔽节点** | `SURF:230-262` |
| `assistant/message` 禁止 `sourceEventSeqs` | `SURF:232-234` |
| `tool/result` 的 replace 只能改 1 个节点、只允许改 `content` | `SURF:350-375` |
| 节点 0 若是 `system/message`，只有"只覆盖该节点的 `system/message`"能替换 | `SURF:382-391` |
| **session 层不校验 tool-pair 平衡** | `SESS` 全文无相关校验；`toolPairingBalanced*` 在 `CORE:22-94` 由后端使用 |

### 5.3 surface 节点与两个 generation

- `session.surface.nodes` 是事件 seq 的有序数组（`SESS:1330-1332`）；append 追加、replace 用替换事件自己的 seq **整体顶替**区间（`SURF:433-436`）。
- `replaceGeneration` 只随 replace 递增；`contentGeneration` 随 replace **与消息投影**递增（`SURF:433-444`）。→ 这是"快照是否还新鲜"的权威判据，比只看 seq 更严。

### 5.4 派生历史读取

| 需求 | API | 证据 |
|---|---|---|
| 全部模型可见消息 | `session.deriveMessages()` | `SESS:1673-1688` |
| 单节点消息 | `session.eventAt(seq)` + `session.deriveEventMessage(event)` | `SESS:1440-1442,1695-1697` |
| 投影规则 | `user/message` 用 `data` 本身；`system/developer/assistant` 用 `data.message`；空 content → `null` | `SURF:75-106` |
| 风险 | `eventAt`/`snapshotEvents`/`ownEvents` 被标 **deprecated（新代码禁止）**，但**无等价替代**（`deriveMessages` 丢 seq，空节点投影为 null 使下标不可靠）；官方包自己仍在用 | `SESS:1433-1459`、`SESS_README:63` |

→ 本项目用 `session.eventAt(`${seq}`)` 构造摘要输入与平衡折叠，并把"该 API 若被移除"列为跨版本风险（[docs/05-limitations.md](05-limitations.md)）。

### 5.5 tool-pair 平衡

- 语义：沿 surface 顺序折叠"在途工具调用计数"（`assistant/message` 内 `tool-call` 块 +n，`tool/result` −1），`cutBalanced[i]` 表示第 i 个节点**之前**的切点是否平衡（`CORE:22-46`）。
- `toolPairingBalancedBefore(seq)` = `cutBalanced[i]`；`After(seq)` = `cutBalanced[i+1]`（`CORE:67-94`）。
- 缓存按 `session.surface.replaceGeneration` 失效；seq 不在当前 surface、找不到事件、出现孤儿 result 时抛错（`CORE:48-65,37-39,70`）。
- **已从包根导出**（`CORE:81-94`）→ 本插件可以直接复用，不必自己实现平衡数学。

---

## 6. 原生压缩实现

### 6.1 触发点

- **不在 agent-loop**：对 `LOOP` 全文 grep `compaction|compactIfNeeded|pressure` 零命中（仅无关字样）。压缩知识全在 `dsh-compaction-basic`：`constructor` 里 `resolveConfig` 后若 `auto` 则 `_registerAutomaticCompaction()`（`BASIC:827-828`）。
- 监听器挂载（`BASIC:835-889`）：
  - `agent/pre-step` → `await this.compactIfNeeded(agent, 'pressure', signal)`（`BASIC:840-853`）；
  - `agent/request-error` → 仅 `failure.code === CONTEXT_WINDOW_EXCEEDED_CODE` → `compactIfNeeded(agent,'context-overflow',signal)` 并返回 `{kind:'retry'}`（`BASIC:862-888`）；
  - `agent/status(idle)` 清空 overflow 重试计数（`BASIC:854-856`）。
- agent-loop 侧：`agent/pre-step` 是 **waterfall**，在 `preStep()` 中派发（`LOOP:903-928`，派发点 `:910`）；`agent/request-error` 在请求失败后派发（`LOOP:1137-1147`）。payload 的 `agent` 由 `agentEvents` 自动 fuse（`AGENT:243-247`）。
- 时序：`turn/start`（`LOOP:946`）→ `preStep()`（`LOOP:957`，内含 waterfall）→ `step/start`（`LOOP:971`）→ 请求。**so 原生压缩发生在当前 turn 内、当前 step 开始前，且会阻塞后续步骤。**

> 结论：**唯一自动触发是"每 step 前的 token 压力"与"提供方确认的上下文溢出"**，没有"每 N 轮/每 N 条消息"。

### 6.2 阈值公式与默认值

`resolveCompactSpec`（`BASIC:125-148`）：

```text
messageBudgetTokens  = W − O                                   # W = contextWindow；O = reservedCompletionTokens
pressureBudgetTokens = messageBudgetTokens − B                 # B = headroomTokens
thresholdTokens      = floor(min(W × thresholdRatio, pressureBudgetTokens))
retainTokens         = retainTokens ?? floor(messageBudgetTokens × retainRatio)
if (retainTokens >= thresholdTokens) throw TargetPressureConfigError
```

默认：`thresholdRatio 0.8`（`BASIC:16,67`）、`retainRatio 0.16`（`BASIC:18,68`）、`headroomTokens 65536`（`BASIC:64`）、`maxTokens = headroomTokens`（`BASIC:65`）、`compactionRetries 1`、`maxOverflowRetries 1`、`auto true`（`BASIC:83-86`）。
`O = session.requestHeader()?.config.maxTokens ?? info.defaultMaxTokens ?? 0`（`BASIC:758-760`）。

**阈值判定用的分子是 `measurement.totalTokens`**（`BASIC:942`，重测后 `:947`，收敛判断 `:959`）；**保留尾部用 `nodes[i].tokens`（路由价）**（`BASIC:419-423`）；`shadowedTokenCount` 用 `heuristicTokens`（`BASIC:577`）。

### 6.3 区间选择

`selectCompactableRange(session, measurement, retainTokens)`（`BASIC:411-434`）：

1. `firstIdx = systemHead(nodes[0]) ? 1 : 0` —— **只保护节点 0 的 system 消息**；后续 system 消息算普通历史，可被 shadow（`BASIC:397-400,416`、`BASIC_README:114`）。
2. 从尾部向前按 `nodes[i].tokens` 累加到 `retainTokens` 为止（不是"条数"）。
3. 若切点 `toolPairingBalancedBefore` 为假，`keepFromIdx -= 1` 继续扩大保留区。
4. `keepFromIdx <= firstIdx` → `null`（无可压缩区间）。
5. 返回 `{start: nodes[firstIdx], end: nodes[keepFromIdx−1]}`。

自动压力路径 `retainTokens = floor((W−O)×0.16)`；`compactNow()` 与 `context-overflow` 传 **0**（只保留最后一个节点，再被平衡规则扩大）——所以 `/compact` 比自动压缩激进得多（`BASIC:993,933`）。

### 6.4 提示词与序列化

- `COMPACTION_INSTRUCTION`（`BASIC:244-279`）是 frozen 常量，**与 `BASIC_README:191-226` 逐字一致**；末尾含"若已有 `<compacted-summary>` 块则视为 PRIOR checkpoint，合并而非照抄"。
- 替换消息框架：`CHECKPOINT_PREAMBLE`（`BASIC:281`）+ `<compacted-summary>` / `</compacted-summary>`（`BASIC:235-236`），由 `frameSummary()` 组装（`BASIC:345-357`）。
- 摘要输入 `buildSummarizationInput(session, shadowedSeqs)`（`BASIC:696-705`）：node0 `system/message` 经 `deriveEventMessage` + 每个被 shadow 的 seq 的消息（过滤 null）+ `requestHeader()?.tools`。
- 指令作为**最后一条 user 消息**追加（`BASIC:306-312`）。
- 路由三段回退：显式 `summarizationProvider+Model` → `requestHeader().config` → `AgentOptions.provider/model`；都空则抛（`BASIC:294-304`）。
- 输出约束：`maxTokens = config.maxTokens`；只保留 text 块（出现 image → `UNSUPPORTED_CONTENT`）；空摘要抛错；`finish.kind` 为 `error|aborted|max-tokens` 抛错（`BASIC:359-375,329`）。
- 收缩校验：`estimateMessage(checkpointMessage) >= shadowedRouteTokenCount` → 抛错（`BASIC:601-602`）。

### 6.5 事件序列（一次成功压缩，严格顺序）

`compactSurfaceRegion`（`BASIC:451-523`）：

| # | 动作 | 时机 | 证据 |
|---|---|---|---|
| 0 | `validateSurfaceRegion` + `inspectCompactionEntryState` + `assertCompactionInactive` | 摘要**前**同步 | `BASIC:453-455` |
| 1 | `append('compaction/start', {compactionId, sourceCommandId?, turn})` = **取锁** | 摘要**前**同步 | `BASIC:465-470` |
| 2 | `await summarize(...)` | **锁已持有** | `BASIC:479` |
| 3 | 稳定性复检（whole-surface 或 selected-span） | 摘要后 | `BASIC:471,481,610-627` |
| 4 | `append('compaction/summary', …)` | 提交阶段，无 await | `BASIC:635-650` |
| 5 | `append('user/message', checkpoint, {surfaceOp:{op:'replace',startSeq,endSeq}, sourceEventSeqs:[startSeq,summarySeq,...shadowedSeqs]})` | 紧接 4，**唯一 surface 变更** | `BASIC:651-662` |
| 6 | `append('compaction/end', …)` = 释放锁 | 提交完成 | `BASIC:485` |
| 7 | （手动路径）`await sessions.flush(session)` | 关闭之后 | `BASIC:509-513` |

失败路径：任何异常 → **恰好一次** `compaction/end{error}`（`BASIC:493-507`）；若关闭本身失败，则**故意留下未配对 start** 作为 busy 信号（`BASIC:501-506`、`CORE_README:74`）。

`compaction/summary` payload（`BASIC:635-650`）：

```text
{ compactionId, sourceCommandId?, summary: ContentBlock[], rawOutput?, llmStreamCall?,
  shadowedRange: {start,end}, shadowedSeqs: number[], shadowedTokenCount: number,
  provider, model, maxTokens?, usage? }
```

运行时**不对 `compaction/*` 的 data 做 schema 校验**（`validateSessionEventData` 只覆盖 5 种 surface 类型 + `request/header` + `tool/result`，`SESS:243-278`）——字段写错不报错，只会静默失去效果。

### 6.6 锁语义

`inspectCompactionEntryState`（`BASIC:707-735`）从日志尾部向前扫，一次性收集并提前退出（`:728`）：

- `openTurn`：最近 `turn/start` 的 `data.turn`；先遇 `turn/end` 则 `null`；
- `unmatchedCompactionStart`：最近 `compaction/start`；先遇 `compaction/end` 则无；
- `latestEndSeedSeq`：最近 `session/end-seed` 的 seq。

busy 判定（`BASIC:537-540`）：无未配对 start → 空闲；`latestEndSeedSeq > unmatchedStart.seq` → **跨进程遗留的孤儿锁，放行**；否则 `ManualCompactionError('busy')`。
`session/end-seed` 在 Session 构造时自动 append（`SESS:1428-1429`），因此"未配对 start + 之后有过 end-seed"= 上一个进程生命周期的残留。

其它硬约束：

- 自动/区域路径**必须有 open turn**：`compactRegion: no open turn — automatic compaction events must be enclosed in a turn`（`BASIC:460-463`）。
- 手动路径**必须 agent idle**：`compactNow` 走 `runMaintenance`，`phase !== 'idle'` 直接抛（`LOOP:823-824`），并被包成 `busy`（`BASIC:1009-1011`）；还要求 `openTurn === null`（`BASIC:457-459`）。

### 6.7 成本

| 项 | 内容 | 证据 |
|---|---|---|
| 输入 | node0 system + `tools` + 全部被 shadow 区域消息 + 固定指令 | `BASIC:696-705,306-312,318` |
| 输出 | ≤ `config.maxTokens`（默认 65536，含推理 token） | `BASIC:319,65` |
| 记账 | `usage` 写进 `compaction/summary.usage` | `BASIC:337,649` |
| 重试 | 收敛重试会**重复支付**（`compactionRetries` 默认 1） | `BASIC:949-960` |
| 是否计入主上下文 | **否**（`llm.stream` 不 append；压力只来自 `request/header` + `assistant/message.usage`） | `LLM` 无 `.append(`；`METER:723-766` |

---

## 7. token 计量与上下文容量

### 7.1 `measure()` 返回结构与语义

```ts
measure(session, requestHeader?): {
  logRevision, baseline: {kind:'none'|'estimated'|'usage', tokens, usage?},
  surfaceDeltaTokens, totalTokens, surfaceTokens,
  nodes: readonly {seq, tokens, heuristicTokens}[]
}
```

证据：`METER:723-766`（`structuredClone` + `deepFreeze` 在 `:758`；`totalTokens = max(0, baseline.tokens + surfaceDeltaTokens)` 在 `:762`）。

| 事实 | 结论 | 证据 |
|---|---|---|
| `nodes[i].seq` 与 `session.surface.nodes[i]` 一一对应 | 契约成立（后端自己也校验） | `METER:758`、`BASIC:415` |
| `tokens` = 路由价（含图像视觉 token），`heuristicTokens` = 与路由无关的启发式价 | 两者用途不同：选区/保留用前者，`shadowedTokenCount` 用后者 | `BASIC:419-423,577` |
| `estimateMessage(message)` 是公开的启发式定价 | 用于压缩检查点体积比较 | `METER:784-786` |
| 每次调用 O(surface) 克隆，但同步、确定、无模型调用 | 可以每步调用 | `METER_README:142` |
| 没有 `cost` 字段/货币概念 | 金额需插件自乘单价 | `METER_README:67-69` |

### 7.2 `contextPressure` 投影

```ts
state = { contextWindow?, pressureTokens?, surfaceTokens, sampledSurfaceTokens? }
view  = { contextWindow?, pressureTokens?, projectedTokens = max(0, pressureTokens + surfaceTokens − sampledSurfaceTokens) }
```

证据：`METER:453-493`。`pressureTokens` = 上次 provider 上报的 prompt token；`projectedTokens` = 下一次请求的估计。

- 服务方法 `contextPressure(session)` 只 `Pick<'pressureTokens'|'contextWindow'>`（`METER:311-312`）——要 `projectedTokens` 得走 `ctx.sessionProjections`。
- **原生阈值不用 `projectedTokens`**，只用 `measure().totalTokens`（`BASIC:942`）→ 本插件同理，只在拿 `contextWindow` 时读 `contextPressure`。

### 7.3 容量（contextWindow）的权威来源

- `ctx.llm.resolveModelInfo(provider, model, signal)` → `{ context?: { contextWindow }, defaultMaxTokens? }`（`LLM:2112-2142`；校验正整数 `:2123-2124`）。
- 容量只来自**路由所属 adapter**，不使用 `listModels()` 目录（`BASIC_README:130`）。
- 路由：`session.requestContext()`（最新一次请求的 `{provider, model, contextWindow?}`）或 `session.requestHeader().config`（`SESS:1613-1634`）。
- `request/context` 事件在 provider/model/contextWindow/systemPromptUpdate 任一变化时才写（`LOOP:1263-1272`）；`request/header` 在系列开始/变化/初始/恢复时写（`LOOP:1227-1241`）。
- 读取代价：`resolveModelInfo` 是异步（可能打 adapter），因此本插件优先读**免费的** `contextPressure().contextWindow`，再用 60 s TTL 缓存 `resolveModelInfo` 的结果（`src/native-policy.js`）。

---

## 8. 快照 / 替换 / 原子提交接口

### 8.1 可用的"快照"原语

| 原语 | 含义 | 证据 |
|---|---|---|
| `session.surface.nodes` | 当前模型可见的节点 seq 序列 | `SESS:1330-1332` |
| `surface.contentGeneration` / `replaceGeneration` | 内容/替换代数，单调递增 | `SURF:433-444` |
| `measure().nodes` | 逐节点定价快照（路由价 + 启发式价） | `METER:758-765` |
| `session.seq` | 日志长度（下一个事件的 seq），**不是** surface 长度 | `SESS:1477-1480` |
| `sessionProjections.register(...)` | 可注册自有投影（host-only 也会 checkpoint 持久化） | 服务目录；`METER:690-701` |

### 8.2 `append` 的通用约束

- `data`/`opts` 必须无损 JSON 可序列化（`SESS:1524-1527`）；随后 `validateSessionEventData`（`SESS:1536`）。
- **重入保护**：在另一个 append 的发布过程中再 append → `session append cannot reenter while another append is being published`（`SESS:1569-1573`）。→ **不能在 `session/event` 监听器里直接 append/commit**，必须排到微任务或下一个边界（本插件在 hook 里同步 commit，并在 `session/event` 回调里用 `state.applying` 守卫）。

### 8.3 第三方能否直接写压缩事件

**能**：`Session.append` 是公开 API（`SESS:1518-1539`），`compaction/*` 是已知类型（`SESS:90-93`），校验器只查 envelope 与 surface 元数据。生产先例：

- `dsh-compaction-tool-result-pruner` 是**独立插件**：自己 append `compaction/prune`（`{shadowedRange, shadowedSeqs, shadowedTokenCount}`）再 append `tool/result` 的 replace（`PRUNER:138-192`）。
- `dsh-compaction-image-offload` 是**纯外部 `apply(ctx)` 插件**：注册消息投影、监听 `agent/request-error`、监听 `compaction/summary-error` waterfall（`IMGOFF:98-152`）。

### 8.4 明确不可做的写入

| 禁止 | 原因 | 证据 |
|---|---|---|
| 自造事件类型（非 `ignorable`） | 持久化读路径抛 `SessionFormatUnsupportedError` 拒绝解释整条日志 | `PERSIST:180-185`、`FMT:185` |
| 用 `appendPluginRecord` 之外的 plugin 记录 | 该 API 只允许 `plugin:` 语法且标 `ignorable`；文档声明仓库内 experimental 专用（运行时是否拒绝外部插件未验证） | `SESS:1249-1316` |
| 替换节点 0 的系统消息 | 只允许"只覆盖该节点的 `system/message`" | `SURF:382-391` |
| 用 `assistant/message` 做聚合替换 | 禁止 `sourceEventSeqs` | `SURF:232-234` |
| 一次 replace 改多个 `tool/result` 或改 `content` 以外字段 | 显式收紧 | `SURF:350-375` |

### 8.5 checkpoint 标记

`COMPACT_CHECKPOINT_MARKER = {kind:'compact-checkpoint'}`（`CORE:110`），`compactCheckpointSource(compactionId)`（`CORE:117-131`），后端把它写成替换消息的 `source`（`BASIC:597-600`）。第三方消费者（含下一次原生压缩、UI）靠 `isCompactCheckpointSource(source)` 识别——所以自建替换消息必须带同样的 `source.kind`，才能被当作压缩产物而不是普通用户消息。

---

## 9. 后台任务能力

| 能力 | 结论 | 证据 |
|---|---|---|
| 托管定时器 | ✅ `ctx.interval(fn, ms)`（fiber 销毁自动清理）；裸 `setInterval` 不可取 | `TIMER:28-54` |
| 可取消的后台工作 | ✅ `ctx.effect` 拥有 + `AbortController` + `AbortSignal.any` | `FIBER:69-101`、`BASIC:990` |
| 可查询的后台作业 | ✅ `ctx.jobs.start/list/get/read/wait/kill` | 服务目录 `jobs` |
| "空闲期跑重活" | ✅ `agent.runMaintenance(job)`（要求 `phase === 'idle'`，否则抛） | `LOOP:823-846` |
| 在请求前插入同步逻辑 | ✅ `agent/pre-step` waterfall（但原生压缩在这里 await，会阻塞） | `LOOP:903-928`、`BASIC:840-853` |
| 真正并行且不影响前台 | ❌ 严格来说不行：`runMaintenance` 要求 idle，期间新用户输入会排队/唤醒；`llm.stream` 本身不阻塞主循环，但"同时跑前台请求 + 后台摘要"会共享 provider 配额 | `LOOP:791-846` |
| 定时器里唤醒 agent | ⚠️ 用 `agent.followup()`；`agent.inject()` 不会唤醒 | `PRACTICES:29` |
| 后台任务里 append session 事件 | ⚠️ 可以，但**不能**在 append 的发布回调里；且必须自行处理重入保护 | `SESS:1569-1573` |

> 本项目的用法：后台摘要 = 普通 async 任务（不 await 在 hook 里），用 `combineSignals([task.abort, disposeController.signal])`（优先 `AbortSignal.any`，缺失时手工合并）支持取消；定时器取 `ctx.get('timer').interval`，缺失时退回裸 `setInterval`（由 runtime 自己清理）；不使用 `runMaintenance`（会要求 idle，反而限制可用时机）。

---

## 10. 既有先例与空白

> 先例代码位置（本机 profile）：`C:\Users\q1325\.dsh\profiles\web\node_modules\smart-compaction\`（`index.js` 241 行 / `select-range.js` / `safe-point.js` / `context-status.js` / `README.md`）。下文 `smart-compaction/index.js:行号` 均指该路径。

| 插件 | 触发时机 | 摘要计算位置 | 是否后台 | 能否复用 |
|---|---|---|---|---|
| `dsh-compaction-basic`（官方） | pre-step 压力阈值 / overflow | **同步**，阻塞 `next()` | ❌ | 其后端 `summarize()` 可作为钩子复用 |
| `smart-compaction` 0.3.15 | pre-step safe point（用量 ≥ 0.5） | **同步**，阻塞 `next()` | ❌ | 不可 import（无导出面）；算法可照抄 |
| `dsh-command-compact` | 用户敲 `/compact` | 同步，要求 idle | ❌（但天然空闲） | 不适用 |
| `dsh-context` | 只读洞察 | — | — | 投影 + `wire.view` 模式可借鉴 |
| `dsh-rewind` | 只遮蔽、不摘要 | — | — | 遮蔽/替换范式可借鉴 |
| **本项目** | 空闲/边界前 | **后台**（锁外） | ✅ | — |

`smart-compaction` 的关键实现（`index.js:62-83`）：选区间 → append 一条 `form:'notice'` 的旁白 `user/message` → `await compaction.compactRegion(start, end, agent, signal)`。它的自动触发在 `index.js:187-212`：`tools/post-execute` 观察 `todo_write` 完成 → 标记 safe point → `agent/pre-step` 里 `await compactAgent(...)`。

**它证明了**：① `compactRegion` 可在回合中途调用；② `agentPresets.serviceFor(agent,'compaction')` 能取到 preset 隔离的压缩服务（`index.js:90-92`）；③ `sessionProjections.stateOf(session,'contextPressure')` 是公开用量入口；④ `surfaceOp:'append'` 的旁白消息合法；⑤ 可选服务用 `ctx.get()` 才能"缺服务也照常加载"。

**它还差什么（= 本项目空间）**：没有后台预计算、没有摘要缓存、没有 UI、没有 `Config` 表单；且 `compactRegion` 内部 `await summarize` 意味着**关键路径仍有一次完整摘要**。

> 共存结论：`smart-compaction` 会无条件注册 `compact_now`/`context_status` 工具并在 pre-step 压缩；与本插件并存会双重压缩（且 `compactRegion` 有并发断言）。**必须二选一**，README/limitations 已写明。

---

## 11. 三张能力清单

### ✅ 官方 API 直接可用（无需 hack）

| # | 能力 | 本项目用途 | 证据 |
|---|---|---|---|
| 1 | Host 插件 + bundle 清单（`dsh.bundle.patch`、`exports`、`locale`、`icon`） | 打包与安装 | `HOST_PLUGIN:5-55` |
| 2 | `export const Config`（schemastery）+ 激活期校验 | 配置表单/校验（可选路径） | `HOST_PLUGIN:64`、`BASIC:807-819` |
| 3 | `ctx.effect` 资源归属与卸载清理 | runtime 释放、命令注销 | `FIBER:69-101,203,235` |
| 4 | `ctx.interval`（替代裸 `setTimeout`） | 5 s 采样 tick | `TIMER:28-54` |
| 5 | `ctx.on` + `waterfall/serial/emit` 语义 | 6 个宿主事件接线（session/event、session/disposed、agent/pre-step、agent/turn-stopping、agent/status、agent/disposed） | `EV:43-105,236-282` |
| 6 | `ctx.logger` 四级 | 诊断日志 | `LOG:13,256-267` |
| 7 | `ctx.tokenMeter.measure()` / `estimateMessage()` / `contextPressure()` | 压力、定价、容量 | `METER:723-786,453-493` |
| 8 | `ctx.llm.resolveModelInfo()` / `prepareCall()` / `stream()` | 容量兜底、回退摘要 | `LLM:2112-2142,2310-2399` |
| 9 | `session.append` + `surfaceOp.replace` + `sourceEventSeqs` | 四连写落地 | `SESS:1518-1539`、`SURF:230-327` |
| 10 | `compaction/*` 已知事件类型 | 复用压缩语义与锁 | `SESS:90-93` |
| 11 | `toolPairingBalancedBefore/After`（包根导出） | 切点平衡 | `CORE:81-94` |
| 12 | checkpoint source 标记 `{kind:'compact-checkpoint'}` | 让消费者识别摘要 | `CORE:110-131`、`BASIC:597-600` |
| 13 | `session.surface.nodes` / `contentGeneration` / `replaceGeneration` | 快照与失效判据 | `SESS:1330-1332`、`SURF:433-444` |
| 14 | 压缩服务双路取用（`ctx.get('compaction')` / `agentPresets.serviceFor`） | 兼容 preset 隔离 profile | `smart-compaction/index.js:90-92` |
| 15 | `commands.register` | `/precompact` | 运行时服务目录 |
| 16 | locale/icon 元数据（插件管理页的标题/描述/图标，不需要激活插件即可读） | 插件管理页显示 | `HOST_PLUGIN:31-51` |

### ⚠️ 需适配 / 有条件可用

| # | 能力 | 适配方式 | 风险 |
|---|---|---|---|
| 1 | 原生阈值（`resolveCompactSpec` 未导出） | 读后端实例 `config`（`thresholdRatio/headroomTokens/retain*`）并按同一公式自算；`nativeThreshold` 可覆盖 | 后端换实现 → 回退 0.8/65536 默认值 |
| 2 | 区间选择（`selectCompactableRange` 未导出） | 用导出的 `toolPairingBalancedBefore/After` 复刻 ~25 行算法 | 后端改算法 → 行为漂移（但语义上仍合法） |
| 3 | 摘要复用（`summarize()` 非契约钩子） | 优先调用；异常/缺失时退回 `ctx.llm.stream()` + 逐字相同提示词 | 跨版本可能移除；回退路径质量略降 |
| 4 | `eventAt` 已被标 deprecated | 唯一可行路径（无替代）；把风险写入 limitations | 未来版本移除 |
| 5 | `Config` 依赖 schemastery 裸 import | 先 `import`，失败再按 `DSH_PROFILE_DIR`/`DSH_HOME` `createRequire`；仍失败则 `undefined` + 手写校验 | linked checkout 无表单 |
| 6 | 每会话状态 | 自己维护 `Map<sessionId,state>`（平台 Config 是入口级） | 无（已实现） |
| 7 | 快照一致性 | 自己比 `contentGeneration` + `replaceGeneration` + 逐节点定价（原生 `assertWholeSurfaceUnchanged` 不可用） | 比原生更严，误拒概率略高 |
| 8 | 压缩服务可能只在 preset `isolate` 组内 | 双路取服务（host 优先，agentPresets 兜底） | 取不到 → 保持惰性 |
| 9 | 命令注册表可能不存在 | `ctx.get?.('commands')` 软取，缺失则不注册 | 无命令入口 |
| 10 | 后台任务生命周期 | `AbortController` + `ctx.effect` + `ctx.interval`；不依赖裸定时器 | 无 |
| 11 | 独立 UI 面板 | 一期不做；声明 Config 已有自动表单；`settings.section`/`composer.dock` 列为后续 | 无状态可视化 |
| 12 | 全局并发/会话级并发 | 平台无原语；本插件只保证**单会话串行**（每会话 1 在途 + 1 待落地），跨会话不做全局节流（无 `activeTasks`/`maxConcurrent`） | 无 |
| 13 | 让 `/compact` 也异步化 | 命令按名称唯一、无替换 API，只能**包装后端实例的 `compactNow`**（monkey-patch） | 非契约；后端冻结/改名即退化（wrapper 仍 delegate） |

### ❌ 不可实现 / 明确禁止

| # | 不可做 | 原因 | 证据 |
|---|---|---|---|
| 1 | 自造 session 事件类型 | 持久化读路径拒绝未知类型（除非 `ignorable`，而实时 append 无法设） | `PERSIST:180-185`、`PRACTICES:21` |
| 2 | 替换节点 0 的系统消息 | session 层显式限制 | `SURF:382-391` |
| 3 | 让 `compactRegion` 使用外部预算好的摘要 | 没有该参数，`summarize` 是内部固定调用 | `BASIC:479,900-904` |
| 4 | 再挂一个 `compaction` 服务 | 固定服务名单例；一个 context 一个实现 | `CORE:161-174` |
| 5 | 在 `session/event` 监听器里 append | 重入保护直接抛 | `SESS:1569-1573` |
| 6 | 真正的"并行后台 LLM 而不影响前台" | `runMaintenance` 要求 idle；provider 配额共享 | `LOOP:823-846` |
| 7 | 否决/阻止已提交事件 | `session/event` 是 emit | `SESS:1586-1593` |
| 8 | 精确 token 计费/成本 | 无 tokenizer、无 `cost` 字段，只有启发式 | `METER_README:67-69,141` |
| 9 | 用 `projectedTokens` 做阈值 | 它是 UI 估计，system 重写会被折叠为 0 delta | `METER_README:144` |
| 10 | 插件读写 profile 的 `cordis.patch.yml` | 官方明文禁止 | `HOST_PLUGIN:68` |
| 11 | import `@deepseek-ai/dsh-client-ui-*` 当模块 | 会被打包/沙箱拒绝，且破坏主题 | `PRACTICES:35` |
| 12 | Host 出 HTML + iframe 嵌入页面 | 拿不到主题/locale | `PRACTICES:33` |
| 13 | `ctx.llm.complete()` | 不存在，只有 `stream()` | 服务目录 |
| 14 | 单条超大消息的"无破坏压缩" | 一个 tool-call/result 对即单节点，无法在不破坏配对的前提下拆分 | `BASIC_README:245`、`CORE:9-18` |
| 15 | 替换/注销宿主已有的 `/compact` 命令 | 命令注册按名称唯一（重名抛错），注册表只提供 `register`，没有替换他人命令的 API | `COMMANDS:89,266-268`；`CMD:94-96` |

---

## 12. 本项目对调研结论的落地对照

| 调研结论 | 代码落点 | 说明 |
|---|---|---|
| 原生阈值公式（§6.2） | `src/native-policy.js` `resolveNativePolicy()` | 读后端 `config`，同公式复算；`nativeThreshold` 可覆盖 |
| 区间选择与 system 头保护（§6.3） | `src/surface.js` `selectCompactableRange()` | 完全同算法（尾部按路由价累加 + 平衡回退 + firstIdx） |
| tool-pair 平衡（§5.5） | `src/surface.js` `toolPairingBalancedBefore/After()` | 自实现等价折叠（缓存按 `replaceGeneration` 失效），**不** import 宿主包（linked 安装限制） |
| 摘要提示词与检查点框架（§6.4） | `src/surface.js` `COMPACTION_INSTRUCTION` / `CHECKPOINT_PREAMBLE` / `createCheckpointMessage()` | 逐字复制，保证 `<compacted-summary>` 续接规则兼容 |
| 后端 `summarize()` 钩子（§9/§11-⚠️3） | `src/summarizer.js` `runSummarization()` | 首选；缺失时 `ctx.llm.stream()` 回退 |
| 四事件提交与锁（§6.5/§6.6） | `src/commit.js` `appendCompaction()` / `inspectEntryState()` | 同序列、同 payload 形状、同失败闭合策略 |
| 快照一致性（§8.2） | `src/snapshot.js` + `validateCommit()` | generation + 逐节点定价双重校验（比原生更严） |
| 重入保护（§8.2） | `src/coordinator.js` `onSessionEvent` 的 `state.applying` 守卫 | commit 期间事件回调直接返回 |
| 后台任务托管（§9） | `src/coordinator.js` `startTimer()`/`dispose()`/`combineSignals()` | 定时器先取 `ctx.get('timer').interval`，缺失退回裸 `setInterval`；取消信号优先 `AbortSignal.any` |
| 事件接线（§3.2） | `index.js` `apply()` | 6 个事件 + 可选命令 |
| 配置双轨（§4） | `src/config.js` + `src/config-schema.js` | 能解析 schemastery 则有声明式 Config，否则手写校验；行为字段 `.volatile()`，`apply()` 用 `unwrapConfigRefs()` 解包 |
| 设置卡片（§3.4 + 实现契约） | `client.js` + `src/coordinator.js` `applyConfig()` | `plugins.bundle.config` 槽 + `ctx.configForms` 绑定 `pre-compact` 命名空间；保存经 `form.mutate(ops, revision)` 写配置，Host 收到 `loader/volatile-update` 后原地应用 |
| 压缩语义归属（落地时的边界收敛） | — | 实现时已把保留区间/摘要模型/质量门槛/模型作用域交还当前压缩后端（见 [02 §1.4](02-design.md#14-契约边界异步调度层-vs-压缩语义层)），本插件只保留时机与异步调度配置 |
| 模型作用域（历史调研项，已在边界收敛中移除） | — | 实现不再按 provider/model 过滤（`routeAllowed`/名单配置已删除；`routeUsable()` 仅判断路由非空，运行时未使用） |
| 固定阈值的可落地性（§6.2 阈值公式） | `src/policy.js` 固定分支 | `autoAdjustFixedThreshold`：配置阈值 ≥ 原生阈值时下调到 `N − max(4096, 2%N)`，下限 `5%C` |
| 最小压缩收益（§6.2/§6.3） | `src/snapshot.js` | `!manual && shadowedRouteTokens < minShadowedTokens` 时跳过（`range-too-small`）；手动请求不受此门限制 |
| 抗抖动（运行期调度） | `src/coordinator.js` `retriggerFloor` | 落地/干跑后设下限（落地后估算 + max(2048, 1%C)），未涨回下限不再触发（`retrigger-floor`） |
| 手动 `/compact` 异步化（§3.2 事件 + §11-⚠️13） | `src/manual-hook.js` + `src/coordinator.js` `tryManualCompaction()` | `/compact` 的 handler 只调 `ctx.compaction.compactNow`（`CMD:56`）；包装该实例方法，转成"排队 → 后台摘要 → 边界四连写"，Promise 落地后 resolve 宿主形状 `CompactionResult` |
| 保留尾部策略（§6.2） | `src/native-policy.js` | 用**插件自己的** `retainRatio`，后端值仅诊断（`backendRetainRatio/backendRetainTokens`） |
| 旁白/状态 UI 不做（§3.4） | — | 无状态面板；配置已由 `plugins.bundle.config` 卡片覆盖，状态仍用 `/precompact` 文本 |
| 与 smart-compaction 共存（§10） | 不做检测 | README/limitations 要求二选一 |

---

## 13. 未验证项与风险

调研阶段明确未闭合、需要在运行态或后续版本复核的条目（**不要当成已验证事实**）：

1. **`CompactionResult` / `compaction/*` payload 的字段类型**：本构建无 `.d.ts`，由构造点反推（`BASIC:629-682,635-650`）。
2. **`ctx.compaction.summarize()` 的稳定性**：运行时存在，但文档把它描述为"子类钩子"，**不是公共 API**；跨版本可能变化（本插件有回退路径）。
3. **`eventAt`/`snapshotEvents` 被移除的时间表**：当前只是 deprecated 标记 + 仓库内 lint 政策。
4. **本 profile 中 `agent/pre-step` 的 listener 实际嵌套顺序**：原生 `compaction-basic` 与本插件的相对次序由 loader 顺序决定；`{prepend:true}` 可调整（`EV:236-282`）。需实测确认"同 step 内不会双压缩"。
5. **自定义 `message.source.kind`（`compact-checkpoint`）在 adapter 渲染时是否被接受**：session 恢复校验只要求 `kind` 非空字符串 + `content` 是数组（`SESS:1195-1220`），adapter 侧未验证。原生用同一个 kind，风险低。
6. **`purpose:'compaction'` / `sessionId` 在适配器与遥测层的消费**：`dsh-llm` 运行时未读取这两个字段（grep 无命中）。
7. **`appendPluginRecord` 的 `packages/experimental/` 门禁是否存在外部插件运行时校验**：从文档看是仓库 CI 门禁（本插件不使用它）。
8. **客户端 UI 是否按 `isCompactCheckpointSource` 渲染"已压缩"提示**：未检查 `dsh-client-ui-*`。
9. **`auto:false` 时是否仍响应 `context-overflow`**：从 `BASIC:828` 看整个自动注册块都不挂载 → `[推断]` 已关闭，需实测。
10. **`SessionStartSource='clear'` 的产生方**：解包内找不到写入点。
11. **`ctx.sessionProjections.register` 的 host-only unit 是否随 cache 落盘**：服务描述称"every persisted unit"，未实测（本插件未使用投影持久化）。
12. **plugin-manager 安装带本地绝对路径的 bundle**：已实测可行——`plugin_manager install_bundle` 传绝对路径 `F:\dev\GitHub\dsh-pre-compact` 会把它装成 profile 的 link 依赖（`@local/dsh-pre-compact 0.1.0 <- F:\dev\GitHub\dsh-pre-compact`），Loader 行 `include:pre-compact` 的 `fiberPhase=active`（见 [docs/06-verification.md](06-verification.md) §1）。
13. **`ctx.jobs` 是否适合承载摘要任务**：本插件未使用（自己管理 AbortController），是否注册作业可获得 UI 可见性未评估。
14. **后端实例 `compactNow` 的跨版本稳定性**：manual hook 依赖它（`dsh-command-compact` 固定调用 `ctx.compaction.compactNow`），但它不是契约 API；后端冻结实例、改名或改为其它入口时，wrapper 会静默不接管/退化为原生（日志见 [docs/05](05-limitations.md) §1.6）。

> 这些条目在 [docs/06-verification.md](06-verification.md) 中留了对应的待填槽位。
