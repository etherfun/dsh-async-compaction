# dsh-async-compaction 对抗性代码审查（GLM-5.3-Flash, high）

> **修复状态（Lead，2026-11-06）**：本报告的 3 个缺陷、flush 风险与 5 项建议已全部处理，`node --test` 从 182 增至 **190/190 通过（0 fail / 0 skip）**，4 个 smoke 全过。
> - **缺陷-1（手动复用自动结果破坏手动语义）已修复**：`tryManualCompaction()` 新增 `supersedeAutomaticWork()`——丢弃自动 READY（`lastOutcome.reason='manual-request-supersedes'`）、abandon+abort 在途自动任务并 bump generation，随后总是启动全新手动任务（`retainTokens=0`、只要求更小）；自动专属的 `small-reduction` 失败不再误伤等待中的手动请求。回归：`a manual request discards an existing automatic READY result and compacts with manual semantics`、`an in-flight automatic task is abandoned when a manual request arrives`、`an automatic small-reduction failure never rejects a waiting manual request`。
> - **缺陷-2（checkpoint source 缺 `sourceCommandId`）已修复**：`checkpointSource/createCheckpointMessage/prepareCheckpoint` 透传 `sourceCommandId`，与宿主 `compactCheckpointSource()` 同形；`test/fake-harness.js` 两个 native 写入函数也改为宿主形状。回归：manual 五处一致性断言 + `appendCompaction carries sourceCommandId...`。
> - **缺陷-3（skip + 无 agent 悬挂）**：防御性 `rejectManual('summary', ...)` 保留；因缺陷-1 修复后该路径不可达，新增可达的“accepted 后会话失效 → cancelled”回归，并在 `test/REPORT.md` 说明。
> - **风险-4（flush）**：手动 commit 成功后 fire-and-forget `ctx.get('sessions').flush(session)`，失败仅 warn、不影响 resolve（回归 2 条）。
> - **风险-7（restore 留 own 属性）**：restore 时若实例原本没有 own `compactNow` 则 `delete`，恢复原型方法（回归 1 条）。
> - **风险-8（未知键静默）**：18 个 legacy 键继续静默，其它未知键打 `unknown config key "<key>" was ignored`（回归 1 条）。
> - **风险-9 的 prune 漏洞**：`pruneStates()` 跳过 `state.manual !== null`（回归 1 条）。
> - **建议-10**：删除 `fixedThreshold > 1` 死代码；`nativeThresholdRatioActual` 重复字段与 `rawOutput`/`llmStreamCall` 形状差异保留（无行为影响）；保留 clamp 0.9×threshold 与 pressureBudget 回退的“更宽容”取舍已在 README/docs/05 记录。
> - 审查建议的“补断言”已全部落地：复用路径改为 supersede 语义断言、small-reduction 不误伤手动、checkpoint source、skip 收敛、flush、prune、restore。

- 审查对象：`F:\dev\GitHub\dsh-async-compaction`（DSH 0.2.2-rc.1 插件，后台上下文预压缩）
- 审查日期：2026-11-06
- 方式：通读生产代码与测试 + 对照提取的真实宿主包（`research/extracted/dsh/node_modules/@deepseek-ai/*`）+ 实际运行 `node --test` 与 4 个 smoke + 对抗性验证脚本（`review/tmp-verify.mjs`，已删除）。
- 只读审查：未修改任何生产文件。

---

## 总体结论

**可以交付（有条件）。** 核心主张成立：四连写提交确实是原子的（`session.append` 同步、观察者同步通知、append 重入守卫——已对照 `dsh-session/lib/index.js:1569-1600` 核实），提交前校验完备（区间/代数/定价/工具对/锁），失败路径会把锁恰好闭合一次（实测 T3）。182/182 测试实跑通过，4 个 smoke 实跑通过，文档质量显著高于平均水平（`docs/05-limitations.md` 诚实记录了大部分真实瑕疵）。

**未发现会破坏会话数据的阻塞项。** 但发现 1 个未记录的真实语义缺陷（手动 `/compact` 复用自动结果时不遵守手动保留语义）、1 个与宿主契约的 payload 形状分歧（checkpoint source 缺 `sourceCommandId`）、1 个手动请求可能永久悬挂的窄路径。均为行为/语义问题，不涉及数据损坏。

---

## 发现（按严重度）

### [缺陷-1] 手动 `/compact` 被自动 READY/在途自动任务"挂接复用"时不遵守手动保留语义（未记录）

- **位置**：`src/coordinator.js:388-395`（tryManualCompaction 复用 `state.ready`）、`src/coordinator.js:763`（startTask 自动任务成功后 `if (state.manual !== null) applyReady(...)`）、`src/coordinator.js:856`（manualPending 绕过 applyStrategy）。
- **证据（实测 T1）**：自动任务先就绪（快照区间 1-62，自动保留尾部，backend `retainTokens=128`）；随后发起手动 `/compact`（经被包装的 `compactNow`）→ 手动 Promise resolve `manual:true`，落地的是**自动保留语义**的压缩（保留尾部），而不是手动路径承诺的"只保留最后一个 surface 节点"（`retainTokens=0`，见 `src/snapshot.js:40`）。与 `dsh-compaction-basic` 的 `compactNow`（`selectCompactableRange(..., 0)`）语义不一致。
- **影响面**：README 明确承诺"手动 `/compact` 固定只保留最后一个 surface 节点（原生语义）"（README 工作原理 §4、配置项表、`test/manual-hook.test.js:425` 的用例名）。真实后端默认 `retainRatio=0.16`：1M 窗口下自动路径可保留 ~16 万 tokens 尾部——用户执行 `/compact` 得到"成功"，实际压缩量远小于原生语义。反向同样成立：在途**自动**任务触发了自动专属的 `small-reduction`（5%）门槛失败时，等待中的手动请求被以 `summary` code **拒绝**（实测 T2：`rejected:summary`，0 次 compaction/summary 落地），尽管手动语义只要求"更小"。
- **文档状态**：`docs/05-limitations.md` §2.13 记录了"挂接复用"机制本身，但**未提保留语义分歧**；README 的强承诺与代码矛盾。
- **建议**：手动请求被接受时若 `state.ready`/`state.active` 是自动产物，改为"等它落地后，若保留区间 ≠ 手动语义则重新快照（retain=0）再补一次"，或至少：a) 失败路径也走 `beginManualTask` 的手动语义重试（与 skip 路径 `coordinator.js:667-672` 对齐）；b) 在 README/§2.13 写明该分歧。最小修复是把 startTask 成功路径里 `state.manual !== null` 的 applyReady 改为只在 `ready.manual === true` 时直接 settle，否则按手动语义重建。

### [缺陷-2] 手动压缩的 checkpoint message source 缺少 `sourceCommandId`（与宿主契约形状分歧）

- **位置**：`src/surface.js:258-260`（`checkpointSource(compactionId)`）、`src/surface.js:267-279`（`createCheckpointMessage`）；对照宿主 `dsh-compaction/lib/index.js:117-123`：`compactCheckpointSource(compactionId, sourceCommandId)` **包含** `sourceCommandId`。
- **证据（实测 T4）**：插件产出的 replacement message source 为 `{"kind":"compact-checkpoint","compactionId":...}`；宿主手动压缩为 `{"kind":"compact-checkpoint","compactionId":...,"sourceCommandId":...}`。
- **影响面**：`compaction/start|summary|end` 三条事件都带 `sourceCommandId`（`src/commit.js:234-236,251`），唯独最终落地的 checkpoint 消息 source 不带——任何按 message source 做展示关联/审计的宿主消费者对手动压缩会对不上号。**未被文档记录**（README 只说"同 checkpoint 标记"、sourceCommandId 写进三条事件）。
- **连带发现**：测试假宿主 `test/fake-harness.js:864,1555` 的 `writeNativeCompaction`/`nativeCompactRange` 用的也是**插件形状**（无 sourceCommandId）而不是宿主真实形状——测试把这个分歧固化了，所以永远测不出来。
- **建议**：`tryManualCompaction` 把 `sourceCommandId` 传入 prepared → `createCheckpointMessage`；同步修正 fake-harness 的两个 native 写入函数为宿主形状。

### [缺陷-3] 手动请求在"自动任务 skip + agent 不可解析"窄路径下永久悬挂

- **位置**：`src/coordinator.js:662-673`（startTask 的 `built.skip` 分支）：`const manualAgent = attachedAgent(state); if (manualAgent !== undefined) void beginManualTask(...)` —— **else 分支不存在**：不重试、不 reject，`state.manual` 保持非空。
- **复现**：自动任务在途时用户发起 `/compact`（请求挂接到该任务）→ 该任务命中 `no-compactable-range` 等 skip → 此时 agent 已从 `ctx.agents` 移除且 `state.agent` 失效（`attachedAgent` 返回 undefined）→ 手动 Promise 永远 pending，只能靠 abort/pause/dispose 收敛。`failManual`（`coordinator.js:456-472`）的失败路径没有这个问题（会 reject），唯独 skip 路径漏了。
- **影响面**：窄（需要 agent 恰在此窗口消失），但违反"Promise 只在落地/abort/dispose 时 settle"的承诺之外又多了一个不可收敛点；且 `state.manual !== null` 会持续压制该会话的自动触发（`coordinator.js:595`）。
- **建议**：skip 分支 else 时 `rejectManual(state, 'summary', ...)` 或复用 `failManual`。

### [风险-4] 提交后不 flush（已记录，确认为真实分歧）

`docs/05-limitations.md` §2.8 已记录：原生手动路径 `compactNow` 在 `compaction/end` 后 `await sessions.flush(session)`（`dsh-compaction-basic/lib/index.js:509-513,999-1001`），插件不做。崩溃窗口内"已报告成功但持久化丢失"。建议采纳文档中的 P0-3：commit 成功后 fire-and-forget `ctx.sessions.flush(session)`（手动路径至少应做——原生契约明确"resolve 前已 checkpoint"）。

### [风险-5] `compactNow` 包装器改变同步抛错语义

原生 `compactNow` 首行 `signal.throwIfAborted()` **同步抛**；包装器（`src/manual-hook.js:40-59`）对已 abort 的 signal 返回 rejected Promise（`coordinator.js:350`）。对 `await` 调用方（dsh-command-compact）等价，但对依赖同步 try/catch 的程序化调用方行为不同。已 reject 的错误是形状相同的普通 Error 而非宿主 `ManualCompactionError` 实例——`dsh-command-compact` 的 `instanceof` 分类会失效、直接冒泡 `error.message`（README/§5.6 **已记录**，此处仅确认属实）。建议：无阻塞，保持现状可接受。

### [风险-6] 手动请求挂接在途自动任务期间的 `busy` 语义差异（已记录）

原生 `/compact` 在 agent 非 idle 时立即 `busy`（runMaintenance 语义）；插件接受请求并等待安全边界，命令一直"运行中"。`docs/05-limitations.md` §2.13/§5.6 已记录。注意 `manualError('busy')` 只覆盖"同会话已有 manual"一种情况。

### [风险-7] `restore()` 在实例上留下遮蔽原型方法的 own 属性

`src/manual-hook.js:105`：`engine.compactNow = original` 把原型方法写成 own 属性而非 `delete engine.compactNow`。当前行为等价；若后端后续热更新原型方法，残留 own 属性会遮蔽它。一行修复（`delete engine.compactNow`，仅当 original 来自原型时）。

### [风险-8] linked 安装（无 schemastery）下**新**键拼写错误也被静默忽略

`src/config.js:68-160` 丢弃一切未知键且无警告（注释理由是"宿主 schema 会拒绝"）。但 linked checkout 下 schema 常为 `undefined`（`docs/05` §1.3 自己承认），此时 `fixedThreshod: 0.8` 这类拼写错误静默回落默认值，用户无从察觉。18 个已删除旧键需要保持静默（有测试锁定），建议对**除这 18 个之外**的未知键打一条 warning。

### [风险-9] 已记录瑕疵复核属实（不重复展开）

以下 `docs/05-limitations.md` §6 条目经代码核实全部属实：§6-1 token meter 缺失永久自禁用（`coordinator.js:497`）；§6-2 以 `error.name === 'AbortError'` 归类取消（`coordinator.js:773`）；§6-3 dry-run `totalBefore` 是节点数（`coordinator.js:893`）；§6-12 `pruneStates` 不保护 manual 状态（`coordinator.js:148`）——prune 掉后该会话的后续 `session/event` 会创建**新 state**，旧 state 成为孤儿，其失效监听失效（晚到结果仍有 commit 前校验兜底，不会损坏数据，但白烧摘要且 status 丢失）。

### [建议-10] 杂项

- `src/config.js:138`：`if (config.fixedThreshold > 1)` 死代码——>1 在 line 76 已被拒。
- `src/policy.js:261`：`nativeThresholdRatioActual` 与 `nativeThresholdRatio` 恒等，死字段。
- `src/commit.js:245-248`：可写出 `llmStreamCall:true` 而无 `rawOutput` 的 `compaction/summary` payload；宿主总是成对写（`dsh-compaction-basic/lib/index.js:631-634`）。形状分歧，低危。
- `src/native-policy.js:231`：`retainTokens` 夹到 `0.9×thresholdTokens` 是插件自创规则——宿主 `resolveCompactSpec` 无此夹取（只在 `retainTokens >= thresholdTokens` 时**抛错**）。后端配置非法时插件选择静默夹取并照常压缩，比宿主更宽容；可接受但与"完全跟随后端"的承诺有偏差（README 已注明夹取，未注明宿主会抛错）。
- `src/native-policy.js:204`：`pressureBudget <= 0` 时插件回退 `messageBudget`（继续触发），宿主此时直接抛 `TargetPressureConfigError` 拒绝压缩。插件更激进但不会比后端更晚，安全方向正确。

---

## 审查目标逐项结论

1. **原子提交与事件溯源（commit.js / coordinator.js）**：✅ 成立。四连写在单个同步 turn 内（`session.append` 同步 + 观察者同步通知 + 重入守卫，`dsh-session/lib/index.js:1569-1600`）；`state.applying` 防自失效（`coordinator.js:1002`）；锁扫描与宿主逐字段一致（含 `session/end-seed` 孤儿判定）；`verifySpan` 比 host 的 `assertSelectedSpanStable` 更严（额外 contentGeneration/replaceGeneration——已确认普通 append 不增 contentGeneration，仅 replace/project 会，`dsh-session/lib/index.js:464-474`，故不会误杀正常追加）；`sourceEventSeqs`、`shadowedTokenCount=启发式价`、`not-smaller` 判定均与宿主对齐。异常路径：append 抛错 → 恰一次 `compaction/end` 补写（实测 T3：starts=1, ends=1, error 记录）；校验失败 → 丢弃不落地；锁占用 → REJECTED；找不到 backend → 评估期 defer。**唯一缺口是不 flush（风险-4）。**
2. **手动 hook**：安装/还原/失败 delegate 实现正确（WeakMap + patched 数组 + `active` 双保险；dispose 先 restore 后 dispose）。无死循环：`changed` 重试由 `manual.retried` 限一次。悬挂面见缺陷-1/3 与风险-6。`sourceCommandId` 在三条事件与结果里透传正确，但 checkpoint message source 缺失（缺陷-2）。
3. **配置与 volatile**：`unwrapConfigRefs`/`loader/volatile-update` 闭包重读正确（smoke-config-live 实证）；`enabled` 切 false 会取消手动（`applyConfig`/`setEnabled`/`cancelPendingManual` 链路齐全）；`hookManualCompact` 切 false 不取消在途手动（合理）；schema 与 `resolveConfig` 默认值/范围一致（16 键，测试锁定）；未知键静默在无 schema 环境是盲区（风险-8）；`statusCommand` 非 volatile 重启语义正确。
4. **阈值/自适应数学**：`thresholdTokens = floor(min(C×ratio, messageBudget−headroom))` 与宿主 `resolveCompactSpec` 逐项一致；retain 合并顺序（target token > target ratio > global token > global ratio > 默认 16%）与宿主 `resolveRetention` 一致（有测试）；夹取差异见建议-10。EMA/burst/时长预测与 `docs/03` 公式一致，边界（<500ms 采样、窗口裁剪、非有限值）有测试。
5. **并发与生命周期**：单会话单任务成立（`evaluate` 在 await 后重查 `state.manual`（line 595）封死了评估/手动双启动竞态——我专门找过，未找到双任务窗口）；`maxConcurrent` 在 `startTask` 同步段内递增，无超卖；`invalidate` 的 generation+abandoned 守卫使晚到结果无法落地；dispose 顺序正确；`session/event` 内不 append 的约束由 `state.applying` 前置返回遵守。
6. **浏览器 half**：注册契约（`window.__ModuleLoader__.load`、slot `plugins.bundle.config`、namespace `pre-compact`、`configForms.mutate(ops, expectedRevision)`/`whileServed`/`writable`）与 `dsh-client-ui-settings` 实际 API 对齐（grep 核对 + smoke-client）；hooks 依赖正确、subscribe 有清理；保存整份字段 + revision 栅栏；数值换算对称（roundPercent/roundRatio）；locale 键 en/zh 完整（测试锁定）；主题走 `--dsw-*` token；无浏览器崩点：`window.__ModuleLoader__` 缺失会直接 TypeError——但该文件只在宿主模块加载器里执行，风险可忽略。小瑕疵：native 自定义数值输入有 id 无关联 label（可访问性）。
7. **测试可信度**：见下节。
8. **文档一致性**：总体极好，`docs/05` §6 的 13 条已知瑕疵逐条核实属实。不一致处：缺陷-1（手动保留语义承诺 vs 复用路径）、缺陷-2（checkpoint source 未记录分歧）、README"同 checkpoint 标记"表述。

---

## 测试可信度评价（182/182 实跑通过）

**结论：对插件自身单元/状态机语义可信度高；对宿主集成语义可信度中等。**

- **强**：fake-harness 不是浅 mock——它是宿主语义的忠实移植（lossless-JSON 快照含 undefined 拒绝、surface fold + replace 校验 + 重入守卫 + sourceEventSeqs 覆盖检查，对照 `dsh-session` 逐项核实一致）。测试通过公共钩子（事件/命令）驱动而非内部函数，覆盖了真实状态机分支（invalidate、generation 守卫、重试、锁、dry-run、legacy 键）。
- **弱**：(a) fake 的 native 写入函数复刻的是**插件形状**而非宿主形状（缺陷-2 的根因），"与原生同构"类断言因此是自我印证；(b) fake 无持久化层，flush 类问题不可见；(c) `agent/created`→patch→`/compact` 链路的真实 monkey-patch 行为（冻结对象、原型方法、preset 隔离组多实例）只能靠 fake 近似；(d) 复用自动结果服务手动请求的**保留语义**无断言（`manual-hook.test.js:389` 只测复用发生，`:425` 只测独立手动路径）。
- **应补**：手动复用自动 READY 后的 shadowed 范围断言；手动请求在自动任务 `small-reduction` 失败后的 settle 断言；checkpoint message source 的 sourceCommandId 断言（对齐宿主形状后）；skip + 无 agent 的手动收敛断言。

## 实跑记录

- `node --test`：182 tests / 182 pass / 0 fail / 0 skipped（≈1.0s）✅
- `scripts/smoke.mjs` / `smoke-manual.mjs` / `smoke-config-live.mjs` / `smoke-client.mjs`：全部通过 ✅
- 对抗脚本（已删）：T1 手动复用自动 READY（证实缺陷-1）；T2 自动 small-reduction 失败拒绝手动（证实缺陷-1 反向）；T3 replace 阶段抛错锁恰好闭合一次（证实提交安全性）；T4 checkpoint source 缺 sourceCommandId（证实缺陷-2）；T5 busy 形状正确 + dispose 会 settle 挂起手动（观察属实）。

---

## 最值得先修的 3 件事

1. **缺陷-1**：手动请求复用自动结果时的保留语义分歧（含自动 small-reduction 失败误伤手动请求）——直接违背 README 对 `/compact` 的核心承诺，1M 窗口下用户可感知。
2. **缺陷-2**：checkpoint message source 补 `sourceCommandId` 并同步修正 fake-harness 的 native 形状——否则测试永远无法发现与宿主契约的形状漂移。
3. **缺陷-3 + 风险-4**：skip 分支 else 时 reject 手动请求（一行）；手动路径 commit 成功后 fire-and-forget `ctx.sessions.flush(session)`——消除两个"承诺 settle 条件之外"的收敛缺口。
