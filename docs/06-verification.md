# 06 · 实测验证

> 本文只记录**实际运行并观察到**的结果。每条附命令、观测位置或会话日志证据；未验证项集中在 §7 诚实列出。
> 验证对象：`F:\dev\GitHub\dsh-pre-compact`（工作树，未提交），DSH Desktop 0.2.2-rc.1。

---

## 1. 环境快照

| 项 | 值 |
|---|---|
| 验证日期 | 2026-11-05（Asia/Manila） |
| DSH 版本 / 安装形态 | `@deepseek-ai/dsh-desktop` 0.2.2-rc.1（`dshBuildCommit=c59d10aff167ad7eefead4b3a9082fb57c8fbfe8`），Electron asar：`D:\SOFT\tools\dsh\resources\app.asar` |
| Web GUI | `http://127.0.0.1:3080` |
| profile | `web`（`C:\Users\q1325\.dsh\profiles\web`），pnpm `nodeLinker: hoisted` |
| 插件安装形态 | `plugin_manager install_bundle` 传入绝对路径 `F:\dev\GitHub\dsh-pre-compact` → profile 依赖 `@local/dsh-pre-compact 0.1.0 <- F:\dev\GitHub\dsh-pre-compact`（link），Loader 行 `include:pre-compact`，`fiberPhase=active` |
| Node 版本 | Host 运行时 `24.21.0`；本机测试 `22.17.1` |
| 实机测试模型 | `magpie` / `deepseek/deepseek-flash`；`contextWindow=1,048,576`，请求 `maxTokens=393,216` |
| 原生压缩触发位置（按公式手算） | `min(1,048,576×0.8, 1,048,576−393,216−65,536)=589,824`（56.3%），因此该模型上**默认 70% 固定阈值会被 `autoAdjustFixedThreshold` 下调**，否则预压缩永远晚于原生 |
| 挂载情况 | `compaction-basic` 在 preset isolate 组内（host 行 `enabled=false`）；`token-meter` host active；`tool-result-pruner` preset 内；`image-offload` host active；`smart-compaction` active（未与本插件冲突） |
| 实机测试配置 | **临时（当时的配置面，部分键现已删除）**：`triggerMode=fixed`、`fixedThreshold=0.1`、`modelAllowlist=['deepseek/deepseek-flash']`、`minInterval=10000`、`growthSamplingInterval=2000`、`logLevel=debug`；测试后已恢复生产默认（`fixedThreshold=0.7`），并重新加载插件。注意：`modelAllowlist` 在后续"边界收敛"中已从本插件移除，旧配置会被静默忽略（当时实机行为不能代表当前配置面） |
| 手动压缩 hook 配置（新增，未参与上述实机） | `hookManualCompact=true`（`cordis.patch.yml` 默认）；手动保留区间固定 `retainTokens=0`；**没有** `manualCompactRetainTokens` / `manualCompactTimeoutSeconds` 配置（均已删除）。**该功能在实机测试之后才合入**：实机未点击过 `/compact`，也没有观察 `hooked the manual compaction entry point` / `Manual request:` 行 |
| 浏览器端 client half（新增，未参与上述实机） | `package.json` 有 `exports["./client"]` 与 `dsh.client`（`platform:"web"`、`immediately:true`、`inject:["@deepseek-ai/dsh-client-ui-plugin-manager"]`），profile 为 link 安装。**设置卡片与 composer 状态指示器在实机测试之后才合入**：未在真实浏览器打开/渲染/保存/轮询过；Host 侧由 `test/client.test.js`、`test/visual-status.test.js` 覆盖 |
| 状态提示接口（新增，未参与上述实机） | `index.js` 在 `ctx.inject(['webServer'])` 成功时注册 `GET /api/pre-compact/status`（`src/visual-status.js`）与 `GET /api/pre-compact/logs`（`src/logs-endpoint.js`）；无 `webServer` 则不注册。实机测试早于该功能，**未在真实 GUI 观察指示器**，也未实测这两个 HTTP 路由（Host 侧单测覆盖 resource/JSON/400/403/注销） |
| 调试日志（新增，未参与上述实机） | 第 17 个配置 `logBufferSize`（默认 500，0=关闭并清空，volatile，不进卡片）；`src/log.js` 双写（console 按 `logLevel`、缓冲记录所有级别）；实机测试早于该功能，未验证真实会话缓冲/命令输出/端点 |
| 右侧边栏可视化（新增，未参与上述实机） | client 会话头部按钮 + 右侧边栏 tab（`conversation.session.header.utilities`、`sidebarRightTabs`、`sidebar.right.pane.tab`）；Host `GET /api/pre-compact/history`（`src/history-endpoint.js`）+ coordinator 每会话 `samples`(120)/`history`(30) 含 `step`；实机测试早于该功能，未在真实浏览器看按钮/tab/图表 |
| dryRun | 实机落地测试为 `false`（真实写入） |
| 代码版本 | 实机运行时为本仓库工作树；**测试之后又加入**抗抖动地板、"回退摘要 payload 修复"、manual hook、volatile 配置就地更新、设置卡片，以及**三轮配置面收敛**（25 → 16 键；删除 19 个旧键，含第三轮 `maxConcurrent`——并发改为单会话固定 1、跨会话并行；自适应内部参数改为 `src/internal-policy.js` 常量；手动 deadline 移除；保留区间/阈值跟随后端含 per-model；新增调试日志 `logBufferSize`）。后者由 `node --test` 与 4 个 smoke 脚本覆盖，未重跑实机 |

---

## 2. 自动化测试

### 2.1 单元 / 集成测试（fake harness）

| 项 | 内容 |
|---|---|
| 命令 | `node --test`（**注意**：本机 Node 22.17 在 Windows 上用 `node --test test/` 会把目录当模块入口而报 `Cannot find module ...\test`；`package.json` 的 `test` 脚本已改为 `node --test`） |
| 结果 | 见 §2.3 的最终统计（由 `test/` 下的用例实测得出） |
| 覆盖模块 | `src/config.js`（**16 键**默认值、逐键越界回退、min>max 交换、`unwrapConfigRefs`、累计 19 个已删除旧键被丢弃（含 `maxConcurrent`）、`logBufferSize` 非负回退）、`src/internal-policy.js`（内部常量被 policy 使用）、`src/policy.js`（固定阈值、自适应降级、min/max 夹取、内部 EMA/burst/窗口常量、`no-capacity`、`routeUsable`）、`src/native-policy.js`（后端全局 + per-model 策略、保留合并顺序）、`src/surface.js`（工具对平衡、尾部保留选择、node0 system 排除、空 surface）、`src/commit.js`（`CommitError` 各 code、`MIN_REDUCTION_RATIO`、原子写、增量保留）、协调器状态机（**单会话串行/跨会话并行、无全局并发闸门**、最小间隔、dispose 中断、边界策略、手动请求排队/取消/重试/无 deadline/**supersede 自动工作**/**flush**、`applyConfig` 就地更新）、`src/manual-hook.js`（安装/还原/delegate/busy/changed 重试/generation 守卫）、端到端（后台摘要 → READY → pre-step 落地；dryRun 不写事件）、**`client.js`（离线渲染设置卡片 + composer 指示器 + 侧边栏按钮/面板：注册契约、13 字段/5 分组、边界说明、单位换算、校验、保存/放弃/恢复默认、五态映射/轮询、按步图表/统计/尺寸）**、**`src/visual-status.js`（状态聚合/优先级/8s 窗口/400/403/路由注册注销）**、**`src/log.js`（双写/环形缓冲/sanitize/snapshot）与 `src/logs-endpoint.js`（参数/200/400/403/注销）**、**`src/history-endpoint.js`（samples/history 白名单/空会话/400/403/注销）与右侧边栏面板（`sidebarRightTabs`/`sidebar.right.pane.tab`、按步图表/空态/轮询）** |
| 详细失败/通过清单 | `test/REPORT.md`（若存在）；命令输出见 §2.3 |

### 2.2 静态检查

| 项 | 内容 |
|---|---|
| 命令 | `node -e "await import('./index.js')"`（加载入口，验证 ESM 语法、TLA、`Config` schema 解析） |
| 结果 | 通过：输出 `entry ok pre-compact config-schema`（Config schema 经 profile 的 `@deepseek-ai/schemastery` 解析成功） |
| 说明 | 仓库为纯 ESM、无构建步骤；未引入 TypeScript/打包器，因此没有 `tsc` 阶段。 |

### 2.3 原始输出（结尾统计）

```
$ cd F:\dev\GitHub\dsh-pre-compact && node --test
1..273
# tests 273
# pass 273
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

> 最终稳定统计（连跑两次一致）：**273 tests / 273 pass / 0 fail / 0 skipped**（16 个 Host 测试文件 243 + `fake-harness.js` 自动发现 1 + `client.test.js` 29）。结构：`config.test.js`（**16 键** + 19 legacy 静默 + 未知键 warning + `logBufferSize` 回退）、`manual-hook.test.js`（supersede/flush/sourceCommandId/无 agent/无 deadline）、`client.test.js`（**13 字段**/5 分组 + composer 指示器 + 侧边栏面板/steps/统计/尺寸共 29 用例）、`policy.test.js`（**21 用例，含 warm start**）、`native-policy.test.js`（per-model 合并）、`visual-status.test.js`（13 用例）、`log.test.js`（18 用例）、`logs-endpoint.test.js`（10 用例）、`history-endpoint.test.js`（10 用例）、`session-view.test.js`（**14 用例，优先 steps**）。

覆盖文件：`test/00-smoke.test.js`、`config.test.js`、`policy.test.js`、`surface.test.js`、`commit.test.js`、`lifecycle.test.js`、`e2e.test.js`、`command.test.js`、`summarizer.test.js`、`manual-hook.test.js`、`native-policy.test.js`、`visual-status.test.js`、`log.test.js`、`logs-endpoint.test.js`、`history-endpoint.test.js`、`session-view.test.js`、`client.test.js`，公共 fake 宿主在 `test/fake-harness.js`（按真实 `Session.append` 语义实现，含无损 JSON/undefined 拒绝、surface fold、tool/result 受限重写、node0 保护、重入拒绝；compaction 桩现已支持 native-style `compactNow`）。`client.test.js` 不需要 DOM/浏览器：它用最小 hook 运行时加载 `client.js` 并离线渲染卡片、指示器与侧边栏面板。

> 说明：测试套件曾发现 1 个高严重度缺陷（回退摘要路径的 `compaction/summary` payload 含 `rawOutput: undefined`，真实宿主会拒绝 append 并导致该路径永远无法提交）。该缺陷已修复（commit 只写存在的字段；回退摘要同时返回 `rawOutput`），回归用例已启用，`test/REPORT.md` 记录了完整链路。

---

## 3. 集成场景

### 3.1 固定模式真实落地（**通过**）

| 项 | 内容 |
|---|---|
| 前置 | 临时配置如上；新起一个 subagent 会话（`origin=subagent`），模型 `magpie/deepseek/deepseek-flash`，任务是分块读取 21,419 行的 `research/extracted/lib/main.js` |
| 操作 | 让子代理持续读取大文件，使 token 增长越过临时阈值（`0.1×1,048,576≈104,857`） |
| 期望 | 后台摘要 → 安全边界原子提交 4 条事件；agent 继续执行；期间新增消息保留 |
| 实际 | 会话 `9d07cd4f-04f9-48b8-bccd-bea2811791e2` 的持久化日志中出现 **3 次完整压缩事务**（全部由本插件写入；原生压缩一次未触发） |
| 证据 | 会话日志（`C:\Users\q1325\.dsh\sessions\--F-dev-GitHub-dsh-pre-compact--\9d07cd4f-04f9-48b8-bccd-bea2811791e2\session.v4.jsonl.zstd`，用 `node scripts/inspect-session.mjs 9d07cd4f-04f9-48b8-bccd-bea2811791e2` 解析）：<br>`seq 67 compaction/start {compactionId:1280c4b5-…, turn:1}` → `seq 68 compaction/summary {shadowedRange:{10,14}, shadowedSeqs:[10,11,12,13,14], shadowedTokenCount:2174, provider:magpie, model:deepseek/deepseek-flash}` → `seq 69 user/message replace 10–14 {source.kind:"compact-checkpoint", sourceEventSeqs:[67,68,10,11,12,13,14]}` → `seq 70 compaction/end`（同一 turn） |
| 原子性证据 | 上述 4 条事件的 `time` 依次为 `10:45:04.691 / .692 / .692 / .694`（**3 ms 内、无 await 间隙**），与"摘要已在后台完成、提交只是同步四连写"的设计一致 |
| 摘要成本证据 | `compaction/summary.usage = {inputTokens:479, cacheReadTokens:17280, outputTokens:885, totalTokens:18644}` —— 摘要调用复用了会话前缀缓存，不计入主上下文 |
| 增量合并证据 | 第一次压缩后，会话继续 `step/start(71)`、追加 `agent-instructions/runtime-context/skill-catalog` 等新消息并继续读文件；随后又发生两次压缩（`range 69–20`、`range 82–25`），每次只替换旧区间、新消息全部保留 |
| 工具链完整性 | 第二次压缩区间 `69–20` 正好把 checkpoint、`assistant/message(tool-call)` 与对应 `tool/result` 一起遮蔽；没有跨切点拆开调用链（`tool/call` 与 `tool/result` 成对在区间内） |
| 最终结果 | 子代理完成并给出 21,419 行文件的完整清单（压缩 3 次后仍能准确复述导出的类/函数），说明压缩后上下文对任务仍连贯 |
| 结论 | **通过**：后台摘要不阻塞主循环；提交原子且连续；原生压缩未介入；期间新增消息未丢失；工具调用链未断裂 |

> 备注（诚实）：实机测试阈值被故意调到 0.1，压缩后用量仍高于触发阈值，因此在插件被禁用前出现了 3 次约 19 s 间隔的连续压缩。该现象促成了已实现的**防抖动地板** `retriggerFloor`（提交后要求用量先降到触发阈值以下、或越过"压缩后预计值 + max(2048,1%×window)"才允许再次触发）；该地板逻辑已由单元测试覆盖，但**尚未在真实会话复测**。生产默认（0.7 触发 / 0.8 原生 / 16% 保留尾部）下一次压缩会把用量降到触发线以下，不会出现上述连发现象。

### 3.2 未达阈值不触发（部分验证）

- 当前主会话（`opencode-go/deepseek-v4.1-flash`，1M 窗口，默认 70%）在插件启用期间**从未出现** `compaction/*` 事件（主会话日志可直接核对）；符合"未达阈值不启动"。
- 但未在实机上逐字段核对 `below-threshold` 决策，只在单元测试中断言。

### 3.3 自适应模式（模拟验证，非实机）

- 自适应公式与降级/夹取由 `policy.test.js` 的模拟样本覆盖（缓慢增长、快速增长、突发、高/低延迟压缩、无历史数据、数据缺失→fallback）。
- 未做真实会话的自适应实机运行（成本原因：自适应在无历史时按 `fallbackThreshold=65%` 触发，需要把真实会话推到大窗口的 65% 才有观察点）；见 §7。

### 3.4 其余场景

`applyStrategy=idle-only/end-of-turn`、dryRun、`/precompact pause|resume|now`、原生压缩抢跑、surface 被 pruner/rewind 替换、`/compact` 竞争、preset isolate 下的服务查找等，均在 `test/` 的 fake harness 中构造验证（见 `test/` 文件与 §2.3 统计）；**未逐项在真实 GUI 会话中复测**。

### 3.5 手动 `/compact` hook（**未实机验证**）

| 项 | 内容 |
|---|---|
| 功能 | 插件包装后端实例的 `compactNow`，把 `/compact` 与程序化 `compactNow()` 转成"后台摘要 → 安全边界四连写"，Promise 在落地后 resolve 为宿主形状的 `CompactionResult`（`manual:true`）；无区间 resolve `null`；失败 reject `ManualCompactionError{code}`。新增 `/precompact compact` 子命令、`status` 的 `Manual request:` 行与 `Manual /compact hook:` 状态行 |
| 前置 | `enabled && !dryRun && hookManualCompact`，且后端实例可写（实例方法 `compactNow` 存在、不是冻结对象） |
| 期望 | 日志出现 `hooked the manual compaction entry point`；`/compact` 不再占用 `runMaintenance`、不再 busy；第一条 `compaction/start` 与 `compaction/end` 由本插件写入且含 `sourceCommandId`；落地后命令显示宿主的 "Compacted N history items…"；abort/暂停/dispose 后结果不会迟到落地；**手动会先取代自动工作、再按手动语义摘要**；提交后 flush（fire-and-forget）；**没有插件级超时**（等待由原生生命周期收敛） |
| 实际 | **未实机验证**：本次实机测试早于该功能合入，未在真实 GUI 点击 `/compact`，也未观察 hook 日志/命令文本 |
| 现有证据 | **有专项测试**（37 用例）——`agent/created` 安装 + `agent/pre-step` 兜底、`dispose` 还原原方法、`enabled=false`/`dryRun=true`/`hookManualCompact=false` 三种 delegate、`busy`、已 abort 的 signal、运行中 abort（迟到完成不落盘）、session/agent/plugin dispose、**无插件 deadline**（abort/dispose 收敛）、无区间 resolve `null`、**skip + 无 attached agent → reject `summary`**、`minShadowedTokens` 仅保护自动路径、running agent 在下次 pre-step 落地、**手动取代自动 READY/在途任务（`supersedeAutomaticWork`，日志 `manual request superseded automatic pre-compaction work`）**、`sourceCommandId` 写入结果/三个事件/**checkpoint source**、**手动提交后 fire-and-forget `sessions.flush`**、手动固定 `retainTokens=0` 的激进区间、`/precompact compact` 六种结果、preset 后端、invalidate 不落地过期结果、`changed` 重试一次；`test/fake-harness.js` 提供 native-style `compactNow` 桩。**未在真实 GUI 点击 `/compact`** |
| 已知差异 | 错误不是宿主 `ManualCompactionError` 类实例（显示本插件 message）；`turn` 可能非 `null`（原生手动恒为 `null`）；`/precompact pause` 会取消手动请求（原生无此概念）；见 [docs/05](05-limitations.md) §1.6/§2.13/§5.6 |
| 结论 | **单元/集成通过，未实机验证**（发布说明必须保留该项） |

### 3.6 插件页设置卡片（**Host 侧通过；真实浏览器未验证**）

| 项 | 内容 |
|---|---|
| 功能 | 浏览器 half（`client.js`）在 **Plugins → 本 bundle 详情页 → 描述下方** 的 `plugins.bundle.config` 槽渲染设置卡片；绑定 Host 的 `pre-compact` 配置命名空间（`ctx.configForms`），**14 个字段、五个分组**（基础/固定/自适应/调度/手动 `/compact`）+ 保存/放弃/恢复默认；顶部固定显示边界说明（只决定时机与异步调度，保留区间/摘要模型/摘要质量由后端决定）；所有行为字段 `.volatile()`，保存后经 `loader/volatile-update` 就地生效 |
| 前置 | Host 能提供 `pre-compact` 配置命名空间（schema 可解析）；profile 装的是最新代码；**浏览器已刷新并加载新 client 模块** |
| Host 侧证据 | `node --test` 的统计以 `npm test` 实跑为准；其中 `test/client.test.js` 断言 **13 字段/5 分组**、四类注册（设置卡片 + composer 指示器 + 会话头部按钮 + 侧边栏 tab/body）、`describeIndicator` 五态映射、1.2s 轮询/隐藏标签页/卸载清理、保存/放弃/恢复默认等；`test/visual-status.test.js` 覆盖状态聚合、优先级、8s 窗口、400/403、路由注册/注销。`node scripts/smoke.mjs`、`smoke-manual.mjs`、`smoke-config-live.mjs`、`smoke-client.mjs` 均通过 |
| volatile 证据 | `node scripts/smoke-config-live.mjs` → `LIVE CONFIG SMOKE OK`：初始触发点 `700,000`；把 `fixedThreshold` 从 0.7 改为 0.4 并触发 `loader/volatile-update` 后 `400,000`；`enabled=false` 后 status 显示 paused；日志出现 `configuration updated`。即 **Host 侧不重启即可生效**已被离线验证 |
| 插件加载 | `plugin_manager` 重载后 Loader 行 `include:pre-compact` 为 `active`（Host 半）；client 半由 `package.json` 的 `exports["./client"]` + `dsh.client` 声明，Host 的 client-modules 已据 manifest 合成 |
| Client graph 证据 | 公开路由 `GET /plugins/events` 的 graph 帧包含 `{"id":"@local/dsh-pre-compact","url":"plugins/??@local/dsh-pre-compact/client.js&rev=<12hex>","inject":["@deepseek-ai/dsh-client-ui-plugin-manager"],"immediately":true}`；按 graph 的 URL 抓取得到 **38,492 字节**的 bundle，内含 `__ModuleLoader__` 加载调用与 `plugins.bundle.config` 注册代码（rev 与按 `client.js` 的 mtime/ctime/size 计算的 `plugin-artifact` 帧哈希一致） |
| 实际 | **未由 Lead 验证浏览器渲染**：没有在真实页面看到卡片、点击保存、观察 UI 反馈或刷新后的持久化；`cordis_inspect_query client/Slots` 在当前已连接页面里查询 `plugins.bundle.config` 的 keyDomain 尚未包含 `@local/dsh-pre-compact`（该页面在本功能合入前启动；同槽内 `dsh-read-image-compress` 也未出现，说明注册是随配置命名空间被服务/页面打开而惰性发生的，不能据此判定失败） |
| 未验证项 | ① 真实浏览器是否渲染卡片（含语言、主题、窄屏布局）；② 点击“保存”后 UI 提示与 Host `loader/volatile-update` 的真实链路；③ `status` 是否立即反映新阈值（Host 侧 smoke 已覆盖逻辑，GUI 未覆盖）；④ 保存失败/revision 冲突/只读状态的 UI 表现；⑤ 刷新页面/重开 bundle 后卡片出现与持久化；⑥ linked bundle manifest 更新后是否需要 entry restart |
| 结论 | **Host 侧（单测 + volatile 冒烟）通过；真实浏览器渲染与保存未验证**，发布说明需注明“装好后请刷新页面并自行确认卡片” |

### 3.7 token 指示器旁的状态提示（**Host 资源单测通过；真实浏览器未验证**）

| 项 | 内容 |
|---|---|
| 功能 | Host 注册只读 `GET /api/pre-compact/status?sessionId=…`（`src/visual-status.js`），client 在 `conversation.composer.dock`（token 环左侧）轮询并显示 `working/ready/done(8s)/failed(8s)`，`idle` 不占位 |
| 前置 | Host 有 `webServer`（否则不注册路由、指示器隐藏）；profile 装最新 client；**浏览器已刷新页面** |
| Host 侧证据 | `test/visual-status.test.js`（13 用例）：`buildVisualStatus` 聚合字段白名单（无消息内容）、`working > ready > failed(更新于 outcome) > done > idle` 优先级、`DONE_WINDOW_MS`/`FAILED_WINDOW_MS` 精确窗口、`manual` 来源、`outcome`/`failure` 裁剪；resource 对合法 session 返回 **200 JSON + `cache-control: no-store`**，未跟踪 session 返回 idle，非法 sessionId **400**，跨源 **403**/同源放行，`apply()` 注册 exact 路由且 dispose 注销，无 webServer 仍启动 |
| client 侧证据 | `test/client.test.js`（29 用例）：四类注册（设置卡片 + `conversation.composer.dock` 指示器 + `conversation.session.header.utilities` 按钮 + `sidebarRightTabs`/`sidebar.right.pane.tab`）、`openTab` 调用、sidebar 缺失跳过、`describeIndicator` 五态与中英文案、挂载立即轮询 + `POLL_INTERVAL_MS=1200`、`document.hidden` 跳过、卸载清 interval + abort、idle 不渲染；面板优先 steps 图表/空态/2500ms 轮询 |
| 实际 | **未在真实浏览器验证渲染/轮询**：没有在 GUI 观察指示器出现、8s 后消失、隐藏标签页行为；也**没有对真实 HTTP server 做 curl**（Host 证据来自 resource 单元测试，非端到端 HTTP） |
| 未验证项 | ① 浏览器是否真的渲染在 token 环左侧且不挤压布局；② 1200ms 轮询在真实页面上的开销/错误恢复；③ 8s done/failed 窗口的视觉与读屏提示；④ 无鉴权路由在真实 profile 的暴露面；⑤ 刷新页面/重开 bundle 后指示器加载 |
| 结论 | **Host 资源与 client 映射的离线测试通过；真实浏览器与真实 HTTP 端到端未验证**，发布说明需注明“刷新页面后自行确认指示器” |

### 3.8 结构化调试日志（**Host 单测通过；真实控制台/端点未验证**）

| 项 | 内容 |
|---|---|
| 功能 | `src/log.js` 双写（console 受 `logLevel` 控制、内存环形缓冲记录所有级别，容量 `logBufferSize` 默认 500/0 关闭）；`/precompact logs [n]` 与 `GET /api/pre-compact/logs` 读取同一缓冲；字段经 `sanitizeFields()` 有界化 |
| 前置 | `logBufferSize > 0`；HTTP 端点还需要 Host `webServer`（无则路由不注册）；无需刷新页面（Host 侧） |
| Host 侧证据 | `test/log.test.js`（18 用例）：双写/级别过滤、容量与 0 关闭清空、volatile 容量、sanitize 边界（300/20/深度 3/循环/Error/BigInt/函数/undefined）、`snapshot` 的 limit/level/sessionId/sinceSeq/升序、`clear`/`stats`；`test/logs-endpoint.test.js`（10 用例）：200 JSON + `no-store`、默认 limit 100、limit 1..500、level 闭集/最低级别、sessionId 格式、sinceSeq 非负整数、400 各分支、跨源 403/同源放行、注册/注销；`command.test.js` 覆盖 `logs [n]` 的默认 30/范围 1..200 与空缓冲提示 |
| 实际 | **未在真实会话验证**：没有在真实 GUI 执行 `/precompact logs`、没有对运行中的 HTTP server 抓 `/api/pre-compact/logs`、没有验证重启后缓冲确实丢失；也没有观察真实 console 与缓冲的一致性 |
| 未验证项 | ① 真实会话中 `/precompact logs` 的格式与字段可读性；② 真实 HTTP 端点 200/400/403；③ 8s/容量淘汰在真实流量下的表现；④ 重启/重载后缓冲丢失（按设计）；⑤ sanitize 对真实错误对象的裁剪效果 |
| 结论 | **Host 侧单测通过；真实命令/HTTP/重启行为未验证**，发布说明需注明“诊断用，不持久化、不适合审计” |

### 3.9 右侧边栏「预压缩」面板（**Host 端点/图表模型单测通过；真实浏览器未验证**）

| 项 | 内容 |
|---|---|
| 功能 | 右侧边栏「预压缩」面板：会话头部 utilities 按钮 → `sidebarRight.openTab('pre-compact')`；tab 由 `sidebarRightTabs.register` + `sidebar.right.pane.tab` body 提供；面板展示五态 pill、当前步 chip、占用仪表（触发/原生 marker）、**统计 chips**（压缩次数/累计节省时间/平均摘要/释放 tokens/距触发）、**按步（step）**的紧凑趋势图（**优先用 Host `steps` 全量序列显示全部步骤**；steps 缺失/为空才回退 samples 分组/采样序号；最多 6 刻度；viewBox 720×168、容器全宽、`height:auto`）、最近 10 条压缩记录（首列步骤、末列节省时间）；数据来自 `GET /api/pre-compact/history`（每会话 `samples` 120 / `history` 30 有界；**`steps` 全量无上限**；均含 `step`；仅成功提交；内存态） |
| 前置 | Host 有 `webServer`；浏览器有 `sidebarRight`/`sidebarRightTabs`（否则按钮/tab 跳过）；profile 装最新 client 且**已刷新页面**；至少发生过一次 evaluate（samples/steps）/成功提交（history），且已收到 `step/start` 才有步骤 |
| Host 侧证据 | `test/history-endpoint.test.js`（10 用例）：200 JSON + `no-store`、`current` **20 字段**白名单（含 `step`；`lastFailure/lastSkip/manualRequest` 裁剪）、顶层 `step`、**`steps` 数组**、未知会话 `current:null` + 三空数组（含 `steps: []`）、非法 sessionId 400、跨源 403/同源放行、注册/注销、samples/steps/history（含 `step`）透传；`test/session-view.test.js`（**14 用例**）：**优先 `steps` 画全部步骤（升序/每步一条）**、steps 缺失/为空回退 samples 分组（同步取最后/未知步骤/序号回退）、空/单点/多点、y 刻度与触发/原生阈值线、最多 6 个步骤刻度、history 只在命中步骤画标记、`describeViewState` 五态、记录表裁剪 |
| client 侧证据 | `test/client.test.js`（**29 用例**）：四类注册（设置卡片/dock 指示器/`conversation.session.header.utilities` 按钮/`sidebarRightTabs`+`sidebar.right.pane.tab`）、`openTab` 调用、sidebar 服务缺失跳过、当前步 chip、表首列步骤、**优先 `steps` 图表**、**`buildStats` 五项统计与 `—` 空值**、**紧凑尺寸断言（CHART_HEIGHT=168、全宽无 760 max-width）**、**节省时间列/aria `saved ≈ X`**、2500ms 轮询与卸载清理、空态/错误点 |
| 实际 | **未在真实浏览器验证**：没有在 GUI 点按钮打开右侧 tab、看到按步 x 轴/统计 chips/仪表/表格的实际 SVG 渲染、**超长全量 steps 与右侧窄栏全宽布局**、主题/读屏；也未验证 2500ms 轮询在真实多步会话的表现 |
| 未验证项 | ① 会话头部按钮是否出现、点击能否打开右侧 tab；② 右侧栏窄布局（全宽、表格横向滚动、chips 换行）；③ 按步轴 SVG/主题/可读性；④ 隐藏标签页跳过与错误恢复；⑤ **超长会话全量 steps（内存/响应体增长）**；⑥ 空态/未知步骤/记录表在真实数据下的表现；⑦ 重载后 samples/steps/history 清空（按设计） |
| 结论 | **Host 数据契约、steps 优先图表模型与统计的离线测试通过；真实右侧边栏/按钮/窄栏/长序列未验证**，发布说明需注明“刷新页面后自行确认按钮与面板” |

### 3.10 自适应 warm start（**纯函数单测通过；真实压缩后取值未验证**）

| 项 | 内容 |
|---|---|
| 功能 | 自动压缩成功后 `growth.reset()` 会让数据短暂不完整；此时若存在 `state.lastAdaptiveTarget`（上一次 `dataComplete` 的 adaptive 目标），`evaluateTrigger` 复用它（reason `adaptive-warm-start`，derivation 带 `warmStartTokens/warmStartRatio/warmStartAt`），不再立刻掉回 `fallbackThreshold`（65%）；没有历史完整预测才 fallback；fixed 模式不读 warm start |
| Host 侧证据 | `test/policy.test.js`（**21 用例**）：warm start 复用上次完整预测、无历史仍 fallback、fixed 不读、warm start 仍受 min/max clamp、derivation 字段；coordinator 只在 `mode==='adaptive' && dataComplete` 记录 `state.lastAdaptiveTarget` |
| 实际 | **未实机验证“压缩后下一次触发确实沿用 75% 而非 65%”**：只有纯函数/状态机单测；未在真实会话观察 `triggerReason=adaptive-warm-start`、`triggerRatio` 连续性与新数据重建后的切换 |
| 未验证项 | ① 真实压缩后 warm start 是否按预期保持上一次阈值；② warm start 被新完整预测替换的时点；③ 模型/配置变化后短暂沿用旧阈值的实际影响；④ `status` 是否暴露足够信息区分 warm start/fallback（当前不打印 `derivation`） |
| 结论 | **warm start 纯函数与状态机单测通过；真实压缩后取值未验证** |

---

## 4. 安全不变量验证

| 不变量 | 实测/测试证据 | 结论 |
|---|---|---|
| I1 原子提交 | 实机：4 条事件 3 ms 内连续写入，`compaction/start` 与其后的 `compaction/end` 严格配对；单测：commit 抛错时补写带 `error` 的 `compaction/end`，原 surface 不变 | 通过 |
| I2 tool-pair 平衡 | 实机：区间 `69–20` 把 `assistant(tool-call)` 与 `tool/result` 连同 checkpoint 一起遮蔽，未拆链；单测：切点落在调用/返回之间时选择器自动扩大保留区或提交被拒 | 通过 |
| I3 node 0 保护 | 单测：system 头在节点 0 时区间从节点 1 起；实机：所有 replace 都未覆盖节点 0 | 通过 |
| I4 锁互斥 | 单测：`compaction/start` 未配对时提交被 `locked` 拒绝；实机：没有与原生并发压缩的情况 | 通过（实机为避开而非竞争） |
| I5 generation 校验 | 单测：摘要期间注入 replace → `surface-replaced` / `span-repriced`，结果丢弃 | 通过 |
| I6 原生兜底 | 实机：原生压缩从未被改动或卸载（`include:compaction-basic` 仍由 preset 挂载）；单测：插件 dispose 后无残留写入 | 通过 |
| I7 保留区间跟随其后端 | 单测：`resolveNativePolicy()` 读后端 `retainTokens`（含 `modelPolicies` 的 per-model 覆盖；读不到按 `retainRatio=0.16` 推导并夹到阈值 90%）；手动路径固定 `retainTokens=0`；实机：压缩后追加的消息仍在 surface（与 I16 一起验证） | 通过（单测；实机未跨后端对比） |
| I8 事件类型 | 实机日志只出现 `compaction/start|summary|end` + `user/message(replace)`，无自造类型；会话重启读路径未报"unknown event type" | 通过 |
| I9 不重入 | 单测：fake session 在 append 发布期间重入会抛错；插件在 `session/event` 里只读、不 append | 通过 |
| I10 不阻塞 | 设计上 hook 内不 await 模型；实机证据：压缩事务 3 ms 完成，且 agent 在压缩前后持续 step（每个 step 间隔约 19 s 是模型/工具耗时，不是摘要耗时） | 通过（未做精确 hook 墙钟埋点） |
| I11 幂等 + 手动取代自动 | 单测：同一会话已有 active/ready 时不重复启动；手动先 `supersedeAutomaticWork()`（丢弃自动 READY / abandon+abort 在途），再启动全新手动摘要 | 通过（单测） |
| I12 收缩保证 | 自动路径：`framedTokens < shadowedRouteTokens` 且 `reduction ≥ MIN_REDUCTION_RATIO`（内部常量 **0.05**，不可配置）；手动路径只要求更小；单测：`not-smaller` / `small-reduction` 拒绝；实机 3 次摘要字符数均远小于被遮蔽区间 | 通过 |
| I13 节流/降级 | 单测：`minInterval`、`retriggerFloor` 生效；跨会话无全局节流；自适应数据不完整时 warm start 优先、无历史才 fallback；fixed 不读 warm start | 通过（单测；真实压缩后取值未验证） |
| I14 手动请求不占维护窗口 + 语义独立 | 单测（`test/manual-hook.test.js`）：`compactNow` wrapper 返回 Promise、后台摘要、边界落地后 resolve 宿主形状 `CompactionResult`；手动不复用自动 READY/在途，按 `retainTokens=0` 重新摘要（可能多一次摘要）；**未在真实 GUI 点击** | 通过（单测）/未实机 |
| I15 最小收益门 | 单测：被压缩区间路由价 < `minShadowedTokens` → `range-too-small` 跳过（不付摘要成本） | 通过 |
| I16 固定阈值可落地 | 单测：`autoAdjustFixedThreshold` 在"用户阈值 ≥ 原生阈值"时下调到 `native − max(4096, 2%·native)`（下限 5%·C）；关闭时保持用户值；实机手算：1,048,576 窗口 + 393,216 输出预留 → 原生 589,824（56.3%），默认 70% 会被下调 | 通过 |
| I17 抗抖动 | 单测：提交/干跑后设置 `retriggerFloor`，同一压力水平不会重复起任务；重启用例按 `retrigger-floor` 断言 | 通过 |
| I18 手动 hook 只接管/可还原 + 永不悬挂 | 单测：`agent/created` 安装、`agent/pre-step` 兜底、dispose 还原原方法、三种 delegate、包装器内部失败 delegate、取消后不迟到落地、**skip + 无 attached agent → reject `summary`**；**未实机** | 通过（单测）/未实机 |
| I19 不接管压缩语义（含 per-model 跟随） | 单测：配置面 **16 键**、累计 19 个旧键被忽略；自适应内部参数为 `src/internal-policy.js` 常量；`resolveNativePolicy()` 跟随后端全局策略与 `modelPolicies` 的 per-target 策略（阈值/headroom：override > target > global > defaults；保留：目标 token > 目标 ratio > 全局 token > 全局 ratio > 默认 16%）；手动固定 retain=0、**无插件 deadline**；自动质量门槛为内部常量 0.05 | 通过（单测；真实后端策略未实机对比） |
| I20 手动落盘检查点 + 诊断 | 单测：手动提交后 fire-and-forget `sessions.flush`（失败只 warn）；未知配置键 warning（19 个 legacy 键静默，含 `maxConcurrent`）；checkpoint source 带 `sourceCommandId` | 通过（单测；真实 flush 未实机验证） |
| I21 状态提示只读且不泄露内容 | 单测（`test/visual-status.test.js`）：只返回聚合字段（无消息内容）、sessionId 白名单（400）、同源校验（403）、`no-store`、路由注册/dispose 注销；client 离线测试覆盖五态映射与轮询 | 通过（单测；真实 HTTP/浏览器未验证） |
| I22 调试日志不泄露消息内容、缓冲有界 | 单测（`test/log.test.js`/`logs-endpoint.test.js`）：双写、容量/0 关闭、sanitize 边界、snapshot 过滤、端点 200/400/403/注销；缓冲不持久化按设计 | 通过（单测；真实命令/HTTP/重启未验证） |
| I23 可视化数据有界/只读（steps 例外） | 单测（`history-endpoint.test.js`/`session-view.test.js`/client）：samples 120（回退）/history 30 有界、**steps 全量**、仅成功提交、current **20 字段**白名单、未知会话三空数组、端点 200/400/403/注销、优先 steps 画全部步骤/缺失回退/最多 6 刻度/记录表步骤、**统计五项与 `—`**、**紧凑尺寸**、**sidebar 注册/缺失跳过** | 通过（单测；真实浏览器/超长序列未验证） |
| I24 并发：单会话串行、跨会话并行 | 单测（`lifecycle.test.js` 更新中）：同一会话不会并行两份摘要；无全局 `maxConcurrent`/`activeTasks`；不同会话各自触发互不阻塞 | 通过（单测；真实多会话并发未实机） |
| I25 warm start 有界且不替代完整预测 | 单测（`policy.test.js`）：只保留最后一次 `dataComplete` 目标；数据不完整时优先复用、无历史 fallback；仍受 min/max 夹取；fixed 不读；`derivation` 带 warmStart 字段 | 通过（单测；真实压缩后未验证） |

---

## 5. 数值核对（自适应算法）

离线执行 `evaluateTrigger()`（`config` 为默认自适应配置；`native={contextWindow:1,000,000, thresholdTokens:800,000, source:'backend-config'}`）得到：

| 场景 | 输入（V=EMA/峰值，T=预测耗时，K=1.3，S=4096） | 期望（按 docs/03 公式） | 实测 `triggerTokens` | 结论 |
|---|---|---|---|---|
| 无历史数据 | 无速率样本、无耗时样本 | 取 `fallbackThreshold`：`0.65×1,000,000=650,000` | `650000`（`adaptive-fallback-no-data`） | 一致 |
| 缓慢增长 + 快压缩 | `V≈38.24 tok/s`, `T=8×1.3=10.4s` → `G≈4,494` | `800,000−4,494=795,506` → 受 `maxThreshold` 夹取 | `750000`（clamps=`max-threshold`） | 一致 |
| 快速增长 + 慢压缩 | `V≈3,047.93`, `T=58×1.3=75.4s` → `G≈233,910` | `800,000−233,910=566,090`（落在 [0.5C,0.75C]） | `566090`（ratio 0.5661，`adaptive-predicted`） | 一致 |
| 突发峰值保护 | 窗口内峰值 `5,200 tok/s`，`T=39s` → `G≈206,896` | 峰值 > EMA×`BURST_GROWTH_FACTOR`（内部常量 2）时用峰值：`800,000−206,896=593,104` | `593104`（ratio 0.5931） | 一致 |
| 当前用量已越过预测触发点 | 同上，`totalTokens=650,000` | `due=true` | `due=true, reason=adaptive-predicted` | 一致 |

`P_trigger=U_trigger/C` 与 `status.triggerRatio` 由同一整数除法得出（`round(…,4)`），上表已核对。

---

## 6. 升级验收清单

| # | 检查项 | 结果 |
|---|---|---|
| 1 | 测试全绿 | 见 §2.3 |
| 2 | `dryRun + debug` 长会话能产出 READY 且 reduction 合理 | 未实机执行（单测覆盖 dryRun 不写事件） |
| 3 | 真实落地后 `seqs` 连续、`total_after_estimate < total_before` | 通过（实机 3 次事务；`seqs` 67–70 / 80–83 / 90–93） |
| 4 | 与 `/compact` 无锁竞争异常 | 未实机触发 `/compact`；单测覆盖 `locked` 拒绝 |
| 5 | 会话重启恢复无未知事件类型错误 | 未重启验证（写入的都是已知 `compaction/*` 与 `user/message`，风险低） |
| 6 | `eventAt` 仍可用 | 通过（实机快照构造成功） |
| 7 | `ctx.compaction.summarize()` 是否存在 | 实机摘要成功且 usage 前缀缓存命中；无法从会话日志区分"原生钩子"与"回退 llm.stream"，两条路径语义一致 |
| 8 | 后端策略可读（`source=backend-config`） | 通过（`/precompact status` 未能在本次实机读取；但 `nativeThreshold` 计算与手算一致、触发点符合公式；单测断言 `backend-config` 与 `modelPolicies` 目标策略） |
| 9 | 配置面收敛后的兼容性 | 通过（单测）：旧 profile 中累计 19 个已删除键被静默忽略（含 `maxConcurrent`）；新配置 **16 键**、卡片 **13 字段**；`cordis.patch.yml` 已同步；自适应内部参数改为 `src/internal-policy.js` 常量；`logBufferSize` 已加入 |
| 10 | 四个 smoke 脚本 | 通过：`smoke.mjs`（会话用后端 16% 保留策略驱动，不再设置 `retainRatio`）、`smoke-manual.mjs`、`smoke-config-live.mjs`、`smoke-client.mjs` |
| 11 | 独立审查修复（手动语义独立性/落盘/诊断） | 通过（单测）：手动 `supersedeAutomaticWork()`（不复用自动 READY/在途）、checkpoint source 带 `sourceCommandId`、skip+无 agent reject `summary`、手动提交后 fire-and-forget flush、未知键 warning（18 legacy 静默） |

**配置面迁移说明**（2026-11-05 边界收敛 + 独立审查）：

- 本插件从"也管压缩语义/暴露密集调参"收敛为"只管时机与异步"：第一轮删除 9 个压缩语义键；第二轮删除 `manualCompactTimeoutSeconds` + 7 个自适应内部调参 + `growthWindow`；第三轮删除 `maxConcurrent`（共 19 个旧键）。这 19 个旧键在旧 profile 中仍被**静默忽略**；**其它未知键**现在会打 warning `unknown config key "<key>" was ignored`（不阻断启动）。并发改为单会话固定 1、跨会话可并行。
- 自适应预测公式未变，但内部参数改为 `src/internal-policy.js` 固定常量；只保留 `minThreshold`/`maxThreshold`/`fallbackThreshold`。
- 手动 `/compact` **不再有插件 deadline**：Promise 只在“后台结果落地 / 调用方 abort / 插件卸载或会话失效”时 settle；超过 600s 也不会自动失败。
- 自动路径的保留区间改为跟随当前后端：`retainTokens`（含 `modelPolicies` 的 per-model 覆盖），读不到时按 `retainRatio=0.16` 推导并夹到阈值 90%；手动 `/compact` 固定 `retainTokens=0`。
- 摘要优先走后端 `summarize()`；回退用会话路由 + 常量 `FALLBACK_MAX_TOKENS=65536`；自动质量门槛改为内部常量 `MIN_REDUCTION_RATIO=0.05`（不可配置）；模型作用域过滤已移除。
- **迁移验证仅由单测覆盖**：没有在真实 profile 中带着旧配置重启验证"旧键被忽略 + 新策略生效"（见 §7）。

---

## 7. 未验证 / 未覆盖（诚实清单）

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| 1 | `agent/pre-step` 中本插件与原生压缩 listener 的先后 | 未直接观测 | 实机未出现同 step 竞争；设计上依赖"原生先执行、我方在 `next()` 内后执行"的注册顺序 |
| 2 | 客户端是否渲染 checkpoint 提示 | 未验证 | 只用了原生同款 `kind:'compact-checkpoint'` |
| 3 | `/precompact` 命令在 Web GUI 的实际交互 | 未在 GUI 点击验证 | 命令注册路径已由单测覆盖 |
| 4 | 纯自适应模式的真实会话运行 | 未实机 | 见 §3.3；公式与降级由单测核对 |
| 5 | 会话重启 / resume 后的行为 | 未实机 | 状态仅在内存；重启后从下一次 step 重新评估 |
| 6 | 图像 offload 与压缩的时间交互 | 未实机 | 被 `contentGeneration` 校验保守丢弃 |
| 7 | 超大会话（>100 轮）内存与状态裁剪 | 未实机 | `pruneStates` 仅保留 32 个会话状态 |
| 8 | 与 `smart-compaction`/pruner 同时改写 surface 的竞争 | 单测模拟 | 实机未构造 |
| 9 | `plugin_manager` 安装后的"应用即生效"在重启后的持续性 | 部分 | 当前进程已 `fiberPhase=active`；重启后由 bundle patch 重新加载 |
| 10 | 设置页 Config 表单的渲染外观 | 未在浏览器核对 | `Config` schema 已成功解析 |
| 11 | 真实 `/compact` 交互（manual hook） | 未验证 | 见 §3.5：未在 GUI 点击，未观察 `hooked the manual compaction entry point` / `Manual /compact hook:`；证据仅来自 `test/manual-hook.test.js`（fake harness，用例数以实跑为准） |
| 12 | `/compact` 的命令文本渲染（成功文案、错误文案） | 未验证 | 成功文案由宿主 `executeCompact` 渲染（`Compacted N history items…`）；错误是本插件 message（非宿主类实例，`expectedFailure` 不生效）；**无插件超时文案** |
| 13 | 手动请求在极端情况下长时间等待（无 deadline） | 未实机 | 单测覆盖 abort/dispose 收敛；没有在本插件外强制 600s 的场景下验证"不自动失败" |
| 14 | 手动 hook 与 `/precompact compact` 的 GUI 可用性 | 未验证 | 命令已注册且单测覆盖；未在 GUI 执行；`hookManualCompact=false` 的提示文案未实机核对 |
| 15 | `/precompact pause` 取消手动请求后、恢复后重新发起 `/compact` 的完整链路 | 未实机 | 单测覆盖暂停时的 unavailability；未覆盖"恢复后重试"的真实命令链 |
| 16 | 插件页设置卡片的真实浏览器渲染 | 未验证 | 见 §3.6：未刷新页面观察卡片；`test/client.test.js` 只做离线渲染（无 DOM/主题/布局） |
| 17 | 卡片保存的真实链路（UI → config editor → `loader/volatile-update` → status） | 未验证 | Host 侧由 `scripts/smoke-config-live.mjs` 覆盖逻辑；GUI 点击未验证 |
| 18 | 刷新页面 / 重开 bundle 后卡片出现与配置持久化 | 未验证 | client 模块在页面 boot 时加载；需用户刷新后自行确认 |
| 19 | linked bundle manifest（`exports["./client"]`/`dsh.client`）变更后的 entry restart 行为 | 未验证 | 链接安装下清单变更可能需要重启/重载该行才会被 Host 读到 |
| 20 | 卡片保存失败 / revision 冲突 / 只读状态的 UI 表现 | 未验证 | 前端逻辑有 `saveFailed`/`readOnly`/`unavailable`，但未在真实 Host 上触发 |
| 21 | 旧配置键迁移在真实 profile 中的表现 | 未实机 | 单测覆盖“19 个 legacy 静默（含 `maxConcurrent`）+ 其它未知键 warning”，但未带旧配置重启验证 |
| 22 | 后端 `modelPolicies`（per-model 阈值/保留）与真实后端的一致性 | 未实机 | 单测覆盖解析与优先级（阈值 override > target > global > defaults；保留目标 token > 目标 ratio > 全局 token > 全局 ratio > 默认 16%），未与真实后端逐模型对比 |
| 23 | 后端未暴露策略时的回退（0.8/65536/16%） | 单测覆盖 | 未在无策略的真实后端上运行 |
| 24 | 手动取代自动任务在真实会话中的成本（多一次摘要） | 未实机 | 单测覆盖 supersede 行为；真实会话中自动任务在跑时的手动请求未测 |
| 25 | 手动提交后的 `sessions.flush` 在真实宿主上的持久化效果 | 未实机 | 单测覆盖 fire-and-forget/失败 warn；未在崩溃/恢复场景验证 |
| 26 | 状态指示器在真实浏览器的渲染/布局 | 未验证 | 见 §3.7：未在 GUI 观察 token 环左侧的渲染与 8s 消失 |
| 27 | 真实 HTTP server 上的 `GET /api/pre-compact/status` | 未验证 | Host 证据来自 resource 单元测试（200/JSON/no-store/400/403），未对运行中的 webserver 做 curl |
| 28 | 无鉴权只读路由的暴露面 | 未验证 | 与 DSH webserver 设计一致；只返回聚合状态/日志文本，但未做真实网络边界评估 |
| 29 | 真实会话中的 `/precompact logs` 输出 | 未验证 | 单测覆盖缓冲/格式化；未在真实 GUI 执行 |
| 30 | 真实 HTTP `GET /api/pre-compact/logs`（200/400/403） | 未验证 | Host 证据来自 resource 单测，未对运行中的 webserver 抓取 |
| 31 | 重启/重载后日志缓冲丢失 | 按设计 | 未在真实重启中观察；缓冲只在内存 |
| 32 | 会话头部「预压缩」按钮与右侧边栏 tab 的真实打开 | 未验证 | 未在 GUI 确认按钮出现、点击 `openTab` 打开 tab、sidebar 缺失时跳过（§3.9） |
| 33 | 按步趋势图 SVG 布局/主题/读屏 | 未验证 | 仅离线模型测试；未看真实布局与 `prefers-reduced-motion` 之外的视觉 |
| 34 | 2500ms 轮询在真实页面的表现 | 未验证 | 隐藏标签页/错误恢复/卸载清理/unmount 只有单测 |
| 35 | 侧边栏面板数据重载后清空 | 按设计 | 未在真实重载中观察 samples/history 清空 |
| 36 | 真实多步会话的步骤轴 | 未验证 | 未在 GUI 观察「步 N」类别、同步取最后、最多 6 刻度 |
| 37 | 未知步骤回退（插件启动前的步骤） | 未验证 | 单测覆盖 `step=null` 的未知类别/序号回退；未在真实早期会话观察 |
| 38 | 跨会话并行摘要的真实行为 | 未实机 | 单测覆盖无全局 `maxConcurrent`；未在多个会话同时触发时观察 provider 并发/429/成本峰值 |
| 39 | 右侧边栏窄栏真实布局与统计 chips 换行 | 未验证 | 全宽（无 760 max-width）、720×168、overflowX 只有离线断言；未在真实窄栏看渲染与换行 |
| 40 | 超长会话的全量 steps 图与端点大小 | 未验证 | 单测覆盖优先 steps/6 刻度；未在真实会话跑超长序列，也未测 `/api/pre-compact/history` 响应体随步数增长 |
| 41 | 真实压缩后的 warm start 取值 | 未验证 | 单测覆盖复用/fallback/fixed；未在真实压缩后观察 `adaptive-warm-start` 与阈值连续性 |
| 42 | 真实宽屏/窄屏侧边栏与统计 chips | 未验证 | 全宽布局与 chips 换行只有离线断言 |

---

## 8. 结论汇总

| 项 | 结论 |
|---|---|
| 单元/集成测试 | 见 §2.3（`node --test` 全绿） |
| 实机集成 | **通过**：固定模式在真实 DSH 会话中完成后台摘要 + 原子提交，原生压缩未介入，新增消息与工具链完整 |
| 自适应算法 | 公式、夹取、降级、突发保护均与代码实测一致；无实机会话验证 |
| 安全不变量 | 关键不变量（原子提交、tool-pair、node0、generation、收缩、节流、不接管压缩语义、手动取代自动/flush/诊断、状态提示只读）均通过实机或单测验证；保留区间与阈值跟随后端（含 per-model `modelPolicies`）已由单测覆盖 |
| 状态提示 | Host 资源与 client 映射/轮询有离线单测；**真实浏览器与真实 HTTP 端到端未验证**（§3.7） |
| 是否可交付 | **可以交付为可用插件**（Host 平面 + **16 键**配置 + 命令 + 测试 + **13 字段**设置卡片 + **token 旁状态指示器** + **调试日志** + **右侧边栏可视化面板**），但应保留 §7 的未验证项作为发布说明；**手动 `/compact` hook 有专项单测、但尚未实机验证**（§3.5，且已无插件 deadline）；**设置卡片/状态指示器/调试日志/侧边栏面板 Host 侧通过，真实浏览器渲染/保存/轮询、真实 HTTP 与重启行为未验证**（§3.6–§3.9），发布说明必须分别标注，并提示用户"装好后刷新页面" |
| 遗留问题与后续优化 | 见 §7 与 `docs/05-limitations.md` |
