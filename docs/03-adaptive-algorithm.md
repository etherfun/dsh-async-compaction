# 03 · 自适应阈值算法

> 目标：在**原生压缩必须停下来做摘要之前**启动后台预压缩，并且**算得完**。
>
> 本文主体描述 `triggerMode: 'adaptive'`。默认是 `fixed`（`fixedThreshold` 0.7）：固定模式没有预测、没有夹取、没有降级，但有**自动下调**——如果用户阈值 ≥ 实际原生阈值，`autoAdjustFixedThreshold`（默认 `true`）会把触发点压到原生阈值下方，否则预压缩永远来不及（见 §2.3）。
>
> 实现：`src/policy.js` 的 `createGrowthTracker` / `createDurationTracker` / `evaluateTrigger`；调参常量在 `src/internal-policy.js`；调用点：`src/coordinator.js` 的 `evaluate()`。所有公式均按代码逐行还原，不是"理想模型"。
>
> **手动请求不经过本公式**：`/compact`（被 manual hook 接管）与 `/precompact compact` 是用户显式发起，不需要预测"何时该压"，也不检查 `minInterval`/`retriggerFloor`/`applyStrategy`/`minShadowedTokens`；它只复用"快照 → 后台摘要 → 边界四连写"，保留区间固定为原生语义（`retainTokens=0`，只留最后一个 surface 节点）。本文件描述的是**自动**预压缩的阈值。

---

## 1. 符号表

| 符号 | 代码字段 | 含义 | 单位 |
|---|---|---|---|
| **C** | `native.contextWindow` | 上下文窗口（来自路由适配器，权威容量） | tokens |
| **U** | `measurement.totalTokens` | 当前上下文占用量（原生阈值判定用的也是它） | tokens |
| **R** | `native.thresholdRatio` | **原生**阈值比例：后端 `config.thresholdRatio`，或用户 `nativeThreshold` 覆盖，或默认 0.8 | 比例 |
| **V** | `growthRateTokensPerSecond` | 有效增长速度（EMA 与窗口峰值的二选一，见 §3） | tokens/s |
| **T** | `duration.baseSeconds` | 基准压缩耗时：已完成任务的耗时 EMA，或内部常量 `DEFAULT_COMPRESSION_SECONDS=45` | s |
| **K** | `COMPRESSION_TIME_MULTIPLIER` | 压缩耗时安全系数（内部常量 `1.3`） | 倍 |
| **S** | `SAFETY_MARGIN_TOKENS` | 预测增长之外的安全余量（内部常量 `4096`） | tokens |
| **G** | `predictedTotalGrowthTokens` | 预测"从现在到摘要在原生阈值之前落地"还会涨多少 | tokens |
| **N** | `nativeThresholdTokens` | 原生阈值对应的 token 数（不是单纯的 `C×R`，见 §2） | tokens |
| **U_trigger** | `triggerTokens` | 预压缩触发位置 | tokens |
| **P_trigger** | `triggerRatio` | 触发位置占窗口比例（两种模式都按 `U_trigger/C` 计算） | 比例 |
| **F** | `fixedThreshold` | 固定模式下用户配置的触发比例；记录为 `derivation.requestedTriggerTokens` 的来源 | 比例 |

派生量（`C`/`U`/`R` 之外的计算依据，来自 `src/native-policy.js`）：

| 符号 | 字段 | 含义 |
|---|---|---|
| **O** | `reservedCompletionTokens` | 为本次输出预留：`requestHeader().config.maxTokens ?? 适配器 defaultMaxTokens ?? 0` |
| **B** | `headroomTokens` | 原生后端自留空间，默认 65536；当 `nativeThreshold` 是数字覆盖时 B 视为 0 |
| **N** | `thresholdTokens` | `floor(min(C·R, pressureBudget > 0 ? pressureBudget : C−O))`，其中 `pressureBudget = C − O − B` |

> **为什么不能写 `U_trigger = C·R − G` 就完事**：`C·R` 只是阈值公式的一项。原生实际阈值是三条约束的 `min`：比例上限、扣掉输出预留后的消息预算、再扣掉后端 headroom。小窗口模型上第二/第三项会**显著压低**阈值（例 6 会看到 20 万窗口的有效阈值只有 63%）。所以本文统一写 **`U_trigger = N − G`**，并注明 `N = C·R` 只在比例项胜出时成立。

---

## 2. 核心公式

```text
G          = V · (T · K) + S                     # 预测压缩期间的增长
N          = floor(min(C·R, (C−O−B) > 0 ? C−O−B : C−O))    # 原生阈值（token）
U_trigger  = clamp(N − G, C·minThreshold, C·maxThreshold)   # 预压缩触发位置
P_trigger  = U_trigger / C                       # 触发比例（状态里四舍五入到 4 位）
due        = U ≥ U_trigger
```

数据不完整时（§4）：若有 warm start（上一次完整预测的触发点）就复用 `warmStart.triggerTokens`；没有才换成 **`C · fallbackThreshold`**，再走同一套夹取。

对应的代码（`evaluateTrigger`，`adaptive` 分支）：

```js
const growthRate = growthComplete
  ? (growth.peak > growth.ema * BURST_GROWTH_FACTOR ? growth.peak : growth.ema)
  : DEFAULT_GROWTH_TOKENS_PER_SECOND
const predictedDuration = duration.seconds                 // 见 §3.2
const growthTokens   = growthRate * predictedDuration
const predictedGrowth = growthTokens + SAFETY_MARGIN_TOKENS
const nativeThresholdTokens = native.thresholdTokens ?? round(C * (native.thresholdRatio ?? 0.8))
const targetTokens = dataComplete
  ? round(nativeThresholdTokens - predictedGrowth)
  : (warmStartTokens ?? round(C * config.fallbackThreshold))
// 再夹到 [round(C·minThreshold), round(C·maxThreshold)]
```

### 2.1 直观解释

- `N − G` 的意思是：**"如果我等到原生阈值 N 才动手，那时摘要在 N 之前是落不了地的；所以我要在 N 之前 G 个 token 就开始。"** `G` 就是"这段时间还会长出来的量"。
- `T·K + S` 是"我需要多久"的保守估计：历史耗时均值 × 安全系数，外加固定 token 余量（吸收估算误差、网络抖动、突发工具结果）。
- 夹取保证两件事：**不早于 `minThreshold`**（太早压缩会砍掉还有用的近因上下文、白烧摘要 token），**不晚于 `maxThreshold`**（必须给后台摘要留出落地窗口，且必须早于原生阈值）。

### 2.2 与原生阈值的关系（默认参数下）

默认 `maxThreshold = 0.75`、原生 `R = 0.8`：**自适应永远不晚于 75%**，也就是至少给"从触发到原生 80%"留 5 个百分点。若把 `maxThreshold` 调到 ≥ 原生阈值，自适应就会失去提前量——这是配置错误，不是算法问题。

### 2.3 固定模式的自动下调（`autoAdjustFixedThreshold`）

固定模式不是"无脑按 `C×F` 触发"：一旦用户阈值落到了原生阈值**之后**，预压缩就没有落地窗口。代码在固定分支里做了显式修正：

```text
requested = round(C × F)                                   # 用户意图
N         = native.thresholdTokens（拿不到则为 null）
trigger   = requested
if (autoAdjustFixedThreshold !== false && N !== null && requested >= N) {
  gap     = max(4096, round(N × 0.02))
  trigger = max(round(N) − gap, round(C × 0.05))            # 不低于 5% 窗口
  clamps  = ['fixed-adjusted-below-native']
}
due = U >= trigger
reason = due ? (clamps.length ? 'fixed-adjusted-trigger' : 'fixed-threshold') : 'below-threshold'
P_trigger = round(trigger / C, 4)                           # 显示的是实际比例，不是 F
derivation = { requestedTriggerTokens, triggerTokens, fixedThreshold,
               nativeThresholdTokens, nativeThresholdRatio, clamps }
```

**为什么需要它**：原生阈值 `N` 不只由比例决定，还会被"输出预留 O"和"后端 headroom B（默认 65536）"压低。小窗口模型上 `N/C` 可能只有 30%~45%。如果用户按"经验"配 `fixedThreshold: 0.7`，就会得到 `requested(70%) > N(42%)` ——**预压缩永远晚于原生**，一次也不会成功。

**算例**：`C = 128,000`、`O = 8,192`、`B = 65,536`、`R = 0.8`、`F = 0.7`

```text
messageBudget  = 128,000 − 8,192 = 119,808
pressureBudget = 119,808 − 65,536 = 54,272
N              = floor(min(128,000×0.8, 54,272)) = 54,272        # N/C = 42.40%
requested      = round(128,000 × 0.7) = 89,600 ≥ N              # 会被自动下调
gap            = max(4,096, round(54,272×0.02)=1,085) = 4,096
trigger        = max(54,272 − 4,096, round(128,000×0.05)=6,400) = 50,176
P_trigger      = 50,176 / 128,000 = 39.20%
```

→ 实际触发点 **39.20%**（`reason = fixed-adjusted-trigger`），`derivation.requestedTriggerTokens = 89,600` 保留用户原值。若关掉 `autoAdjustFixedThreshold`，触发点会停在 70%，而原生在 42.40% 就已经压缩——预压缩失去意义。

**注意**：自动下调只在**能读到真实 `N`** 时发生（`N === null` 时保持用户值）。因此"读不到后端策略"的 profile 上，固定模式不会自动修正，需要显式配 `nativeThreshold`。

> 实机示例（见 [docs/06-verification.md](06-verification.md) §1）：`C = 1,048,576`、`O = 393,216` → `N = 589,824`（56.3%）；此时默认 `fixedThreshold: 0.7` 必然被自动下调，否则预压缩永远晚于原生压缩。

---

## 3. 两个估计器

### 3.1 增长速度 V：EMA + 窗口峰值（突发保护）

`createGrowthTracker({ windowMs: GROWTH_WINDOW_MS, alpha: EMA_ALPHA })`：

1. **采样**：每次成功 `measure()` 记录 `(t, totalTokens)`。采样点来自 `session/event`（受 `GROWTH_SAMPLING_INTERVAL_MS=5000` 节流）、`pre-step`、`turn-stopping`、`idle` 与定时 tick（每 `max(1000, min(GROWTH_SAMPLING_INTERVAL_MS, 10000))` ms，默认 5 s）。
2. **成对速率**：相邻样本 `dt ≥ 500 ms` 才计算

   ```text
   r_i = (tokens_i − tokens_{i−1}) / dt_ms × 1000        # tokens/s，可为负
   ```

3. **EMA**（只对算得出的 `r_i` 更新）：

   ```text
   e_i = α · r_i + (1 − α) · e_{i−1}          α = EMA_ALPHA（内部常量 0.3）
   ```

4. **窗口峰值**：在 `GROWTH_WINDOW_MS`（内部常量，默认 60 s）内取所有成对速率的 `max(0, max r_i)`——负速率不算峰值。
5. **有效 V**（`evaluateTrigger` 里真正的选择）：

   ```text
   V = (V_peak > V_ema × BURST_GROWTH_FACTOR) ? V_peak : V_ema     # 内部常量，默认 2
   ```

   即：**只有峰值超过 EMA 的两倍（突发）才用峰值**，否则用平滑值。这样单次大工具输出不会永久抬高阈值，但真正的爆发（例如并行读多个大文件）会被提前识别。

> 代码里 `growth.read()` 还返回一个 `rate = max(ema, peak)` 字段——**它不参与决策**，`evaluateTrigger` 按上面的 burst 规则自行选择。看到两者不一致不是 bug。

**样本清理**：样本数 > 512 时只保留最近 256 个；窗口外样本按 `now − max(windowMs, 1000)` 裁剪。

**重置**：一次成功落地后 `state.growth.reset()`（清样本、清 EMA），下一次触发重新学习——但**不会再立刻掉回 65%**：如果之前有过完整预测，会先复用 `state.lastAdaptiveTarget`（warm start，§4.4），直到新增长样本重建或 warm start 被替换。

### 3.2 压缩耗时 T：历史 EMA × 安全系数

`createDurationTracker({ alpha: EMA_ALPHA })`：

- **样本来源**：**只有成功产出 READY 的任务**才记一次耗时（秒 = 单调时钟差/1000；失败/取消不记）。
- **EMA**：首个样本直接作为基线，之后 `d_i = α·s + (1−α)·d_{i−1}`。
- **预测**（每次评估都算）：

  ```text
  base      = (observations > 0) ? d_ema : DEFAULT_COMPRESSION_SECONDS   # T
  predicted = base × COMPRESSION_TIME_MULTIPLIER                         # T·K
  source    = observations > 0 ? 'history' : 'default'
  ```

默认 `T = 45 s`、`K = 1.3` → 初始假设 **58.5 s** 的压缩耗时；有历史后按实际值放大 1.3 倍。

> 注意两次乘法共用同一个 `EMA_ALPHA`，但 EMA 状态是分开的（一个记增长，一个记耗时）。

---

## 4. 数据完整度与降级

`dataComplete` 是四个条件的**与**：

| 条件 | 判定 | 默认值下的含义 |
|---|---|---|
| `fresh` | `input.fresh !== false` | 生产路径恒为 `true`（只有纯函数测试会传 `false`） |
| `growthComplete` | `growth.known && growth.sampleCount ≥ 2` | 至少两次采样且至少算出一个速率（`ema !== null`） |
| `durationComplete` | `duration.observations > 0` | 至少成功完成过一次后台压缩 |
| `nativeComplete` | `native.source !== 'defaults' && native.known === true` | 能读到**真实**后端策略（或用户显式 `nativeThreshold` 覆盖）；只拿到官方默认值不算 |

```text
dataComplete = fresh && growthComplete && durationComplete && nativeComplete
target = dataComplete
           ? round(N − (V·T·K + S))
           : (warmStart 有效 ? warmStart.triggerTokens : round(C · fallbackThreshold))
```

### 4.1 降级路径（含 warm start）

| 缺失项 | 后果 | 触发位置 |
|---|---|---|
| 数据不完整，但存在上一次 `dataComplete` 的 adaptive 目标 | **优先复用上一次完整预测的触发点**（不回到 65%）；仍走 min/max 夹取 | `adaptive-warm-start`（derivation 带 `warmStartTokens/warmStartRatio/warmStartAt`） |
| 增长样本不足（<2 或算不出速率），且无 warm start | 不做预测，走 `fallbackThreshold`（默认 65%） | `adaptive-fallback-no-data` |
| 没有耗时样本（首次运行 / 刚重置），且无 warm start | 同上（**最常见的第一轮状态**） | 同上 |
| 只拿到后端默认策略（`source='defaults'`），且无 warm start | 同上（不信任默认比例，避免和真实后端错位） | 同上 |
| 容量未知（`contextWindow` 拿不到） | **完全不触发**（不是降级） | `no-capacity` |
| `N` 算不出正数（`no-pressure-budget`） | 完全不触发 | 由 `resolveNativePolicy` 返回 `known:false` |
| warm start / fallback 落在 `[minThreshold,maxThreshold]` 外 | 先取目标、再夹取；`triggerReason` 变成 `adaptive-clamped-min/max` | 见 §5 |

### 4.2 触发原因码（`triggerReason` / `decision.reason`）

| reason | 何时 |
|---|---|
| `adaptive-predicted` | 数据完整、未触发夹取 |
| `adaptive-warm-start` | 数据不完整，但复用了上一次完整预测的 adaptive 目标 |
| `adaptive-clamped-min` | 预测/warm start 值低于下界，被抬到 `minThreshold` |
| `adaptive-clamped-max` | 预测/warm start 值高于上界，被压到 `maxThreshold` |
| `adaptive-fallback-no-data` | 数据不完整且无 warm start，用 `fallbackThreshold` |
| `below-threshold` | 未达标（**无论数据是否完整**都是这个值） |
| `fixed-threshold` / `fixed-adjusted-trigger` / `below-threshold` | 固定模式：按用户值触发 / 自动下调后触发 / 未达标（`derivation.requestedTriggerTokens` 保留原值，`clamps=['fixed-adjusted-below-native']`） |
| `no-capacity` | 容量未知 |

> 观测提示：`/precompact status` 只在**已达标**时显示 `adaptive-*`；未达标时恒为 `below-threshold`。判断是否处于降级，先看 `triggerRatio`：等于 65%（`fallbackThreshold`）才是纯 fallback；若是上一次的 75% 左右，可能是 warm start。`dataComplete`/`derivation` 字段在状态对象里存在，但当前渲染函数没有打印它们。

### 4.3 数据新鲜度与"陈旧"处理

算法里没有"训练集"概念，所有输入都是**当场取的**；但"是否可信"由下面这些机制决定：

| 输入 | 新鲜度机制 | 陈旧时的行为 |
|---|---|---|
| `U`（当前占用） | 每次评估都调用 `measure()`（同步、确定性） | 测量抛错 → `recordMeasureError` 清空上次测量、`lastMeasurementAt=0`，本轮不触发；下一次 surface 事件立即重试 |
| `V`（增长） | 只有 `dt ≥ 500 ms` 的相邻样本才产生速率；样本按 `GROWTH_WINDOW_MS`（内部常量 60 s）裁剪，超过 512 条只留最近 256 条 | 窗口内不足 2 条 → `growthComplete=false` → 先 warm start，无历史完整预测才降到 `fallbackThreshold`；压完一次后 `reset()`，同样走 warm start 直到攒够新样本 |
| `T`（耗时） | 每个成功的后台任务记一次；EMA（`EMA_ALPHA`） | 失败/取消不记；`observations=0` → `dataComplete=false` → 降级 |
| `native`（容量/阈值） | `contextPressure()` 免费读；否则 `resolveModelInfo()` + 60 s TTL 缓存 | 读不到 → `known:false`（不触发）或 `source='defaults'`（自适应降级） |
| `ready` 快照 | 快照带 `contentGeneration`/`replaceGeneration`/逐节点定价 | 任何变化 → 提交时 `STALE` 丢弃（不是"用旧数据硬上"） |
| `fresh` 参数 | `evaluate()` 恒传 `true`；只有纯函数测试会传 `false` | `false` → `dataComplete=false` → 降级（这也是"数据可能陈旧"的显式开关） |

**关键取舍**：宁可降级到固定比例，也不拿"陈旧的增长/耗时估计"做预测；但"上一次**完整**预测"是已知可信的锚点，所以数据短暂不完整时先 warm start 复用它，而不是立刻换成 65%。warm start 本身仍受 `minThreshold`/`maxThreshold` 夹取。

### 4.4 warm start：压缩后不立刻掉回 fallback

- **触发条件**：`dataComplete === false` 且 `state.lastAdaptiveTarget` 存在（有 `triggerTokens > 0`）。与 fallback 的优先级：**warm start > fallback**；`fixed` 模式完全不读 warm start。
- **来源**：coordinator 在每次 `mode==='adaptive' && dataComplete===true` 时记录 `{at, triggerTokens, triggerRatio}` 到 `state.lastAdaptiveTarget`；下一次 `evaluateTrigger({ warmStart })` 使用它。
- **输出**：`reason = 'adaptive-warm-start'`（达标时；未达标仍是 `below-threshold`）；`derivation` 带 `warmStartTokens` / `warmStartRatio` / `warmStartAt`，可与 `fallbackThreshold` 区分。
- **为什么**：一次成功压缩会 `growth.reset()`，数据要几秒才能重建；若立刻回 65%，同一会话会出现"刚按 75% 压完、立刻按 65% 再压"的抖动。复用上次完整预测既保持阈值连续，也不凭空外推。
- **局限**：只保留**最后一次**完整预测；模型/窗口/配置变化后可能短暂沿用旧阈值（仍受 min/max 夹取），等新的 `dataComplete` 预测或下一次 warm start 更新。

---

## 5. 夹取与"不可能三角"

```text
U_trigger ∈ [ C·minThreshold , C·maxThreshold ]
```

夹取发生在降级判定**之后**，并且**会覆盖 reason**：

- `target < C·minThreshold` → 取 `C·minThreshold`，`clamps += 'min-threshold'`，reason = `adaptive-clamped-min`
- `target > C·maxThreshold` → 取 `C·maxThreshold`，`clamps += 'max-threshold'`，reason = `adaptive-clamped-max`

为什么要两侧都夹：

- **夹下界**：极端增长（例如一次 10k tokens/s 的并行读取）会让 `N − G` 掉到很低，理论上是"现在就该压缩"，但实际上会过早砍掉近因上下文、并多烧一次摘要。下界保证"至少用掉一半窗口再动手"。
- **夹上界**：极端缓慢增长会让 `N − G` 贴近原生阈值，等于**没提前**；上界保证始终留出落地窗口。

因此 `minThreshold`/`maxThreshold` 是这套算法的"安全笼"，`fallbackThreshold` 是"没有数据时的默认位置"，三者应满足：

```text
minThreshold < fallbackThreshold < maxThreshold < R(原生比例)
默认：     0.5      <      0.65        <      0.75      <   0.8
```

`resolveConfig` 会在 `minThreshold > maxThreshold` 时自动交换并告警；但**不会**校验 `fallbackThreshold` 落在区间内（它会先降级再被夹取，并如实反映在 reason 里）。

---

## 6. 参数表（自适应相关）

**可配置的只有 3 个自适应阈值**（其余都是内部常量，见下表）：

| 参数 | 默认值 | 作用 | 什么时候调 |
|---|---|---|---|
| `triggerMode` | `fixed` | 选固定/自适应 | 想要"提前且随负载自适应"时改 `adaptive` |
| `fixedThreshold` | `0.7` | 固定模式触发比例 `F` | 固定模式的主参数；若高于原生阈值会被自动下调 |
| `autoAdjustFixedThreshold` | `true` | 固定模式下把"高于原生阈值"的配置自动压到原生阈值下方 | 想严格按配置值触发 → `false`（但可能永远来不及） |
| `minThreshold` | `0.5` | 触发下界 | 上下文里"近因"更重要 → 调高（如 0.55~0.6） |
| `maxThreshold` | `0.75` | 触发上界 | 原生阈值更高（如后端改成 0.9）→ 可上调，但必须 < 原生比例 |
| `fallbackThreshold` | `0.65` | 数据不完整时的位置 | 与 `minThreshold`/`maxThreshold` 保持区间内 |
| `nativeThreshold` | `'auto'` | 原生比例来源 | 后端读不到策略时显式给数字（如 `0.8`），**这也是打开自适应信任链的最简单办法** |

**内部常量**（`src/internal-policy.js`，不可配置；公式与行为不变，只是不再暴露调参）：

| 常量 | 值 | 作用 |
|---|---|---|
| `SAFETY_MARGIN_TOKENS` | `4096` | `G` 的固定余量 `S` |
| `COMPRESSION_TIME_MULTIPLIER` | `1.3` | 耗时安全系数 `K` |
| `DEFAULT_COMPRESSION_SECONDS` | `45` | 无历史时的基准耗时 `T` |
| `DEFAULT_GROWTH_TOKENS_PER_SECOND` | `200` | 无增长样本时的 `V` |
| `BURST_GROWTH_FACTOR` | `2` | 峰值相对 EMA 的倍数阈值 |
| `EMA_ALPHA` | `0.3` | 增长/耗时 EMA 系数 |
| `GROWTH_SAMPLING_INTERVAL_MS` | `5000` | 采样节流（ms） |
| `GROWTH_WINDOW_MS` | `60000` | 峰值统计窗口（ms） |

`resolveConfig` 的归一化细节（会影响算法输入）：

- 比例类字段（`fixedThreshold`/`minThreshold`/`maxThreshold`/`fallbackThreshold`）必须 ∈ (0,1]；`fixedThreshold` 再夹到 `[0.01,1]`。
- `minThreshold > maxThreshold` 时自动交换；`minInterval`、`minShadowedTokens` 取非负整数；`logBufferSize` 取非负整数；**并发不在此配置**（单会话固定 1，跨会话可并行）。
- 模型作用域（`modelAllowlist`/`modelDenylist`）已移除；运行时不按 provider/model 过滤，只有路由非空的 `routeUsable()` 工具（当前未使用）。
- 摘要质量门槛不是配置：自动路径使用内部常量 `MIN_REDUCTION_RATIO=0.05`（`src/commit.js`），手动路径只要求摘要更小。
- 已删除的 8 个自适应调参键（`safetyMarginTokens`、`compressionTimeMultiplier`、`defaultCompressionSeconds`、`defaultGrowthTokensPerSecond`、`burstGrowthFactor`、`emaAlpha`、`growthSamplingInterval`、`growthWindow`）在旧配置中会被静默忽略。

> 与算法无关但会影响"是否走到算法"的前置门只剩**最小收益门**（`minShadowedTokens`，区间路由价太小就 `lastSkip='range-too-small'`）。它不改变阈值，只决定"这个会话这一轮要不要算"。

---

## 7. 数值算例

基准（与本机 profile 的 `opencode-go/deepseek-v4.1-flash` 一致）：**C = 1,000,000**，`O = 128,000`（适配器 `maxTokens`；若会话请求头另设更小值，以 header 为准），`B = 65,536`，`R = 0.8`，`S = 4096`，`T = 45`，`K = 1.3`。

```text
N = floor(min(1,000,000 × 0.8, 1,000,000 − 128,000 − 65,536))
  = floor(min(800,000, 806,464)) = 800,000        # 比例项胜出；N/C = 80%
T·K = 45 × 1.3 = 58.5 s
夹取区间 = [500,000, 750,000]
```

### 算例 1：数据完整、中等增长（V = 200）→ 被上界夹住

```text
G = 200 × 58.5 + 4096 = 11,700 + 4,096 = 15,796
U_trigger = 800,000 − 15,796 = 784,204 → 78.42%  > 750,000
```

→ 夹取到 **750,000（75%）**，`reason = adaptive-clamped-max`，`clamps = ['max-threshold']`。

**解读**：增长很慢，理论上可以等到 78% 再动手；但那样只剩 2 个百分点给"触发→落地"，所以上界强制提前到 75%。

### 算例 2：增长变快（V = 2000）→ 落在区间内

```text
G = 2000 × 58.5 + 4096 = 117,000 + 4,096 = 121,096
U_trigger = 800,000 − 121,096 = 678,904 → 67.89%
```

→ 无需夹取，`reason = adaptive-predicted`。

**解读**：增长快了 10 倍，触发点从 75% 提前到 ≈67.9%，差值约 7.1 个百分点 ≈ 71,096 token ≈ 35.5 s 的增长量。

### 算例 3：突发（V_ema = 300，V_peak = 800）→ 峰值优先

```text
800 > 300 × 2 = 600 → V = 800（growthSource = burst-peak）
G = 800 × 58.5 + 4096 = 46,800 + 4,096 = 50,896
U_trigger = 800,000 − 50,896 = 749,104 → 74.91%
```

→ 未夹取（< 75%），`reason = adaptive-predicted`。

对照：若没有突发保护（V = 300），`G = 21,646`、`U_trigger = 778,354 → 77.84%`，会被上界夹到 75%。**注意默认 `maxThreshold = 0.75` 时，两者都可能被上界吃掉差别（74.91% vs 75%，实测只差 900 token）；突发保护的完整价值要在 `maxThreshold` 高于 ~0.78（例如原生 0.9、你把上界放到 0.85）时才显现：那时 77.84% vs 74.91% 的 2.9 个百分点会真实保留。**

### 算例 4：压缩耗时更长（历史 T = 90 s，V = 500）

```text
T·K = 90 × 1.3 = 117 s
G = 500 × 117 + 4,096 = 58,500 + 4,096 = 62,596
U_trigger = 800,000 − 62,596 = 737,404 → 73.74%
```

相比之下（T = 45 s、V = 500）：`G = 29,250 + 4,096 = 33,346`、`U_trigger = 766,654 → 76.67%` → 会被夹到 75%。

**解读**：历史耗时翻倍时，触发点提前约 1.3 个百分点（免于被夹取）；耗时估计是"提前量"的重要来源，但受夹取上界保护。

### 算例 5：小窗口 + 高增长（C = 200,000，O = 8,192，B = 65,536）

```text
N = floor(min(200,000 × 0.8, 200,000 − 8,192 − 65,536))
  = floor(min(160,000, 126,272)) = 126,272        # headroom 项胜出；N/C = 63.14%
V = 1000 → G = 58,500 + 4,096 = 62,596
U_trigger = 126,272 − 62,596 = 63,676 → 31.84%   < 100,000
```

→ 夹取到 **100,000（50%）**，`reason = adaptive-clamped-min`。

**解读**：小窗口上"输出预留 + 后端 headroom"会把有效阈值压到 63%，预测值再低一点就跌破 50% 下界；下界保证不会在上下文还很空的时候浪费一次摘要。

### 算例 6：数据不完整（首次运行）→ 降级

```text
dataComplete = false（没有耗时样本 / 或 native.source = 'defaults'）
U_trigger = round(1,000,000 × 0.65) = 650,000 → 65.00%
```

→ `reason = adaptive-fallback-no-data`，在夹取区间内、不触发夹取。

### 算例 7：增长为负（上一轮压缩后）→ V 取 0，被上界夹住

```text
V_ema = −150，V_peak = 0
突发判定：0 > −150 × 2 = −300 → 成立 → V = V_peak = 0（不是 −150）
G = 0 × 58.5 + 4,096 = 4,096
U_trigger = 800,000 − 4,096 = 795,904 → 79.59% > 750,000
```

→ 夹取到 750,000（75%），`reason = adaptive-clamped-max`，`growthSource = 'burst-peak'`。

**解读**：上下文在变小时不该提前压缩；但也不能"无限等"——上界仍是 75%，给落地留余量。注意一个反直觉的细节：**当 EMA 为负、峰值为 0 时，突发判定成立，V 取 0 而不是负值**；负增长最终表现为"按 0 增长处理"，而不是"预测增长为负"。

### 一张表看完参数敏感性（C = 1e6，其余同基准）

| V (tok/s) | T·K (s) | G (tok) | U_trigger | P_trigger | 结果 |
|---|---|---|---|---|---|
| 200 | 58.5 | 15,796 | 784,204 | 78.42% | 夹到 75% |
| 500 | 58.5 | 33,346 | 766,654 | 76.67% | 夹到 75% |
| 800 | 58.5 | 50,896 | 749,104 | 74.91% | 自适应 |
| 1,000 | 58.5 | 62,596 | 737,404 | 73.74% | 自适应 |
| 2,000 | 58.5 | 121,096 | 678,904 | 67.89% | 自适应 |
| 5,000 | 58.5 | 296,596 | 503,404 | 50.34% | 自适应（贴近下界） |
| 10,000 | 58.5 | 589,096 | 210,904 | 21.09% | 夹到 50% |
| 1,000 | 117 | 121,096 | 678,904 | 67.89% | 自适应（耗时翻倍） |
| 1,000 | 23.4 | 27,496 | 772,504 | 77.25% | 夹到 75% |

---

## 8. 边界场景与已知行为

| 场景 | 行为 |
|---|---|
| **首次运行（无任何样本）** | 走 `fallbackThreshold`；固定模式下不受影响 |
| **可压缩区间太小** | `lastSkip='range-too-small'`（区间路由价 < `minShadowedTokens`，默认 1024），不烧摘要 |
| **固定阈值 ≥ 原生阈值** | `autoAdjustFixedThreshold=true`（默认）时下调到 `N − max(4096, 2%·N)`，且不低于 `5%·C`；reason `fixed-adjusted-trigger`，`derivation.requestedTriggerTokens` 保留原值 |
| **固定模式读不到原生阈值（`N=null`）** | 不做自动下调，按用户值触发（可能永远晚于原生） |
| **只有 1 个增长样本** | `growth.known = false`（要求 `samples ≥ 2` 且 `ema !== null`）→ 降级 |
| **两次采样间隔 < 500 ms** | 该对不产生速率；若始终如此则 `ema` 一直为 `null` → 降级 |
| **增长样本恰好在窗口边缘被裁掉** | 峰值窗口按 `now − max(GROWTH_WINDOW_MS, 1000)` 裁剪；样本不足时退回 EMA/默认值 |
| **刚完成一次预压缩（growth 被 reset）** | 下一轮从降级阈值重新学习（可能回到 65%），随后 `minInterval` 60 s 内不会再启动 |
| **刚压缩/干跑过，占用还没涨回下限** | `retriggerFloor = 落地后估算（dry-run 用快照占用）+ max(2048, 1%×C)`；达标但 `U < floor` → `lastSkip='retrigger-floor'`，不重复付费；`U < triggerTokens` 或失效时清零 |
| **原生后端读不到策略（`source='defaults'`）** | 自适应永不进入 `adaptive-predicted`，长期停在 `fallbackThreshold`；显式配 `nativeThreshold: 0.8` 即可恢复 |
| **容量未知** | `no-capacity`，完全不触发（不是走 fallback）——没有容量就没有阈值 |
| **`N − G` 为负** | 先算出负值，再被 `minThreshold` 抬起（算例 5） |
| **EMA 为负、峰值为 0** | 突发判定成立 → `V = 0`（算例 7），等价于"按零增长预测" |
| **`fallbackThreshold` 在夹取区间外** | 降级值被夹取，reason 变成 `adaptive-clamped-*`（降级信息被覆盖，属于已知的可观测性瑕疵） |
| **`minThreshold > maxThreshold`** | 配置归一化时自动交换并打 warning |
| **时钟回拨 / 单调时钟不可用** | 耗时用 `performance.now()`（不可用时退回 `Date.now()`）；增长速率由 `Date.now()` 差值计算，回拨会让该对速率被 `dt < 500` 过滤或产生负值（负值不抬高 peak） |
| **`measure()` 抛错** | `recordMeasureError`：清空上次测量、`lastMeasurementAt = 0`（下一次 surface 事件立即重试）、warn 一行 |
| **`measure()` 返回 `totalTokens` 非数字/无 `nodes`** | 同上看作测量失败，不进入触发计算 |
| **任务在途/结果就绪时** | 不再测量、不再加样本（`evaluate()` 提前返回），避免把"压缩中"的上下文变化计入增长 |
| **手动请求（`/compact` / `/precompact compact`）** | 不计算阈值：`tryManualCompaction()` 直接排队，`decision = {mode:'manual', triggerTokens:0}`；绕过 `applyStrategy`/`minInterval`/`retriggerFloor`/`minShadowedTokens`/内部 5% 收缩门槛；全部提交校验照常生效；保留区间固定 `retainTokens=0`。同会话与自动任务串行（手动会先取代自动工作），不同会话互不阻塞 |
| **`triggerMode='fixed'`** | 没有自适应预测/夹取/降级/突发保护，`dataComplete` 恒为 `true`；触发点 = `round(C×F)`，若 ≥ 原生阈值则按 §2.3 下调 |
