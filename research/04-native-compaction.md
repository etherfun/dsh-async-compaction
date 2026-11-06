# 04 · DSH 原生压缩机制调研（行号级证据）

> 调研对象：`D:/SOFT/tools/dsh/resources/app.asar`（Electron 内置 DSH 安装）解压后的 `dsh/node_modules/@deepseek-ai/*`。
> 所有 `别名:行号` 均可复核。解压根目录：`research/extracted/`。

## 0. 路径别名表

| 别名 | 完整路径（相对仓库根） |
|---|---|
| README_CORE | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-compaction/README.md` |
| CORE | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-compaction/lib/index.js` |
| README_BASIC | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/README.md` |
| BASIC | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js` |
| CMD | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-command-compact/lib/index.js` |
| SESS | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js` |
| SURF | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js` |
| METER | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js` |
| USAGE_PROJ | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js` |
| LOOP | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js` |
| AGENT | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js` |
| PRUNER | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js` |
| IMGOFF | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-compaction-image-offload/lib/index.js` |
| LLM | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js` |
| FMT | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js` |

注意：这些包**只发布了 `lib/*.js`（构建产物），没有 `.d.ts`、没有 `src/`、也没有 `docs/subsystems/compaction.md`**（已用 `asar-list.cjs` 验证，dsh-compaction 在 asar 内共 11 个文件）。因此"类型层面的签名"只能从 README 契约 + 运行时代码反推；下文凡属反推的，标注 `[推断]`。

---

## 1. `CompactionEngine` 的 API、`CompactionResult`、错误码

### 1.1 抽象基类（运行时几乎为空）

```js
var CompactionEngine = class extends Service {
	constructor(ctx) { super(ctx, "compaction"); }
};
```
证据：`CORE:170-174`。即：**基类在运行时只注册 Cordis 服务名 `compaction`，没有任何抽象方法体、没有默认实现**。方法签名纯靠契约（`README_CORE:79`）与后端实现（`BASIC`）。三个操作是：

| 方法 | 签名（来自实现与调用点） | 证据 |
|---|---|---|
| `compactIfNeeded(agent, trigger, signal)` | `trigger: "pressure" \| "context-overflow"`；返回 `CompactionResult \| null` | `BASIC:915`；trigger 闭集见 `BASIC:921-926`、调用点 `BASIC:842`(pressure)/`BASIC:873`(context-overflow) |
| `compactNow(agent, signal, sourceCommandId?)` | 同步返回 `Promise<CompactionResult \| null>`（内部 `runMaintenance`） | `BASIC:986`；调用点 `CMD:56` |
| `compactRegion(start, end, agent, signal)` | `start`/`end` 为 surface seq（含端点）；返回 `CompactionResult` | `BASIC:972`；内部调用 `BASIC:935`、`BASIC:957` |
| `summarize(input, agent, signal)` | 后端可覆盖的唯一钩子；不是基类成员 | `BASIC:900`；`README_BASIC:110`、`README_BASIC:138` |

另一个后端可见成员：`config`（`BASIC:821`）、`regionDependencies()`（`BASIC:1014`）。

### 1.2 `CompactionResult` 字段（`[推断]`：由构造点逐字段还原）

由 `commitCompactionBody`（`BASIC:663-675`）返回体 + `completeCompaction` 追加（`BASIC:678-682`）：

```
{
  compactionId,          // CompactionId（branded string，UUID）  BASIC:464
  sourceCommandId?,      // 手动命令来源，可选                    BASIC:467
  startSeq,              // compaction/start 事件的 seq           BASIC:666
  summarySeq,            // compaction/summary 事件的 seq          BASIC:667
  summary,               // ContentBlock[]（仅 text）              BASIC:668
  shadowedRange: { start, end },                               BASIC:669-672
  shadowedSeqs,          // 被 shadow 的 surface 节点 seq 数组      BASIC:673
  shadowedTokenCount,    // 启发式 token（heuristicTokens 之和）   BASIC:674 / 577
  endSeq                 // compaction/end 事件的 seq              BASIC:681
}
```

消费侧确认：`CMD:63-64` 读取 `shadowedSeqs.length`、`shadowedTokenCount`、`summarySeq`。
另有两个**只在内部用**的字段：`checkpointMessage`（`BASIC:606`）、`shadowedRouteTokenCount`（`BASIC:578`）。

`compactNow()` 在无可压缩范围时返回 `null`（`BASIC:994`），`CMD:57-60` 渲染为 "No compactable history yet."

### 1.3 `ManualCompactionError.code` 闭集（6 个）

`CMD:19-48` 的 `switch` 穷举 + `assertNever`兜底（`CMD:13-16`）证明 code 是**封闭集合**：

| code | 语义 | 抛出点 |
|---|---|---|
| `busy` | 已有活动压缩锁 / agent 非 idle / 已有开放 turn | `BASIC:539`、`BASIC:458`、`BASIC:1010` |
| `cancelled` | 手动路径取消 | `BASIC:1004` |
| `changed` | 选中区间在摘要期间变化 | `BASIC:527` |
| `summary` | 摘要失败或不缩小 | `BASIC:528` |
| `commit` | 提交阶段异常 | `BASIC:526` |
| `persistence` | 提交成功但 flush 失败 | `BASIC:519` |

`ManualCompactionError` 定义：`CORE:147-160`（`name`, `code`, `cause`）。注意 `busy` 也可能来自自动路径（`CORE:144-146` 注释）。

### 1.4 checkpoint 标记（可被任意消费者识别）

`CORE:110` 定义 `COMPACT_CHECKPOINT_MARKER = { kind: "compact-checkpoint" }`；`compactCheckpointSource(compactionId, sourceCommandId?)`（`CORE:117-123`）产出 `{kind:'compact-checkpoint', compactionId, sourceCommandId?}`；`isCompactCheckpointSource(source)`（`CORE:129-131`）是纯谓词。
后端把它写成替换消息的 `source`：`BASIC:597-600`。

---

## 2. 自动触发：位置、阈值、测量字段

### 2.1 触发点**不在 agent-loop**，而在后端自己的 `agent/pre-step` 监听器

对 `LOOP` 全文 grep `compaction|compactIfNeeded|CONTEXT_WINDOW_EXCEEDED|pressure`：**零命中**（仅命中 `compact stream` 这类无关字样，`LOOP:355/396/449`）。agent-loop 只提供两个通用扩展点，压缩知识全部在 `dsh-compaction-basic`：

```js
this.config = resolveConfig(config);
if (this.config.auto) this._registerAutomaticCompaction();   // BASIC:827-828
```
证据：`BASIC:835-889`，其中：
- `ctx.on("agent/pre-step", ...)` → `await this.compactIfNeeded(agent, "pressure", signal)`（`BASIC:840-853`）
- `ctx.on("agent/request-error", ...)` → 仅当 `failure.code === CONTEXT_WINDOW_EXCEEDED_CODE` → `compactIfNeeded(agent,"context-overflow",signal)`（`BASIC:862-888`）
- `ctx.on("agent/status", idle)` 清空 overflow 重试计数（`BASIC:854-856`）

agent-loop 侧对应事件：`agent/pre-step` waterfall 在 `preStep()` 中派发（`LOOP:903-928`，派发点 `LOOP:910`）；`agent/request-error` waterfall 在请求失败后派发（`LOOP:1137-1147`）。payload 里的 `agent` 由 `agentEvents` 自动 fuse 进所有事件（`AGENT:243-247`），所以监听器可解构 `{ agent, signal }`。

时序：`turn()` 先 `turn/start`（`LOOP:946`）→ `preStep()`（`LOOP:957`）→ `step/start`（`LOOP:971`）→ 请求。所以 `agent/pre-step` 里的压缩发生在**当前 turn 内、当前 step 开始前**，且 `turn/start` 已落盘（这是后面"必须包在 turn 内"的前提）。

### 2.2 阈值公式与默认值

`resolveCompactSpec`（`BASIC:125-148`）：

```
messageBudgetTokens = W - O                       // BASIC:129
pressureBudgetTokens = messageBudgetTokens - B    // BASIC:131
thresholdTokens = floor(min(W * thresholdRatio, pressureBudgetTokens))   // BASIC:133
retainTokens    = retainTokens ?? floor(messageBudgetTokens * retainRatio) // BASIC:134
```
- `W` = `info.context.contextWindow`（来自适配器，`BASIC:941`），由 `ctx.llm.resolveModelInfo()` 返回，形状 `{ context?: {contextWindow}, defaultMaxTokens? }`（`LLM:2112-2139`，字段归一化 `LLM:2138-2139`）。
- `O` = `reservedCompletionTokens(agent, info.defaultMaxTokens)` = `session.requestHeader()?.config.maxTokens ?? adapterDefault ?? 0`（`BASIC:758-760`）。
- `B` = `headroomTokens`，默认 **65536**（`BASIC:64`）。
- `thresholdRatio` 默认 **0.8**（`BASIC:16`，`BASIC:67`）。
- `retainRatio` 默认 **0.16**（`BASIC:18`，`BASIC:68`）。
- `maxTokens`（摘要输出上限）默认 = `headroomTokens` = **65536**（`BASIC:65`）。
- `compactionRetries` 默认 1，`maxOverflowRetries` 默认 1，`auto` 默认 true（`BASIC:83-86`）。

与 README 一致：`README_BASIC:63`、`README_BASIC:67-77`。Config schema（schemastery）：`BASIC:807-819`（`modelPolicies` 子结构 `BASIC:780-792`）。

### 2.3 用 `measure()` 的哪个字段做分子

```js
let measurement = this.ctx.tokenMeter.measure(agent.session);   // BASIC:920
if (measurement.totalTokens < spec.thresholdTokens) return null; // BASIC:942
```
- **分子 = `measurement.totalTokens`**（`BASIC:942`、重测后 `BASIC:947`、收敛判断 `BASIC:959`）。
- **分母 = `spec.thresholdTokens`**（不是 contextWindow 本身；公式见上）。
- **保留尾部预算**用 `measurement.nodes[i].tokens`（路由价）逐节点累加（`BASIC:419-423`）；`shadowedTokenCount` 则用 `nodes[i].heuristicTokens`（`BASIC:577`）。

`measure()` 返回字段（`METER:758-765`）：`{ logRevision, baseline:{kind,tokens,usage?}, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes:[{seq, tokens, heuristicTokens}] }`，`deepFreeze` + `structuredClone`（`METER:758`）。`totalTokens = max(0, baseline.tokens + surfaceDeltaTokens)`（`METER:762`）。`estimateMessage(message)` 是公开的启发式定价（`METER:784-786`）。

### 2.4 自动路径的完整判定顺序（`compactIfNeeded`）

1. 无 routed target → 直接 `null`（`BASIC:916-917`）。
2. `resolveTargetPolicy` 取按模型覆盖（`BASIC:918`）。
3. `context-overflow` 分支：先 prune（若挂了 pruner）→ `selectCompactableRange(..., 0)` → `compactRegion`（`BASIC:928-935`），**完全绕开阈值与保留策略**。
4. `pressure` 分支：`resolveModelInfo` → `assertNoActiveCompaction` → 解析 spec → 阈值比较 → prune → 再比较 → 循环 `compactionRetries+1` 次（`BASIC:937-961`）。仍未降到阈值则抛错（`BASIC:961`）。
5. 配置错误（`TargetPressureConfigError`，`BASIC:44-54`）在 pre-step 监听器里"每个 target 只警告一次然后放行"（`BASIC:845-848`）。

> 结论：**没有"每 N 轮"或"每 N 条消息"的触发，唯一自动触发是 (a) 每个 step 前的 token 压力，与 (b) 提供方确认的上下文溢出。**

---

## 3. 压缩范围选择算法

`selectCompactableRange(session, measurement, retainTokens)`（`BASIC:411-434`）：

```js
const firstIdx = systemHead(session, surfaceNodes[0]) === undefined ? 0 : 1;  // 416
let accumulated = 0, keepFromIdx = pricedNodes.length;
for (let i = pricedNodes.length - 1; i >= 0; i -= 1) {      // 从尾部向前累加
  accumulated += pricedNodes[i].tokens;                      // 420
  keepFromIdx = i;                                           // 421
  if (accumulated >= retainTokens) break;                    // 422
}
if (keepFromIdx <= firstIdx) return null;                    // 424
while (keepFromIdx > firstIdx) {                             // 向前扩展保留尾部
  if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break;  // 426
  keepFromIdx -= 1;
}
if (keepFromIdx <= firstIdx) return null;                    // 429
return { start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] }; // 430-433
```

要点：

1. **保留多少最近消息**：不是"条数"，而是**从尾部向前按路由 token 累加到 `retainTokens` 为止**（`BASIC:419-423`）。自动压力路径 `retainTokens = floor((W-O)*0.16)`（`BASIC:134`）；`compactNow()` 与 `context-overflow` 传 **0**（`BASIC:993`、`BASIC:933`），即只保留最后一个 surface 节点（再被平衡规则向后扩大）。
2. **如何向前扩展**：命中 `retainTokens` 后，若 `keepFromIdx` 处的切点不满足 `toolPairingBalancedBefore`，就把 `keepFromIdx` **减 1**（保留区变大）直到切点平衡（`BASIC:425-428`）。
3. **system 消息处理**：**只有 surface node 0 的 `system/message` 被排除在压缩范围外**（`BASIC:397-400` 的 `systemHead`，`BASIC:416`）。若 node 0 不是 `system/message`，范围从 node 0 开始（`BASIC:416`）。**后续**出现的 `system/message`（例如 in-history 的 prompt 更新）属于普通历史，**可以被 shadow**（`README_BASIC:114`）。会话级保护在 session 层（见 §6）。
4. **平衡校验的两层**：
   - 选择器用 `toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])`（`BASIC:426`）；
   - 事务入口 `validateSurfaceRegion` 再用 before/after 双向校验（`BASIC:558-559`），不符即抛错（不是 `ManualCompactionError`，是普通 `Error`）。
5. `toolPairingBalancedBefore/After` 语义：**切点处没有"未答复的 assistant tool-call 跨过"**。实现是对 surface 顺序折叠 `inProgressToolCalls`：`assistant/message` 中 `tool-call` 块 +1，`tool/result` -1；`cutBalanced[i] = (计数===0)`（`CORE:22-46`）；`Before(seq)` 取 `cutBalanced[index]`，`After(seq)` 取 `cutBalanced[index+1]`（`CORE:67-94`）。缓存按 `surface.replaceGeneration` 失效（`CORE:48-65`），seq 不在当前 surface 或缺事件/孤儿 result 时**抛错**（`CORE:37-39`、`CORE:70`）。

---

## 4. 压缩提示词、输入序列化、模型与预算

### 4.1 完整提示词（frozen 常量）

`COMPACTION_INSTRUCTION`：`BASIC:244-279`（`join("\n")`），与 `README_BASIC:191-226` 逐字一致。末尾规则含"若已有 `<compacted-summary>` 块则视为 PRIOR checkpoint，合并而非照抄"（`BASIC:278`）。
落到 checkpoint 用户消息的框架：`CHECKPOINT_PREAMBLE`（`BASIC:281`）＋ `<compacted-summary>` / `</compacted-summary>` 标签（`BASIC:235-236`），由 `frameSummary()` 组装（`BASIC:345-357`）。最终消息内容 = `[ {text: PREAMBLE+"\n\n"+OPEN}, ...summaryTextBlocks, {text: CLOSE} ]`。

### 4.2 消息如何序列化给 summarizer

`buildSummarizationInput(session, shadowedSeqs)`（`BASIC:696-705`）：
- `system` = node 0 的 `system/message` 经 `session.deriveEventMessage()` 得到（无则 `null`，`BASIC:698-699`）；
- `regionMessages` = 被 shadow 的每个 seq 各自 `deriveEventMessage`，过滤 `null`（`BASIC:700`）；
- `tools` = `session.requestHeader()?.tools`（`BASIC:702`）。

`summarizeWithLlm` 把 `COMPACTION_INSTRUCTION` 作为**最后一条 user 消息**追加（`BASIC:306-312`），然后：

```js
const options = {
  provider, model, messages, toolHistory: agent.session.toolHistory(),
  ...tools, maxTokens: config.maxTokens, sessionId: agent.session.id,
  purpose: "compaction", ...signal
};
for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);  // BASIC:324
```
证据：`BASIC:313-324`。设计意图注释在 `BASIC:237-243`（复用 provider 热前缀以命中 KV cache）。

### 4.3 用哪个模型

`BASIC:294-304`，优先级**三段回退**：
1. 显式配置 `summarizationProvider + summarizationModel`（两者必须成对，`BASIC:200-207`）；
2. 最近一次已落盘请求的 `session.requestHeader().config`（即"当前会话路由"）；
3. `AgentOptions.provider/model`。

三者为空则抛：`no provider/model available for summarization...`（`BASIC:304`）。**默认就是当前会话模型**（`README_BASIC:71-72`）。

### 4.4 输出约束与拒绝条件

- `maxTokens: config.maxTokens`（默认 65536，`BASIC:65`、`BASIC:319`）。
- 只保留 text 块；出现 image 输出 → `LlmError(...,"UNSUPPORTED_CONTENT")`（`BASIC:371-375`）。
- 空文本摘要 → 抛错（`BASIC:329`）。
- `finish.kind` 为 `error`/`aborted`/`max-tokens` → 抛错（截断视为失败，`BASIC:359-370`）。
- **收缩校验**：`estimateMessage(checkpointMessage) >= shadowedRouteTokenCount` 则抛错（`BASIC:601-602`）。

---

## 5. 事件序列、payload 与锁语义

### 5.1 一次成功压缩的写入顺序（严格如此）

`compactSurfaceRegion`（`BASIC:451-523`）：

| # | 事件 | 何时 | payload / opts | 证据 |
|---|---|---|---|---|
| 0 | （只读）`validateSurfaceRegion` + `inspectCompactionEntryState` + `assertCompactionInactive` | 摘要**前**同步完成 | — | `BASIC:453-455` |
| 1 | `compaction/start` | 摘要前**同步** append（= 取锁） | `{ compactionId, sourceCommandId?, turn }` | `BASIC:465-470` |
| 2 | `await summarize(...)` | 锁已持有 | — | `BASIC:479` |
| 3 | 稳定性复检 | 摘要后 | whole-surface 或 selected-span | `BASIC:471`、`BASIC:481`、`BASIC:610-627` |
| 4 | `compaction/summary` | 提交阶段，无 await | 见下 | `BASIC:635-650` |
| 5 | `user/message`（**唯一的 surface 变更**） | 紧接 4 | `surfaceOp:{op:'replace',startSeq:start,endSeq:end}`，`sourceEventSeqs:[startSeq,summarySeq,...shadowedSeqs]` | `BASIC:651-662` |
| 6 | `compaction/end` | 释放锁 | `{ compactionId, sourceCommandId?, turn }`（失败路径 `+error`） | `BASIC:485`、`BASIC:496-499` |
| 7 | （手动路径）`await sessions.flush(session)` | 关闭之后 | — | `BASIC:509-513`、`BASIC:999-1001` |

失败路径：任何异常 → 恰好尝试一次 `compaction/end` 带 `error: errorChain(error)`（`BASIC:493-507`）；**关闭本身失败则故意留下未配对 start 作为 busy 信号**（`BASIC:501-506`，`README_CORE:74`）。

`compaction/summary` 完整 payload（`BASIC:635-650`）：

```
{ compactionId, sourceCommandId?, summary: ContentBlock[],
  rawOutput?: ContentBlock[], llmStreamCall?: true,
  shadowedRange: {start, end}, shadowedSeqs: number[],
  shadowedTokenCount: number, provider, model, maxTokens?, usage? }
```

### 5.2 事件是否"可携带字段"由谁校验

- `compaction/start|summary|end|prune` 都是 `KNOWN_SESSION_EVENT_TYPES` 成员（`SESS:90-93`），**但不是 surface-eligible**（surface 类型集合只有 5 个：`SESS:158-164`），因此**禁止携带 `surfaceOp` / `sourceEventSeqs`**，否则 append 直接抛（`SESS:299-305`）。
- 运行时**没有**对 `compaction/*` 的 data 做 schema 校验：`validateSessionEventData` 只处理 5 种 surface 类型 + `request/header` + `tool/result`（`SESS:243-278`）。`dsh-compaction/lib/types/types.js` 是纯类型出口（`export {}`，全文 10 行），所以事件 payload 的类型约束**只存在于 TypeScript 声明合并里，运行时不强制**。
- 推论：第三方插件 append `compaction/*` 时字段"能写进去"，但**语义只有原生消费者认**；写错字段不会报错，只会静默失去效果。

### 5.3 锁语义（live vs orphaned）

`inspectCompactionEntryState(session)`（`BASIC:707-735`）从日志尾部向前扫，一次性收集三样东西并提前退出（`BASIC:728`）：
- `openTurn`：最近的 `turn/start` 的 `data.turn`；若先遇到 `turn/end` 则为 `null`（`BASIC:722-727`）；
- `unmatchedCompactionStart`：最近的 `compaction/start`；若先遇到 `compaction/end` 则无（`BASIC:716-721`）；
- `latestEndSeedSeq`：最近的 `session/end-seed` 的 seq（`BASIC:715`）。

busy 判定（`BASIC:537-540`）：
```js
if (unmatchedStart === undefined) return;                       // 无未配对 start → 空闲
if (latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedStart.seq) return;  // 跨进程的陈旧锁 → 放行
throw new ManualCompactionError("busy", ...);                   // 否则 = 活锁
```
即 **"未配对 start 之后又出现 `session/end-seed`" ⇒ 上一个进程生命周期遗留的孤儿锁，不阻塞**（`README_CORE:112`）。`session/end-seed` 在 Session 构造时自动 append（`SESS:1428-1429`）。

其它两条硬约束：
- **自动/区域路径必须有 open turn**：`owner !== null` 且 `entryState.openTurn === null` → 抛 `compactRegion: no open turn — automatic compaction events must be enclosed in a turn`（`BASIC:460-463`）。
- **手动路径必须 agent idle**：`compactNow` 用 `agent.runMaintenance`，而 `runMaintenance` 在 `phase !== 'idle'` 时直接抛（`LOOP:823-824`），被包成 `busy`（`BASIC:1009-1011`）；且手动路径还要求 `entryState.openTurn === null`（`BASIC:457-459`）。

---

## 6. 第三方插件能否直接 append 这些事件复用语义？

**能，而且不需要任何 DSH 内部白名单**——`Session.append` 是公开 API（`SESS:1518-1539`），`compaction/*` 是已知事件类型（`SESS:90-93`），校验器只检查 envelope + surface 元数据。

### 6.1 `append` 的通用约束

`append(type, data, opts?)`（`SESS:1518-1539`）：
- `data` / `opts` 必须无损 JSON 可序列化（`snapshotJsonValue` 失败即抛，`SESS:1524-1527`）；
- `validateSessionEventData(event, ...)`（`SESS:1536`）；
- **重入保护**：在另一个 append 的发布过程中再 append → `session append cannot reenter while another append is being published`（`SESS:1569-1573`）。**这意味着在 `session/event` 监听器里直接 append 会抛错**（`commit` 期间 `entry.appending = true`，`SESS:1582`）。→ 后台插件必须把写入排到微任务/下一拍。

### 6.2 `replace` 的硬性要求（session 层，逐条）

1. `surfaceOp` 必须是**精确三键** `{op:'replace', startSeq, endSeq}`（`SESS:293-296`：`Object.keys(op).length === 3`）。
2. `startSeq`/`endSeq` 必须是**更早**的事件（`SESS:360`）。
3. 两个 seq 必须存在于**当前 surface**，且 `startIdx <= endIdx`（`SESS:365-370`；被 shadow 集合 = `nodes.slice(startIdx, endIdx+1)`，`SESS:371-375`）。
4. `sourceEventSeqs` 若存在：非空、正整数、无重复、全部 `< event.seq`（`SESS:315-330`）；并且**必须包含每个被 shadow 的 surface 节点**（`SESS:331-332`，`SURF:259-262` 同一逻辑）。
5. **surface node 0 的 system 保护**：若替换范围覆盖 node 0 且 node 0 是 `system/message`，则替换事件本身必须是 `system/message` 且**恰好覆盖该一个节点**（`SESS:420-424`，`SURF:382-391`）。→ 压缩把 node 0 排除在外（§3），用的是 `user/message` replace 覆盖 `[1..k]`。
6. `tool/result` 的替换被额外收紧：只能覆盖**当前恰好一个** `tool/result`，且**只允许改 `content`**（其余字段深比较必须相等）（`SESS:397-411`，`SURF:350-375`）。
7. 消息形状：`user/message` 的 `data` 就是 Message 本体，必须 `id` 非空字符串、`role === 'user'`、`source.kind` 非空字符串、`content` 是数组（`SESS:1195-1220`，`MESSAGE_ROLE_BY_TYPE` 在 `SESS:1187-1193`）。

**`tool pair 平衡校验不在 session 层**：对 `SESS` grep `tool-call|toolCall|orphan` 只命中 `ToolCallRecovery`（`SESS:805-865`，用于中断回合补结算）与 `tool/result` 消息 id 校验（`SESS:1218-1219`）。也就是说：**session 会无条件接受一个把 tool-call 与 result 拆开的 replace**，平衡必须由写入方自己保证——原生后端在 `BASIC:558-559` 与 `BASIC:426` 做的就是这个。

### 6.3 第三方"自定义事件类型"的限制

- 读路径会拒绝未知且非 `ignorable` 的事件类型：`session "..." contains event type "..." unknown to this harness and not marked ignorable; refusing to interpret the log`（`FMT:185`）。→ **不要自造 `mycompact/...` 类型**。
- 合法替代：(a) 复用 `compaction/*` 已知类型；(b) 用 `appendPluginRecord(session, "plugin:your-pkg/record", data)`，类型必须匹配 `plugin:[a-z0-9]...` 语法，事件带 `ignorable:true`、永不进 surface（`SESS:1249-1256`、`SESS:1266-1298`、`SESS:1307-1316`）。注意其文档声明**"只有仓库内 `packages/experimental/` 的生产代码可调用"**（`SESS:1282-1285`）——那是**本仓库的 CI 门禁，不是运行时限制**；外部插件调用不会被拒绝。

### 6.4 已有先例：插件直接写 session 事件 + 挂钩压缩管线

`dsh-compaction-tool-result-pruner` 是**独立插件**，它自己：
- 读取 `session.surface.nodes`，构造新的 `tool/result` 消息；
- 先 append `compaction/prune`（`{shadowedRange:{start,end}, shadowedSeqs:[seq], shadowedTokenCount}`），再 append `tool/result` 的 `replace`（`surfaceOp` + `sourceEventSeqs:[seq]`）。
证据：`PRUNER:138-192`（pruner 服务名 `toolResultPruner`，`PRUNER:62-74`）。

`dsh-compaction-image-offload` 是**纯外部 `apply(ctx)` 插件**（无 Service）：
- 注册自定义消息投影 `ctx.sessions.registerMessageProjection(imageOffloadProjection)`（`IMGOFF:141`、定义 `IMGOFF:98-122`）；
- 监听 `agent/request-error` 返回 `{kind:'retry'}`（`IMGOFF:142-146`）；
- 监听 **`compaction/summary-error`** waterfall 返回 `true`（`IMGOFF:147-152`）——这是压缩后端暴露给第三方"摘要失败可恢复"的正式扩展点（后端侧派发见 `BASIC:1018-1023`）。

→ **结论：DSH 明确允许第三方插件读写 session 事件、挂钩压缩瀑布。这正是本项目的可行性基础。**

---

## 7. `compactRegion` 能否当"后台调用"？prepare/commit 能否分离？

### 7.1 三个入口的准入条件（决定"什么时候能调"）

| 入口 | 前置条件 | 锁持有区间 | 是否阻塞调用者 |
|---|---|---|---|
| `compactIfNeeded`（pressure） | 在 turn 内（pre-step） | start → 摘要 → 提交 → end | **是**，`pre-step` 里 await（`BASIC:842`，`LOOP:910` 等待 waterfall） |
| `compactRegion` | **必须已有 open turn**（`BASIC:460-463`），owner=当前 turn，stability=whole-surface（`BASIC:973-976`） | 同上 | 是 |
| `compactNow` | **agent 必须 idle**，且抢到 `runMaintenance` 独占（`LOOP:823-832`），owner=null → `turn:null`，stability=selected-span，并在关闭后 flush（`BASIC:995-1002`） | 同上 | 是（但此时主循环本就空闲） |

**结论 1：`compactRegion` 不是"后台"接口。** 它要求 open turn，且持锁穿越整个摘要模型调用（`BASIC:470` → `BASIC:479`），期间任何其它压缩入口都会 `busy`（`BASIC:537-540`）。

**结论 2：`compactNow` 是唯一"空闲期"入口，但它会立即落地替换**，且用 `retainTokens = 0`（`BASIC:993`），比自动路径（保留 16%）**激进得多**——只留最后一个 surface 节点。如果背景预压缩直接复用它，行为会和应用内 `/compact` 一致，而不是和"自动压缩"一致。

### 7.2 prepare/commit 是否可分离

- 原生**没有**公开的 prepare 阶段：`compactSurfaceRegion` 是模块私有函数，包导出只有 `BasicCompactionEngine`（`BASIC:1028`），`begin/prepare/commit` 无对外方法。
- **但运行时存在一个可用的半成品钩子**：`BasicCompactionEngine.summarize(input, agent, signal)` 是 public 方法（`BASIC:900-904`），且 `ctx.compaction` 就是这个实例（`CORE:170-174` Service 名 `compaction`）。`input` 的形状是 `{tools?, messages}`（`BASIC:701-704`）。→ 第三方**可以**在空闲期自己构造同样的 `input`（node0 system + shadowed region 消息，用 `session.deriveEventMessage`）、调用 `ctx.compaction.summarize(...)` 拿到摘要并缓存，然后在需要的时刻**自己**取锁、写 4 个事件完成提交。
  - 这属于**未在类型/文档中承诺的运行时可用接口**（`summarize` 在 `README_BASIC:110` 被描述为"subclass 钩子"，不是公共 API）→ 标注 `[推断/未验证稳定性]`。
- 若走"自己写事件"的路线，等价于在插件里重实现 `commitCompactionBody`（`BASIC:629-676`），并自行保证：span 仍有效且平衡（对应 `BASIC:551-567`）、摘要确实更小（对应 `BASIC:601-602`）、`sourceEventSeqs` 覆盖全部 shadowed 节点（对应 `SESS:331-332`）。
- 关键优势（也是本项目"后台预压缩"的核心动机）：**摘要调用耗时在锁外**，取锁→写 4 条事件是纯同步、无 await，毫秒级完成，不会挤占主循环。

### 7.3 会不会阻塞主循环

会。`agent/pre-step` 是 await 的 waterfall（`LOOP:910`），监听器里 `await this.compactIfNeeded(...)`（`BASIC:842`）；在它返回前 `step/start` 不会 append（`LOOP:971`），模型请求不会发出。即**原生自动压缩 = 用户可感知的停顿**，且摘要请求与主请求串行。（`README_BASIC:230` 也承认这是一次"额外模型调用"。）

---

## 8. 单次压缩的 token 成本

成本来源（一次成功压缩）：

| 项 | 内容 | 证据 |
|---|---|---|
| 输入 | node0 `system/message` + 当前 `tools` + **全部被 shadow 区域消息** + 固定指令（作为最后一条 user） | `BASIC:696-705`、`BASIC:306-312`、`BASIC:318` |
| 输出 | ≤ `config.maxTokens`（默认 65536，含推理 token） | `BASIC:319`、`BASIC:65`、`README_BASIC:73` |
| 记账 | 返回 `usage` 写入 `compaction/summary.usage`，回传 `CompactionResult`（不含 usage） | `BASIC:337`、`BASIC:649`、`BASIC:663-675` |
| 重试 | 收敛重试会**重复支付**（`compactionRetries` 默认 1） | `BASIC:949-960`、`README_BASIC:230` |

**是否计入主上下文**：**不计入**。三条证据：
1. 这次调用走 `ctx.llm.stream()`（`BASIC:324`），而 `dsh-llm` 的 `stream` 路径**不 append 任何 session 事件**（grep `\.append\(` 在 `LLM` 全文零命中；`stream` → `streamWithRegistration` → `adapterStream`，`LLM:2394-2399`、`LLM:2310-2382`）。
2. token-meter 的压力只来自 `request/header` 的 envelope + `assistant/message|attempt` 的 usage 锚点（`METER:723-766`、`USAGE_PROJ:60-66` 的 `usageOf`），摘要调用不产生这两者。
3. 摘要返回后唯一进入上下文的是替换后的 checkpoint 消息（`BASIC:651-662`），体积由收缩校验保证小于原区域（`BASIC:601-602`）。

补充：`purpose: "compaction"` 与 `sessionId` 被传给 `GenerateOptions`（`BASIC:320-321`），但在 `dsh-llm` 运行时**未见读取这两个字段**（grep 无命中）——可能由适配器/遥测使用，**未验证**。

---

## 9. 能力 / 复用性表

| 能力 | 原生是否提供 | 第三方可否复用 | 结论 | 关键证据 |
|---|---|---|---|---|
| 读当前压力（token 数 / 各节点价） | ✅ | ✅ 直接调 `ctx.tokenMeter.measure(session)` | **可复用**，无需权限 | `METER:723-766` |
| 读阈值（何时该压） | ✅ 但**未导出**：`resolveCompactSpec` 是模块私有函数 | ⚠️ 只能按公式自己算：`floor(min(W*0.8, W-O-65536))`，`W` 从 `ctx.llm.resolveModelInfo()` 取 | **需适配（自己重算）** | `BASIC:125-148`、`LLM:2112-2139` |
| 选择安全压缩区间（含 tool pair 平衡） | ✅ `selectCompactableRange` **未导出** | ✅ 但 `toolPairingBalancedBefore/After` **已从包根导出**，可完整复刻选择算法 | **可复用（重实现 ~20 行）** | `CORE:81-94`、`BASIC:411-434` |
| 只调摘要器、不落地 | ❌ 无公开 prepare | ⚠️ `ctx.compaction.summarize(input, agent, signal)` 运行时存在（非契约 API）；`input` 需自建 | **需适配 + 未验证稳定性** | `BASIC:900-904`、`BASIC:696-705` |
| 出摘要后自行提交（锁外摘要 + 锁内提交） | ❌ | ✅ 写 4 条事件即可，session 不拦 | **可实现** | `SESS:1518-1539`、`BASIC:629-676` |
| 立即压缩（等主循环空闲） | ✅ `compactNow` | ✅ `ctx.compaction.compactNow(agent, signal)` | **可复用，但激进（retainTokens=0）** | `BASIC:986-1012`、`BASIC:993` |
| 在当前 turn 内压缩 | ✅ `compactRegion` | ⚠️ 只能在有 open turn 时调，且会与原生自动压缩争锁 | **需适配** | `BASIC:972-977`、`BASIC:537-540` |
| 压缩期间不阻塞主循环 | ❌ 原生 pre-step 里 await | ✅ 自建"锁外摘要 + 同步提交"即可绕开 | **可实现（核心设计点）** | `LOOP:910`、`BASIC:842` |
| 让 UI/消费者认出"这是压缩摘要" | ✅ `kind:'compact-checkpoint'` | ✅ 用 `compactCheckpointSource(compactionId)` 写进 `source` | **可复用** | `CORE:110-131`、`BASIC:597-600` |
| 复用原生压缩锁（避免与 `/compact` 打架） | ✅ | ✅ 只需 append `compaction/start`/`compaction/end` | **可复用（但必须原子闭合）** | `BASIC:537-540`、`BASIC:707-735` |
| 自造事件类型 | ❌ 读路径拒绝 | ❌ | **不可实现**（除非 `ignorable:true` / `plugin:` 记录） | `FMT:185`、`SESS:1266-1298` |
| tool pair 平衡校验 | ✅ 仅在后端层 | ❌ session 层不校验 → **必须自己保证** | **需自担风险** | `BASIC:558-559`、无 session 侧校验（§6.2） |
| 摘要失败可恢复钩子 | ✅ | ✅ 监听 `compaction/summary-error` waterfall | **可复用** | `BASIC:1018-1023`、`IMGOFF:147-152` |
| 用户可见性 | 替换消息 **不进人类 transcript** | 同左 | 压缩产物只对模型可见 | `SURF:41-51` |

### 9.1 对插件设计的四条直接结论

1. **不要试图"接管" `ctx.compaction`**：`CompactionEngine` 以固定服务名 `compaction` 注册（`CORE:170-174`），`CORE:161-169` 明确"Load one implementation per context as `ctx.compaction`"（`CORE:168`）；同 context 内再挂一个同类 Service 属于未定义行为（Cordis 同名服务冲突的**具体表现未验证**），而挤压掉 `dsh-compaction-basic` 会同时失去自动触发与 `/compact` 后端。
2. **后台预压缩的正确形态是"旁路 + 同语义提交"**：空闲时用 token-meter 判断 + 自己在锁外跑 `ctx.llm.stream()`（或借用 `summarize`）产出摘要并缓存；到了要生效的时刻，**同步**写 `compaction/start → compaction/summary → user/message(replace) → compaction/end` 四条事件（全部无 await），复用原生锁语义与 checkpoint 标记。
3. **必须自己实现的校验**：`toolPairingBalancedBefore/After`（已导出，`CORE:81-94`）、span 仍在 surface 且连续、摘要确实更小、`sourceEventSeqs ⊇ shadowedSeqs`。
4. **不要在 `session/event` 监听器里 append**（重入保护，`SESS:1569-1573`）；也不要在持有 `runMaintenance` 时调 `compactNow`（`phase !== idle` 会抛，`LOOP:824` + `BASIC:989`）。

---

## 10. 明确未验证 / 需实测

- `CompactionResult`、`compaction/*` 事件的**字段类型**：本构建无 `.d.ts`，只能由构造点反推（§1.2、§5.1）。
- 客户端 UI 是否按 `isCompactCheckpointSource` 渲染"已压缩"提示：未检查 `dsh-client-ui-*` 包，**未验证**。
- `purpose:"compaction"` / `sessionId` 在适配器与遥测层的消费：`dsh-llm` 运行时未读取，**未验证**下层行为。
- `ctx.compaction.summarize()` 作为公共 API 的稳定性：运行时可用但不是契约，**未验证**跨版本兼容。
- `appendPluginRecord` 的 `packages/experimental/` 调用限制是否存在外部插件运行时校验：**未验证**（文档写作"gate"，看起来是仓库 CI）。
- 自动压缩在 `auto:false` 时是否仍响应 `context-overflow`：从 `BASIC:828` 看**整个自动注册块都不挂载**，故溢出恢复也一并关闭 → `[推断]` 已关闭，建议实测确认。
