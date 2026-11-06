# 测试实现报告：发现的实现缺陷与观察

> **状态（Lead 更新，2026-11-05）**：本报告发现的 **#1–#5 全部已由 Lead 修复**，原先用于记录“期望行为”的 skip 用例已改为常规回归用例并全绿；3 项低严重度项已定案；配置面随后按用户要求收敛为“只保留异步调度参数”（见“配置面收敛”一节）。
> 当前 `node --test` 结果：**284 tests / 284 pass / 0 fail / 0 skipped**（约 1.1s；含 `client.test.js` 的 29 个 UI 用例——该文件由 impl-ui 维护）。
> - **#1**：`src/commit.js` 不再写入值为 `undefined` 的字段；`src/summarizer.js` 回退路径同时返回 `rawOutput`。
> - **#2**：`manual.onAbort` 现在通过 `cancelActiveManualTask()` 真正终止后台任务；迟到的摘要完成不再写事件/状态。
> - **#3**：手动超时改为 reject `code='cancelled'`（此前用了闭集外的内部码 `'timeout'`）。
> - **#4**：`manualFailureOf` 增加 `case 'changed'`；`invalidate()` 同步触发 `failManual(changed)`，changed 自动重试一次可用。
> - **#5**：保留策略按后端 `resolveRetention(override, inherited)` 的完整顺序合并（`target.retainTokens` > `target.retainRatio` > `backend.retainTokens` > `backend.retainRatio` > 默认 16%，再 clamp）。
> - 低严重度定案：`minShadowedTokens` 对手动路径不再生效（已修复）、手动落地日志文案保持现状（决定：`manual=true` 字段足以区分）、`DEFAULTS` 数组复制问题随配置键删除而消失。
> - **配置面收敛**：删除 9 个“如何压缩”的键，插件只负责异步调度；保留/摘要/最小压缩比/模型作用域全部回归后端契约（详见下文）。
> - **配置面再收敛**：配置 **25 → 16 键**——手动超时移除（移交原生生命周期）、自适应 8 个调参移到 `src/internal-policy.js` 常量（详见“配置面再收敛”一节）；调试日志系统新增 `logBufferSize`（volatile）后为 17 键，并发模型收敛又移除 `maxConcurrent`，**当前 16 键**。
> - **独立审查修复 #6–#12**：手动请求改为 supersede 自动工作（不再复用自动保留区间）、checkpoint source 带 `sourceCommandId`、手动 commit 后 flush、prune 保护 pending 手动状态、hook restore 删除 own 属性、未知配置键诊断 warning（19 个 legacy 键静默）等（详见“独立审查修复”一节）。
> - **可视状态接口**：只读 `/api/pre-compact/status` 供 token 指示器轮询（`working/ready/failed/done/idle` 投影、8s 窗口、同源校验、`no-store`，仅聚合数字），并验证 `ctx.inject(['webServer'])` 路由注册/注销（详见“可视状态接口”一节）。
> - **调试日志系统**：内存环形缓冲（容量 `logBufferSize`，默认 500，0=关闭，volatile 即时生效）+ 字段 sanitize、`snapshot/clear/stats` API、只读 `GET /api/pre-compact/logs` 与 `/precompact logs [n]` 命令（详见“调试日志系统”一节）。
> - **会话视图可视化数据**：每会话 `samples`（120，每次 evaluate，含 turn/step）、`steps`（全量不设容量，按 step upsert/升序、内存态）与 `history`（30，仅成功提交，含快照时 turn/step）、只读 `GET /api/pre-compact/history`（current 白名单 + 三条序列），与 status/logs 一起注册三条路由（详见“会话视图可视化数据”一节）。
> - **自适应 warm start**：压缩后 growth 重建期间复用上次 dataComplete 推导的阈值（而不是掉回 65% fallback），policy 与 coordinator 均有回归（详见“自适应 warm start”一节）。
> - **运行中手动压缩（step 基线）**：`/compact` 在回合执行中请求时保留当前 in-flight step、只压缩更早历史，并在 `step/end` 以
>   `step-boundary` 安全落地（详见“运行中手动压缩”一节）。

- 测试命令：`node --test`（本机 Node v22.17 / Windows 下 `node --test test/` 会把目录当模块入口报 `Cannot find module ...\test`，已按 Lead 通知改用自动发现）
- 测试只写 `test/`；未修改 `src/`、`index.js`、`client.js`、`client.test.js`、`package.json`、`cordis.patch.yml`。

---

## #1【高｜已修复】回退摘要路径的 compaction/summary payload 含 `undefined`，真实宿主会拒绝 append

### 影响面
当挂载的 compaction 后端**没有 `summarize()` 钩子**（即不是 `dsh-compaction-basic` 的实例，而是其它/自定义后端）时，插件走
`src/summarizer.js` 的 `fallbackSummarize()`。该路径能成功产出摘要并进入 `READY`，但**永远无法提交**：替换事件前的那条
`compaction/summary` 会被宿主的 append 校验拒绝。

### 根因链（修复前的源码行号）
1. `src/summarizer.js:180-188`：回退结果返回 `{ summary, llmStreamCall: true, provider, model, maxTokens, ... }`，
   **没有 `rawOutput` 字段**。
2. `src/commit.js:229-231`：提交时按 `llmStreamCall === true` 无条件构造
   `{ rawOutput: prepared.rawOutput, llmStreamCall: true }` → payload 中出现 **`rawOutput: undefined`**。
3. 真实 `Session.append()` 在写日志前用 `snapshotJsonValue()`（`@deepseek-ai/dsh-util-values`）做“无损 JSON”快照；
   该函数的对象分支会遍历所有 own enumerable key 并递归校验，**任何位置出现 `undefined`（包括对象属性）都会使整个 payload
   无效**（`research/extracted/dsh/node_modules/@deepseek-ai/dsh-util-values/lib/index.js:676-776`：
   非 object/boolean/string/number 的值直接 `return void 0`；`dsh-session/lib/index.js:1524-1527` 对返回值判空后抛错）。
   因此 append 抛：`session event "compaction/summary" carries non-JSON-serializable data`。
4. `src/commit.js` 的失败兜底会追加一条带 `error` 的 `compaction/end`（锁正确闭合），再抛
   `CommitError('commit-failed')`；`applyReady` 将其归类为 `REJECTED`，原上下文不变。

即：**失败是安全兜底的（不丢历史、不留活锁），但回退摘要功能实际不可用。**

### 复现（修复前）
- 会话（`turns=10, toolPairs=1, extraTokens=20000`）以 `fixedThreshold=0.05` 触发后台摘要 → `READY` → `agent/pre-step`。
- 实际：日志尾部 `compaction/start` + 带 error 的 `compaction/end`；无 `compaction/summary`、无替换；`phase=REJECTED`，
  `lastFailure.code='commit-failed'`。

### 修复点（Lead）
- `src/commit.js`：只写存在的字段（`callRecord` 用条件展开），不再产生 `undefined`。
- `src/summarizer.js`：回退路径返回 `rawOutput: blocks`（与原生 `llmStreamCall: true` 形状一致）。
- 回归守卫：`test/summarizer.test.js` 的 `fallback commit lands four events without undefined fields (REPORT #1 regression)`
  与 `fallback summarization commits on a real host (REPORT #1 fixed)`（均绿）。

---

## #2【中｜已修复】中止手动 `/compact` 后，后台摘要仍会继续并在之后的边界把结果落盘

### 影响面
调用方传入 `signal` 并在摘要进行中 abort 时，Promise 正确 reject `cancelled`，但**后台任务没有被 abort**：
`manual.onAbort` 只 reject 请求（并在已有 READY 时 discard），没有取消 `state.active`。于是摘要继续跑完进入 `READY`，
并在此后任意安全边界被 `applyReady` 提交 —— 一个**已被取消的请求实际生效**。

### 复现（修复前）
1. `compactNow(agent, signal)` 启动手动任务并让 summarize 挂起；
2. `signal.abort()` → Promise reject `cancelled`；此时无事件（正确）；
3. 释放 summarize → 任务仍到达 `READY`；再触发 `agent/pre-step` → 4 条 compaction 事件落盘（错误）。

### 修复点（Lead）
- `manual.onAbort` 首行调用新增的 `cancelActiveManualTask(state, reason)`：bump `state.generation`、标记 `task.abandoned`、
  abort 任务、清 `state.active`；随后 discard 手动 READY 并 reject `cancelled`。
- `startTask` 在 `await summarize` 之后与 `catch` 入口都检查 `task.abandoned || state.generation !== taskGeneration || disposed`；
  迟到的完成/失败**不再写任何事件或状态**（只记 debug `abandoned summarization settled late`）。
- 回归用例：`test/manual-hook.test.js` → `an aborted manual request does not commit later`（绿）。

---

## #3【中｜已修复】手动超时的 reject code 落在宿主闭集之外（`'timeout'` 而非 `'cancelled'`）

### 影响面
宿主 `ManualCompactionError.code` 是封闭集合 `busy|cancelled|changed|summary|commit`（`dsh-command-compact` 用 `switch` +
`assertNever` 穷举）。`manualFailureOf('timeout')` 本身已映射为 `cancelled`，但 deadline 处理直接
`rejectManual(state, 'timeout', ...)`，绕过了映射，产出集合外的 `error.code='timeout'`；宿主 UI/消费者按闭集分支时可能落空。

### 复现（修复前）
让手动任务在 `READY` 但 agent `running`（不立即落地），触发 `timer.timeout` 回调 → Promise reject，`error.code === 'timeout'`；
同时 READY 已被 discard（这部分行为正确）。

### 修复点（Lead）
- deadline 处理改为 `cancelActiveManualTask(state, 'manual-timeout')` + `rejectManual(state, 'cancelled', ...)`，
  并照旧 discard 手动 READY。
- 当时的回归用例：`test/manual-hook.test.js` → `a manual timeout rejects with code "cancelled"`
  （已随插件 deadline 被移除而由“无插件 deadline”用例取代，见下）。

> 后续「配置面再收敛」**移除了插件自有的手动 deadline**（生命周期交回原生），因此该用例被“无插件 deadline”用例取代；
> `manualFailureOf('timeout')` 映射保留，用于把底层 summarize 抛出的超时错误映射为 `cancelled`。

---

## #4【中｜已修复】`changed` 自动重试失效：失效路径把已映射的字面量 `'changed'` 再传给映射函数

### 影响面
规格要求“选中历史变化 → `changed` 自动重试一次”。`manualFailureOf` 的职责是把**内部 commit 码**（如
`surface-replaced` / `span-changed`）映射为 `changed`；但失效路径（`invalidate()`、`startTask` 的 invalidated 分支）调用的是
`manualFailureOf('changed', reason)` —— 映射表没有 identity case `'changed'`，于是落入 `default`：

- 返回 `{ code: 'summary', message: 'Compaction failed: <reason>' }`（错误分类错误，应为 `changed`）；
- `failManual` 的重试条件是 `failure.code === 'changed'` → 永远不成立 → **重试分支是死代码**。

### 复现（修复前）
手动摘要进行中，对 surface 做一次 `tool/result` 重写（pruner 式 replace）→ `invalidate()` → 请求立即 reject
`code='summary'`（所有 `rewriteToolResult` 期间 `summarizeCalls` 仍为 1，无第二次摘要）。

### 修复点（Lead）
- `manualFailureOf` 增加 `case 'changed'`（identity 映射）。
- `invalidate()` 同步触发 `failManual(changed)`（并 bump generation，不再等待不配合 abort 的 summarize 返回），
  因此重试能立即开始；旧调用因 abort 计入 aborted，不计入 pending。
- 回归用例：`test/manual-hook.test.js` → `a changed history retries a manual request once`
  （断言 `summarizeCalls.length===2`，最终 resolve 为宿主形状结果）；另有
  `a surface invalidation during the manual summary never applies a stale result` 守卫“失效快照不得落盘”。

---

## #5【低｜已修复】per-model `retainRatio` 未覆盖后端全局 `retainTokens`（与后端自身合并语义不一致）

### 影响面（修复前）
后端 `dsh-compaction-basic` 的 `resolveTargetPolicy()` 用 `resolveRetention(override, inheritedRetention)` 合并保留策略：
**精确模型策略里的 `retainRatio` 会覆盖全局 `retainTokens`**（`override.retainTokens !== undefined` 优先，
否则 `override.retainRatio !== undefined` 优先，两者都没有才继承全局）。修复前的 `resolveNativePolicy()` 则先在
`targetPolicy`/全局之间取 `retainTokens`，只有当目标策略与全局都没有 `retainTokens` 时才看 `targetPolicy.retainRatio`。
因此当后端配置为“全局 `retainTokens` + 某模型只配 `retainRatio`”时，插件按全局绝对 token 数保留，而后端实际按该模型的
ratio 保留——两者保留尾部不同，预压缩的触发/提交范围会与原生压缩不一致（“完全跟随后端策略”目标里的一个边角）。

### 复现（修复前）
- 后端：`{ thresholdRatio: 0.8, headroomTokens: 0, retainTokens: 8000, modelPolicies: [{ provider: 'target-provider', model: 'target-model', retainRatio: 0.25 }] }`
- 会话路由 `target-provider/target-model`，contextWindow 200000、maxTokens 1024（messageBudget 198976）。
- 后端自身会得到 `floor(198976 * 0.25) = 49744`（再 clamp 到 `floor(160000*0.9)=144000`）。
- 修复前插件实际返回 `retainTokens = 8000`；期望 **49744**。

### 期望优先级
目标策略 `retainTokens` > 目标策略 `retainRatio`（按 messageBudget 推导）> 后端全局 `retainTokens` >
后端全局 `retainRatio` > 内置默认 16%，最后统一 `max(0, min(retainRaw, floor(thresholdTokens*0.9)))`。

### 修复点（Lead）
`src/native-policy.js` 的保留解析改为按后端 `resolveRetention(override, inheritedRetention)` 的显式顺序分支：
`target.retainTokens` → `floor(messageBudget * target.retainRatio)` → `backend.retainTokens` →
`floor(messageBudget * backend.retainRatio)` → 默认 16%，再统一 clamp。

### 回归
- 正式用例（已由 skip 启用）：`test/native-policy.test.js` →
  `a target retainRatio beats a global retainTokens, like the backend (REPORT #5 fixed)`，断言全局 `retainTokens=8000` +
  目标 `retainRatio=0.25` 时返回 **49744**（而不是 8000）。
- 其余 6 条 native-policy 用例覆盖规范化/目标命中/全局回落/仅 ratio 推导/override 优先级/内置默认，均绿。

---

## 独立审查修复（#6–#12）

> 来源：GLM-5.3-Flash high 独立审查 + Lead 修复。以下条目均已修复并有回归用例。

### #6【中｜已修复】手动请求复用自动结果会破坏手动保留语义
修复前 `tryManualCompaction()` 若发现自动 READY 或在途自动任务就挂接复用：落地的是自动保留区间（后端 16% 尾部），
而自动专属的 `small-reduction(5%)` 失败还会把等待中的手动请求以 `summary` 拒绝。
**修复**：手动请求接受后先 `supersedeAutomaticWork(state)`——丢弃自动 READY（`discard(..., 'manual-request-supersedes')`，
`lastOutcome.reason` 可查）、对在途自动任务 `abandoned = true` + `generation += 1` + abort 并清空 `active`，
随后**总是启动全新的手动任务**（retain=0、只要求“更小”）；日志 `manual request superseded automatic pre-compaction work`。
**回归**：`test/manual-hook.test.js` →
`a manual request discards an existing automatic READY result and compacts with manual semantics`（自动 READY 被丢弃、`summarizeCalls===2`、
落地区间从 node1 起只留最后节点）、
`an in-flight automatic task is abandoned when a manual request arrives`（自动任务 abort、迟到完成不落地、手动独立完成）、
`an automatic small-reduction failure never rejects a waiting manual request`（会被自动 5% 门槛拒绝的超大摘要不再污染手动请求，手动 `COMPLETED`）。

### #7【中｜已修复】手动落地消息的 `source` 缺 `sourceCommandId`（审查 #2）
**修复**：`checkpointSource(compactionId, sourceCommandId)`、`createCheckpointMessage(..., sourceCommandId)`、
`prepareCheckpoint(..., sourceCommandId)` 与宿主 `compactCheckpointSource()` 同形；manual 命令 id 写入
`user/message.source.sourceCommandId`，三条 compaction 事件也带同一 id。fake-harness 的两个 native 写入函数同步改为宿主形状。
**回归**：`test/manual-hook.test.js` → `sourceCommandId is carried into the result, checkpoint source and compaction events`
（result / start / summary / end / replace.source 五处一致）；
`test/surface.test.js` 的 checkpoint 构造与 source 辅助函数用例；`test/summarizer.test.js` 的 `prepareCheckpoint` 用例；
`test/commit.test.js` → `appendCompaction carries sourceCommandId into the lifecycle, summary and checkpoint source`。

### #8【低｜已修复（防御性兜底）】skip 分支 + 无 attached agent 时手动请求永久悬挂（审查 #3）
**修复**：`startTask` 的 `built.skip` 分支在 `state.manual !== null` 且 `attachedAgent(state) === undefined` 时
`rejectManual(state,'summary','...no attached agent.')`。
**可达性说明**：修复 #6 后手动请求会先 supersede/abort 自动任务，因此“手动 pending 时仍有自动任务走到 skip”的旧路径**不可达**；
该 reject 分支作为防御性兜底保留。原先的白盒复现用例已移除（不可达），查询正确性改由 #6 的 supersede 用例与
`test/manual-hook.test.js` → `a manual request whose session goes away before its task starts rejects cancelled`
（accepted 后、`beginManualTask` 恢复前会话失效 → 可达的 cancelled 收敛）共同覆盖。

### #9【低｜已修复】手动 commit 后缺少持久化检查点
**修复**：`applyReady()` 在手动结果落地后调用 `flushSession(session)`（`ctx.get('sessions').flush(session)`，fire-and-forget，
失败仅 warn），对齐原生手动路径。
**回归**：`test/manual-hook.test.js` → `a manual commit asks the host to flush the session`
（`ctx.sessions.flushes === [session]`）、`a flush failure is logged and does not reject the manual request`
（`flushError` 下 resolve 不受影响，日志含 `manual compaction flush failed`）。

### #10【低｜已修复】prune 可能清掉 pending 手动请求的 state
**修复**：`pruneStates()` 的 candidates 过滤与删除条件都要求 `state.manual === null`，避免手动 pending 时会话 state
被清掉导致 Promise 永久悬挂/孤儿状态。
**回归**：`test/manual-hook.test.js` → `pruneStates keeps a session whose manual request is still pending`
（白盒：`createRuntime` + `stateFor` 构造 >32 状态后触发修剪，pending 会话仍可 `statusFor`，`manualRequest.id` 保持）。

### #11【低｜已修复】hook restore 留下 own 属性会遮蔽后端后续升级
**修复**：patch 时记录实例原本是否 own `compactNow`；restore 时原本无 own 属性的实例执行 `delete engine.compactNow`
（恢复原型方法），原本有 own 才写回。
**回归**：`test/manual-hook.test.js` → `restore deletes the own property when compactNow was inherited from the prototype`
（原型提供 `compactNow` 的 fake engine：patch 后 `Object.hasOwn === true`，dispose 后为 `false` 且调用走原型方法）；
原有“own 属性还原”用例保留。

### #12【低｜已修复】配置诊断与死代码
**修复**：`resolveConfig()` 对**未知且非 legacy** 的键发出 `unknown config key "<key>" was ignored` warning；
18 个历史旧键（第一轮 9 个语义 + 第二轮 9 个超时/自适应）+ 并发收敛移除的 `maxConcurrent` 共 **19** 个 legacy 键保持静默忽略。另删除死代码
`if (config.fixedThreshold > 1) config.fixedThreshold = 1`（范围校验已覆盖，行为不变）。
**回归**：`test/config.test.js` → `unknown keys are dropped from the resolved config and diagnosed`
（2 个未知键 → 2 条 warning、resolved 仍 16 键）、`every removed key is silently ignored (no warning, not resolved)`（19 个 legacy 键 → 0 warning）。

---

## 会话视图可视化数据（samples/history + /api/pre-compact/history）

**用途**：给 Web UI 的会话视图提供有界的上下文曲线与“已应用的压缩”历史，同时保留 composer 旁指示器用的轻量
`/api/pre-compact/status`。

**实现形状**（`src/coordinator.js`、`src/history-endpoint.js`、`index.js`）：
- 会话轮次/步骤：`onSessionEvent()` 收到 `step/start` 时用 `event.data.turn`/`event.data.step` 更新 `state.turn`/`state.step`
  （`turn/start` 只更新 turn）；`statusFor()` 新增顶层 `turn`、`step`（未观察前为 null）。
- 每会话 `state.samples`（容量 **120**）：每次 `evaluate()` 记录 `{at, tokens, trigger, native, turn, step}`
  （trigger/native 取自本次 decision / native policy，缺失为 null；turn/step 为评估时的当前值，可能 null），超出后 shift 最旧；
  同一次评估同时维护 `state.steps`（**全量、不设容量**，仅内存态、插件重载清空）：按 `step` upsert（同一步只保留最后一条）、始终升序；
  `state.history`（容量 **30**）：`applyReady()` 成功提交后记录
  `{at, turn, step, manual, trigger, mode, boundary, compactionId, shadowedTokens, framedTokens, reduction, totalAfterEstimate, durationMs}`
  （turn/step 在 task 创建/快照开始时捕获为 `task.turn`/`task.step`，READY 时写入 `ready.*`，代表“这次压缩被决定时的位置”）；
  dry-run/失败/取消**不记录**。
- `statusOfState()` 输出新增顶层 `turn`/`step` 与 `samples`、`steps`、`history`；`/precompact status` 的文本渲染不变（未加入这些字段）。
- `GET /api/pre-compact/history?sessionId=` → `{ok,version:1,now,sessionId,current|null,samples,steps,history}`；
  `current` 为严格白名单（**20 键**：enabled/phase/mode/applyStrategy/currentTokens/contextWindow/usageRatio/trigger* /
  nativeThreshold* / growthRateTokensPerSecond / predictedDurationSeconds / turn / step / lastSkip / manualRequest / manualHook / lastFailure），
  不含 `readyResult`/`activeTask`/`derivation`/`lastOutcome`/`surfaceNodes`；诊断对象继续裁剪：
  `lastFailure → {at,code}`、`lastSkip → {at,reason}`、`manualRequest → {id,requestedAt,retried}`（不泄露错误链、选择 detail 或 command id）；
  `samples`/`steps`/`history` 逐项浅拷贝（调用方修改响应不污染 runtime state）；同源检查、sessionId 正则（非法 400）、
  `cache-control: no-store`、未知会话 `current:null` + 三个空数组、异常 500。
- 同一次 `ctx.inject(['webServer'])` 现在注册 **三条** exact 路由（status/logs/history），dispose 全部注销。

**回归覆盖**：
- `test/history-endpoint.test.js`（10 用例）：
  `the history endpoint returns the bounded series and applied compactions`（200/JSON/no-store、samples/steps/history 内容等价）、
  `current is a strict whitelist aligned with runtime.statusFor()`（精确 20 键；`turn`/`step` 透传为 7/4；隐藏字段不出现；
  `lastFailure` 深等于 `{at,code}`、`lastSkip` 深等于 `{at,reason}`、`manualRequest` 三字段）、
  `current.turn and current.step stay null before any turn/step was observed`、
  `samples, steps and history are per-request copies, not runtime state references`（修改响应数组/对象后第二次请求与 state 不变）、
  `an untracked session answers current:null with empty arrays`（samples/steps/history 均为 `[]`）、
  `sessionId must match the shared id shape (400 before querying the runtime)`（缺失/空/空格/`a/b`/129 字符 → 400 且不触达 runtime）、
  `the history endpoint enforces the same-origin guard`（同源/无 Origin 200，跨源/非法 Origin 403）、
  `a throwing statusFor reports 500 instead of crashing`、
  `malformed samples/steps/history on the status collapse to empty arrays`、
  `apply() registers all three read-only routes and dispose unregisters each`（三条 exact 路由 + 全部注销）。
- `test/session-view.test.js`（14 用例，白盒 `createRuntime` + `_internals`）：
  `statusFor() exposes samples and history as empty arrays by default`（数组类型/默认空；顶层 `turn`/`step` 默认 null；`steps` 默认 `[]`）、
  `turn/start updates the status turn and the next sample records it`（append `turn/start {turn:3}` 后 status.turn=3、
  下一条 sample.turn=3；再切换 turn 4 后新 sample 为 4、旧样本保留 3）、
  `step/start updates the status step and the next sample records it`（`step/start {turn:8,step:2}` 同时更新 turn/step、
  样本记录 2；切到 step 3 后新样本 3、旧样本保留 2）、
  `the context sample series is bounded to the newest 120 evaluations`（125 次 evaluate 后 120 条、保留最新、字段
  `{at,tokens,trigger,native,turn,step}` 与类型；无事件时 turn/step 均为 null）、
  `steps keep one point per step, upserting repeats and staying ascending`（同一步二次 evaluate 只保留一条且取最新 tokens；
  step 3→2 乱序到达后序列仍 [1,2,3]）、
  `the steps series keeps every step while samples stay at 120`（205 个 step 后 `steps` 205 条、首条 step=1、
  末条 205、升序；`samples` 仍 120）、
  `a committed manual compaction appends one history entry with the public fields`（13 字段含 turn=5/step=7、manual/trigger/mode/boundary、
  compactionId 与结果一致、reduction/shadowed/framed/totalAfterEstimate/durationMs）、
  `the history turn/step are captured when the task snapshot starts, not when it completes`（turn=5/step=3 开始、摘要期间
  `step/start {turn:6,step:4}`、提交后 `history[0].turn===5`/`step===3` 且 `status.turn/step===6/4`）、
  `the coordinator warm-starts the adaptive target after a growth reset`（先录得 dataComplete 的 75% 目标，清空 growth 后
  下一次 evaluate 仍为 150000、`triggerReason='adaptive-warm-start'`、derivation 含 warmStart*）、
  `a fresh adaptive session without history still falls back to fallbackThreshold`（无 warm start 时 65%=130000、reason `adaptive-fallback-no-data`）、
  `a dry run does not append to the applied-compaction history`（dryRun 的 lastOutcome 仍记录、无 history/commit）、
  `a rejected commit does not append to the applied-compaction history`（锁占用 → REJECTED、history 空）、
  `a cancelled manual request does not append to the applied-compaction history`、
  `the applied-compaction history is bounded to the newest 30 commits`（31 次手动提交后 30 条、最旧被丢弃、字段一致）。
- `test/logs-endpoint.test.js` / `test/visual-status.test.js` 的路由集成用例同步断言**三条** exact 路由
  （`/api/pre-compact/status`、`/api/pre-compact/logs`、`/api/pre-compact/history`）且 dispose 全部注销。

**实现观察（测试按当前实现断言，已向 Lead 报告）**：
- `current.manualHook` 仍是 `statusFor()` 的原样透传对象（`{state, detail?}`）；若 `detail` 可能含内部文本，可按
  `lastFailure`/`lastSkip` 的做法裁成 `{state}` 或白名单字段。
- `samples` 在 trickle 情况下同一毫秒可重复 `at`；曲线的顺序即记录顺序，依赖时间时需自行按 `at` 稳定排序。
- `history.turn`/`history.step` 在 task 创建/快照开始时捕获（`task.turn`/`task.step`），完成期间的新 `step/start`
  不会改变已记录位置；测试用“任务开始 turn=5/step=3 → 摘要期间 step/start 6/4 → 提交后 history 仍为 5/3”的交叉场景覆盖。

---

## 运行中手动压缩（step 基线）

**动机**：回合执行中用户发起 `/compact` 时，当前正在进行的 step 属于“尚未完成的工作”，不能被当作历史压掉；
手动压缩应以**当前步之前**为基线，只压缩更早历史，并在当前步结束时安全落地。

**实现形状**（`src/coordinator.js`、`src/snapshot.js`）：
- `state.currentStepStartSeq`：`step/start` 记录 `event.seq`；`step/end`、`turn/start`、`turn/end` 清空。
- manual `createSnapshot()` 传入 `preserveFromSeq = state.currentStepStartSeq`：找到第一个 `seq >= preserveFromSeq` 的 surface 节点，
  `retainTokens = 该节点及其后所有 priced tokens 之和`（保留整个 in-flight step），只压缩更早历史；cutoff 落在第一个可压缩节点
  或之前 → `skip:'no-compactable-range'`；快照字段 `preserveFromSeq` 记录该 seq（未 preserve 时为 null），`endSeq` 必然
  早于 `preserveFromSeq`，当前步消息不进入 `shadowedSeqs`；tool-pair 平衡仍由选择器保证（不会拆开 cutoff 前的调用/结果对）。
- 新边界 `BOUNDARIES.STEP='step-boundary'`：`step/end` 且 `state.ready.manual === true` 时用 `queueMicrotask` 调
  `applyReady(state, BOUNDARIES.STEP)`（避开当前 append 的 reentrancy，回合继续）；若 `step/end` 先于 READY 到达，
  边界调用为空操作，随后下一个 pre-step 仍按原路径落地。
- 没有 in-flight step（idle / 回合开始前）时 `currentStepStartSeq === null`，行为与旧手动压缩一致（retain 0，仅保留最后节点）。

**回归覆盖**：
- `test/snapshot.test.js`（6 用例）：
  `a manual snapshot with preserveFromSeq keeps the in-flight step and shadows only earlier history`（endSeq < S、
  startSeq 为 system 后首节点、`shadowedSeqs` 不含 S 及之后、`preserveFromSeq===S`）、
  `without preserveFromSeq manual compaction keeps the native retain-0 behavior`（shadowed=nodes[1..-2]、preserveFromSeq null）、
  `a preserve cutoff without earlier history is skipped as no-compactable-range`、
  `a preserve cutoff at the first compressible node is skipped as no-compactable-range`、
  `the preserve cutoff does not split a tool pair even when it sits before the step`（assistant tool call + result 都进入 shadowed，
  endSeq=result）、
  `the preserve cutoff walks back over an unmatched tool call instead of splitting it`（未闭合调用被移出 shadowed，endSeq 更早）。
- `test/step-baseline.test.js`（5 用例，白盒 `createRuntime`）：
  `an in-flight manual compaction keeps the current step and lands on the step boundary`（step/start 记录基线；摘要期间追加当前步消息；
  `history[0].boundary==='step-boundary'`；结果 `shadowedRange.end < stepStartSeq` 且 `shadowedSeqs` 全 < S；当前步节点仍在 surface；
  `lastOutcome.appendedSinceSnapshot===1`；manual promise resolve）、
  `a step/end that arrives before the summary is ready still lands at the next pre-step`（step/end 先到不报错、无事件；READY 后 pre-step
  落地，boundary `pre-step`）、
  `without an in-flight step the manual compaction keeps the old retain-0 behavior`（切回 idle，`currentStepStartSeq=null`、
  shadowed=nodes[1..-2]、boundary `idle`）、
  `step/start, step/end and turn boundaries maintain the in-flight baseline`（step/start 记录 seq、step/end 清空、新 step 更新、
  turn/start 与 turn/end 清空）、
  `statusFor() exposes currentStepStartSeq: null by default and the step/start seq while running`（公开 status 默认 null、
  step/start 后等于事件 seq、step/end 后回 null）。

**状态暴露**：`statusOfState()` 现在返回 `currentStepStartSeq`（`state` 值或 null），基线断言走公开的
`runtime.statusFor(session.id).currentStepStartSeq`；其余断言仍用 `_internals` 驱动的白盒会话。

---

## 按步序列（steps）

**动机**：raw `samples` 只有 120 条，一个繁忙 step 的多次 evaluate 会把窗口填满，图表只剩前后两段、看不到按步趋势。
因此运行时在 `recordSample()` 中同时维护按步序列。

**行为**：
- `state.steps` **全量保留本次插件加载以来的所有真实 step，不设容量**（纯内存态，插件重载后清空）；
  每个真实 `step` 只保留一条：同一 step 的后续 evaluate **upsert** 为最后一条；序列始终按 `step` 升序。
- 条目形状与 samples 相同：`{at, tokens, trigger, native, turn, step}`；`step` 为 null 的评估不进入 steps。
- `statusFor()` 暴露 `steps`（默认 `[]`）；`GET /api/pre-compact/history` 返回 `steps`（逐项浅拷贝；未知会话为 `[]`）；
  raw `samples` 仍保持 120 容量。

**回归覆盖**：`test/session-view.test.js` →
`steps keep one point per step, upserting repeats and staying ascending`（同一步两次 evaluate 只一条且 tokens 取最新；
step 3→2 乱序后仍 [1,2,3]）、
`the steps series keeps every step while samples stay at 120`（205 步 → 205 条、首条 step 1、末条 205、升序，
samples 仍 120）、
`statusFor() exposes samples and history as empty arrays by default`（steps 默认 `[]`）。
`test/history-endpoint.test.js` → 200 用例断言 `body.steps` 内容等价；`samples, steps and history are per-request copies...`
（修改响应不影响 state）；未知会话与 malformed 用例断言 `steps === []`。

---

## 自适应 warm start

**动机**：刚完成一次压缩后 growth tracker 被清空，下一轮 `dataComplete=false`；若直接回退到 `fallbackThreshold`（65%），
会与压缩前模型刚推导出的阈值（如 75%）矛盾，造成触发位置跳变。

**行为**：
- `evaluateTrigger` 接受 `input.warmStart`；当 `dataComplete=false` 且 warmStart 有有效 `triggerTokens`（有限且 >0）时，
  目标取 warmStart，`reason='adaptive-warm-start'`，derivation 带 `warmStartTokens`/`warmStartRatio`/`warmStartAt`；
  无效/缺失 warmStart 时仍回退 `fallbackThreshold`（65%）；fixed 模式完全不受 warmStart 影响。
- `coordinator` 在每次 `mode==='adaptive' && dataComplete===true` 时把 `{at, triggerTokens, triggerRatio}` 记入
  `state.lastAdaptiveTarget`，作为下一次 evaluate 的 `warmStart`。

**回归覆盖**：
- `test/policy.test.js` → `adaptive warm start reuses the last data-complete target when data is incomplete`
  （warm 150000/0.75 被原样采用，reason/derivation 字段齐全，dataComplete=false）、
  `without a valid warm start the adaptive fallback still applies`（undefined/null/空对象/0/负数/字符串 → 65%=130000）、
  `a warm start never influences fixed mode`（fixed 决策仍按 fixedThreshold，derivation 无 warmStart 字段）。
- `test/session-view.test.js` → `the coordinator warm-starts the adaptive target after a growth reset`
  （先构造 dataComplete 的 75%（150000）决策并记录 lastAdaptiveTarget；`growth.reset()` 后再次 evaluate 仍 150000、
  `triggerReason='adaptive-warm-start'`、derivation warmStart* 正确）、
  `a fresh adaptive session without history still falls back to fallbackThreshold`（从未有完整决策 → 65%=130000、
  reason `adaptive-fallback-no-data`）。

---

## 调试日志系统

**用途**：排障时不必重新打开 debug 日志再复现问题——运行时把所有级别的结构化记录保留在内存环形缓冲里，
随时通过 `/precompact logs [n]` 或只读 HTTP 端点取回。

**实现形状**（`src/log.js`、`src/logs-endpoint.js`、`index.js`）：
- `createLogger(ctx, config)` 同时向宿主 logger 输出原有 `[pre-compact] message key=value` 单行（受 `logLevel` 控制），
  并把**所有级别（含 debug）**写入内存环形缓冲；容量来自 `logBufferSize`（默认 500，0=关闭，volatile 每次 emit 动态读取）。
- 记录形状 `{seq, at, level, event, fields}`；`sanitizeFields()` 做有界拷贝：字符串 300 字符截断（尾部 `…`）、数组 20 项
  （多出标记 `…N more`）、深度 3（`[depth]`）、循环引用 `[cyclic]`、`Error` 只留 `{name,message,code}`、`undefined` 丢弃、
  BigInt/函数/Symbol 安全字符串化；只记聚合字段、不记录消息内容。
- API：`snapshot({limit=100, level, sessionId, sinceSeq})`（`level` 为最低级别；`sessionId` 精确匹配 `fields.session`；
  `sinceSeq` 排他；返回升序的最后 N 条，limit 夹取 1..500）、`clear()`、`stats() → {capacity,count,lastSeq}`；
  `formatFields`/`sanitizeFields` 导出。
- `GET /api/pre-compact/logs?limit=1..500&level=debug|info|warn|error&sessionId=&sinceSeq=`：
  `limit` 越界/`level` 非法/`sessionId` 非法/`sinceSeq` 非负整数校验失败 → 400；跨源 → 403；正常 200
  `{ok,version:1,now,count,capacity,lastSeq,records}` + `cache-control: no-store`；logger 无 `snapshot` → 500。
- `/precompact logs [n]`（默认 30，夹取 1..200）打印 `#seq HH:MM:SS.mmm LEVEL event key=value…`，尾部给出 JSON 端点提示；
  空缓冲提示会说明 `logBufferSize=0` 关闭缓冲、`logLevel` 只控制控制台。usage 已含 `logs [n]`。
- `index.js` 在同一次 `ctx.inject(['webServer'])` 中同时注册 status 与 logs 两条 exact 路由，dispose 全部注销；
  无 webServer 时只 debug 日志。

**配置**：16 → **17 键**，新增 `logBufferSize`（number，默认 500，`≥0` 取整，volatile，0 关闭缓冲）；
`logLevel` 语义不变（只控制控制台）。后续并发模型收敛移除 `maxConcurrent`，当前 **16 键**；19 个 legacy 键仍静默。

**回归覆盖**：
- `test/log.test.js`（18 用例）：
  - 环形容量/覆盖：`capacity=3` 只留最后 3 条且 seq 连续（3,4,5）；`logBufferSize=0` 不记录并清空已有记录、seq 不增长；
    volatile 改容量后下一条 emit 立即生效并裁剪；默认容量 500。
  - 控制台 vs 缓冲：`logLevel='error'` 时宿主 logger 只收到 1 条，而 snapshot 有 4 个级别；单行格式保持
    `[pre-compact] msg key=value`；logger 抛错不影响调用方。
  - `snapshot` 过滤：最低级别、`sessionId` 精确匹配（含前缀相似 `s1`/`s10` 不误匹配）、`sinceSeq` 排他、
    `limit` 最后 N 条并升序、默认 100、`clear()` 后 seq 不重置。
  - `sanitizeFields`：长字符串 300+`…`、数组 20 项+`…N more`、对象深度 3→`[depth]`、循环→`[cyclic]`、
    `Error` 只留 name/message/code、`undefined` 从对象丢弃（数组槽位保留）、BigInt/函数/Symbol 安全、非对象输入→`{}`。
  - `formatFields`：空格/引号/`=` 触发 JSON 引号化、`null`、数组、undefined 跳过、空对象→空串、对象→`[object Object]`。
- `test/logs-endpoint.test.js`（10 用例）：200 正常 payload 与 `no-store`；`limit=1/500` 通过、0/501/-1/abc/空 → 400；
  四个合法 level 通过、`trace/WARN/空` → 400；sessionId 合法字符类通过、空/空格/`a/b`/129 字符 → 400；
  `sinceSeq=0` 与空值（Number('')→0）通过、-1/1.5/abc → 400；同源/无 Origin → 200，跨源/非法 Origin → 403；
  无 `snapshot` → 500，无 `stats` → capacity/lastSeq 为 null；`apply()` 注册 status/logs/history 三条 exact 路由并全部注销。
- `test/command.test.js`（14 用例）：`/precompact logs` 默认 30 条、行格式、JSON 提示；`logs 5` 限制显示条数；
  `logBufferSize=0` 时提示关闭原因；usage 文案含 `logs [n]`。
- `test/config.test.js`（19 用例）：16 键精确集合；`logBufferSize` 默认 500/0 合法/小数取整/非数字与负值 warning+回退；
  host schema 中 `logBufferSize` 为 `volatile` 的 number（min 0、step 1），除 `statusCommand` 外行为键均 volatile；
  未知键 warning 与 19 个 legacy 键静默不变。

**实现观察（测试按当前实现断言，已向 Lead 报告）**：
- 负 `logBufferSize` 走 non-negative 校验：warning 后回退默认 500（并非夹到 0）；`0` 才是显式关闭。
- `?sinceSeq=`（空值）经 `Number('')` 变成 0 并被接受，而不是 400；若希望空值报错需在端点里区分空串。

---

## 可视状态接口（visual-status）

**用途**：Web UI 在 token/上下文指示器旁显示“后台压缩进行中/完成”的小徽标。浏览器半侧轮询一个只读 HTTP 资源；
payload 只含聚合数字与状态，**绝不含消息内容**。

**实现形状**（`src/visual-status.js` + `index.js`）：
- `VISUAL_STATUS_PATH = '/api/pre-compact/status'`；`GET ?sessionId=`；`sessionId` 必须匹配 `/^[A-Za-z0-9_-]{1,128}$/`。
- 有 `Origin` 且与请求 `Host` 不同源 → 403；非法 sessionId → 400；正常 → 200 JSON + `cache-control: no-store`；异常 → 500。
- `buildVisualStatus(status, now)` 把 `runtime.statusFor()` 投影为
  `{ ok, version, now, state, phase, enabled, manual, startedAt, outcome, failure }`。
- `state` 优先级：`working`（有在途任务）> `ready`（有已备好结果）> `failed`（最近 `FAILED_WINDOW_MS=8000` 内、
  且 `lastFailure` 比 `lastOutcome` 新）> `done`（最近 `DONE_WINDOW_MS=8000` 内 `lastOutcome.state==='COMPLETED'`）> `idle`。
  “成功后又失败”显示失败（Lead 定案：失败优先）。
- `outcome` 仅 `{ state, at, manual, dryRun, reduction, shadowedTokens }`；`failure` 仅 `{ at, code }`；
  `manual` 来自 pending 的 `manualRequest`（已完成的 manual 标记保留在 `outcome.manual`）。
- `index.js` 在 `ctx.inject(['webServer'])` 后 `webServer.register({ kind:'exact', path, resource })`，
  dispose 时由 `webCtx.effect` 自动注销；没有 webServer 时只打 debug 日志、不影响插件启动。

**回归覆盖**（`test/visual-status.test.js`，13 用例）：
- `buildVisualStatus(null)` → `state:'idle'`、`outcome:null`、`failure:null`、`enabled:null`；payload 键集合精确固定（仅聚合字段）。
- 优先级：`working` > `ready`（同时有二者取 working；`startedAt` 取在途任务）；`done` 窗口边界（`8000ms` 仍是 done、
  `8001ms`/`9000ms` 回到 idle）；`failed` 窗口边界与“必须比上次 outcome 新”规则（旧 outcome + 新失败 → failed；
  失败更旧 → idle；**最近 completed 之后的新失败 → failed**（失败优先）；比 completed 更旧的失败被 `failureIsNewer` 挡住 → done）；
  缺失 failure code → `'failed'`。
- `manual` 透传：pending `manualRequest` → `manual:true`；完成的 manual 结果在 `outcome.manual` 中保留。
- 字段裁剪：构造带 `message`/`task`/`compactionId`/`seqs`/`detail` 的 status，断言 `outcome`/`failure` 只含公开字段、
  非数字指标归 `null`（不泄漏内部字段与内容）。
- Fetch 资源：合法 sessionId → 200、JSON、`no-store`、`statusFor` 收到 id；runtime 返回 null → idle payload；
  非法 sessionId（缺失、空、`a/b`、129 字符、含空格）→ 400 且**不调用** runtime；合法字符类与 128 长度边界 → 200；
  同源 Origin → 200，跨域/伪 Origin/非法 Origin → 403，无 Origin（同源 fetch/非浏览器客户端）→ 200。
- 路由注册：fake `ctx.inject` 立即回调 + `webServer.register` spy → `apply()` 注册
  `{ kind:'exact', path:'/api/pre-compact/status', resource:function }`，其 resource 对未知会话返回 idle；
  `ctx.dispose()` 后 disposer 被调用（测试走 `test/fake-harness.js` 新增的 `FakeCtx.inject` / `createFakeWebServer` spy，
  未白盒 runtime 内部）；无 webServer 的 profile 正常启动并输出 `web server unavailable` debug 日志。

> 说明：路由的宿主侧真实挂载（`webServer` 的实际 HTTP 服务）由 smoke/实机覆盖；本套件用 spy 验证注册 shape 与注销生命周期。

---

## 配置面收敛：只保留异步调度参数

### 理由（契约边界）
本插件的定位是**异步调度层**：什么时候在后台准备摘要、结果在哪个安全边界原子落地、并发/间隔/熔断等调度策略。
“如何压缩”属于挂载后端（`dsh-compaction-basic` 及其它 compaction 实现）的契约：保留多少尾部、用哪个模型/路由、
摘要输出上限、最小压缩比、按模型启用与否，都应由后端决定。插件自己再暴露一套语义会与同 profile 内的其它压缩插件
冲突，也让两套策略难以解释。因此 Lead 删除了 9 个配置键，`schema`/`DEFAULTS`/校验同步移除；
旧 profile 里残留的这些键会被**静默忽略**（不产生 warning，也不进入 resolved 对象）。

### 删除的 9 个键与行为迁移

| 删除的键 | 原职责 | 迁移后的行为 |
|---|---|---|
| `retainRatio`、`retainTokens` | 自动路径“保留多少尾部”的预算 | 完全跟随挂载后端：`resolveNativePolicy` 读后端全局 `config` **以及每模型 `modelPolicies`**；优先级 显式 `nativeThreshold` override > 目标模型策略 > 后端全局 > 内置默认（0.8 / 65536 / 16%）；保留仍 clamp 到 `min(retainRaw, floor(thresholdTokens*0.9))`。插件的 `minShadowedTokens` 仍是自动路径唯一的最小增益闸门 |
| `manualCompactRetainTokens` | 手动 `/compact` 的保留预算 | 固定为 **0**：原生“只保留最后一个 surface 节点”（选择器会为工具对向前扩展） |
| `summarizationProvider`、`summarizationModel` | 摘要调用路由覆盖 | 删除；优先走后端 `summarize()` hook，回退路径固定使用会话路由 `snapshot.route` |
| `maxSummaryTokens` | 摘要输出 token 上限 | 删除；后端 hook 用其后端配置，回退路径用常量 `FALLBACK_MAX_TOKENS = 65536` |
| `minReductionRatio` | 插件额外的最小压缩比门槛 | 删除；`src/commit.js` 导出内部常量 `MIN_REDUCTION_RATIO = 0.05`，`coordinator` 同步引用；手动请求仍只要求“摘要比原文小” |
| `modelAllowlist`、`modelDenylist` | 按模型/路由启用或禁用 | 删除；评估阶段不再有 `model-not-allowed` skip；`src/policy.js` 仅保留 `routeUsable(route)`（provider/model 非空）供诊断/未来使用 |

在完成上述迁移时配置面曾收敛到 25 个键；随后按用户要求**进一步收敛到 16 个键**（手动超时与自适应预测内部参数也移出配置；调试日志系统新增 `logBufferSize` 后为 17 键；并发模型收敛移除 `maxConcurrent`，当前 **16 键**），
详见下一节「配置面再收敛：手动超时移交原生 + 自适应简化」。`cordis.patch.yml` 已同步移除所有旧键。

### 后端策略的完整跟随（全局 + 每模型）

`src/native-policy.js` 中的 `readBackendPolicy()` 会读取后端 `config.modelPolicies`，并做与后端一致的规范化：
只保留 `provider`/`model` 非空的条目；每条只接受合法的 `thresholdRatio (0,1]`、`headroomTokens ≥ 0`、
`retainRatio (0,1)`、`retainTokens ≥ 0`，非法字段丢弃、非法条目整条丢弃。
`resolveNativePolicy()` 在会话路由匹配到某条 `modelPolicies` 时：

- `thresholdRatio` / `headroomTokens` / `retainRatio` / `retainTokens` 均按目标策略取值；
- 优先级：显式 `nativeThreshold` override > 目标模型策略 > 后端全局 > 内置默认（0.8 / 65536 / 16%）；
- 返回值新增 `targetPolicy: { provider, model }`（仅匹配时），供状态/日志诊断；
- 保留预算仍是 `min(retainRaw, floor(thresholdTokens * 0.9))`，目标策略只给 `retainRatio` 时按
  `floor(messageBudget * retainRatio)` 推导；
- 手动 `/compact` 仍固定 retain=0，不受 `modelPolicies` 影响。

### 迁移的回归覆盖（test/）
- **① 自动保留由后端驱动**：`test/lifecycle.test.js` → `automatic retention follows the backend policy, not legacy plugin config`
  （同一会话、后端 `retainTokens` 32 vs 512 → 被 shadow 节点数显著不同；同时传入旧 `retainTokens/retainRatio` 不改变结果）。
- **② 手动保留固定 0**：`test/manual-hook.test.js` → `manual /compact always keeps only the last surface node (retain=0, native semantics)`
  （即使传入旧 `retainTokens/retainRatio/manualCompactRetainTokens`，shadowedRange 仍从 node1 起、只留最后节点）。
- **③ 内部压缩比常量**：`test/commit.test.js` → `a summary that frees too little context is rejected by the internal MIN_REDUCTION_RATIO`
  （常量 0.05；旧 `minReductionRatio` 0.99/0.0001 均不影响判定）。
- **④ 旧键静默忽略**：`test/config.test.js` → `every removed key is silently ignored (no warning, not resolved)`
  （19 个历史旧键含错误类型：`warnings === []`、resolved 键集合仍恰好 16 个、旧键不在对象里）。
- **⑤ 路由不再被白/黑名单阻断**：`test/lifecycle.test.js` → `a legacy model allowlist/denylist no longer scopes compaction`
  （传旧 allow/deny 键仍启动任务，status 无 `model-not-allowed`）；`test/policy.test.js` 用 `routeUsable` 覆盖新的纯判断函数。
- **⑥ 回退摘要只用会话路由**：`test/summarizer.test.js` → `the fallback always uses the session route and the constant token cap`
  （传旧 `summarizationProvider/Model/maxSummaryTokens` 仍用 `snapshot.route` 与 65536）。
- **⑦ 全局 + 每模型后端策略跟随**：`test/native-policy.test.js`（7 用例）——
  `readBackendPolicy normalizes modelPolicies and drops invalid entries/fields`（规范化与非法项过滤）、
  `a matching modelPolicy drives threshold, headroom and retention`（目标策略生效 + 返回 `targetPolicy`）、
  `without a matching modelPolicy the backend global policy applies`（不匹配回落全局）、
  `a target policy with only retainRatio derives retention from the message budget and clamps it`（仅 ratio 时推导 + clamp）、
  `an explicit nativeThreshold override still beats the target policy`（override 优先级）、
  `documented fallback defaults are exported and used without a backend policy`（无后端时内置默认）；
  另有 #5 修复回归用例 `a target retainRatio beats a global retainTokens, like the backend (REPORT #5 fixed)`。
- `test/config.test.js` 另覆盖 `unwrapConfigRefs()` 对 volatile 引用 `{ get() }` 的解包。

---

## 配置面再收敛：手动超时移交原生 + 自适应简化

### 再删除的 9 个键（配置面 25 → 16）

| 删除的键 | 原职责 | 迁移后的行为 |
|---|---|---|
| `manualCompactTimeoutSeconds` | 插件自有的手动 `/compact` 超时 | **移除插件的 deadline**：手动请求的生命周期完全交回原生 compaction 语义；Promise 只在 ① 后台结果落地 ② 调用方 signal abort ③ 插件 dispose / session/agent 失效 时 settle。`manualFailureOf('timeout')` 保留，仅用于把底层 summarize 抛出的超时错误映射为 `cancelled`，插件自身不再产生 `manual-timeout` |
| `safetyMarginTokens`、`compressionTimeMultiplier`、`defaultCompressionSeconds`、`defaultGrowthTokensPerSecond`、`burstGrowthFactor`、`emaAlpha`、`growthSamplingInterval`、`growthWindow` | 自适应触发公式的调参 | 全部移到 `src/internal-policy.js` 常量；`src/policy.js`/`src/coordinator.js` 改读常量，**公式逻辑不变**，只是参数不可再配置 |

理由：手动 `/compact` 的超时属于原生压缩生命周期（native 自己拥有该请求），插件再定义一套 deadline 会与其语义重叠；
自适应参数是预测器的实现细节，8 个旋钮让公式难以推理而收益有限——只保留 `minThreshold`/`maxThreshold`/`fallbackThreshold`
三个窗口键。旧 profile 里的这些键继续**静默忽略**（无 warning、不进入 resolved 对象），`cordis.patch.yml` 已同步删除。

### 现在的 16 个键

`enabled`、`triggerMode`、`fixedThreshold`、`nativeThreshold`、`minThreshold`、`maxThreshold`、`fallbackThreshold`、
`minInterval`、`applyStrategy`、`minShadowedTokens`、`logBufferSize`（调试日志系统新增，volatile）、
`hookManualCompact`、`dryRun`、`autoAdjustFixedThreshold`、`logLevel`、`statusCommand`。

### `src/internal-policy.js` 常量

| 常量 | 值 | 含义 |
|---|---:|---|
| `SAFETY_MARGIN_TOKENS` | 4096 | 预测上下文增长之外的安全余量（tokens） |
| `COMPRESSION_TIME_MULTIPLIER` | 1.3 | 预测压缩耗时的乘数 |
| `DEFAULT_COMPRESSION_SECONDS` | 45 | 尚无耗时观测时的默认压缩秒数（×1.3 → 58.5s） |
| `DEFAULT_GROWTH_TOKENS_PER_SECOND` | 200 | 尚无增长样本时的默认增长率 |
| `BURST_GROWTH_FACTOR` | 2 | 峰值 > `ema * 2` 视为 burst（取峰值） |
| `EMA_ALPHA` | 0.3 | growth/duration 的 EMA 平滑系数 |
| `GROWTH_SAMPLING_INTERVAL_MS` | 5000 | 采样 tick 间隔（coordinator 取 `clamp(1000..10000)`） |
| `GROWTH_WINDOW_MS` | 60000 | growth 样本窗口 |

### 回归覆盖（test/）
- **配置面**：`test/config.test.js` — 16 键精确集合（`Object.keys(config).length === 16`）；`every removed key is silently ignored`
  覆盖 19 个历史旧键（9 个压缩语义 + 9 个超时/自适应 + `maxConcurrent`）；旧 timeout/adaptive 配置传入后 `resolved config` 仍 `deepEqual DEFAULTS`；
  原 `emaAlpha`/`growthSamplingInterval`/`growthWindow`/`manualCompactTimeoutSeconds` 的校验用例已删除；
  `logBufferSize` 的默认 0/取整/负值回退与 schema volatile 由独立用例覆盖（见“调试日志系统”）。
- **自适应常量**：`test/policy.test.js` — 断言 8 个常量值，且无样本时 derivation 使用它们
  （`growthSource='internal-default'`、200 t/s、45×1.3=58.5s、safety 4096、burst 2、EMA 0.3、predictedGrowth=11700）；
  旧调参键传入时 derivation 与不带旧键完全一致（`deepEqual`）。原有 full-data/burst/clamp 用例继续覆盖公式逻辑。
- **无手动 deadline**：`test/manual-hook.test.js` —
  `a manual request has no plugin-owned deadline and stays pending until aborted`（`ctx.timeouts` 为 0；推进假时钟 + tick 100 次后仍 pending；只有 abort 结束）；
  `a ready-but-unapplied manual result waits for a boundary instead of timing out`（READY 后长时间不落地仍 pending，abort 后 discard 且无事件）；
  `a legacy manualCompactTimeoutSeconds config key is ignored (no deadline registered)`（旧键不创建 deadline，release 后正常 resolve）。
  原“超时 reject cancelled / 超时丢弃 READY / deadline 预算”三条用例已删除；abort/dispose/session 失效取消用例保留。
- **采样来源**：`test/lifecycle.test.js` — `the sampling interval comes from the internal constant, not legacy config`
  （传旧 `growthSamplingInterval/growthWindow/emaAlpha` 后 `ctx.intervals[0].ms === 5000`）。
- `test/fake-harness.js` 的 timer 服务保留 `timeout()`/`ctx.fireTimeouts()`（宿主 timer 服务的形状），
  但当前插件不再注册任何 manual deadline，测试据此断言 `ctx.timeouts` 始终为空。
- **未知键诊断**：`resolveConfig()` 现在对非 legacy 的未知键发出 `unknown config key "<key>" was ignored` warning，
  18 个历史旧键 + `maxConcurrent` 共 19 个 legacy 键静默（回归：`unknown keys are dropped from the resolved config and diagnosed`、
  `every removed key is silently ignored (no warning, not resolved)`）；`fixedThreshold > 1` 的死代码已删除，
  行为不变（范围校验已覆盖）。

---

## 并发模型收敛：移除全局上限，单会话固定 1

**行为变化**：删除 `maxConcurrent`（进程级并发上限）配置及其 `activeTasks` 闸门。并发语义固定为：
- **单会话最多 1 个在途任务 + 1 个待落地结果**（仍由 `evaluate()` 的 `state.active`/`state.ready` 检查保证）；
- **不同会话之间不再互相排队**——各自可以同时运行后台摘要，没有全局并发上限。

**迁移**：配置 **17 → 16 键**；`maxConcurrent` 加入 legacy 集合（旧 profile 传入如 `4` 会被静默忽略：无 warning、不进入
resolved 对象、host schema 也不再提供该键）；`cordis.patch.yml` 同步删除；`/precompact status` 文本本就不含该字段，无需改动。

**回归覆盖**：
- `test/config.test.js` — 16 键精确集合；新增 `the removed maxConcurrent key is silently ignored`
  （`maxConcurrent: 4` → `warnings === []`、resolved 无该键、`Config.dict` 无该键）；`every removed key is silently ignored`
  的 legacy 集合扩为 **19**（18 + `maxConcurrent`），旧值/错误类型全部静默；`maxConcurrent` 默认与 >0 校验用例已删除。
- `test/lifecycle.test.js` — 保留并依赖 `same session never runs two background tasks at once`
  （同一会话连续 pre-step 仍只有 1 次 summarize、不写事件）；原“全局 `maxConcurrent` 阻止第二个会话”用例改为
  `different sessions run background tasks concurrently (no global cap)`：两个 session 各自 pre-step 后都进入
  `COMPRESSING`、`summarizeCalls === 2`，release 后各自 READY，证明不再有全局闸门。
- 其他测试/fake 配置中不再引用 `maxConcurrent`；`/precompact status` 断言不变（文本未包含该字段）。

---

## 低严重度观察（已定案）

- **`DEFAULTS` 数组浅拷贝 —— 随配置面收敛消失**：`modelAllowlist`/`modelDenylist` 已从配置面删除，
  `resolveConfig()` 不再返回数组键；旧配置里出现它们会被静默忽略（见上一节）。`src/config.js` 里先前的
  `[...DEFAULTS.modelAllowlist]` 修复也随之移除，不再有共享引用问题。
- **`minShadowedTokens` 对手动路径 —— 已修复（Lead）**：`src/snapshot.js` 的检查改为
  `if (!manual && shadowedRouteTokens < config.minShadowedTokens)`。理由：该阈值是自动触发的“省不了多少就别烧摘要”保护；
  `/compact` 是用户显式决定，应与原生一致地压缩任何存在的区间。回归用例：
  `test/manual-hook.test.js` → `minShadowedTokens protects only the automatic path, not an explicit manual request`
  （同一会话下自动路径仍 `Last skip: range-too-small`、`summarizeCalls===0`，而 `compactNow()` 成功 resolve 结果并落 4 条事件）。
- **手动落地的日志文案 —— 决定：不新增独立文案**。保持 `background pre-compaction applied` + 字段 `manual=true`；
  该字段足以区分自动/手动落地，因此不视为缺陷，测试按实际日志断言（`... applied ... manual=true`）。
- **“摘要不小于原文”的阶段归类（未变更）**：拒绝发生在后台任务阶段（`startTask` 的 `prepareCheckpoint` 校验），归类为
  `phase=FAILED` / `lastFailure.code='not-smaller'`，而非提交阶段的 `REJECTED`。两者可观察结果一致：不写任何事件、
  原上下文不变、原生压缩仍作为兜底。测试按实际行为断言（`test/lifecycle.test.js` →
  `a summary that is not smaller than the shadowed span fails closed without committing`），提交阶段的同类校验
  （`validateCommit` 的 `not-smaller`）由 `test/commit.test.js` 直接覆盖。若产品语义要求统一为 `REJECTED`，
  需要实现侧调整阶段归类。

---

## 测试文件清单

| 文件 | 用例数 | 覆盖 |
|---|---:|---|
| `test/fake-harness.js` | — | 按真实宿主语义实现的 FakeSession（append 校验、surface fold、replace 规则、sourceEventSeqs 覆盖、tool/result 受限重写、system head 保护、reentrancy）、`snapshotJsonValue` 无损 JSON 校验、tokenMeter/llm/compaction（含原生风格 `compactNow` 委托实现）/commands/sessions（含 `flush` spy）/agents/timer（`interval`/`timeout` 手动时钟）、构建器与驱动 helper、`ctx.inject` 立即回调与 `webServer.register` spy |
| `test/00-smoke.test.js` | 1 | 启动 → 触发 → READY → pre-step 提交的最小闭环 |
| `test/config.test.js` | 19 | 16 键配置面（键集合精确断言）、默认值、逐键越界回退+warning、min/max 交换、nativeThreshold、`logBufferSize`（默认 500/0 合法/取整/负值与非法值 warning+回退）与 schema volatile、**非 legacy 未知键 → warning**、19 个历史旧键静默忽略（含 `maxConcurrent`；无 warning、不进入 resolved、错误类型也不校验；含旧的 timeout/自适应调参）、手动词典校验、`unwrapConfigRefs()` volatile 解包 |
| `test/policy.test.js` | 21 | fixed/auto-adjust、adaptive 预测/夹取/burst、growth/duration EMA、usageRatio、`routeUsable`（路由不再按模型过滤）、`src/internal-policy.js` 常量值与 `internal-default` 推导、旧调参键不改变 derivation、**warm start**（data 不完整时复用上次目标、无有效 warmStart 回退 fallback、fixed 模式不受影响） |
| `test/native-policy.test.js` | 7 | `readBackendPolicy` 的 `modelPolicies` 规范化（非法条目/字段过滤）、目标模型策略生效（`thresholdRatio`/`headroomTokens`/`retainRatio`/`retainTokens` + 返回 `targetPolicy`）、不匹配回落全局、仅 `retainRatio` 时按 `messageBudget*ratio` 推导并 clamp、`nativeThreshold` override 优先级、无后端时内置默认（0.8/65536/16%）、**#5 修复回归**（目标 `retainRatio` 覆盖全局 `retainTokens`，按后端 `resolveRetention` 顺序） |
| `test/surface.test.js` | 16 | deriveEventMessage、工具对平衡、system head、范围选择（不切开工具对/排除 node0/空 surface/measurement 不匹配）、摘要输入、checkpoint 消息与指令 |
| `test/commit.test.js` | 16 | 4 事件事务 happy path、snapshot 后新增节点保留（无丢失/无重复/工具链完整）、native 已压缩→span-missing、锁占用→locked、stale end-seed、not-smaller/small-reduction（内部 `MIN_REDUCTION_RATIO=0.05`，旧配置不生效）、surface 改写→surface-rewritten、span-changed、unbalanced-start/end、session-mismatch、失败兜底闭合锁、`sourceCommandId` 透传（含 checkpoint `source.sourceCommandId`） |
| `test/lifecycle.test.js` | 27 | 同会话单任务（固定 1）、不同会话并发（无全局上限）、minInterval、retrigger-floor、dispose/session-disposed/agent-disposed 取消与清理、pre-step/turn-stopping/idle 边界与三种 applyStrategy、timer 采样 + running 守卫（采样间隔来自内部常量）、native 压缩/替换导致 STALE、锁占用→REJECTED、不缩小→FAILED、range-too-small、**自动保留由后端 `native.retainTokens` 驱动（旧 retain 键忽略）**、**旧 model allow/deny 不再阻断**、无 meter/无 compaction/无 agent 降级、preset 作用域后端、`resolveModelInfo` 容量来源 |
| `test/e2e.test.js` | 3 | 61 条消息会话：事件触发后台摘要 → 压缩期间新增 3 条 → READY → pre-step 原子提交（4 事件顺序、payload 字段、checkpoint source、旧节点 shadow、新增 3 条仍在 surface、无丢失/重复、工具链完整、summarizer 输入前缀）；dryRun 不写事件；minShadowedTokens 跳过 |
| `test/command.test.js` | 14 | `/precompact` 注册、status/list/pause/resume/dry-run/live/now、`logs`（默认 30 条/行格式/JSON 提示）、`logs 5`（限制条数）、空缓冲提示（`logBufferSize=0`）、未知子命令（usage 含 `logs [n]`）、statusCommand=false、无 commands 服务、dispose 注销 |
| `test/log.test.js` | 18 | 环形缓冲容量/覆盖/seq 连续、`logBufferSize=0` 关闭并清空、volatile 改容量即时生效；控制台按 `logLevel` 输出而缓冲记录所有级别；`snapshot` 的 level/sessionId/sinceSeq/limit/顺序与默认 100；`sanitizeFields`（长字符串/数组/深度/循环/Error/undefined/BigInt/函数/Symbol）；`formatFields` 规则 |
| `test/logs-endpoint.test.js` | 10 | 200 payload/`no-store`、limit/level/sessionId/sinceSeq 边界与 400、同源/跨源、无 snapshot→500、无 stats→null 字段、`apply()` 注册 status/logs/history 三条 exact 路由并全部注销 |
| `test/session-view.test.js` | 14 | 白盒 `createRuntime`：顶层 `turn`/`step`（默认 null、事件后更新）、`samples` 容量 120、`steps` 每步 upsert/升序/全量不设容量、`history` 成功提交后 13 字段（含快照时 turn/step）、`history` 容量 30、**adaptive warm start**（data 不完整时保持上次 75% 目标、fresh 会话回退 65%）、dry-run/REJECTED/取消均不追加 |
| `test/history-endpoint.test.js` | 10 | `GET /api/pre-compact/history` 的 200 结构/`no-store`、`current` 20 键白名单（含 `turn`/`step`）+ 诊断对象裁剪、`turn`/`step` 透传与未观察时 null、隐藏字段不泄漏、samples/steps/history 逐项浅拷贝、未知会话 `current:null`+三个空数组、sessionId 400、同源/跨源、statusFor 抛错→500、非法序列→空数组、三条路由注册/注销 |
| `test/snapshot.test.js` | 6 | manual `preserveFromSeq`：保留 in-flight step、endSeq<S、shadowed 不含当前步、preserveFromSeq 字段；无 preserve 时 retain-0；cutoff 无更早历史/在首个可压缩节点 → `no-compactable-range`；tool-pair 平衡（闭合对整体压缩、未闭合调用回退不拆） |
| `test/step-baseline.test.js` | 5 | 白盒 runtime：公开 status 的 `currentStepStartSeq`（默认 null、step/start=事件 seq、step/end/turn 边界清空）、摘要期间追加当前步消息、结果在 `step-boundary` 落地且 shadowed 全 < S、当前步留在 surface、`appendedSinceSnapshot` 正确；step/end 先于 READY → 下一 pre-step 落地；无 in-flight step 回到 retain-0 语义 |
| `test/visual-status.test.js` | 13 | `buildVisualStatus` 的 idle/working/ready/done/failed 优先级与 8s 窗口边界、failure 新旧比较、manual 透传、outcome/failure 字段裁剪（无内容泄漏）；`createStatusResource` 的 200/JSON/no-store、sessionId 校验（400 且不触达 runtime）、Origin 同源校验（403/200/无 Origin）、null status → idle；`apply()` 注册 status + logs + history 三条 exact 路由并在 dispose 全部注销、无 webServer 时仅 debug 启动 |
| `test/manual-hook.test.js` | 37 | 安装/接管（agent/created + pre-step 兜底）、`compactNow` wrapper 返回 Promise、宿主形状 `CompactionResult`、委托（enabled=false / dryRun / hookManualCompact=false）、并发 busy、已中止 signal、摘要中 abort（迟到完成不落盘）、session/agent/plugin dispose 取消、**无插件 deadline**、旧 timeout 键被忽略、无区间 resolve null、`minShadowedTokens` 仅保护自动路径、running agent 走 pre-step、**手动 supersede 自动工作（READY 丢弃 / 在途任务 abandon+abort / 自动 small-reduction 不污染手动）**、changed 自动重试、**checkpoint source 带 `sourceCommandId`**、手动保留固定 retain=0、preset 作用域后端、**hook restore 删除 own 属性（原型方法恢复）**、**手动 commit flush（成功调用一次 / 失败仅 warn）**、**prune 保护 pending 手动状态**、session 在 begin 前失效 → cancelled、`/precompact compact` 全部分支、status `Manual request: queued` |
| `test/summarizer.test.js` | 17 | backend hook 优先与归一化、非 text 块过滤、空摘要/空文本/无路由 fail-closed、fallback llm.stream、**回退固定用会话路由 + 常量 65536（旧 summarization*/maxSummaryTokens 忽略）**、无 llm、MAX_TOKENS/provider 失败、prepareCheckpoint 计价、#1 修复回归（四事件 + 无 undefined 字段） |

> 上表 18 个 `.test.js` 合计 254 个用例（全部启用）；完整 `node --test` 统计为 **284**：
> +1 是 Node 22 自动发现把 `test/fake-harness.js` 当作一个（无测试的）测试文件（空用例），
> +29 来自 impl-ui 维护的 `test/client.test.js`（UI 卡片，不在本次改动范围；并行编辑中数量会变）。整体 284 pass / 0 fail / 0 skip。
