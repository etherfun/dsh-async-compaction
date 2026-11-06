# DSH 插件平台契约调研（Host 清单 / Config / 生命周期 / LLM / UI / 主题）

> 阶段一 · 交付 A（task-3）
> 调研对象：本机已安装的 DSH（`D:/SOFT/tools/dsh/resources/app.asar`，Web GUI `http://127.0.0.1:3080`，模型 `magpie/opencode-go/deepseek-v4.1-flash`）。
> 约定：本文所有结论都带**可复核证据**（绝对路径 + 行号）。凡是没查到实据的，一律标注 ❗未验证，不臆造。

---

## 0. 结论速览

| 能力 | 结论 | 关键依据 |
|---|---|---|
| Host 插件（`apply(ctx, config)` + `dsh.bundle.patch`） | ✅ 官方一等公民，纯 JS 零依赖可发 | `host-plugin.md:5-27` |
| `export const Config` / `static Config`（schemastery） | ✅ 校验收口在 Loader 行激活时 | `host-plugin.md:64`、`compaction-basic/lib/index.js:807` |
| 运行期改自己的配置并持久化 | ✅ `ctx.get('configEditor').edit(ctx.fiber.entry, …)` | `host-plugin.md:68-77` |
| 会话级（多会话隔离）配置 | ⚠️ 插件 Config 是**入口级**，不是会话级；要按会话隔离必须挂到 agent 子 ctx / preset group 的 `isolate` 上 | `context.ts:121-125`、profile `cordis.patch.yml` 的 `cordis:group`+`isolate` |
| 后台异步任务安全运行 | ✅ `ctx.effect` + `ctx.timeout/interval`（已废弃裸 `setTimeout`）+ `ctx.jobs` | `cordis-plugin-timer/src/index.ts:4-54`、Service 目录 `jobs` |
| 独立模型调用（旁路 LLM） | ✅ `ctx.llm.prepareCall()` → `call.stream(options)`，带 `system`/`purpose`/`maxTokens`/`signal` | `dsh-session-title-llm/lib/index.js:160-227`、`dsh-compaction-basic/lib/index.js:293-345` |
| 日志 | ✅ `ctx.logger` / `ctx.logger(name)`，四级，自动命名空间 | `logger.ts:13,184-186,256-267` |
| 插件设置页 | ✅ **声明 Config 即自动有表单**（Plugins 页 Configuration 区） | `dsh-context/README.md:219`、`ui-settings/README.md:34` |
| 自定义 UI 面板 | ✅ `settings.section`（list/root）、`conversation.composer.dock`（list/session）等 | 源码注册处见 §7 |
| 主题样式 | ✅ 414 个 `--dsw-alias-*` / `--dsw-font-*` / `--dsw-radius-*` token | `dsh-client-ui-theme/lib/client.js` |
| **运行时客户端探针** | ❗本次不可用：`client/Slots.listSubTree` 与 `client/Theme.listTokens` 均 10s 超时（没有已连接的页面） | 见 §7.0 |

---

## 1. 证据来源与工具限制（先读，避免误信）

### 1.1 一手来源

| 类别 | 位置 |
|---|---|
| 官方插件开发技能文档 | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/{host-plugin,ui-plugin,practices,verification,user-actions}.md`、`templates/decoration/*` |
| 可装载包清单 | `research/extracted/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md` |
| asar 内真实实现 | `research/extracted/dsh/node_modules/@deepseek-ai/*`（解压脚本 `scripts/asar-get.cjs` / `scripts/asar-list.cjs`） |
| Cordis 框架源码（**带 TS 源码**） | `research/extracted/dsh/node_modules/@deepseek-ai/cordis/src/{context,fiber,events,logger,registry,reflect}.ts` |
| 运行时契约 | `cordis_inspect_query`：`host/Service.listService`、`host/Event.listEvents`（成功）；`host/Config.listConfigs`、`client/Slots`、`client/Theme`（`Config` 因 `input` 参数缺陷未取到；`client/*` 超时） |
| 真实第三方插件 | `C:\Users\q1325\.dsh\profiles\web\node_modules\{smart-compaction,dsh-context,dsh-rewind-plugin,dsh-read-image-compress}` |
| profile 实况 | `C:\Users\q1325\.dsh\profiles\web\package.json`、`cordis.patch.yml` |

### 1.2 本次的两个工具缺陷（复现方式附上，供复核）

1. **`cordis_inspect_query` 的 `input` 参数不可用**：
   任何带 `input` 的调用都返回 `Error: Host Cordis inspect Service.listService rejected input: "input" must be an object`（`input` 被序列化成字符串）。因此 `Service.listService(service:'llm')` 的**精确类型展开**拿不到，只能用「紧凑目录 + 真实调用点」交叉验证（见 §6）。
   - 复核命令（在有人工交互的会话里可成功）：`cordis_inspect_query(platform:"host", provider:"Service", method:"listService", input:{service:"llm"})`
2. **client 端探针超时**：`client/Slots.listSubTree`、`client/Theme.listTokens` 均 `timed out after 10000ms`（"Open or reconnect the Harness page, then retry."）。本次改为**读 asar 内 UI 包的 client bundle 源码**取证（§7/A7）。复核需要在浏览器页面在线时重跑。

---

## 2. Host 插件清单与 bundle 机制

### 2.1 最小可用清单（照抄即可）

官方 `host-plugin.md:5-27` 给的最小形态，与真实 `templates/decoration/package.json:1-21` 一致：

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

字段职责（证据：`host-plugin.md:7-55`、`decoration/package.json:6-20`、`dsh-read-image-compress/package.json:7-64`、`dsh-Survival-mode/package.json:7-36`）：

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | ✅ | 也是 Client 侧 lazy factory 的 id；Loader 行 `name:` 引用它 |
| `version` | ✅ | 与 `engines.dsh` 一起参与安装期兼容性检查（`plugin-manager/README.md:77`） |
| `type: "module"` | ✅（建议） | 全部真实插件都是 ESM |
| `exports["."]` | ✅ | Host 入口 |
| `exports["./client"]` | UI 需要 | 浏览器包入口 |
| `exports["./locale/*.json"]`、`exports["./icon"]` | 建议 | 插件管理页/设置页在**不激活插件**的前提下读 `meta.title`/`meta.description`/图标（`host-plugin.md:31-51`）；`package.json` 顶层 `icon` 优先于 `./icon` |
| `files` | 打包必需 | 链接目录安装时 `files` **不生效**（`host-plugin.md:35`） |
| `dsh.bundle.patch` | ✅（bundle） | 指向本 bundle 的默认 patch 层 |
| `dsh.client.{platform,immediately,inject}` | UI 需要 | `platform:"web"`；`immediately:true` 表示不等页面交互即加载；`inject` 只表达**激活顺序**，不能当模块 import 用（`practices.md:35`） |
| `engines.dsh` / `peerDependencies` | 建议 | `plugin-manager/README.md:77` 安装期会拒绝不满足的运行版本；peer 全部 `optional` 是社区惯例（`dsh-rewind-plugin/package.json`） |

### 2.2 `cordis.patch.yml` 语法

最小模板（`templates/decoration/cordis.patch.yml`、`dsh-read-image-compress/cordis.patch.yml:1-22`）：

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: { ... }        # 该行传给 apply(ctx, config)
```

真实 profile 里出现的全部语法（`C:\Users\q1325\.dsh\profiles\web\cordis.patch.yml`）：

| 语法 | 例 | 语义 |
|---|---|---|
| `insert:` | `- insert: [ {id, name, config, disabled} ]` | 新增 Loader 行 |
| 按 `id` 覆盖 | `- id: agent-default-model` + `config:` | **整体替换**该行 config（`host-plugin.md:3`：「a matching override replaces the complete config」） |
| `disabled: true/false` | `- id: remote-web-ui` / `disabled: true` | 停用/启用已有行 |
| `!!js` 表达式 | `disabled: !!js process.platform === 'win32'` | Loader 支持的 JS 表达式 |
| `cordis:group` + `group: true` | preset 里的 `compaction`/`planning`/`delegation` 组 | 逻辑分组，`config:` 变成子行数组 |
| `isolate:` | `isolate: { compaction: true, toolResultPruner: true }` | **为该子树建立独立服务作用域**（见 §4.4） |

优先级（`plugin-manager/README.md:40`）：bundle 层 → profile patch 层 → home/invocation patch 层；后层覆盖前层。toggle 一个插件只改 profile `cordis.patch.yml` 里**最后一条**匹配 override 的 `disabled`。

### 2.3 bundle 与 plugin 的关系

- **plugin** = 导出一个 Cordis 插件的 npm 包（`export function apply` 或 default 导出 Service 类，`host-plugin.md:57-64`）。
- **bundle** = 在 `package.json` 里声明 `dsh.bundle.patch` 的包：它带一层默认 patch，把「自己（或别的包）的行」插进 Loader 树（`host-plugin.md:3`）。
- 一个 bundle 可以只是"配方"（`templates/mcp/cordis.patch.yml` 只挂 MCP client 行，自己不含 Host 代码）；反过来一个纯代码包不声明 `dsh.bundle` 也能作为行被别人的 patch 引用。
- profile 里登记的是 bundle 名：`C:\Users\q1325\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles[]`（顺序即层序）。

### 2.4 `plugin_manager.install_bundle` 的真实行为（不是 `npm install` 的薄壳）

来自 `research/extracted/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/README.md`：

| 行为 | 证据 |
|---|---|
| 真正的 `pnpm add` 由管理器执行，**不要**自己用 shell 复现 | `host-plugin.md:81`；`plugin-manager/README.md:68` |
| 安装前按 registry 计划逐级探测（`options.registry` → 配置的 `registry` → `fallbackRegistries`，默认含 `https://registry.npmmirror.com/`） | `README.md:64,93-94` |
| GitHub/tarball/git spec 先 `git ls-remote` 探测（5s 超时），失败才中止 | `README.md:60-62` |
| 版本兼容：安装前校验目标版本 `engines.dsh` 与 DSH peer；不满足直接拒绝（`incompatible-version`），可用 `set_version_exemption(acceptRisk)` 豁免 | `README.md:77-83` |
| 安装是**包安装 + bundle 选择**两步；新安装默认 `enabled:true` 并追加到 `dsh.profile.bundles` 末尾（会改变层序！） | `README.md:40,54` |
| 失败/cancel 会回滚 `package.json` + `pnpm-lock.yaml`（**不回滚** `pnpm-workspace.yaml`） | `README.md:68,72` |
| 有 HMR 时新装 bundle 可热激活；**替换已安装包**需要重启（`restart-required`） | `host-plugin.md:83`；`README.md:54` |
| pnpm 11 挡住 build script 时，返回 `pendingBuilds`；只有用户在对话里明确同意后才允许传 `approvedBuilds` | `README.md:72`；工具签名同名字段 |
| 每次操作后广播 `plugin-manager/changed` | `README.md:68` |

> 对本项目：发布 → 只写 `package.json` + `files` + `cordis.patch.yml` + `locale` + `icon`；安装 → 用户点一次。**不要**写脚本去改 profile。

---

## 3. Config：声明、校验、读取、持久化、隔离

### 3.1 三种声明形态（真实代码里都存在）

| 形态 | 例 | 何时用 |
|---|---|---|
| `export const Config = z.object({...})` | `dsh-client-ui-settings/lib/index.js:10`；`dsh-session-title-first-prompt-llm/lib/index.js:14-22`；`dsh-read-image-compress/index.js:78` | 函数式插件（`apply(ctx, config)`） |
| `static Config = z.object({...})` | `dsh-compaction-basic/lib/index.js:807-819` | Service 类插件 |
| **不声明 Config，自己 `resolveConfig()`** | `dsh-Survival-mode/index.js:59-80`（注释：`Config is resolved manually so the bundle needs no schemastery dependency`）；`smart-compaction/index.js:179-183` 同风格 | 想零依赖；**代价**：插件设置页不会自动生成表单（见 §3.4） |

`z` 是 `@deepseek-ai/schemastery`（`host-plugin.md` 间接引用；`dsh-read-image-compress/index.js:57-77` 演示了外部插件如何稳妥地从运行中的 DSH 安装里 `require('@deepseek-ai/schemastery')`，因为它作为 link 包时裸 import 可能解析不到）。

### 3.2 校验时机与读取

- **校验时机**：该行被**激活时**（`host-plugin.md:64`：「A plugin that declares `Config` validates the row's `config` at activation」）。
- **取 schema 的官方途径**：`cordis_inspect_query(host/Config.listConfigs)`，先按 `name` 过滤目录，再按 `entry` 取该行的投影 JSON Schema，注意跟随 `$defs`（`host-plugin.md:64`）。❗本次因 §1.2 的工具缺陷未能实测。
- **运行期读取**：就是 `apply(ctx, config)` 的第二个参数（原始值，未填充默认值 —— 默认值由 schemastery 自己处理）。
- **`config` 是冻结/不可变？** `Fiber` 侧有 `_effectiveConfig`（`fiber.ts:211,256`），插件侧把 config 当只读用即可。

### 3.3 `.volatile()` 与"改配置会重启插件"

来自 `host-plugin.md:77`（关键，容易踩）：

- 修改普通字段 → **插件重启**，`apply` 重跑重建状态。
- 声明为 `.volatile()` 的字段 → **原地更新**，用 `config.field.get()` 读。
- 例：`dsh-client-ui-settings/lib/index.js:10` → `enabled: ...volatile()`。

### 3.4 持久化配置的三条正当路径

1. **让用户改 `cordis.patch.yml`**（推荐）：把可调项放进 `Config`，用户在自己的 patch 层覆盖（`practices.md:22`：「the user's patch layer survives upgrades」）。**插件代码绝不要**去读/改/找 profile 的 `cordis.patch.yml`（`host-plugin.md:68`，明确禁止）。
2. **配置编辑器（运行时写回）**：`const entry = ctx.fiber.entry; const editor = ctx.get('configEditor'); await editor.edit(entry, cur => ({...cur, field: value}))`（`host-plugin.md:70-77`）。`configEditor` 的服务面：`entries()` / `configuration()` / `edit(entry, change)`（Service 目录）。它会校验、串行化、拒绝被更高层覆盖的值。
3. **settings 服务（用户级/跨会话偏好）**：`ctx.settings` 的服务面是 `configure({auto}, owner)` / `describe(options)` / `update(ns, patch, rev)` / `replace(ns, section, rev)` / `mutate(ns, ops, rev)`（Service 目录 `settings`）。dsh-context 用它做"系统提示词前后缀"（`dsh-context/README.md:221`），Survival 用它贡献设置卡片（`dsh-Survival-mode/src/host/settings.js:1-16`，落在 profile 旁边的 `survival.settings.json`）。
   - 注意：`settings` 的 `describe()` 会把 Config schema **投影成表单**（Service 目录描述："Project Config schemas into forms"），所以 UI 侧不用自己画表单。

### 3.5 多会话配置如何隔离（本项目关键）

- **事实**：插件 `Config` 属于 **Loader 行**，一行一个 config，天然是「入口级/进程级」的，**不是会话级**。
- 要做「每个会话一份状态/配置」，有三条已被验证的路：
  1. **agent 子 ctx**：在 `agent/created` 里拿 `agent.ctx`，把 per-agent 行为挂上去（`practices.md:19`），卸载/销毁随 agent 走。
  2. **agent preset group + `isolate`**：profile `cordis.patch.yml` 里 `cordis:group` + `isolate: { compaction: true, toolResultPruner: true }` 让每个 preset 子树拥有**私有服务实例**；跨插件取用靠 `ctx.agentPresets.serviceFor(agent, 'compaction')`（`smart-compaction/index.js:90-92`）。这正是 `dsh-web-app` 预设隔离 compaction 的做法（`smart-compaction/README.md:122-128`）。
  3. **自己的存储域**：`ctx.storage`（`mount`/`form`）+ `ctx.storageDomain.open(spec)`（schema 校验 + 事件的 KV），或 `ctx.settings` 的 `ns`。
- **隔离原语**：`ctx.isolate(name, label?)` 建独立服务作用域（`context.ts:121-125`），`ctx.intercept(name, config)` 给子树注入服务配置（`context.ts:139-145`）。

---

## 4. 插件生命周期与 ctx 能力

### 4.1 `ctx` 的骨架

`research/extracted/dsh/node_modules/@deepseek-ai/cordis/src/context.ts:16-33`：

```ts
export interface Context {
  root: this                 // 根
  events: EventsService      // ctx.on / ctx.emit / ctx.waterfall ...
  logger: LoggerService      // ctx.logger / ctx.logger(name)
  reflect: ReflectService    // ctx.get / ctx.provide ...
  registry: RegistryService  // ctx.plugin / ctx.inject
}
```

`ctx` 是 Proxy：读属性走服务解析（`ctx.llm`、`ctx.tools`、`ctx.sessions`…），`ctx.extend/isolate/intercept` 产生作用域子 ctx，不改父（`context.ts:35-42`）。

### 4.2 事件（`ctx.on` 及调度模式）

`src/events.ts`：

| 方法 | 行 | 语义 |
|---|---|---|
| `on(name, listener, options?)` | `89-96` | 注册监听，返回 disposer（`() => boolean`），**由当前 fiber 拥有**，随 fiber 销毁自动注销 |
| `once(...)` | `105` | 一次性 |
| `emit(name, ...args)` | `52,199-207` | 同步、不等 promise |
| `parallel(...)` | `43,186-198` | 并发跑完所有监听 |
| `serial(...)` | `62,209-221` | 顺序 await 直到 bail |
| `bail(...)` | `72,223-238` | 同步短路 |
| `waterfall(...)` | `85,240-282` | 最外层先执行，**不调用 `next()` 即否决** |

Host 端可用事件全表已实测（`host/Event.listEvents`，本会话返回 90+ 条）。与本项目直接相关的：

| 事件 | 模式 | 签名（摘要） | 用途 |
|---|---|---|---|
| `agent/pre-step` | waterfall | `({agent, messages, turn, step, signal, modelSelection}, next) => PreStepDecision` | **替换进入下一步的消息**；也是压缩插入点 |
| `llm/stream` | waterfall | `(this: LlmRuntime, options: GenerateOptions, next) => AsyncIterable<StreamChunk>` | 拦截/改写在途模型流 |
| `agent/request-error` | waterfall | `({agent,turn,step,provider,failure,retryPolicy,signal}, next) => RequestErrorAction` | 上下文溢出恢复（返回 `{kind:'retry'}`） |
| `tools/post-execute` | waterfall | `(exec, result, next) => PostToolDecision` | 观察/改造工具结果 |
| `tools/result` | emit | `(exec, result)` | 只观察最终结果 |
| `tools/pre-execute` | waterfall | `(exec, next) => PreToolDecision` | 允许/拒绝/取消/询问 |
| `session/event` | emit | `(session, event)` | 每个已提交事件（同步派发） |
| `session/flush` | parallel | `(session) => Promise<void>` | 可 await 的持久化检查点 |
| `agent/turn-stopping` | serial | `({agent, turn, signal}) => void` | 回合即将关闭 |
| `agent/created` / `agent/disposed` | serial / emit | `({agent, source, signal?})` | 拿 `agent.ctx` 挂 per-agent 行为 |
| `compaction/summary-error` | waterfall | `({session, sourceEventSeqs, error, signal?}, next) => boolean` | 摘要请求失败的兜底恢复 |
| `settings/document-updated` | emit | `(ns, revision)` | 配置变更通知 |

> ⚠️ 文档与运行时不一致的一处：`practices.md:16` 提到 `agent/request` 事件，但**实测事件目录里没有 `agent/request`**（只有 `agent/pre-step`、`agent/request-error`）。以 `cordis_inspect_query(Event.listEvents)` 为准。

### 4.3 `ctx.effect`：资源归属的唯一正确姿势

`src/fiber.ts`：

- `ctx.effect(callback, label?)`，`callback` 可返回 disposer、disposer 数组（generator 逐个注册）或 Promise（异步 effect）；返回值本身也是 disposer（`fiber.ts:69-101`）。
- 所有注册（`ctx.on`、`ctx.tools.register`、`ctx.slots.register`、`ctx.timer.*`…）内部都挂到当前 fiber 的 `_disposables`（`fiber.ts:203,235`），fiber 销毁时逆序清理。
- 在已停用的 ctx 上建 effect 会抛 `INACTIVE_EFFECT`（`fiber.ts:171,355-359`）——所以**不要**把 ctx 存进闭包长期使用，要么在 `apply` 期间用完，要么用 `agent.ctx` + 自己的 disposer 双保险（`practices.md:8,19`）。

### 4.4 `ctx.inject` / `ctx.plugin` / `ctx.get`

`src/registry.ts`：

| API | 行 | 说明 |
|---|---|---|
| `ctx.inject(deps, callback)` | `167-176` | 「等服务齐了再跑 callback」，等价于 `ctx.plugin({inject, apply: callback})`；依赖变化会卸载重跑 |
| `ctx.plugin(plugin, ...config)` | `178-185,305-320` | 在当前 ctx 下装载插件，得到 fiber |
| 插件级 `export const inject = [...]` | `host-plugin.md:61` | 声明必需服务；缺服务则插件**不激活**而不是抛错（`practices.md:20`） |
| `ctx.get(name)` | `reflect.ts` + 真实用法 | 可选服务的软取用：`ctx.get('compaction')`（`smart-compaction/index.js:91`）、`ctx.get('sessionProjections')`（`:96`）、`ctx.get('toolResultPruner')`（`dsh-compaction-basic/lib/index.js:927`） |
| `ctx.provide(name, value)` | `reflect.ts` | 提供服务（一般用 `class X extends Service` 更规范） |

> 设计要点（smart-compaction 的血泪注释，`index.js:33-40`）：**不要把可选服务写进 `inject`**，否则在没有该服务的 profile 上直接不加载；用 `ctx.get()` 在调用点取，取不到就走降级分支。

### 4.5 后台/异步任务的安全运行（不要裸 `setTimeout`）

**权威实现**：`research/extracted/dsh/node_modules/@deepseek-ai/cordis-plugin-timer/src/index.ts`

```ts
// :3-7  —— ctx 上直接混入了这些方法
interface Context extends Pick<TimerService, 'interval'|'timeout'|'throttle'|'debounce'|'setTimeout'|'setInterval'> { timer: TimerService }
// :12-16
class TimerService extends Service {
  constructor(ctx) { super(ctx, 'timer'); ctx.mixin('timer', ['timeout','interval','throttle','debounce','setTimeout','setInterval']) }
// :28-54  —— 每个 timer 都包在 ctx.effect 里，fiber 销毁即 clearTimeout
timeout(callback, delay)   // 返回 disposer
timeout(delay)             // 返回 Promise，ctx 销毁时 reject
interval(callback, delay)  // 返回 disposer
interval(delay)            // 返回 AsyncIterableIterator
```

可用结论：
- ✅ 用 `ctx.timeout(fn, ms)` / `ctx.interval(fn, ms)` / `ctx.throttle` / `ctx.debounce`；`ctx.setTimeout` 已被标 `@deprecated`（`src/index.ts:18-26`）。
- ✅ 长任务用「`ctx.effect` 拥有 + `AbortController` + 超时」三件套；超时工具是 `@deepseek-ai/dsh-timeout` 的 `deadline(signal, timeoutMs, code)`（真实用法 `dsh-session-title-llm/lib/index.js:179`，`import { MAX_TIMER_DELAY_MS, deadline } from '@deepseek-ai/dsh-timeout'`）。
- ✅ 需要"可查询/可取消/可读输出"的后台作业，用 `ctx.jobs`（Service 目录 `jobs`：`start(spec)` / `list` / `get` / `read` / `readAt` / `wait(id,timeoutMs,...)` / `kill` / `remove` / `attachController(name)`）。
- ⚠️ 定时器里**唤醒 agent** 要用 `agent.followup()`；`agent.inject()` 不会唤醒（`practices.md:29`）。
- ⚠️ 不要在 effect 外起 fire-and-forget 的 `async` IIFE：它不会被取消，卸载时也不会等它（`practices.md:8`）。

### 4.6 与"会话日志是唯一真相"相关的硬约束

`practices.md:21`（重要，直接决定本插件能不能"自己写事件"）：

> 不要用新 `type` 追加 session 事件：读取侧只接受带 `ignorable: true` 的未知事件，而**实时 `Session.append()` 无法设置该标记**，于是 Session 之后会拒绝重开。`appendPluginRecord()` 会写 `ignorable` 的 `plugin:` 记录，但那是 DSH 实验包的保留地盘。

所以：**派生状态要靠现有事件折叠**（或 `ctx.sessionProjections` 注册自己的投影），不要发明事件类型。

---

## 5. 日志

`src/logger.ts`：

| 事实 | 行 |
|---|---|
| 等级只有 4 个：`'error' \| 'warn' \| 'info' \| 'debug'` | `13` |
| `ctx.logger` 是可调用对象：`ctx.logger(name?)` 取具名 logger；也可直接 `ctx.logger.info(...)` | `183-186,194-276` |
| 缺省命名空间 = `hyphenate(fiber.name)`（即插件名的短横线形式），**自动**带上，无需手写前缀 | `256-267` |
| 输出阈值按 exporter 的 `levels[name]`/`levels.default`/logger 自身 level 判定 | `141-161` |
| 支持 printf 风格 `%s %d %i %f %o %O %c`，单条默认上限 10240 字符 | `50-61,127-131` |
| 真实用法 | `ctx.logger.info(...)`/`ctx.logger.warn(...)`：`dsh-compaction-basic/lib/index.js:838,850`；`ctx.logger.error(reason)`：`cordis/src/fiber.ts:312` |

> 建议：`ctx.logger.info('prewarm: summary ready ...')` 即可，命名空间自动是 `my-plugin`。

---

## 6. 独立模型调用：`ctx.llm`

### 6.1 服务面（实测 Service 目录）

`research` 中的 `host/Service.listService` 返回（`llm` 条目）：

```
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
listProviders(): LlmProviderInfo[]
registerConfigurableProviders(...)
listConfigurableProviders(): LlmConfigurableProvider[]
registerModelDiscovery(settingsNs, discover)
discoverModels(settingsNs, request, signal?): Promise<LlmDiscoveredModel[]>
providerRetryPolicy(provider): ResolvedRetryPolicy
imageRequestPricing(provider, model)
imageRequestTarget(provider, model, image)
fileRequestText(ref)
listModels(provider): Promise<LlmModelInfo[]>
resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>
resolveCallConfig(config: LlmCallConfig, signal?): Promise<LlmCallConfig>
prepareCall(config: LlmCallConfig, signal?, configure?: ConfigureCall): Promise<PreparedLlmCall>
stream(options: GenerateOptions): AsyncIterable<StreamChunk>
```

> **没有 `complete()`**——旁路调用也是流式的，需要自己聚合（用 `BlockAssembler`）。

### 6.2 生产级的两次真实调用（这两处就是"标准答案"）

**（a）压缩后端自己的摘要调用** —— `research/extracted/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:293-345`（`summarizeWithLlm`，options 在 `:313-322`）：

```js
const options = {
  provider: target.provider,
  model: target.model,
  messages,                                   // 历史前缀 + 末尾一条压缩指令
  toolHistory: agent.session.toolHistory(),
  ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
  maxTokens: config.maxTokens,
  sessionId: agent.session.id,
  purpose: 'compaction',
  ...(signal === undefined ? {} : { signal }),
}
for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
const error = finishError(assembler.finish)
const rawOutput = assembler.blocks()
```
（同一函数还演示了：路由解析顺序 `config.summarization* → session.requestHeader()?.config → agent.options`；空摘要兜底 `throw new Error('summarization produced no text summary content')`。）

**（b）完全"旁路"的一次性调用（本项目的直接范式）** —— `research/extracted/dsh/node_modules/@deepseek-ai/dsh-session-title-llm/lib/index.js:160-227`：

```js
const callDeadline = deadline(request.signal, config.timeoutMs, SESSION_TITLE_TIMEOUT_CODE)   // :179
const call = await ctx.llm.prepareCall({ ...route, maxTokens }, callDeadline.signal,
  (controls, model) => ({ ...controls, ...(effort === undefined ? {} : { reasoningEffort: effort }) }))  // :181-190
const options = deepFreeze({
  ...call.config,            // provider / model / maxTokens / 其它调用控制
  messages,                  // [createUserMessage({ content, source: { kind } })]
  system: prepared.system,   // ★ system 提示词是独立字段，不进 messages
  sessionId: request.session.id,
  purpose: 'session-title',  // ★ 用途标签
  signal: callDeadline.signal,
})
request.session.append('session/title-llm-request', { ... })   // ★ 可选：把这次旁路调用记进日志（有专属事件类型）
const assembler = new BlockAssembler()
for await (const chunk of call.stream(options)) { callDeadline.signal.throwIfAborted(); assembler.push(chunk) }
const finish = terminalFinish(assembler.finish)   // 'stop' | 'tool-calls' | 'max-tokens' | 'error' | 'aborted'
```

### 6.3 `GenerateOptions` 字段表（来自上述两处调用点；❗以调用点为准，因为类型展开被工具缺陷挡住）

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `provider` | string | ✅ | 路由 provider（如 `magpie`） |
| `model` | string | ✅ | 精确模型 id（如 `opencode-go/deepseek-v4.1-flash`） |
| `messages` | Message[] | ✅ | 用 `createUserMessage({content, source:{kind}})` 构造，`source.kind` 是自己的生产者标记 |
| `system` | string | 可选 | 系统提示词独立字段 |
| `tools` | ToolSchema[] | 可选 | 需要工具时传 |
| `toolHistory` | — | 可选 | `agent.session.toolHistory()` |
| `maxTokens` | number | 可选（强烈建议） | 输出上限；`session-title` 走 `prepareCall` 的 `maxTokens` |
| `sessionId` | SessionId | 可选 | 关联会话（用于日志/统计/路由回退） |
| `purpose` | string | 可选 | 用途标签（`'compaction'` / `'session-title'` …），便于审计与 `llm/stream` 监听分类 |
| `signal` | AbortSignal | 可选 | 取消 |
| `reasoningEffort` | string | 可选 | 由 `prepareCall` 的 `configure(controls, model)` 回调设置 |
| `store`/`stream` 等其它字段 | ❗未验证 | — | `GenerateOptions` 完整类型需在有交互的会话里用 `listService(service:'llm')` 展开 |

### 6.4 Abort 语义

- 传 `signal` 后，abort 会让流以 `finish.kind === 'aborted'` 结束；`terminalFinish()` 把它转成抛错（`dsh-session-title-llm/lib/index.js:130-144`）。
- 组合取消：`AbortSignal.any([agentSignal, operationSignal])`（`dsh-compaction-basic/lib/index.js:990`）。
- 每个 chunk 之后都该 `signal.throwIfAborted()` 再 push（同上 `:211-214`），否则取消延迟到下个 chunk。
- 超时：`deadline(...)` 生成带 `code` 的派生 signal；把 `signal` 传给 `prepareCall` 与 `stream` 同时生效。
- **`ctx.llm.stream` 会被 `llm/stream` waterfall 拦截**（事件目录），所以走官方 stream 而不是自建 HTTP，才能被 retry / replay / 路由策略覆盖。

### 6.5 token 计量（旁路调用不必自己算）

`ctx.tokenMeter`（Service 目录）：`measure(session, requestHeader?)`、`contextPressure(session)`、`estimateMessage(message)`。`contextPressure` 投影由 `@deepseek-ai/dsh-token-meter` 注册，是 UI 上下文计量条与 smart-compaction `context_status` 的同一数据源（`smart-compaction/README.md:60-73`）。

---

## 7. 设置界面 / 状态展示（Client 侧）

### 7.0 前提：本次 client 探针不可用

`client/Slots.listSubTree`、`client/Theme.listTokens` 均超时（§1.2）。**下列内容全部来自 asar 内 UI 包源码**，属于"实现级证据"，比文档更硬，但**不等于本机当前页面的实时 slot 树**。请在浏览器在线时用一条 `Slots.listSubTree` 复核一次。

### 7.1 已确认的 slot 目录（含 kind / scope）

| slot key | kind | scope | 出处 |
|---|---|---|---|
| `settings.section` | list | root | `dsh-client-ui-settings-general/lib/client.js:1547` |
| `settings.section.icon` | list, `inline:true` | root | 同上 `:1551-1555`；渲染处 `:341`、`:1588-1592` |
| `settings.onboarding` | list | root | 同上 `:1556-1559` |
| `settings.close` | single | root | 同上 `:1543-1546` |
| `settings.action` | list | root | 同上 `:1539-1542` |
| `settings.trigger` / `settings.header` / `settings.launcher` | single | root | 同上 `:1530-1538` 区块 |
| `settings.general.item` | list | root | 由 `settings.section(id:"general")` 的 `children` 声明（`:1587-1597`） |
| `settings.plugins.tab` | list | root | `dsh-client-ui-settings-plugins/lib/client.js:262`（声明）、`:255-268`（注册） |
| `conversation.composer.dock` | list | session | `dsh-client-ui-conversation/lib/client.js:22994-22997` |
| `conversation.session.header.corner` | single | session | 同包 declaration（`"conversation.session.header.corner": {kind:"single", scope:"session"}`） |
| `sidebar.right.pane.tab` | **keyed** | session | `dsh-client-ui-sidebar-right/lib/client.js:5683-5687` |
| `sidebar.right.pane.tab.title` | keyed | session | 同上 `:5688-5692` |

（`conversation.*` 全家福实测字符串：`conversation.composer.bar`、`conversation.composer.dock`、`conversation.content`、`conversation.header.leading`、`conversation.hero.*`、`conversation.input.{activity,attachments,dock,left,model,overlay,permission,plan,right}`、`conversation.session.header.{actions,corner,lineage,utilities,views.actions}`、`conversation.view`。）

### 7.2 注册 API（唯一正确写法）

```js
// 所有注册都必须包在 ctx.slots.inject(ownerKey, () => ctx.slots.register(...)) 里，
// owner 声明塌缩时自动卸载、回来时自动重装（practices.md:36）
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'pre-compact',              // list 槽必须有 id（渲染/排序/图标按 id 对齐）
  order: 40,
  label: () => t('nav'),          // 设置左侧导航文字
  locale: NS,                     // 提供 t
  inject: () => ({ ...props }),   // 见 §7.3
  children: { 'settings.precompact.item': { kind: 'list', scope: 'root' } },
}, MySection))
```

真实范例：`dsh-client-ui-settings-general/lib/client.js:1587-1596`（general 分节）与 `dsh-client-ui-settings-plugins/lib/client.js:255-268`（plugins 分节）。

### 7.3 `inject` 返回值怎么变成 props（重要，容易猜错）

`F:\dev\GitHub\dsh-Survival-mode\test\notes\dsh-core-api.md:243-249` 记录了实证结论（作者贴了 renderer 源码行号）：

- `inject(sessionIdOrKey?, actions?)` 收到的是**作用域键**（session 作用域给 sessionId，`session-maybe` 无会话时给 `undefined`）。
- 返回值里：
  - `hooks: {name: observableSource}` → 组件收到 `use<Name>` 属性（`observableHook` 绑定）；
  - `keyedHooks: {name: (key)=>source}` → `use<Name>(key)`；
  - **其它键原样展开成 props**；
  - 声明了 `locale` → 多一个 `t`；
  - 声明了 `children` → 多 `renderSlot` / `renderSlotChain`；
  - 声明了 `store` → 多 `useStore` / `actions`（仅 session 作用域）。
- `single` 槽只有第一个 entry 渲染，第二个**静默不显示**（不报错）。

具体实例：
- `settings.section` 的表达式是 `renderSlot("settings.section", { close: onClose }, { only: active })`（`settings-general/lib/client.js:341`）→ **分节组件必定收到 `close`**。
- `conversation.composer.dock` 的 owner props 只有 `renderSlot(..., {})`（`conversation/lib/client.js:22219`），因此 occupant 主要靠 `inject` 自己声明要什么。

### 7.4 三条可选落地方式（按风险从低到高）

| 方式 | 需要的文件 | 成本 | 适用 |
|---|---|---|---|
| **① 只声明 `Config`** → Plugins 页自动出现 Configuration 表单 | 无 UI 文件 | 零 | 参数调节（阈值/模型/开关） |
| **② `settings.section` 整页** | `client.js`（注册 + React 组件）+ `package.json` 的 `exports["./client"]` 与 `dsh.client` + `locale/*.json` | 中 | 需要「状态面板 + 历史列表 + 手动触发」 |
| **③ `conversation.composer.dock` 小状态条** | 同上，组件更小 | 低-中 | 实时显示「已预压缩 X 次 / 预计省 Y tokens」 |

> 补充事实：`conversation.composer.dock` 里**宿主已经渲染了一个 `ContextMeter`**（`conversation/lib/client.js:22219-22222`，条件 `activity ? null : <ContextMeter …/>`）。所以状态条要做增量信息（预压缩就绪度/节省量），不要重复显示上下文占用率。

> `sidebar.right.pane.tab` 是 `keyed` 槽，**不是**直接 register 就能出现：需要先在 tab 类型注册表里注册一个 kind，再按 `key: <kind>` 注册 body（`sidebar-right/lib/client.js:5740-5765` 的 guide 实现即范例）。成本明显高于 `settings.section`，不建议一期做。

### 7.5 硬性 UI 约束（违反会白屏）

来自 `practices.md:33-38` / `ui-plugin.md:9-13`：

- **不要** `require('@deepseek-ai/dsh-client-ui-primitives')` 或任何 Harness Client 包；照抄它的 markup/CSS 到自己前缀下，只保留 `--dsw-alias-*` token 引用。
- 组件抛错会让**整个 slot 入口白屏**（console: `slot entry crashed in '<slot>'`）→ 组件要自带 error boundary 兜底。
- 不要 iframe 嵌 HTML 页（拿不到主题 token / locale）。
- 不要在 `document.body` 上追加东西、不要读别的插件的 DOM。
- 文本走 Client locale 服务（`ctx.locale.register(ns, {...})` + `ctx.locale.bind(ns)`，见 `settings-plugins/lib/client.js:214-230`）。

---

## 8. 主题 token

无实时 `Theme.listTokens`（§1.2），改从 `research/extracted/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js` 提取：**共 414 个 token**，命名空间 `--dsw-*`。分四族：

- `--dsw-alias-*`（语义别名，最该用）：`bg-base`、`bg-layer-1/2/3`、`bg-mask-*`、`border-l1..l4`、`label-primary/secondary/tertiary/caption/dimmed`、`brand-primary`、`interactive-bg-hover*`、`button-primary-fill/hover`、`state-success-primary/secondary/tertiary`、`state-error-primary/secondary`、`code-diff-added/deleted`、`markdown-*`、`link`。
- `--dsw-font-*`：`base-16`、`s-14`、`xs-13`、`xxs-12`、`xxxs-11`、`m-18`、`l-20`、`xl-24`（每族还有 `-font-family/-font-size/-font-weight/-line-height` 子 token），以及 `font-family`、`font-markdown-code`。
- `--dsw-radius-*`：`xs/sm/md/lg/xl/panel`。
- `--dsw-shadow-*`：`lv1`、`lv2`、`lv3`（含 `-blur`）。

状态色只有 success / error 两支（**没有** warning/危险色），做"预警"时应用 `state-error-*` 或 `label-dimmed` 降权表达。

---

## 9. 清单

### ✅ 官方 API 直接可用（无需 hack）

1. Host 插件 + bundle 清单（`dsh.bundle.patch`、`exports`、`files`、`locale`、`icon`）——`host-plugin.md:5-55`。
2. `export const Config` / `static Config`（schemastery）+ 激活期校验——`host-plugin.md:64`、`compaction-basic:807`。
3. 运行期持久化配置：`ctx.get('configEditor').edit(ctx.fiber.entry, …)`——`host-plugin.md:70-77`。
4. `ctx.effect` 资源归属 + 卸载清理——`fiber.ts:69-101,203,235`。
5. `ctx.timeout/interval/throttle/debounce`（替代裸 `setTimeout`）——`cordis-plugin-timer/src/index.ts:4-54`。
6. `ctx.on/waterfall/emit/serial/parallel`（含 `agent/pre-step`、`tools/post-execute`、`agent/request-error`、`session/event`、`session/flush`、`compaction/summary-error`）——`events.ts:43-105`、`host/Event.listEvents`。
7. `ctx.logger` / `ctx.logger(name)`，四级，自动命名空间——`logger.ts:13,256-267`。
8. 旁路 LLM 调用：`ctx.llm.prepareCall()` + `call.stream({...call.config, messages, system, sessionId, purpose, maxTokens, signal})` + `BlockAssembler`——`dsh-session-title-llm/lib/index.js:160-227`。
9. 超时/取消：`deadline(signal, ms, code)` + `AbortSignal.any` + 每 chunk `throwIfAborted()`——同上 `:179`、`compaction-basic:990`。
10. token 压力读数：`ctx.tokenMeter.contextPressure(session)` / `ctx.sessionProjections.stateOf(session,'contextPressure')`——Service 目录 + `smart-compaction:95-99`。
11. 自动设置表单（声明 Config 即可）——`dsh-context/README.md:219`、`ui-settings/README.md:34`。
12. 三个低风险 UI 落点：`settings.section`(list/root)、`settings.plugins.tab`(list/root)、`conversation.composer.dock`(list/session)——§7.1。
13. 主题 token 全覆盖（414 个 `--dsw-*`）——§8。
14. `ctx.jobs`（可查询/可取消的后台作业登记）——Service 目录 `jobs`。

### ⚠️ 需适配 / 有条件可用

1. **会话级配置隔离**：`Config` 是入口级；要 per-session 必须挂 `agent.ctx` 或走 preset `isolate` 组。**需要设计决策**，不是照抄。
2. **Client 探针**：必须在有在线页面的会话里跑一次 `Slots.listSubTree` / `Theme.listTokens` 复核；当前 slot 树可能与本机版本有出入。
3. **`GenerateOptions` 完整字段**：受 §1.2 工具缺陷影响，只能按两个真实调用点反推；`store`/`stream`/图片参数等字段 ❗未验证。
4. **自定义 UI**：要自己写 React（不能 import primitives），并自带 crash 兜底；`sidebar.right.pane.tab` 还需先注册 tab kind（成本高）。
5. **外部包依赖 schemastery**：作为 link 包时裸 import 可能解析失败，需照 `dsh-read-image-compress/index.js:57-77` 的做法从运行中的 DSH 安装路径 `require`。
6. **bundle 内改用户的 preset**：preset 文档属于用户的 `cordis.patch.yml`（`preset-def`/`preset-survival` 都是用户侧 insert 行）。要替换 preset 里的 compaction 行，只能"给用户一段可复制的 preset 片段"，不能替用户改。
7. **`ignorable` 事件限制**：想追加自定义 session 事件不行；派生状态必须用投影/折叠（`practices.md:21`）。

### ❌ 不可行 / 明确禁止

1. 插件代码读写/定位 profile 的 `cordis.patch.yml` ——`host-plugin.md:68` 明文禁止。
2. 用新 `type` append session 事件（热路径无法设 `ignorable`）——`practices.md:21`。
3. `require` 任何 `@deepseek-ai/dsh-client-ui-*` 包当模块用 ——`practices.md:35`。
4. Host 出 HTML + iframe 嵌进页面 ——`practices.md:33`。
5. 用裸 `setTimeout` 起后台任务（不会被 fiber 清理、卸载后仍跑）——§4.5。
6. 在 `document.body` 追加节点、读别的插件 DOM/样式 ——`ui-plugin.md:13`。
7. `ctx.llm.complete()`：**不存在**，只有 `stream()`。
