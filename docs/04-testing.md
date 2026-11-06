# 04 · 测试用例与运行方式

> 自动化测试位于 `test/`，零第三方依赖（`node:test` + `node:assert/strict`）；公共 fake 宿主在 `test/fake-harness.js`，按真实 DSH 语义实现。实测结果与统计见 [docs/06-verification.md](06-verification.md) §2。

## 运行

```powershell
cd F:\dev\GitHub\dsh-async-compaction
node --test              # 或 npm test：273 个用例（16 个 Host 测试文件 243 + fake-harness 自动发现 1 + client 29）
node --test test/client.test.js   # 只跑设置卡片 + composer 指示器 + 右侧边栏面板（29 用例）
node --test test/visual-status.test.js # 只跑状态资源（13 用例）
node --test test/log.test.js      # 只跑结构化日志缓冲/sanitize（18 用例）
node --test test/logs-endpoint.test.js # 只跑日志端点（10 用例）
node --test test/history-endpoint.test.js # 只跑右侧边栏面板数据端点（10 用例）
node --test test/session-view.test.js # 只跑面板图表模型（14 用例）
node scripts/smoke.mjs            # 快速冒烟（会话用后端 16% 保留策略驱动，不再设置 retainRatio）
node scripts/smoke-manual.mjs     # 手动 /compact hook 冒烟
node scripts/smoke-config-live.mjs # volatile 配置就地更新的 Host 侧冒烟
node scripts/smoke-client.mjs     # 设置卡片模块加载/注册契约冒烟
```

> 注意：本机 Node 22.17 + Windows 下 `node --test test/` 会把目录当模块入口并报 `Cannot find module ...\test`，请用自动发现（`node --test`）或 `node --test "test/*.test.js"`。

## fake 宿主的能力边界

`test/fake-harness.js` 复刻的是**被调用的真实契约**，而不是插件内部的实现：

- `Session.append()`：5 种 surface 类型必须带 `surfaceOp`；`replace` 必须精确三键、端点必须存在且有序、`sourceEventSeqs` 必须覆盖全部被 shadow 节点；tool/result 只能"单节点、只改 content"；node 0 的 `system/message` 只能被 `system/message` 自身重写；append 发布期间重入 append 抛错。
- 无损 JSON：与宿主 `snapshotJsonValue()` 一致，payload 中任何 `undefined` 都会让 append 失败（这条曾抓到真实缺陷，见 `test/REPORT.md` #1）。
- `surface` 投影：`replace` 才推进 `replaceGeneration`，`replace`/投影推进 `contentGeneration`；`deriveEventMessage` 的 null 投影规则。
- 服务：`tokenMeter`（`measure`/`estimateMessage`/`contextPressure`）、`llm`（`resolveModelInfo`/`stream`，可控延迟与中止）、`compaction` 假后端（可配置是否实现 `summarize`、是否实现 native-style `compactNow`、`manualCalls`、`holdSummaries`、延迟、`hold`、abort）、`commands`、`sessions`、`agents`、`agentPresets`、`timer`。
- 驱动：`effect`/`on`/`waterfall`/`interval` 与真实 Cordis 的生命周期语义；状态读取统一走宿主公开的 `/precompact status` 命令，不读插件私有对象。

## 文件与覆盖

| 文件 | 覆盖 |
|---|---|
| `00-smoke.test.js` | 启动 → 触发 → READY → pre-step 提交的最小闭环 |
| `config.test.js` | 默认值全量（**16 键**，含 `logBufferSize`）、逐键越界回退 + warning（负数 `logBufferSize` 回退默认 500）、min/max 交换、`nativeThreshold` 三态、19 个 legacy 旧键（含 `maxConcurrent`）**静默**丢弃、其它未知键打 `unknown config key` warning、`unwrapConfigRefs` |
| `policy.test.js` | 固定阈值与 due 边界、`autoAdjustFixedThreshold`（下调/下限/关闭/无 native）、自适应（fallback、全量数据预测、min/max 夹取、burst 峰值、数据完整性、**warm start：复用上次完整预测 / 无历史仍 fallback / fixed 不读 / derivation.warmStart\***）、growth/duration EMA、`routeUsable`（21 用例） |
| `surface.test.js` | 工具对平衡矩阵、范围选择（排除 node0、不切开工具对、空 surface、measurement 不匹配）、摘要输入、checkpoint 消息/指令 |
| `commit.test.js` | 四事件事务 happy path、快照后新增消息保留（无丢失/无重复/工具链完整）、native 已压缩、锁占用、orphan 锁、not-smaller/small-reduction、surface 改写/span 变化、unbalanced、session 不匹配、失败兜底闭合锁 |
| `lifecycle.test.js` | **并发模型：单会话串行（最多 1 个在途 + 1 个待落地）+ 跨会话并行**、`minInterval`、`retriggerFloor`、dispose/session-disposed/agent-disposed、三种 `applyStrategy`、timer 采样与 running 守卫、native/替换导致 STALE、range-too-small、无 meter/无 compaction/无 agent 降级、preset 作用域后端；不再有 `maxConcurrent`/`activeTasks` 用例 |
| `e2e.test.js` | 61 节点会话：事件触发后台摘要 → 期间新增 3 条消息 → READY → pre-step 原子提交；payload/顺序/source/shadow/保留断言；dryRun 零写入 |
| `command.test.js` | `/precompact` 注册与 status/list/**logs**/pause/resume/dry-run/live/now、`logs` 默认 30/范围 1..200、未知子命令、`statusCommand=false`、无 commands 服务、dispose 注销 |
| `summarizer.test.js` | backend hook 优先与归一化、回退 `llm.stream`（会话路由 + 常量 65536）、失败分类、无损 JSON 回归守卫、`MIN_REDUCTION_RATIO` 相关校验 |
| `manual-hook.test.js` | 手动 `/compact` hook（37 用例）：`agent/created` 安装 + `agent/pre-step` 兜底、dispose 还原原方法、`enabled=false`/`dryRun=true`/`hookManualCompact=false` 三种 delegate、`busy`、已 abort 的 signal、运行中 abort（迟到完成不落盘）、session/agent/plugin dispose、**无插件 deadline**、**手动取代自动 READY/在途任务（`supersedeAutomaticWork`，自动结果被丢弃、按 `retainTokens=0` 重新摘要）**、**skip + 无 attached agent reject `summary`**、**提交后 fire-and-forget flush**、**checkpoint source 带 `sourceCommandId`**、无区间 resolve `null`、`minShadowedTokens` 仅保护自动路径、running agent 在下次 pre-step 落地、手动固定 `retainTokens=0` 的激进区间、invalidate 不落地过期结果、`changed` 重试一次、`/precompact compact` 成功/不可用（dry-run/hook=false/paused）/空历史/缺少 agent、preset 后端 |
| `native-policy.test.js` | 后端策略读取与合并：全局 `thresholdRatio`/`headroomTokens`/`retainRatio`/`retainTokens`、`modelPolicies` per-target 覆盖、保留合并顺序（目标 token > 目标 ratio > 全局 token > 全局 ratio > 默认 16%）与 clamp；无策略回退 0.8/65536/16% |
| `log.test.js` | 结构化日志（18 用例）：双写（console 按 `logLevel`、缓冲记录所有级别）、环形容量 `logBufferSize`（含 0 关闭并清空、volatile 即时生效）、`sanitizeFields` 边界（字符串 300/数组 20/深度 3/循环/Error/BigInt/函数/undefined）、`snapshot` 的 limit/level/sessionId/sinceSeq 过滤与升序、`clear`/`stats` |
| `logs-endpoint.test.js` | 日志端点（10 用例）：200 JSON + `no-store` + `count/capacity/lastSeq`、默认 limit 100、limit 1..500、level 闭集/最低级别、sessionId 格式、sinceSeq 非负整数、400 各分支、跨源 403/同源放行、`apply()` 注册 exact 路由与 dispose 注销 |
| `visual-status.test.js` | 只读状态与日志资源（13 用例）：`buildVisualStatus(null)`、聚合字段白名单（无内容）、状态优先级 `working > ready > done(8s) > failed(8s) > idle`、done/failed 时间窗、manual 来源、outcome/failure 裁剪、200 JSON + `no-store`、未跟踪 session、非法 sessionId 400、同源/跨源 403、`apply()` 注册 exact 路由与 dispose 注销、无 webServer 仍能启动 |
| `history-endpoint.test.js` | 右侧边栏面板数据端点（10 用例）：200 JSON + `no-store`、`current` **20 字段**白名单与裁剪（`lastFailure/lastSkip/manualRequest`、含 `turn`/`step`）、顶层 `step`、**`steps` 数组**、未知会话 `current:null`+三空数组（含 `steps: []`）、非法 sessionId 400、跨源 403/同源放行、`apply()` 注册 exact 路由与 dispose 注销、samples/steps/history（含 `turn`/`step`）原样透传 |
| `session-view.test.js` | 面板图表模型（14 用例）：`buildChartModel` **优先 `steps`（保留全部步、升序、每步一条）**、`steps` 缺失/为空回退 samples 分组（同步取最后/未知步骤/序号回退）、空/单点/多点、y 轴刻度与触发/原生阈值线、最多 6 个步骤刻度（含首尾）、history 只在命中步骤画标记、`describeViewState` 五态、记录表首列步骤裁剪（最近 10 条） |
| `client.test.js` | 浏览器 half 的**离线**测试（29 用例，无 DOM/浏览器）：按 `window.__ModuleLoader__` 方式加载 `client.js`；**四类注册**（设置卡片、`conversation.composer.dock` 指示器、`conversation.session.header.utilities` 按钮、`sidebarRightTabs` + `sidebar.right.pane.tab` 面板）；`DEFAULTS` 字段覆盖（**13 字段**，除 `logLevel`/`logBufferSize`/`statusCommand`；并断言不再包含任何压缩语义字段与已删除的调参键）、卡片单位 ↔ schema 单位往返（百分比）、前端校验（空/非数/越界/`min>max`）、边界说明与手动分区说明存在、五个分组、一次保存提交每个字段的 `set` op、loading/unavailable/read-only/summary 渲染、保存携带 revision、保存失败/放弃/恢复默认；**指示器**：`describeIndicator` 五态映射与中英文案、挂载立即轮询 + 1200ms 间隔、隐藏标签页跳过、卸载清理、idle 不渲染；**右侧边栏面板**：`openTab` 按钮、sidebar 服务缺失跳过、**优先 `steps` 图表模型**/空态/错误点/2500ms 轮询与卸载清理/当前步 chip/表首列步骤、`buildStats` 五项、紧凑尺寸、节省时间列/aria saved |

## 手工/实机验证

- 快速冒烟（不依赖测试框架）：`node scripts/smoke.mjs`（会话按“后端 16% 保留策略”合成，不再设置 `retainRatio`）。
- 手动 `/compact` hook 冒烟：`node scripts/smoke-manual.mjs`。
- 设置卡片模块加载/注册契约冒烟：`node scripts/smoke-client.mjs`。
- volatile 配置就地更新：`node scripts/smoke-config-live.mjs`（断言 70%→700,000、40%→400,000、`enabled=false`→paused、日志 `configuration updated`）。
- 真实会话日志核对：`node scripts/inspect-session.mjs <sessionId>`（解析 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 的拼接 zstd 帧，统计事件、surface、压缩事务与 payload）。
- 设置卡片的**真实浏览器**验证（刷新页面、打开 Plugins 详情页、保存并看 `/precompact status`）属于人工步骤，尚未自动化；见 [docs/06-verification.md](06-verification.md) §3.6。
- **配置面收敛**：`config.test.js` 覆盖“16 键默认值 + 累计 19 个旧键被忽略 + `unwrapConfigRefs`”；没有在真实 profile 上带旧配置重启验证（见 06 §7）。
- 实机验证过程与证据见 [docs/06-verification.md](06-verification.md)。
