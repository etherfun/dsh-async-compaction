# 05 · 会话事件模型与 token 计量（surface / seq / tokenMeter / projections）

阶段一架构调研 · 面向"后台上下文预压缩"插件的可编码事实集。

## 0. 证据约定

- 源码根：`research/extracted/dsh/node_modules/@deepseek-ai/<pkg>/…`（asar 内 `dsh/node_modules/…`）。
  下文简写为 `<pkg>/lib/index.js:行号`，例如 `session/lib/index.js:1518`。
- 运行时契约证据写作 `inspect: Service(sessions).methods[append]` / `inspect: Event(session/event)`，
  指本次会话用 `cordis_inspect_query`（host/Service、host/Event）取到的真实签名，不是从源码推测。
- 未在本版本源码中闭合、只能靠运行时确认的结论，一律标注 **需运行时验证**。
- 反编译 JS 保留行号，但原始 `.ts` 已被剥离；类型声明以 inspect 返回的 `referencedTypes` 为准（与源码一一对应）。

包名缩写：`session` = `@deepseek-ai/dsh-session`，`compaction` = `dsh-compaction`，
`compaction-basic` = `dsh-compaction-basic`，`meter` = `dsh-token-meter`，`llm` = `dsh-llm`，
`loop` = `dsh-agent-loop`，`pruner` = `dsh-compaction-tool-result-pruner`，
`persistence` = `dsh-session-persistence`。

子路径文件简写：`surface.js` = `session/lib/types/surface.js`，`types.js` = `session/lib/types/types.js`，
`tool-pairing.js` = `compaction/lib/types/tool-pairing.js`，`events.ts` = `cordis/src/events.ts`
（cordis 源文件，已用 `scripts/asar-get.cjs` 取出）。

---

## 1. Session 事件模型

### 1.1 `SessionEvent` 信封

```ts
// inspect: Service(sessions) → referencedTypes[SessionEvent]
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K;
    seq: SessionSeq;      // 0-based 连续整数，== 该事件在日志中的下标
    time: number;         // Date.now()
    data: SessionEventMap[K];
    ignorable?: true;     // 只有未知类型/插件记录用它做"可跳过"标记
  } & (K extends SurfaceEventType
      ? SurfaceIntent<K>                                  // { surfaceOp } & { sourceEventSeqs? }
      : { surfaceOp?: never; sourceEventSeqs?: never });  // log-only：两者都禁止
}[T];
```

运行时构造点 `session/lib/index.js:1529-1535`（`deepFreeze({type, seq, time, data, ...surfaceMetadata})`），
`seq` 恒等于 `log.length`（`session/lib/index.js:1531`），因此**信封 seq = 日志下标 = 该事件序号**，三者同一。
`SessionSeq` / `SessionLogOffset` 都是"非负安全整数"品牌类型，运行时就是普通 number
（`session/lib/types/types.js:15-20, 26-31`；类型定义 `inspect: Service(sessions) → SessionSeq`）。
当前格式版本 `SESSION_FORMAT_VERSION = 4`（`session/lib/types/types.js:54`、`session/lib/index.js:57`）。

**关键后置事实**：`seq` 是"提交成功才分配"的，`append()` 在写入日志前先跑 `surfaceManager.validateNext(event)`，
提交后 `push` 并同步派发 `session/event`（`session/lib/index.js:1580-1600`）。
监听器抛错被逐个捕获，不影响其他监听器，也不回滚已提交事件（`collectSessionCallbacks` `:1228`、
`invokeContainedSessionObservers` `:1232-1240`）。

### 1.2 事件类型全集

`KNOWN_SESSION_EVENT_TYPES`（60 项，`session/lib/index.js:80-143`）是本 build 能解释的全部 `SessionEventMap` 成员。
只挑与本插件相关的：

| 分组 | 类型 |
|---|---|
| surface（产生模型消息） | `system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result` |
| 轮/步边界 | `turn/start`、`turn/end`、`step/start`、`step/end` |
| 请求信封 | `request/header`、`request/context` |
| 工具 | `tool/call`、`tool/result`、`tool/ptc-dispatch`、`tool/ptc-dispatch-start` |
| 压缩 | `compaction/start`、`compaction/summary`、`compaction/end`、`compaction/prune` |
| 图像/其他投影 | `image/offload`（唯一的 `MESSAGE_PROJECTION_EVENT_TYPES`，`session/lib/index.js:145`） |
| 模型尝试 | `assistant/attempt`、`llm/retry`、`llm/retry-started` |

各载荷（节选，来自 inspect `SessionEventMap` 与写入点）：

```ts
'turn/start'   : { turn: number }                       // loop:946
'turn/end'     : { turn: number; reason: TurnEndReason } // loop:1030
'step/start'   : { turn: number; step: number }          // loop:971
'step/end'     : { turn: number; step: number }          // loop:995
'user/message' : UserMessage                             // data 就是消息本身，不再包一层
'developer/message': { turn; step; message: DeveloperMessage; headerSeq?: SessionSeq }
'system/message'   : { turn; step; message: SystemMessage }
'assistant/message': { turn; step; message: AssistantMessage;
                       stream: AssistantStreamRecord[]; usage?: TokenUsage; interrupted?: true }
'assistant/attempt': { turn; step; stream: AssistantStreamRecord[] }   // log-only
'tool/call'    : { turn; step; callId: ToolCallId; name: string; arguments: string }
'tool/result'  : { turn; step; message: ToolResultMessage;
                   error?: { name; code; reason? }; meta?: JsonValue }
'request/header': { header: EpochHeader; reason: 'initial'|'resume'|'change'|'series'; startsSeries?: true }
'request/context': { provider: string; model: string; contextWindow?: number;
                     systemPromptUpdate?: 'in-history' }
```

`Message` 结构（`llm/lib/index.js:30-113`）：`{ id, role, source, content: ContentBlock[], … }`，
`ContentBlockMap` = `text | reasoning | image | file | tool-call | tool-addition | tool-removal`。
`UserMessage` 的 `source` 只需 `{ kind: string }`（`session/lib/index.js:1195-1207` 的恢复校验只要求 `kind` 非空字符串 + `content` 是数组），
所以插件可以给替换消息打自己的 `source.kind` 标记；`system/message` 必须是 `kind:'system-prompt'`，
`assistant/message` 必须 `kind:'model'` 且带 provider/model，`tool/result` 必须 `kind:'tool'` 且 `toolCallId === source.callId`。

### 1.3 `surfaceOp` 合法形态

```ts
// inspect: Service(sessions) → SurfaceOp / SurfaceIntent
export type SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq };
export type SurfaceIntent<T> = { surfaceOp: SurfaceOp }
  & (T extends 'assistant/message' ? { sourceEventSeqs?: never } : { sourceEventSeqs?: SessionSeq[] });
```

校验矩阵（全部在 append 提交前执行，抛错即拒绝且日志不变）：

| 规则 | 实现 | 证据 |
|---|---|---|
| 只有 5 种 surface 类型可带 `surfaceOp` | `SURFACE_EVENT_TYPES` | `session/lib/types/surface.js:13-19` |
| surface 类型**必须**带 `surfaceOp`，缺则抛 | `surfaceOpOf` | `surface.js:215-218` |
| log-only 类型带 `surfaceOp` 或 `sourceEventSeqs` 抛错 | `surfaceOpOf` | `surface.js:207-213` |
| replace 对象必须**恰好** 3 个键 `op/startSeq/endSeq` | `isReplaceOp` | `surface.js:190-199` |
| `startSeq`/`endSeq` 必须 < 当前事件 seq（只能指向更早事件） | `validateSurfaceMetadata` | `surface.js:299-308` |
| `startSeq`/`endSeq` 必须是**当前 surface 上存在的节点 seq**，且 start 位置 ≤ end 位置 | `replacementRange` | `surface.js:310-327` |
| `sourceEventSeqs` 非空、无重复、严格指向更早事件 | `assertSourceEventReferences` | `surface.js:230-258` |
| replace 的 `sourceEventSeqs` 必须**覆盖全部被遮蔽节点** | 同上 | `surface.js:259-262` |
| `assistant/message` 禁止 `sourceEventSeqs` | 同上 | `session/lib/types/surface.js:232-234` |
| `tool/result` 的 replace 只能改 1 个节点，且只允许改 `message.content` | `assertToolResultRewrite` | `session/lib/types/surface.js:350-375` |
| surface 节点 0 若是 `system/message`，只有"覆盖该单节点的 system/message"能替换它 | `assertSystemHeadRewrite` | `session/lib/types/surface.js:382-391` |

> 注意：`replace` 的 `startSeq/endSeq` 是**事件 seq**，不是节点下标；它们恰好也是 surface 顺序上的左右端点
> （`nodes.indexOf(op.startSeq)`，`surface.js:311-318`）。

### 1.4 surface 节点如何定位

- surface 是一组**事件 seq 的有序数组**：`Session.surface.nodes: readonly SessionSeq[]`
  （`session/lib/index.js:1330-1332`；`session/lib/types/surface.js:535-540`）。
- `append` → `state.nodes.push(event.seq)`（`surface.js:433`）；
  `replace` → `state.nodes.splice(startIdx, endIdx-startIdx+1, event.seq)`（`surface.js:436`）。
  即：**替换后原区间的所有节点被"替换事件自己的 seq"这一个节点取代**，位置落在 startIdx 上。
- 两个单调计数器：`replaceGeneration`（仅 replace 递增，`surface.js:437`）、
  `contentGeneration`（replace + 插件消息投影都递增，`surface.js:438, 444`）。
  两者是插件判断"我准备期间的 surface 有没有变"的权威依据。
- 空内容的 `system/message` / `developer/message` / `assistant/message` 仍是 surface 节点，但投影为 `null`、不产生消息
  （`surface.js:88-97`）。

### 1.5 log-only（不产生消息）类型

`turn/start|end`、`step/start|end`、`request/header`、`request/context`、`tool/call`、`assistant/attempt`、
`compaction/*`、`image/offload`、`session/end-seed` 以及所有其余类型 → `deriveEventMessage` 返回 `null`
（`surface.js:101-105`）。它们**不得**携带 `surfaceOp`/`sourceEventSeqs`。
唯一例外：未知类型 + `ignorable: true` 的记录允许携带不透明元数据但不改变 surface（`surface.js:205-206`）。

> 运行时硬校验（比注释更权威）：持久化读取遇到"未知类型且未标 `ignorable`"会抛
> `SessionFormatUnsupportedError` 并**拒绝解释整条日志** —— `session-persistence/lib/index.js:180-185`。
> 这就是"插件不能自造事件类型"的根因。

---

## 2. 派生历史与插件侧读取

### 2.1 `deriveMessages()` 的投影规则

```ts
// inspect: Service(sessions) → Session.deriveMessages(): Message[]
deriveMessages(): Message[]   // 实现 session/lib/index.js:1673-1688
```

规则（`deriveEventMessage`，`session/lib/types/surface.js:75-106`）：

| 事件类型 | 派生结果 |
|---|---|
| `user/message` | `event.data` 本身（不再解包） |
| `system/message`、`developer/message`、`assistant/message` | `event.data.message`；若 `message.content.length === 0` → `null` |
| `tool/result` | `event.data.message` |
| 其他（含 log-only、插件投影未命中的未知类型） | `null` |

- 顺序 = `surface.nodes` 顺序；被 replace 弄空的节点不出现。
- 缓存：按 `contentGeneration` 失效；纯尾部追加只投影新节点 O(新节点)，replace/投影会整体重建
  （`session/lib/index.js:1676-1686`）。
- 返回**新数组**，但数组里的 `Message` 是共享的、深冻结对象（`session/lib/index.js:1665-1671`）。

### 2.2 插件侧枚举当前 surface（可编码配方）

```js
// 1) 全部 surface 节点 seq（模型可见顺序）
const nodes = session.surface.nodes;                       // readonly SessionSeq[]

// 2) 逐节点取消息（角色 / 内容 / id）
for (const seq of nodes) {
  const event = session.eventAt(seq);                      // SessionEvent | undefined
  if (!event) continue;
  const message = session.deriveEventMessage(event);        // Message | null（已应用插件投影）
  if (!message) continue;                                   // 空 system/developer/assistant
  // message.role: 'system'|'developer'|'user'|'assistant'|'tool'
  // message.content: ContentBlock[]；message.id / message.source
}

// 3) 只要模型历史（无 seq 映射）
const messages = session.deriveMessages();
```

- `eventAt(seq)` 见 `session/lib/index.js:1440-1442`，`deriveEventMessage` 见 `:1695-1697`。
- ⚠️ `eventAt` / `snapshotEvents` / `ownEvents` 在本仓库被标记为 **deprecated（新代码禁止调用）**
  （`session/lib/index.js:1433-1449`，`session/README.md:63`）。
  该禁令是**仓库内 lint 政策**，不是运行时限制；`compaction-basic`、`pruner`、`meter` 等官方包至今仍在内部使用
  （如 `compaction-basic/lib/index.js:398`、`pruner/lib/index.js:141`、`meter/lib/index.js:801`）。
  插件侧如需"seq ↔ message"的精确映射，没有非废弃替代：`deriveMessages()` 丢 seq，
  且空内容节点投影为 `null` 使下标无法可靠对齐。**结论：插件用 `eventAt` 是唯一可行路径**，
  若要规避风险，可只依赖 `session.surface.nodes` + `session.surface.contentGeneration` 做变化检测，
  把消息正文读取限制在少数替换点。**需运行时验证**：该 deprecated 标记是否会在未来版本移除方法本体。

### 2.3 `session.seq` 语义

```ts
get seq(): SessionLogOffset    // == 日志长度 == 下一个事件的 seq
```
`session/lib/index.js:1477-1480`。**注意它不是 surface 节点数**；surface 长度是 `session.surface.nodes.length`。
`isOwnSeq(seq)`、`inheritedEventCount`、`firstLiveSeq`、`firstLifecycleSeq` 用于区分 fork 继承段与自身段
（`session/lib/index.js:1343-1367, 1466-1476`）。

### 2.4 事件订阅方式（Cordis 侧，已 inspect 验证）

```ts
// inspect: Event(session/event)   mode = 'emit'
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
// inspect: Event(session/created) mode = 'emit'
'session/created'(this: Scoped<Session>, session: Session): void
// inspect: Event(session/disposed) mode = 'emit'
'session/disposed'(this: Scoped<Session>, session: Session): void
// inspect: Event(session/flush)  mode = 'parallel'
'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void
```

订阅方式：`ctx.on('session/event', (session, event) => { … })`。派发点 `session/lib/index.js:1586-1593`
（`collectSessionCallbacks(entry.emitCtx, [entry.carrier, 'session/event', this, event])`）。

- 事件的 **`this` 是 session 作用域载体**（`Scoped<Session>`）：用 `ctx.on` 注册在 agent 的 ctx 上即可自动按 session 过滤
  （`loop/lib/index.js:977-979` 就是这么做的）。
- 想拿到 session 对象：直接从回调第一个参数取；或 `ctx.agents.get(sessionId)` / `ctx.sessions.get(sessionId)`。
- `emit` 是**同步**派发、fire-and-forget，监听器不能否决；异步抛错被捕获记 warn（`session/lib/index.js:1237-1240`）。
- 需要"改/否决"语义的只能用 waterfall 事件（`agent/pre-step`、`agent/request-error`、`compaction/summary-error` 等）。

**Cordis waterfall 嵌套顺序（对编排至关重要）**：listener 按注册顺序**最外层优先**执行，
后注册者更靠内层；`ctx.on(name, cb, { prepend: true })` 可让后注册者排到最外层
（`cordis/src/events.ts:236-270`：`dispatch()` 用 `callbacks.shift()` 逐个包进 `next()`；`register` 的
`method = options.prepend ? 'unshift' : 'push'`）。

---

## 3. 工具调用链完整性

### 3.1 配对规则

- **请求侧**：`assistant/message.message.content` 里的 `{type:'tool-call', id, name, arguments}` 块，是该 step 的请求。
- **启动记录**：`tool/call`（`{turn, step, callId, name, arguments}`）是 log-only 的"已启动"记录，
  不参与 surface（`session/lib/index.js:834-838` 中记录 `callSeq`）。
- **结果侧**：`tool/result`（surface 事件），`message.source.callId` / `message.toolCallId` 指向请求 id。
- 恢复补写的结果带 `surfaceOp: 'append'` 且 `sourceEventSeqs:[callSeq]`（`session/lib/index.js:876-895`）。

### 3.2 `toolPairingBalancedBefore / After` 的精确语义

```ts
// compaction/lib/types/tool-pairing.js:83-96
export function toolPairingBalancedBefore(session: Session, seq: SessionSeq): boolean
export function toolPairingBalancedAfter(session: Session, seq: SessionSeq): boolean
```

- 语义：把一个"在途工具调用计数"沿**当前 surface 顺序**折叠；`assistant/message` 按其中的 `tool-call` 块数量 **+n**，
  `tool/result` **−1**，其余事件 0（`tool-pairing.js:9-18`）。
  `cutBalanced` 是长度 `nodes.length + 1` 的布尔数组，`cutBalanced[0]` 恒为 `true`（空 surface 的切点），
  `cutBalanced[i]` = **第 i-1 个节点之后、第 i 个节点之前**那个切点是否平衡
  （`pendingCuts.push(inProgressToolCalls === 0)`，`tool-pairing.js:37-40`；哨兵在 `:55` `cutBalanced: [true]`）。
- `balancedBefore(seq)` = 第 i 个节点**之前**的切点是否平衡（`cutBalanced[i]`）；
  `balancedAfter(seq)` = 第 i 个节点**之后**的切点（`cutBalanced[i+1]`），`cutBalance(cache, seq, offset)`（`tool-pairing.js:67-74`）。
- 抛错条件：seq 不在当前 surface（`tool-pairing.js:70-71`）、surface seq 找不到对应日志事件、
  `tool/result` 前没有未闭合的 `tool-call`（负计数，`:39`）。
- 缓存：`WeakMap<Session, {generation, cutBalanced, indexBySeq, inProgressToolCalls}>`；
  **`replaceGeneration` 变化或 surface 变短就整体重建**（`tool-pairing.js:45-65`）。
  这正是"跨快照边界如何 snap"的机制：replace 之后 surface 顺序变了，缓存按新顺序重算，位置索引全部重新建立。

### 3.3 未完成工具调用的识别

三种等价手段（按插件可用性排序）：

1. **计数法（推荐，无副作用）**：对 `session.surface.nodes` 依次套用 3.2 的 delta；末尾计数 `> 0` 即存在未闭合调用。
   与 `toolPairingBalancedAfter(session, lastNode)` 为 `false` 等价。
2. **`ToolCallRecovery`**（`session/lib/index.js:805-897`）：
   `observe(event)` 维护 `pendingCalls: Map<callId, {turn, step, callSeq}>`；
   `turn/start`、`turn/end`、`step/end` 清空（`:822-826`）；
   `assistant/message` 收集 tool-call 块（`:828-832`）；`tool/call` 记 `callSeq`（`:834-838`）；
   `tool/result` 且 `surfaceOp === 'append'` 且 turn/step 匹配才删除（`:839-843`）。
   `results()` 产出保守错误结果：未记录启动 → `TOOL_NOT_STARTED`，已启动无结果 → `TOOL_OUTCOME_UNKNOWN`
   （`:854-897`，文案常量在 `:737-738`）。
3. **边界法**：`ctx.agents.turnBoundaryOf(session)` → `TurnBoundaryProjection`
   `{ openTurnStartSeq, lastStepStartSeq, lastStepBoundary: {kind:'start'|'end', seq}, lastTurn }`
   （`inspect: Service(agents).methods[turnBoundaryOf]`）。`lastStepBoundary.kind === 'start'` 表示 step 未关闭，
   此时尾部必然可能有未完成调用。

### 3.4 跨快照/边界如何 snap

| 场景 | 机制 | 证据 |
|---|---|---|
| 选区必须落在平衡切点 | 先按 token 保留尾部，再**向上回退** `keepFromIdx` 直到 `toolPairingBalancedBefore(nodes[keepFromIdx])` | `compaction-basic/lib/index.js:417-433` |
| 显式区间校验 | `balancedBefore(start)` 且 `balancedAfter(end)` 都必须为 true，否则抛错 | `compaction-basic/lib/index.js:551-560` |
| surface 被替换后 | 缓存按 `replaceGeneration` 重建，旧位置索引作废 | `tool-pairing.js:45-65` |
| 中断/崩溃 | `interruptedTurnClosers(events)` 只为**开着的** turn 补 closer | `session/lib/index.js:908-910` |
| fork 前缀 | `buildForkSeed` 复制前缀 + `session/end-seed{inherited:true}` + `{kind:'forked'}` 的补写结果；**已关闭的 step/turn 一律不动** | `session/lib/index.js:928-937` |

---

## 4. `ctx.tokenMeter`

### 4.1 `measure()` 签名与返回结构

```ts
// inspect: Service(tokenMeter).methods[measure]
measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement
estimateMessage(message: Message): number
contextPressure(session: Session): Pick<ContextPressureProjection,
  'pressureTokens' | 'contextWindow'>                       // 注意：签名只 Pick 两项

// inspect: Service(tokenMeter) → referencedTypes
export interface TokenMeasurement {
  readonly logRevision: SessionLogOffset;      // 已消费到的日志位置（状态截止点）
  readonly baseline: TokenMeasurementBaseline;
  readonly surfaceDeltaTokens: number;         // 相对锚点的有符号净值（可为负）
  readonly totalTokens: number;                // 阈值判断用这个
  readonly surfaceTokens: number;              // == Σ nodes[].tokens
  readonly nodes: readonly TokenSurfaceNode[]; // 当前 surface 位置快照
}
export type TokenMeasurementBaseline =
  | { kind: 'none'; tokens: 0 }                                   // 无 header 且 surface 为空
  | { kind: 'estimated'; tokens: number }                         // 启发式（4 字符/token + 结构开销）
  | { kind: 'usage'; tokens: number; usage: Readonly<TokenUsage> } // 复用 provider 上报用量
export interface TokenSurfaceNode {
  readonly seq: SessionSeq;      // 对应 surface 节点的事件 seq —— 与 nodes 顺序严格一致
  readonly tokens: number;       // 路由定价（含图像视觉 token）
  readonly heuristicTokens: number; // 与路由无关的启发式价（供 replacement 影子定价）
}
```

实现：`meter/lib/index.js:723-766`；返回体 `structuredClone` + `deepFreeze`（`:758`）。

- `nodes[i].seq` 与 `session.surface.nodes[i]` **一一对应**；`compaction-basic` 会显式校验这一点
  （`compaction-basic/lib/index.js:415`）。
- `totalTokens = max(0, baseline.tokens + surfaceDeltaTokens)`（`meter/lib/index.js:762`）。
- `surfaceTokens = Σ nodes[].tokens`（`meter/README.md:37`）。
- **`cost` 语义**：`TokenMeasurement` **没有** `cost` 字段，也没有任何货币概念；
  这里"代价"只指 token。若需要金额，必须由插件自乘单价（`meter/README.md:67-69` 明确"occupancy 不是账单"）。
- 成本：每次调用 O(surface) 克隆（`meter/README.md:142`），但是**同步、确定性、无模型调用**，
  可以每步调用；真正贵的是 summarizer 的 LLM 请求。

### 4.2 baseline 与 surfaceDelta 的语义

`synchronize` 后按三种情况取 baseline（`meter/lib/index.js:729-757`）：

1. 存在"锚点"（上一轮成功的 `assistant/message` 且 header 与本次一致）→
   `baseline.kind = 'usage'`（当 `usageTokens(usage) ≥ 全量路由定价锚点`，`usageTokens = input + cacheRead + cacheWrite + output`，`:675-677`）
   否则 `'estimated'`；`surfaceDeltaTokens = 当前 surfaceTokens − 锚点 surfaceTokens`（`:744`）。
2. 无 header 且 surface 为空 → `'none'`，delta 0（`:745-750`）。
3. 其余 → `'estimated'`，`baseline.tokens = tools 估算 + surfaceTokens`，delta 0（`:751-756`）。

锚点在 `assistant/message` 折叠时更新，含 `step/start` 之后才加入的 system/user 输入
（`meter/lib/index.js:846-862`，`meter/README.md:46`）。

### 4.3 `contextPressure` / `projectedTokens`

`tokenMeter` 注册的 `contextPressure` 投影单元（`meter/lib/index.js:453-493`）：

```ts
state = { contextWindow?, pressureTokens?, surfaceTokens, sampledSurfaceTokens? }
// request/context 事件 → contextWindow（被移除时删除字段）
// assistant/message 的 usage → pressureTokens、sampledSurfaceTokens = 当时 surfaceTokens
// 之后的 surface 变化 → surfaceTokens += deltaTokens
view() = { contextWindow?, pressureTokens?,
           projectedTokens: max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens) }
```
（`meter/lib/index.js:457-465`、`:470-478`、`:490-493`；`usage-projection.js` 亦有同构 schema）

- `pressureTokens` = **上一次 provider 上报的 prompt 侧 token 数**（不含本次输出）。
- `projectedTokens` = **下一次请求 prompt 的估计**＝上次实测 + 之后 surface 的有符号变化。
- `contextPressure()` 的服务签名只 `Pick<'pressureTokens'|'contextWindow'>`，
  要 `projectedTokens` 得走 `ctx.sessionProjections.snapshot(session)` / 读该 unit 的 state
  （`meter/README.md:50`；`inspect: Service(sessionProjections).methods[snapshot]`）。

### 4.4 原生压缩阈值用的是 **totalTokens**

```js
// compaction-basic/lib/index.js:937-962
const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
const spec = resolveCompactSpec(policy, info.context.contextWindow, reservedCompletionTokens(agent, info.defaultMaxTokens));
if (measurement.totalTokens < spec.thresholdTokens) return null;      // :942
if (prune !== void 0) { prune.pruneSession(agent.session); measurement = meter.measure(agent.session); }
if (measurement.totalTokens < spec.thresholdTokens) return null;      // :947
… result = await this.compactRegion(...); measurement = meter.measure(agent.session);
if (measurement.totalTokens < spec.thresholdTokens) return result;    // :959
```

→ 原生判定是 `measure().totalTokens` vs `thresholdTokens`。
`surfaceTokens` 只用于**选区与保留尾部**（`selectCompactableRange` 用 `nodes[].tokens` 累加，`:411-423`）；
`projectedTokens` 只服务 UI/展示，**不参与**原生阈值判定。

### 4.5 原生阈值公式（默认策略）

```js
// compaction-basic/lib/index.js:125-141
const messageBudgetTokens = contextWindow - reservedCompletionTokens;          // :129
const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens;     // :131
const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens)); // :133
const retainTokens = policy.retainTokens ?? Math.floor(messageBudgetTokens * policy.retainRatio);          // :134
if (retainTokens >= thresholdTokens) throw TargetPressureConfigError(...);    // :135
```
默认值：`thresholdRatio 0.8`（`:16`）、`retainRatio 0.16`（`:18`）、`headroomTokens 65536`（`:65`）、
`maxTokens = headroomTokens`（`:65`）、`compactionRetries 1`、`maxOverflowRetries 1`、`auto true`（`:83-86`）。
`reservedCompletionTokens = session.requestHeader()?.config.maxTokens ?? info.defaultMaxTokens ?? 0`
（`:758`）。配置 Schema 见 `:807-819`。

触发入口：`agent/pre-step` → `compactIfNeeded(agent,'pressure',signal)`（`:840-853`，失败只 warn 不阻塞 turn）；
`agent/request-error` + `CONTEXT_WINDOW_EXCEEDED` → 绕过阈值做一次最大程度的头部削减并 `{kind:'retry'}`（`:862-888`）。

---

## 5. 上下文容量的权威来源

### 5.1 `ctx.llm.resolveModelInfo()`

```ts
// inspect: Service(llm).methods[resolveModelInfo]
async resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
  provider: string; id: string; name: string; description?: string;
  inputModalities?: …;
  context?: { contextWindow: number };   // ← 唯一权威容量
  defaultMaxTokens?: number;
  systemPromptUpdate?: 'in-history';
  toolUpdate?: 'in-history' | 'addition-only';
  reasoning?: …;
}>
```
实现 `llm/lib/index.js:2112-2118`；校验 `contextWindow` 为正整数（`:2123-2124`）；
装配进返回值 `:2132-2142`（`context` 与 `defaultMaxTokens` 都是可选的）。
容量只来自**路由所属 adapter**，不使用 `listModels()` 目录（`compaction-basic/README.md:130`）。

### 5.2 从 session 当前路由拿 provider/model/contextWindow

```js
// 1) 路由（最新一次请求信封）
const target = session.requestHeader()?.config;   // { provider, model, maxTokens?, reasoningEffort?, … }
if (!target?.provider || !target.model) return;   // 还没有任何请求
// 2) 权威容量
const info = await ctx.llm.resolveModelInfo(target.provider, target.model);
const contextWindow = info.context?.contextWindow; // 可能 undefined
const defaultMaxTokens = info.defaultMaxTokens;

// 3) 日志里也有一份"当时"的路由上下文（可能 undefined，且只在变化时写）
const ctxMeta = session.requestContext();  // { provider, model, contextWindow?, systemPromptUpdate? }
```
证据：`compaction-basic/lib/index.js:744-751`（`routedTarget`）、`:758`；`session/lib/index.js:1613-1634`
（`requestHeader()` / `requestContext()` 的增量折叠）。

### 5.3 `request/context` 事件字段与写入时机

```ts
'request/context': { provider: string; model: string; contextWindow?: number;
                     systemPromptUpdate?: 'in-history' }
```
写入点 `loop/lib/index.js:1263-1272`：`contextWindow` 取自**本次已准备好的调用**（`preparedCall?.context?.contextWindow`），
仅当 provider/model/contextWindow/systemPromptUpdate 任一变化时才 append。
`request/header` 则在系列开始/变化/初始/恢复时写（`loop/lib/index.js:1227-1241`，`reason: 'initial'|'resume'|'change'|'series'`）。

---

## 6. 会话生命周期与可监听事件

### 6.1 Cordis 事件（inspect 验证，`mode` 即派发语义）

| 事件 | mode | 签名 | 用途 |
|---|---|---|---|
| `session/created` | emit | `(session: Session)` | 会话进入 store 后的一次性广播（只读期） |
| `session/disposed` | emit | `(session: Session)` | 离开 store（含发布回滚） |
| `session/event` | emit | `(session, event: SessionEvent)` | 追加事件流，**主入口** |
| `session/flush` | parallel | `(session) => Promise<void>` | 持久化屏障（消费方一律走 `ctx.sessions.flush`） |
| `agent/created` | serial | `({agent, source: SessionStartSource, signal?})` | `source: 'startup'\|'resume'\|'clear'\|'compact'` |
| `agent/status` | emit | `({agent, status: 'idle'\|'running'})` | 后台工作闸门 |
| `agent/pre-step` | **waterfall** | `({agent, messages, turn, step, signal, modelSelection}, next) => PreStepDecision` | 原生压缩在此判断压力（**唯一同步前置插点**） |
| `agent/request-error` | waterfall | `({agent, turn, step, provider, failure, retryPolicy, signal}, next) => RequestErrorAction` | 溢出恢复，可返回 `{kind:'retry'}` |
| `agent/turn-stopping` | serial | `({agent, turn, signal})` | turn 即将关闭 |
| `agent/error` | emit | `({agent, turn, step, error})` | 错误观测 |
| `agent/disposed` | emit | `({agent})` | agent 下线 |
| `compaction/summary-error` | waterfall | `({session, sourceEventSeqs, error, signal?}, next) => boolean` | 摘要失败后同步记录持久输入变化 |
| `agent/assistant-stream` | emit | `({agent, frame})` | 流式帧（可做流式摘要） |

`PreStepDecision`：`{kind:'enter', messages}` 或 `{kind:'reject'}`（`loop/lib/index.js:910-927`）。
`request-error` 的 `{kind:'retry'}` 用法见 `compaction-basic/lib/index.js:879, 887`。

### 6.2 会话生命周期事件（Session 日志侧）

| 概念 | 落点 |
|---|---|
| 创建 | `ctx.sessions.create/prepare+enter+announce` → `session/created`（`session/lib/index.js:1773-1780, 1854-1884, 1902-1924`） |
| 恢复 | 持久化插件 `open()` 后 `Session.fromRestore` + `sessions.prepare({eventState})` → `agent/created source:'resume'`（`session/lib/index.js:1397-1398, 1811`） |
| fork/继承 | `sessions.fork` → 子会话 seed = 前缀 + `session/end-seed{inherited:true}` + forked closers（`session/lib/index.js:2007-2022, 928-937`） |
| turn/step | 会话事件 `turn/start`(loop:946)、`step/start`(971)、`step/end`(995)、`turn/end`(1030) |
| 压缩 | 会话事件 `compaction/start` / `compaction/summary` / `compaction/end` / `compaction/prune`（见 §8.3） |
| 结束 | `agent/disposed` → `session/disposed`（agent 先于 session 分离，`inspect: Event(agent/disposed)` 描述） |
| 重置(clear) | 类型上存在 `SessionStartSource='clear'`，但**本 build 的可解压包内找不到产生它的代码** → **需运行时验证**（实际由哪个命令/接口产生） |

---

## 7. `ctx.sessions`（SessionStore）服务

```ts
// inspect: Service(sessions).methods（实现：session/lib/index.js:1715-2051）
create(id?: SessionId, options?: CreateSessionOptions): Session
prepare(id?: SessionId, options?: PrepareSessionOptions): Session
enter(session: Session): () => void
announce(session: Session): void
async flush(session: Session): Promise<boolean>
get(id: SessionId): Session | undefined
list(): Session[]
fork(source: Session | SessionId, boundary?: SessionSeq, childSessionId?: SessionId): Session
registerMessageProjection(projection: SessionMessageProjection): () => Promise<void>   // 返回类型为 inspect 视图
```
`CreateSessionOptions = { seed?: readonly SessionEvent[]; inheritedEventCount?: SessionLogOffset;
meta?: { cwd?, parentSession?, createdAt?, isSeeded?, origin?: 'subagent', delegationDepth?, agentPreset? } }`。

- `prepare`/`enter` 是给 agent factory 的**有序拆装**原语（先装钩子，再 announce，失败可回滚）；
  普通插件用 `create()` 即可，但 `create` 会把会话生命周期绑到**调用方 fiber**：fiber 卸载即 detach
  （`session/lib/index.js:1752-1780`）。
- `flush(session)` 是唯一 flush 入口（内部走 `session/flush` parallel，`:1952-1969`）；返回值 =
  是否有 listener 参与；任一 listener 失败会 throw。
- `fork` 只做"拷贝前缀 + 补 closer"，不修复已关闭 step 的缺失结果（`:928-937`）。

### 判断"会话被重置/切换"

| 信号 | 用法 | 证据 |
|---|---|---|
| 身份 | `session.id` / `session.header.id`（`SessionId`）；同一 id 的 `Session` 实例在 resume 时是**新对象** | `session/lib/index.js:1345-1347` |
| 生命周期起点 | `session.firstLifecycleSeq`、`session.firstLiveSeq`、`session.inheritedEventCount` | `:1361-1427` |
| 继承标记 | 日志里 `session/end-seed`，`data.inherited === true` 表示 fork 切点 | `:1423-1425, 930-935` |
| 创建来源 | `agent/created` 的 `source: 'startup'\|'resume'\|'clear'\|'compact'` | `inspect: Event(agent/created)` |
| 会话集合变化 | `session/created` / `session/disposed`；或 `ctx.sessions.list()` diff | `:1902-1938, 1988-1990` |
| 是否活着的 store 实例 | `liveEntryFor` 会拒绝 detached/prepared 对象 | `:1971-1975` |

---

## 8. `sessionProjections`

### 8.1 它是什么

`ctx.sessionProjections` 是"投影单元表 + 驱动"：服务只订阅一次 `session/event`，把每个已提交事件喂给每个已注册单元
的纯函数 `apply(state, event) -> state`；状态变化才通知 change feed。每个 session 的单元状态可被
**checkpoint 持久化**（`inspect: Service(sessionProjections).description`）。

### 8.2 插件能不能注册自己的投影：**能**

```ts
// inspect: Service(sessionProjections).methods[register]（两个重载）
register<K extends keyof SessionProjectionMap, S>(
  definition: Omit<ProjectionDefinition<K,S>, 'wire'> & { wire: NonNullable<…['wire']> }
): Promise<ProjectionHandle<S>>                                    // 客户端可见（带 wire）
register<K extends string, S>(
  definition: ProjectionDefinition<K,S> & { key: Exclude<K, keyof SessionProjectionMap> }
): Promise<ProjectionHandle<S>>                                    // host-only（无 wire，仍会 checkpoint）

interface ProjectionDefinition<K extends string, S> {
  key: K;
  stateSchema: ZodType<S>;
  init(header: SessionHeader, inheritedEventCount: SessionLogOffset): S;
  apply(state: S, event: SessionEvent): S;
  wire?: { viewSchema; view(state): …; summary?: boolean };
  stateVersion: number;      // 变更即让旧 checkpoint 失效重折
}
interface ProjectionHandle<S> { stateOf(session): S; readerFor(session): () => S; dispose(): Promise<void> }
```
其它方法：`onChanged(listener)`、`onEventChanged(listener)`、`snapshot(session, keys?)`、
`summaryKeys()`、`checkpoint(session)`、`restoreFloor(checkpoint)`、`viewCheckpoint(checkpoint, keys?)`、
`restore(checkpoint, events, baseSeq, header, inheritedEventCount)`、`hydrate(session, checkpoint, events, baseSeq)`。

范例（官方用法）：`meter` 注册 3 个单元 —— `tokenUsage`、`contextPressure`、`contextBreakdown`
（`meter/lib/index.js:690-701`，`meter/README.md:50`）。持久化侧由 `sessionProjectionCache.write(session)`
落盘（`inspect: Service(sessionProjectionCache).methods[write]`），checkpoint 行形如 `(sessionId, key, ver, seq, val)`。

**这是插件持久化自己统计数据的首选通道**：注册一个 host-only unit（任意 key，`stateVersion` 自管），
状态就会被 projection cache 持久化并在 resume 时从 checkpoint 恢复。

### 8.3 压缩相关的会话事件载荷（可直接照抄的形状）

```js
// compaction/start
{ compactionId: CompactionId, sourceCommandId?: CommandId, turn: number | null }
// compaction/end（成功 / 失败）
{ compactionId, sourceCommandId?, turn }   |   { …, error: unknown }
// compaction/summary
{ compactionId, sourceCommandId?, summary: string, rawOutput?: string, llmStreamCall?: true,
  shadowedRange: { start: SessionSeq, end: SessionSeq }, shadowedSeqs: SessionSeq[],
  shadowedTokenCount: number, provider: string, model: string, maxTokens?: number, usage?: TokenUsage }
// compaction/prune（pruner 写入，影子定价）
{ shadowedRange: {start, end}, shadowedSeqs: SessionSeq[], shadowedTokenCount: number }
```
证据：`compaction-basic/lib/index.js:470, 485, 496-499, 635-650`；`pruner/lib/index.js:160-167`。
**替换体的标准写法**（压缩落地的关键 3 行）：

```js
// compaction-basic/lib/index.js:651-662
session.append('user/message', checkpointMessage, {
  surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
  sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
});
```
即：`sourceEventSeqs` 必须**同时包含**本次事务的开/闭标记与**全部被遮蔽的 surface 节点 seq**。
checkpoint 消息来源标记 `compactCheckpointSource(compactionId, sourceCommandId?)`
→ `{ kind: 'compact-checkpoint', compactionId, sourceCommandId? }`（`compaction/lib/index.js:110-131`）。

并发保护：**未匹配的 `compaction/start` 就是持久化锁**；`assertCompactionInactive` 在起事务前检查，
只有更早的 `session/end-seed` 边界能证明那个 orphan 属于上一个生命周期
（`compaction-basic/lib/index.js:546-556, 707-720`）。自动压缩必须**处于打开的 turn 内**
（否则 `compactRegion: no open turn`，`:461`）；手动 `compactNow` 必须 agent 空闲（`:986-1012`）。

---

## 9. 对"后台上下文预压缩"插件的直接结论

### 9.1 可实现清单（有 API 支撑）

| # | 能力 | 依据 |
|---|---|---|
| 1 | 读取当前 surface 的完整节点序列与每个节点的事件 seq | `session.surface.nodes`（`session/lib/index.js:1330-1332`） |
| 2 | 拿到每个节点的消息（role/content/id）与派生历史 | `deriveEventMessage` / `deriveMessages`（`session/lib/index.js:1673-1697`） |
| 3 | 同步、确定性、无模型调用的压力测量 | `ctx.tokenMeter.measure()`（`meter/lib/index.js:723-766`） |
| 4 | 用与原生一致的阈值公式算容量压力 | `ctx.llm.resolveModelInfo().context.contextWindow` + §4.5 公式 |
| 5 | 监听每一次事件提交（含 compaction/* ）做增量记账 | `ctx.on('session/event', …)`（`session/lib/index.js:1586-1593`） |
| 6 | 在 agent 空闲时跑后台任务 | `agent.runMaintenance(job)`（`loop/lib/index.js:823-846`，非 idle 直接抛错） |
| 7 | 在 turn 内、请求派生之前插入同步逻辑 | `agent/pre-step` waterfall（`loop/lib/index.js:903-928`） |
| 8 | 在原生压缩之后、同一 pre-step 内继续加工 | `ctx.on('agent/pre-step', cb, { prepend: true })` 后 `await next()`（`cordis/src/events.ts:236-270`） |
| 9 | 直接改写模型可见历史（surface replace），甚至完全替代 `compaction/summary` 的落地写法 | `session.append(type, data, {surfaceOp:{op:'replace',…}, sourceEventSeqs})`（`compaction-basic:651-662`、`pruner:168-178`） |
| 10 | 安全切点（不切断工具调用对） | `toolPairingBalancedBefore/After`（`compaction/lib/types/tool-pairing.js:83-96`） |
| 11 | 用 provider 上报用量做"真实压力"锚点 | `TokenMeasurement.baseline.kind === 'usage'`（`meter/lib/index.js:736-743`）与 `contextPressure.pressureTokens` |
| 12 | 持久化插件自己的统计（跨 resume） | `ctx.sessionProjections.register(host-only unit)` + `sessionProjectionCache` |
| 13 | 与持久化对齐（写完 stats 再返回） | `await ctx.sessions.flush(session)`（`session/lib/index.js:1952-1969`） |
| 14 | 订阅溢出错误做兜底 | `agent/request-error` + `{kind:'retry'}`（`compaction-basic:862-888`） |
| 15 | 可复用的静默压缩落地范式 | `pruner.pruneSession`（无模型调用、逐节点 replace、先写影子价） |

### 9.2 不可实现 / 受限清单

| # | 限制 | 依据 |
|---|---|---|
| 1 | 不能追加**自定义事件类型**（不写 `ignorable` 会让持久化读取路径抛 `SessionFormatUnsupportedError` 拒绝解释整条日志；带 `ignorable` 的 `appendPluginRecord` 明确禁止仓外插件调用） | `session-persistence/lib/index.js:172-185`（运行时硬校验）；`session/lib/index.js:66-79, 1549-1563`；`session/README.md:71` |
| 2 | 不能替换 surface 节点 0（system prompt），除非替换体本身是"只覆盖该节点的 `system/message`" | `session/lib/types/surface.js:382-391` |
| 3 | `assistant/message` 不能带 `sourceEventSeqs`，所以不能用它做"聚合替换"载体 | `session/lib/types/surface.js:232-234` |
| 4 | `tool/result` 的 replace 只能改 `message.content`，且一次只能一个节点 | `session/lib/types/surface.js:350-375` |
| 5 | 不能在没有 open turn 时做"自动路径"压缩（原生 `compactRegion` 会抛 `no open turn`）；空闲期只能用 `runMaintenance` 包裹的自定义路径 | `compaction-basic:461`；`loop:823-826` |
| 6 | 不能进行**真正的并行**后台 LLM 请求而不影响前台：`runMaintenance` 要求 idle，且期间 `agent.status` 已是 `idle`，新用户输入会排队/唤醒 | `loop/lib/index.js:823-846, 791-800` |
| 7 | 不能阻止或否决已提交事件（`session/event` 是 emit，fire-and-forget） | `session/lib/index.js:1586-1593` |
| 8 | 单节点不透明内容（超大工具调用对）无法在不破坏配对的前提下压缩 | `compaction-basic/README.md:245`；`tool-pairing.js:9-18` |
| 9 | 不能每次都精确计费：无 `cost` 字段；无 provider tokenizer，只有 4 字符/token 启发式 | `meter/README.md:67-69, 141`；§4.1 |
| 10 | 不能依赖 `projectedTokens` 做阈值决策（它只是 UI 估计，且 system 重写会被当作 0 delta 折叠） | `meter/README.md:144`；`meter/lib/index.js:490-493` |
| 11 | 不能抢占原生压缩的并发锁：与一个 orphan `compaction/start` 同时起事务会被判 busy | `compaction-basic:546-556` |
| 12 | `eventAt`/`snapshotEvents` 属"新代码禁止" API；无 seq↔message 的非废弃替代 | `session/lib/index.js:1433-1459`；`session/README.md:63` |
| 13 | 不能修改或接管 `ctx.compaction` 单例之外的压缩语义（一个 context 只有一个 `CompactionEngine`） | `compaction/lib/index.js:170-174` |

### 9.3 三个必须处理的竞态（设计约束）

1. **surface 变化竞态**：任何异步摘要前取 `session.surface.contentGeneration`/`replaceGeneration` 与
   `tokenMeter.measure().nodes` 快照，落地前重新比对（原生做法：`assertWholeSurfaceUnchanged` 深比较
   `measure().nodes`，`compaction-basic:610-627`）。节点序列变化 → 放弃或重算。
2. **与原生压缩的重入**：`agent/pre-step` 是 waterfall，原生引擎也挂在这里。谁在外面决定谁先跑；
   要"原生先跑、我再收尾"，必须 `{prepend:true}` 且把逻辑放在 `await next()` 之后
   （`cordis/src/events.ts:236-270`）；否则可能在同一 step 上做两次替换、双倍 invalidation。
   **需运行时验证**：本 profile 的 loader 顺序决定默认嵌套次序，需实测确认。
3. **KV cache 代价**：替换会让"从第一个被遮蔽消息起"的缓存全部失效（`session/README.md:166`）。
   后台预压缩应尽量贴近尾部、并优先做无损操作（如 pruner 式裁剪）而非整段摘要。

---

## 10. 待运行时验证清单

1. `SessionStartSource='clear'`（会话重置）由哪个命令/接口产生 —— 解压包内无写入点。
2. deprecated 的 `eventAt`/`snapshotEvents` 在后续版本是否被移除（影响插件读取路径的长期稳定性）。
3. 本 profile 中 `agent/pre-step` 的 listener 实际嵌套顺序（原生 `dsh-compaction-basic` 与本插件的相对位置）。
4. 自定义 `message.source.kind`（非 `user`/`model`/`tool`/`system-prompt`/`compact-checkpoint`）在**当前 adapter**
   渲染请求时是否会报 `UNSUPPORTED_CONTENT` 类错误（恢复校验只要求 `kind` 为非空字符串 + `content` 为数组，
   `session/lib/index.js:1205-1207`，但 adapter 侧未验证）。
5. `ctx.sessionProjections.register` 的 host-only unit 是否会随 `sessionProjectionCache.write` 一起落盘
   （服务描述称"every persisted unit"，未实测）。
