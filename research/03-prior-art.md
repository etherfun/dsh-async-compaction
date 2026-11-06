# 既有插件先例调研（smart-compaction / dsh-context / dsh-rewind / 本机两仓库骨架）

> 阶段一 · 交付 B（task-3）
> 重点：**smart-compaction 是否已经做了"后台预压缩"**、它的接口证明了哪些可行性、能否复用。
> 证据：`C:\Users\q1325\.dsh\profiles\web\node_modules\info`下真实安装包（pnpm 实体）+ asar 内官方实现。

---

## 0. 一页结论

| 问题 | 答案 |
|---|---|
| smart-compaction 实现"后台预压缩"了吗？ | **没有**。它的自动路径是**在 `agent/pre-step` 里同步 `await compactRegion()`**（关键路径上阻塞下一步），不是后台、无缓存、无预计算。 |
| 它能被直接复用为库吗？ | **不能**：不导出任何可调用 API（只 `export name/inject/apply`），且它会自行注册 `compact_now`/`context_status` 工具并在 pre-step 抢压缩时机，与我们并存会**双重压缩**。 |
| 它证明了哪些接口可行？ | ① `compactRegion()` **可在回合中途调用**（`compactNow()` 会 `busy`）；② `agentPresets.serviceFor(agent,'compaction')` 能拿到 preset 私有压缩服务；③ `sessionProjections.stateOf(session,'contextPressure')` 拿到真实用量；④ `session.append('user/message', …, {surfaceOp:'append'})` 可发"通知"式提示；⑤ 可选服务不写 `inject`、用 `ctx.get()` 取，缺服务时降级而非崩。 |
| "后台预压缩"的可行改造点在哪？ | `BasicCompactionEngine.summarize(input, agent, signal)` 被官方注明是**唯一子类定制钩子**（`compaction-basic:797-800,890-904`）；`CompactionEngine extends Service{super(ctx,'compaction')}` 且"每个 context 装载一个实现"。→ **由我们的 bundle 提供自己的 compaction engine（子类，命中缓存就直接返回预計算摘要）** 是唯一能真正把摘要成本移出关键路径的路径。 |
| 还缺什么证据？ | 预计算摘要与 `compactRegion` 实际请求的 `input`（replay 前缀 + tools）之间的**可复现映射**；以及"把 engine 装进用户的 preset group"的分发方式（preset 属用户侧配置）。见 §6。 |

---

## 1. smart-compaction 0.3.15（最重要）

安装位置：`C:\Users\q1325\.dsh\profiles\web\node_modules\smart-compaction\`
（pnpm 实体：`.pnpm\smart-compaction@0.3.15\node_modules\smart-compaction`）
文件：`index.js`(241 行) / `select-range.js`(41) / `safe-point.js`(42) / `context-status.js`(54) / `cordis.patch.yml` / `package.json` / `README.md`(228 行) / `icon.svg`

### 1.1 它做什么

`package.json:4` 自述 + `README.md:13-18`：

1. **`compact_now`**：让模型自己挑「安全点」触发压缩，回合中途可用。
2. **`context_status`**：读真实 token 用量 / 上下文窗口。
3. **自动 safe-point 压缩**：`todo_write` 有任务项翻成 `completed` 时视为「一步完成」，若此时用量已过 `safePointRatio`（默认 **0.5**），下一步开始前先压缩（`README.md:75-89`）。

### 1.2 核心实现（逐行）

**（a）真正干活的地方：`index.js:62-83`**

```js
async function compactAgent(compaction, agent, signal, notice) {
  const session = agent.session
  const range = selectCompactableRange(session, toolPairingBalancedBefore)   // :64
  if (range === null) return { compacted: false }                            // :65 无可用区间 → 无害 no-op
  session.append('user/message', createUserMessage({                          // :73
    content: [{ type: 'text', text: notice }],
    source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'Compacting now' },  // :75 form:'notice' → 渲染成折叠的系统旁白
  }), { surfaceOp: 'append' })                                                // :76
  const result = await compaction.compactRegion(range.start, range.end, agent, signal)  // :77 ★
  return { compacted: true, shadowedCount: result.shadowedSeqs.length,
           shadowedTokenCount: result.shadowedTokenCount }                    // :78-82
}
```

**（b）拿到压缩服务：`index.js:90-92`（两条路径的兜底，非常关键）**

```js
function compactionFor(ctx, agent) {
  return ctx.get('compaction') ?? ctx.get('agentPresets')?.serviceFor(agent, 'compaction')
}
```
> 原因见 `README.md:122-128`：`dsh-web-app` profile **禁用了 host 平面的 compaction 行**，每个 preset 在隔离组里挂私有的；所以要向 preset 注册表要「这个 agent 的那一份」。这与我们在 profile 里看到的 `cordis:group` + `isolate:{compaction:true}` 完全对应（`C:\Users\q1325\.dsh\profiles\web\cordis.patch.yml` 的 `preset-def` / `preset-survival` 内）。

**（c）用量读数：`index.js:95-99` + `context-status.js:36-53`**

```js
const projections = ctx.get('sessionProjections')
const state = projections.stateOf(exec.agent.session, 'contextPressure')
```
`context-status.js:42-45` 给出 `usedTokens` 公式：`pressureTokens + surfaceTokens - sampledSurfaceTokens`（无采样时退化为 `surfaceTokens` 并标 `estimated`），`percentUsed` 保留 1 位小数。

**（d）自动触发（= 它离"后台"最近但也最远的地方）**：`index.js:187-212`

```js
ctx.on('tools/post-execute', async (exec, _result, next) => {       // :187
  if (exec.agent && exec.name === 'todo_write') {                    // :188 只认 todo_write
    const done = completedCount(exec.arguments)                      // :189
    if (finishedStep(lastCompleted.get(exec.agent), done)) atSafePoint.add(exec.agent)  // :190
    lastCompleted.set(exec.agent, done)                              // :191
  }
  return next()                                                      // :193
})

ctx.on('agent/pre-step', async ({ agent, signal }, next) => {        // :196
  if (!atSafePoint.has(agent) || signal.aborted) return next()       // :197
  atSafePoint.delete(agent)                                          // :198
  const compaction = compactionFor(ctx, agent)                       // :199
  if (!compaction) return next()                                     // :200
  const usage = usageOf(ctx, agent.session)                          // :201
  if (!overSafePointRatio(usage, ratio)) return next()               // :202
  try {
    await compactAgent(compaction, agent, signal, `⏳ Step finished with …`)  // :204 ★ 同步等待
  } catch (error) {
    console.warn(`smart-compaction: safe-point compaction failed: …`)         // :209 失败绝不打断回合
  }
  return next()                                                              // :211
})
```

→ **它把压缩搬到了「更合适的时机」，但仍然在同一条关键路径上同步执行**。`compactRegion` 内部要跑一次完整摘要模型调用（`compaction-basic` 的 `summarizeWithLlm`），因此这一步的墙钟时间 = 一次完整 LLM 摘要。这正是本项目要消灭的成本。

**（e）区间选择：`select-range.js:23-41`**（复刻 core 的 `selectCompactableRange`，只用公开 API）

```js
const nodes = session.surface.nodes
const head = session.eventAt(nodes[0])
const firstIdx = head !== undefined && head.type === 'system/message' ? 1 : 0   // 跳过 system 头
let keepFromIdx = nodes.length - 1                                              // 至少保留最后一个 surface 节点
while (keepFromIdx > firstIdx) {
  if (toolPairingBalancedBefore(session, nodes[keepFromIdx])) break              // 工具配对平衡
  keepFromIdx -= 1
}
if (keepFromIdx <= firstIdx) return null
return { start: nodes[firstIdx], end: nodes[keepFromIdx - 1] }
```
依赖：`toolPairingBalancedBefore` 来自 `@deepseek-ai/dsh-compaction`（`dsh-compaction/lib/index.js` 明确导出），`session.surface.nodes` / `session.eventAt()` 来自 Session。

**（f）配置**：`index.js:179-183` 只接受 `safePointRatio ∈ (0,1)` 或 `false`；README 教用户在 profile patch 里覆盖。

### 1.3 它**没有**做的事（= 我们的空间）

| 能力 | smart-compaction 实况 | 证据 |
|---|---|---|
| 后台/空闲期预计算摘要 | ❌ 无 | `index.js` 全文只有 `compactRegion` 一条摘要路径 |
| 摘要结果缓存 / 二次利用 | ❌ 无 | 每次 `compactRegion` 都重新 summarize |
| 预压缩就绪度/状态展示 | ❌ 无 UI（零 client 文件） | 包内无 `client.js`，`package.json` 无 `dsh.client` |
| 设置表单 | ❌ 无（**没有 `export const Config`**，只有 `name`/`inject`/`apply` 三个导出） | `package.json:58-65` 的 `files` 无 schema 声明；`index.js:33,40,107` |
| 多会话隔离 | ✅ 用 `WeakMap<agent,…>`/`WeakSet<agent>` | `index.js:184-185` |
| 可取消 | ⚠️ 用 `exec.signal` / pre-step 的 `signal` | `index.js:197,204` |
| 失败降级 | ✅ 只 warn，不打断回合 | `index.js:207-210` |
| 与 core 80% 触发器共存 | ✅ 明确把 core 当 backstop | `README.md:81` |

### 1.4 能否复用（三条结论）

1. **不能当库用**：包 `exports` 只有 `index.js`（`package.json` 无 `exports` 字段，`main: "./index.js"`），导出面只有 `name/inject/apply`；`select-range.js`/`safe-point.js`/`context-status.js` **没有被导出**（只能靠深路径 import，等于依赖其内部文件结构，脆弱）。
2. **不能同时装**：它无条件在 `tools` 上注册 `compact_now`/`context_status`，并在 `agent/pre-step` 里做 safe-point 压缩。我们的插件若也压缩，同一回合会连续压缩两次，且 `compaction` 服务内部有"同一 session 不允许并发压缩"的断言（`compaction-basic` 的 `assertNoActiveCompaction`，`lib/index.js:938`）。→ **我们的插件必须「要么取代它、要么明确让位」**，并在 README 写清共存策略。
3. **它的价值是「接口可行性证词」**，逐条可直接搬：

| 可复用点 | 出处 | 我们能怎么用 |
|---|---|---|
| `compactRegion` 可 mid-turn；`compactNow` 会 `busy` | `index.js:9-13` 注释、`README.md:93-97` | 任何在回合内触发的压缩都必须走 `compactRegion` |
| `ctx.get('compaction') ?? ctx.get('agentPresets')?.serviceFor(agent,'compaction')` | `index.js:90-92` | 我们取压缩服务的标准写法 |
| 可选服务**不要**写进 `inject` | `index.js:34-40` | 我们的 `inject` 只放 `tools`/`sessionProjections` 这类必有的 |
| `stateOf(session,'contextPressure')` + `summarizeContextUsage` 公式 | `index.js:95-99`、`context-status.js:36-53` | 状态卡片直接复用这套算法（注意：它复刻了 token-meter 的**私有** view，属于"跟着核心实现走"的耦合） |
| 通知旁白：`session.append('user/message', createUserMessage({source:{kind,form:'notice'}}), {surfaceOp:'append'})` | `index.js:73-76` | 后台预压缩完成时给一条折叠提示 |
| safe-point 判定：`tools/post-execute` 观察 `todo_write` → `agent/pre-step` 消费 | `index.js:187-202` | 我们也需要"干净边界"，这是现成信号 |
| 区间选择算法 | `select-range.js:23-41` | 直接照写（它是公开 API 复刻，不是抄内部实现） |
| 失败只 warn | `index.js:207-210` | 后台任务必须 fail-open |

### 1.5 README 里两条**高价值踩坑记录**（省我们一轮 debug）

- `README.md:214-222`：`summarization produced no text summary content` —— 当被压缩区间里只有注入的样板（如 standing instructions）而没有真实助手文本时，官方摘要器会返回空。**对我们的预计算同样适用**：预计算前必须校验候选区间有实质内容，否则预计算结果为空，等于白跑一次模型。
- `README.md:203-212`：连续三次 `compact_now` 均成功、无 `busy`、无损坏 —— 说明 `compactRegion` 对"已含一次压缩 checkpoint 的 surface"是安全的（我们的后台预计算会频繁触碰这块，这条是定心丸）。

---

## 2. dsh-context 0.82.0

位置：`C:\Users\q1325\.dsh\profiles\web\node_modules\dsh-context\`（`lib/index.js` 112KB 压缩产物、`lib/client.js` 660KB、`lib/index.d.ts` 14KB）

### 2.1 它做什么

上下文**洞察**插件，不是压缩插件：

- **上下文洞察页面**（侧边栏 → 全中栏面板）、**Context 标签页**（每会话完整仪表盘）、**Fleet 标签页**（Agent 网络）、**`/context` 命令**（居中弹窗）、**Preferences 卡片**（`README.md:52-60`）。
- 每个会话三个投影：`contextTimeline` / `contextHeaders` / `contextActivity`（`lib/index.d.ts:108-119` 的 module augmentation）。
- 设置里可给**所有会话（含子 Agent）的系统提示词**加前缀/后缀（`README.md:221`）。

### 2.2 技术面（可借鉴）

| 事实 | 证据 |
|---|---|
| 导出只有 `Config` / `apply` / `inject` / `name`，`inject = ['sessionProjections']` | `lib/index.js` 末尾 `export{Tn as Config, ho as apply, mo as inject, po as name}` |
| 注册 3 个投影并 `stateOf` 读值 | 同文件 `ho` 函数：`e.sessionProjections.register(qi(r))` …；全文 `stateOf` 出现 8 次 |
| 服务取用走 `ctx.get('llm')` / `ctx.get('settings')`（可选服务软取） | 反编译片段：`e.get('llm')`、`e.get('settings')` |
| 用 `ctx.on('internal/get', …)` 给 `tools.register` 打归属标记（诊断用） | 反编译片段 `e.on('internal/get', (e,t,n,r)=>{ if(t!=='tools') return r() … })` |
| 用 `ctx.effect(()=>()=>{…}, 'tools.register attribution')` 清理 | 同上 |
| **无 `ctx.provide`** → **不对外暴露任何上下文读写 API** | 全文 `provide(` 0 次 |
| 理解"压缩后"状态的字段：`archived[]`、`archiveFloor`、`pendingShadowedSeqs`、`pendingShadowEventSeq` | `lib/index.d.ts:68-99` |

### 2.3 对我们的用法

- ❌ **不能**当"上下文读写 API"用（它只读投影 + 自己画 UI）。
- ✅ **可以**照抄它的"投影 + 客户端 wire view"模式来做状态卡片的数据通道（`practices.md:38`：Client 需要派生值就在 Host 投影上声明 `wire.view`，别在浏览器里折叠事件）。
- ✅ 它的 `archived`/`archiveFloor` 字段证明：压缩后旧节点仍能从日志取回（只是不在 surface 上）——这对"后台预压缩要不要缓存原文"有直接参考价值。

---

## 3. dsh-rewind-plugin 0.20.0

位置：`C:\Users\q1325\.dsh\profiles\web\node_modules\dsh-rewind-plugin\`（`lib/index.js` 170KB、`lib/client.js` 102KB、`lib/types/*.d.ts`）

### 3.1 它做什么

`/rewind`：**就地回退对话 + 还原工作区文件**（`README.md:91-99`）。机制见 `README.md:103-114`：

> 对话部分「只遮蔽、不删除」——往日志末尾追加一条**空消息标记**，把目标消息及其之后的内容「遮蔽 + 替换」；采用与官方 `/compact` **相同**的隐藏+替换机制，因此日志重放/压缩/续接检查都能正确识别。

`lib/types/index.d.ts:1-25` 进一步写实：

> execution appends a marker `user/message` whose `surfaceOp` replaces the target and every surface node after it with itself, cutting only the model-visible surface.

文件部分是 Claude-Code 式**写前备份**：在 `tools/execute`（around-dispatch）阶段捕获，`tools/post-execute` 提交备份，锚定到 turn 的 anchor 消息 seq；备份落 `<dsh home>/rewind-snapshots/`，每会话保留最新 100 组。

### 3.2 是否提供可复用的快照/恢复能力

| 结论 | 证据 |
|---|---|
| **没有**运行时服务（无 `ctx.provide`） | 导出面是 `name / inject / ENGINE_COMMAND / SnapshotStore / 若干类型`（`lib/types/index.d.ts:29-38`），不是 `ctx.snapshot` |
| **有**可 import 的库类 `SnapshotStore` | `export { SnapshotStore } from './snapshot.ts'`（同上 `:29`）；但把它作为依赖会把我们和它的内部实现绑死 |
| 文件级能力 ≠ 会话级 | 它备份的是**工作区文件**，不是会话/投影；对"上下文预压缩"没有直接可借用的持久化层 |
| **有**高价值的机制参考 | 它是"`append` + `surfaceOp:{op:'replace',startSeq,endSeq}`"的完整生产实现；与 `compactRegion` 走的是同一个 surface 遮蔽机制（`dsh-session/lib/index.js` 的 `surfaceOpOf`/`replaceRange` 校验） |
| `ENGINE_COMMAND = "rewind-plugin"` 的内部命令通道 | `lib/types/index.d.ts:33-38` —— 这是"Client 驱动 Host 私有操作"的范式（避免占用公开命令名），我们的 UI 手动触发可以照抄这个做法 |

---

## 4. 本机两个仓库的骨架约定（可直接照抄）

### 4.1 `F:\dev\GitHub\dsh-Survival-mode`（`@local/dsh-survival`）

**目录**

```
package.json          (841B)
cordis.patch.yml      (7.6KB, 含自带 preset 的完整快照)
index.js              (82KB, host 入口)
core.js               (83KB, 纯函数/状态机)
client.js             (139KB, 浏览器半)
src/host/settings.js  (9.8KB, 设置归一化)
src/host/delegation.js
locale/{en,zh}.json
icon.svg
test/                 core.test.js / wiring.test.js / client.test.js / replay.test.js / settings.test.js
                      headless.*.yml (10 个 headless 冒烟配置) + browser/cdp.mjs
analysis/             asar-dump.mjs / asar-grep.mjs / session-read.mjs（自建 asar 探针）
README.md (64KB) / DESIGN-phase4.md / DEATH-TEXTS.md
```

**package.json 关键段**（`package.json:7-36`）

```json
"exports": { ".": "./index.js", "./client": "./client.js",
             "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
"files": ["index.js","core.js","client.js","src","cordis.patch.yml","locale/*.json","icon.svg","README.md"],
"dsh": { "bundle": { "patch": "./cordis.patch.yml" },
         "client": { "platform": "web", "immediately": true,
                     "inject": ["@deepseek-ai/dsh-client-ui-conversation",
                                "@deepseek-ai/dsh-api-session-controller",
                                "@deepseek-ai/dsh-client-locale"] } }
```

**cordis.patch.yml 的两种内容**（`cordis.patch.yml:1-45`）
- 一段 `insert` 挂自己的常驻插件（带 `config`）；
- 再一段 `insert` 挂一个 `@deepseek-ai/dsh-agent-preset` 行，`config.plugins` 里**整份快照**一份 standard preset，从而多出一个"模式"。

**host 入口形状**（`index.js:19-21`）

```js
export const name = 'survival'
export const inject = ['tools', 'commands', 'systemPrompt', 'sessionProjections', 'agents']
```

**故意不声明 Config**（`index.js:59-80`）：`Config is resolved manually so the bundle needs no schemastery dependency`；代价是设置页没有自动表单，于是它自带 `survival.settings.json` + 自绘设置卡片（`src/host/settings.js:1-16` 明确三层覆盖：core 内置 → bundle config → settings 文件）。

**测试方式（值得照抄）**
- `node --test` 纯单测（`test/*.test.js`），核心逻辑抽到 `core.js` 纯函数；
- `test/headless.*.yml`：给无头 runtime 的**冒烟配置**（10 个场景），`test/browser/cdp.mjs` + `hero-probe.mjs` 做 CDP 端到端；
- `analysis/*.mjs`：直接读 asar / session jsonl / 投影缓存的探针脚本（我们 `scripts/asar-*.cjs` 同类）。

**locale 结构**（`locale/en.json` 全文）

```json
{ "meta": { "title": "Survival Mode",
            "description": "Turns tokens into hearts, ... win when the user accepts the delivery." } }
```

### 4.2 `F:\dev\GitHub\dsh-read-image-compress`（0.15.0）

```
index.js / client.js / preview-sample.js / cordis.patch.yml / locale/{en,zh}.json / icon.svg
docs/{benchmark.md,design.md,toc.yml}   preview/sample.png
scripts/validate-docs.mjs               test/{client-render,preview-sample}.test.mjs
package.json (含 engines.dsh)            README.md (14.7KB)
```

**它解决的"外部插件没有 schemastery"问题**（`index.js:57-77`）——**我们若想有设置表单又不想被打包依赖绑死，这就是标准写法**：

```js
function loadSchema() {
  const candidates = []
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery'))
    ...
  }
  if (process.env.DSH_PROFILE_DIR) candidates.push(path.join(process.env.DSH_PROFILE_DIR, 'node_modules', '@deepseek-ai', 'schemastery'))
  if (profile) candidates.push(path.join(process.env.DSH_HOME, 'profiles', profile, 'node_modules', '@deepseek-ai', 'schemastery'))
  return loadFirst(candidates)
}
export const Config = Schema === undefined ? undefined : Schema.object({ ... })   // :78
```
并配 `normalizeConfig()`（`index.js:151-171`）做**第二道手写校验**（因为 `Config` 可能为 `undefined`）。

**cordis.patch.yml**（全文 22 行）：一行 `insert`，`config` 把**全部默认值写全**（`enabled/quality/maxEdge/maxBytes/format/...`）。→ 约定：bundle 默认层写全默认值，用户覆盖更省事。

**测试**：`node --test test/*.test.mjs`；`scripts/validate-docs.mjs` 校验文档与代码同步（`package.json:16-19`）。

### 4.3 两仓库共同的**发布约定**（= 我们的模板）

| 约定 | 来源 |
|---|---|
| 双半包：`index.js`（host）+ `client.js`（browser），`dsh.client.platform:"web"` | 两者一致 |
| `exports` 必须含 `./client`、`./locale/*.json`、`./icon` | 两者一致；`host-plugin.md:31-51` 要求 |
| `locale/*.json` 的 `meta.title` / `meta.description` 是**插件管理页显示用的唯一来源** | 两者一致 |
| patch 行 `name` **必须等于包名**（Client 半用 `require.resolve('<row-name>/package.json')` 找包） | `dsh-rewind-plugin/cordis.patch.yml:1-6` 的注释明确写了 |
| README 结构：效果图 → 安装 → 使用 → 原理 → 配置 → 兼容性 → 已知限制 → 安全 → 开发/测试 → License（+ 结尾中文简介） | `dsh-rewind-plugin/README.md` 目录、`smart-compaction/README.md:196-228` |
| 纯函数下沉 + `node --test` 单测；UI 另做 jsdom 渲染测 | 两者一致 |

---

## 5. 横向对照：为什么"后台预压缩"还是空白

| 插件 | 触发时机 | 摘要计算位置 | 是否可后台 |
|---|---|---|---|
| `dsh-compaction-basic`（core） | `agent/pre-step` 压力阈值 / `agent/request-error` 溢出 | **同步**，阻塞 `next()` | ❌（`lib/index.js:840-853`） |
| `smart-compaction` | `agent/pre-step`（safe point，用量 ≥ 0.5） | **同步**，阻塞 `next()` | ❌（`index.js:196-212`） |
| `dsh-command-compact` | 人敲 `/compact` | 同步，要求 agent 空闲（`compactNow` → `runMaintenance`） | ❌ 但**天然在空闲期** |
| `dsh-context` | 只读，不压缩 | — | — |
| `dsh-rewind` | 只遮蔽，不摘要 | — | — |
| **本项目（拟）** | 空闲/回合结束后台预计算 | **后台**，关键路径只做一次 replace | ✅ |

**为什么没人做**：三条硬约束叠加 ——（1）摘要必须经 `compactRegion` 才能产生合规的 checkpoint 事件（`compaction/start`/`compaction/end`）；（2）`summarize` 是 `compactRegion` 内部固定调用的钩子，外部无法塞入现成文本；（3）"每个 context 只能有一个 `compaction` 实现"。→ 唯一合法切口是**提供自己的 engine 实现**（见 §6）。

---

## 6. smart-compaction 的接口证明了什么、还差什么

### 6.1 已由它证明可行（可作为我们设计的"事实底座"）

1. 第三方插件可以在**回合中途**驱动 `ctx.compaction.compactRegion(start, end, agent, signal)` 并得到合规 checkpoint（`index.js:77`，`README.md:203-212` 实测三次）。
2. `agentPresets.serviceFor(agent,'compaction')` 能在 preset 隔离的 profile 上取到该 agent 的压缩服务（`index.js:91`+`README.md:122-128`）。
3. `sessionProjections.stateOf(session,'contextPressure')` 是拿"真实用量/窗口"的公开入口（`index.js:96-98`）。
4. 第三方插件可以合法地 `session.append('user/message', …, {surfaceOp:'append'})` 生成 `form:'notice'` 旁白，且不会污染对话（`index.js:73-76`）。
5. `tools/post-execute` + `agent/pre-step` 这对组合可以安全地插入"在下一步之前做点重活"（`index.js:187-211`）。
6. 不把可选服务写进 `inject`、改用 `ctx.get()`，能让插件在缺服务的 profile 上**照常加载**（`index.js:33-40`，注释里写明曾经 "a hard inject broke boot"）。

### 6.2 还差的证据（下一步必须先打死这三点，再动手）

1. **摘要缓存命中判定**：`compactRegion(start,end,agent,signal)` 内部把 `input`（replay 的 system+tools+leading messages）交给 `summarize(input, agent, signal)`（`compaction-basic/lib/index.js:1014-1025` 的 `regionDependencies()`）。要复用预计算结果，必须能判断"当前 `input` 是否等于我后台算过的那一份"。可行锚点是 `start/end` seq + `session.surface.replaceGeneration`（`compaction-basic:870,884` 用过 generation 做乐观校验），但 `regionDependencies` 是否把任何标识传给 `summarize` **尚待确认**（当前签名只有 `input, owner, abort`）。→ 需要读 `lib/types/region.js` 的完整实现（未在本次解压范围）。
2. **engine 的装载位置**：`CompactionEngine extends Service{super(ctx,'compaction')}`，`dsh-compaction/lib/index.js` 文档写着 "Load one implementation per context as `ctx.compaction`"。web profile 的 preset 组用 `isolate:{compaction:true}` 隔离，因此我们的 engine 必须挂进**同一个 preset 组的同一 isolate 标签**下，否则 `serviceFor` 取到的是原 `compaction-basic`。→ 分发方式是"给用户一段可粘贴的 preset 片段"（放在其 `cordis.patch.yml` 的 `preset-*` 行里），而不是 bundle 自动改。
3. **账要算清**：后台预计算本身也要烧一次模型调用（只是移到空闲期）。收益是**墙钟时延**而非 token。若只在"预计算 + 命中率"都成立时才划算，需要 `compaction/summary-error`（事件目录里唯一与摘要失败相关的水位）与命中率埋点来验证。

### 6.3 复用建议（一句话）

> **不要 import smart-compaction，也不要与它并存**；把它的 `select-range.js` 算法、`compactionFor()` 双路取服务、`contextPressure` 读数、`notice` 旁白写法"照抄成我们自己的代码"，并在 README 里写明「若已安装 smart-compaction，请二选一（disable 其一）」。

---

## 7. 清单

### ✅ 可直接采用的先例做法

1. 取压缩服务：`ctx.get('compaction') ?? ctx.get('agentPresets')?.serviceFor(agent,'compaction')`（`smart-compaction:90-92`）。
2. 回合内压缩只用 `compactRegion`，绝不用 `compactNow`（`smart-compaction:9-13,77`；`compaction-basic:986-1012` 的 `busy`）。
3. 区间选择算法（`smart-compaction/select-range.js:23-41`，仅依赖 `toolPairingBalancedBefore` + `session.surface.nodes` + `session.eventAt`）。
4. 用量读数与 percentUsed 计算（`smart-compaction/context-status.js:36-53`）。
5. `form:'notice'` 旁白消息（`smart-compaction:73-76`）。
6. safe-point 信号：`tools/post-execute` 观察 `todo_write` + `WeakSet<agent>` 标记，`agent/pre-step` 消费（`smart-compaction:187-202`）。
7. 失败 fail-open，只 warn（`smart-compaction:207-210`；`compaction-basic:844-851` 同款）。
8. 双半包 + `exports`/`files`/`locale`/`icon`/`dsh.client` 清单（`dsh-Survival-mode/package.json:7-36`、`dsh-read-image-compress/package.json:7-64`）。
9. 外部包动态加载 schemastery + 手写 `normalizeConfig` 二道校验（`dsh-read-image-compress/index.js:57-77,151-171`）。
10. `node --test` 纯函数单测 + headless 冒烟 yml + jsdom 渲染测（两仓库 + `dsh-rewind` 的 `verify:*` 脚本）。
11. Client 驱动 Host 私有操作的内部命令通道（`dsh-rewind` 的 `ENGINE_COMMAND = "rewind-plugin"`，`lib/types/index.d.ts:33-38`）。
12. 投影 + `wire.view` 把派生值推给浏览器，而不是在浏览器里折叠日志（`dsh-context/lib/index.d.ts:108-119`；`practices.md:38`）。

### ⚠️ 需适配（先验证再写码）

1. **预计算摘要的命中判定**（§6.2-1）——未验证。
2. **把自定义 engine 装进 preset 的 isolate 组**（§6.2-2）——这是**用户侧配置**，我们只能提供片段与文档。
3. `compactRegion` 与 core 80% 触发器的**竞态**：两边都在 `agent/pre-step`，注册顺序决定谁先。需要实测（`compaction-basic` 在 `constructor` 里注册，我们的插件若晚于它装载，就会在其后跑）。
4. `dsh-context` 的 `contextPressure` 复刻公式依赖 token-meter **私有**实现，有随版本漂移风险 → 我们应优先用官方 `stateOf` 的原始 state，自己算而不是复制它的 `summarize`。
5. smart-compaction 已有 `compact_now` 工具名；我们若也要工具，**必须换名**避免冲突。

### ❌ 不可行

1. 把 smart-compaction 当库 import（无导出面，深路径 import 脆弱）。
2. 与 smart-compaction 同时启用并各自压缩（并发压缩断言 + 双重摘要 + 双份 notice）。
3. 让 `compactRegion` 使用外部预先算好的摘要文本（无此参数；`summarize` 是内部钩子，不对外）。
4. 用 dsh-rewind 做"上下文快照/恢复"（它是文件备份 + surface 遮蔽，无会话快照服务）。
5. 用 dsh-context 读写上下文（只读投影 + 自绘 UI，无 `ctx.provide`）。
