# 06 · 把 dsh-pre-compact 重构为 TypeScript 的可行性报告（证据版）

> 调研范围：`F:\dev\GitHub\dsh-pre-compact`（纯 ESM JS：`index.js` + `src/*.js` + `client.js` + `node:test` 测试）
> 目标形态：TypeScript（Host） + TSX（Browser half），编译产物仍满足 DSH 第三方插件契约
> 本报告只做调研与探针，**未改动任何生产文件**；探针目录 `F:\dev\GitHub\dsh-ts-probe`（仓库外）已按要求清理。
> 相关前序报告：`research/02-plugin-platform.md`（插件平台契约）、`research/05-session-token.md`（session/tokenMeter）。

---

## 0. 结论先行

**可行，建议做「完整 TypeScript」（Host `.ts` + Client `.tsx`），分 7 个可独立回滚的阶段推进。**

四条决定性结论：

1. **类型来源不是障碍，但来源和大家通常以为的不一样。** 安装版 DSH（`app.asar`，22103 个文件、337 个 `@deepseek-ai/*` 包）里 **一个 `.d.ts` 都没有**（`*.d.cts` 有，说明是打包时按 `*.d.ts` 过滤掉的）。但 npm registry 上有**同版本**的公开包（app 版本 `0.2.2-rc.1`，`@deepseek-ai/dsh-session@0.2.2-rc.1`、`@deepseek-ai/cordis@4.1.0`、`@deepseek-ai/schemastery@3.19.0` 全部可拉），并且声明文件完整。探针实测两种取型方式都 `tsc --noEmit` **0 错误**：
   - A. 精确锁版本的 `devDependencies`（11–12 个包，`node_modules` 30.0 MB）；
   - B. 把 `.d.ts` 抽成仓库内 `types-vendor/`（**101 个文件 / 542.6 KiB / 14 个包**）+ `tsconfig.paths` 映射，零 npm 依赖。
2. **编译产物完全满足 DSH 契约，Loader / Settings / 插件页零影响。** Host 入口由 Loader 按 Node 解析 `name` → `main`/`exports`，DSH 运行期**从不读 `.d.ts`**（安装包里没有就是证明）；`Config` 是运行期 schemastery 对象，插件页表单由它生成，与是否 TS 无关。
3. **客户端必须自建打包链**：安装包里 **没有** tsdown/esbuild/rollup/vite（按 337 个 `package.json` 与路径索引双重扫描：0 命中），但官方 bundle 的产物形状与 loader 的实现（`dsh-client-modules`）已经足够精确地反推出来。探针用 **esbuild 0.25** 打出的单文件 `client.js`（1963 B）在沙箱里通过了 loader 契约验证：1 次注册、`factory(require)` 只请求 `react`、导出 `apply`、`ctx.slots.inject/register` + disposer 正常。
4. **测试迁移有一个必须提前决定的点**：Node 22.17 的 `--experimental-strip-types` 不能把 `./util.js` 解析到 `util.ts`（`ERR_MODULE_NOT_FOUND`），而 `node --import tsx --test` 可以。因此要么全仓改用 `.ts` 后缀 import（`allowImportingTsExtensions` + noEmit），要么保留 NodeNext 的 `.js` 后缀并用 `tsx` 跑测试。**推荐后者**：260+ 用例、7417 行测试的改动量最小。

**最大阻塞点**（按严重度）：

| # | 阻塞点 | 证据 | 影响 |
|---|---|---|---|
| 1 | 安装包内 0 个 `.d.ts`，且普通 node/tsc **无法读取 asar 内部路径**（`fs.readdirSync(...app.asar/...)` → `ENOENT`） | 见 §3.1 | 不能"直接指向 asar"取型，必须走 npm 包或抽取快照 |
| 2 | npm 的 `latest` dist-tag 是**错的**：`@deepseek-ai/dsh-session` 的 `latest = 0.0.1-rc.1`，而实际安装版是 `0.2.2-rc.1`（在 `next` tag 上） | 见 §3.2 | 裸 `npm i @deepseek-ai/dsh-session` 会装进一个 0.0.1 的占位包 → **必须精确锁版本** |
| 3 | 官方客户端构建工具（tsdown/rolldown）未随安装包分发 | `SOURCE_MAP_TRAILER` 注释直言 "emitted by tsdown"；包扫描 0 命中 | 需要自建 30 行构建脚本（已探针验证） |
| 4 | 现有 `test/client.test.js` 对产物有硬约束：只允许 `require('react')`、恰好 1 次注册、依赖 `__internals` 测试钩子 | `test/client.test.js:196-204` | 换 JSX 自动运行时（`react/jsx-runtime`）必须同步改测试桩，或改用 `h()` 工厂 |

**工作量**：完整 TS 约 **8–12 人日**；仅 Host（client 留 JS）约 **4.5–6.5 人日**；JSDoc+`checkJs` 混合约 **4–6 人日**（但类型收益显著更低，见 §6）。

**建议第一步**：Phase 0（0.5–1 天）——在仓库内落地 `tsconfig.json` + `types-vendor/` + `scripts/sync-types.mjs` + `npm run typecheck`，**先只对现有 JS 开 `allowJs + checkJs` 做一次全量基线类型检查**，用真实报错数量校准后续估算，再决定是否进入 Phase 1。这一步不改变任何运行时行为，可以随时回滚。

---

## 1. 证据约定与工具限制

- 安装版路径：`D:\SOFT\tools\dsh\resources\app.asar`（内含 `dsh/` 与根 `node_modules/`），版本 **`@deepseek-ai/dsh-desktop-runtime@0.2.2-rc.1`**；profile 目录 `C:\Users\q1325\.dsh\profiles\web`（`DSH_PROFILE=web`）。
- **asar 不能被普通进程当目录读**。实测（探针 `asar-pkg-versions.mjs`）：
  ```
  fs.readdirSync('.../app.asar/dsh/node_modules/@deepseek-ai/cordis') => ENOENT
  fs.statSync('.../app.asar/.../cordis/package.json')           => ENOENT
  手工解析 asar 头（buf.readUInt32LE(12) + JSON）读 cordis/package.json => 1241 bytes ✔
  ```
  即：**读 asar 文件本身可以，按路径进 asar 里面不行**。`read` 工具能读 asar 内文件，是因为 Host 进程的 fs 打了 asar 补丁（技能文档亦如此说明）。仓库里既有的 `scripts/asar-list.cjs` / `asar-get.cjs` 正是走手工解析路线，本次沿用。
- 探针目录 `F:\dev\GitHub\dsh-ts-probe` 内所有命令输出均为本报告 §3–§5 的证据；目录已删除，报告内命令可复现。

---

## 2. DSH 第三方插件的产物契约（编译后是否仍然成立）

### 2.1 Host 侧

| 契约点 | 事实 | 证据 |
|---|---|---|
| 入口解析 | Loader 用行 `name` 走 Node 解析（`main`/`exports`），与文件是否由 TS 编译无关；`dist/index.js` 只要被 `main`/`exports["."]` 指到即可 | `host-plugin.md:9-27`（清单示例）；本仓库以 `link:F:/dev/GitHub/dsh-pre-compact` 挂载（profile `C:\Users\q1325\.dsh\profiles\web\package.json:7`），行引用在同目录 `cordis.patch.yml:544-545` |
| `Config` | 运行期 schemastery 对象；激活时由 Loader 校验该行 `config`，插件页/设置页表单由该 schema 生成 → 编译不改变任何行为 | `host-plugin.md:57-64`；本仓库 `src/config-schema.js:14` + `src/config.js:237-273`（可选 schemastery，解析不到则 `undefined`，自己校验） |
| `.volatile()` | 声明为 volatile 的字段在 `apply` 里是 `{ get() }` 引用，Loader 发 `loader/volatile-update` 原地更新、不重启插件 | `host-plugin.md:77`；本仓库 `src/config.js:179-201`（`unwrapConfigRefs`）与 `index.js:60-70` |
| patch / bundle | `dsh.bundle.patch` + `cordis.patch.yml` 纯文本，与编译无关 | `host-plugin.md:9-27`；`cordis.patch.yml:7-25` |
| 显示元数据 | 插件页读**导出的 locale JSON**（`meta.title/description`）和 `./icon`；与入口是否编译无关，但 `files`/`exports` 必须继续导出它们 | `host-plugin.md:31-49`；`package.json:8-14,28-39` |
| 硬依赖 | 装进 profile 的包只有 `dependencies`（`link:` 依赖是目录链接，**不安装**目标包 devDependencies），所以类型包放 `devDependencies` 不会污染用户 profile | 本仓库 profile 用 `link:`（`profiles/web/package.json:7`）；pnpm 的 `link:` 语义如此——**列为 Phase 0 需验证项**（见 §8 R7） |

结论：Host 改成 `src/**/*.ts` → `dist/index.js` + `dist/**/*.d.ts`，**对 Loader、Settings、插件页没有任何影响**；DSH 运行期从不读 `.d.ts`（§3.1 的反证）。

### 2.2 Client 侧（浏览器 half）

契约来自 `@deepseek-ai/dsh-client-modules` 的实现（已抽取在仓库内：`research/extracted/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js`）：

| 契约点 | 事实 | 证据（文件:行） |
|---|---|---|
| 产物形状 | 一个**经典脚本**（不能有顶层 `import`/`export`），顶层调用 `window.__ModuleLoader__.load({ id, factory })`；`factory(require) → exports` 在首次 require 时惰性求值并被缓存 | 该文件 `:42-56` 注释、`:521-541`（queue 模式实现） |
| id | 必须等于包名（本仓库 `client.js:36` `id: '@local/dsh-pre-compact'`；loader 用 `exports["./client"]` 找文件） | `:200` `clientExportOf`、`:783` `resolveMeta` |
| `exports["./client"]` | 可以是任意相对路径（含子目录），字符串或 `{ default: string }`；编译到 `./dist/client.js` 完全合法 | `:200-210` |
| `dsh.client` 字段 | `platform`(必填 string) / `immediately`(boolean) / `inject`(string[]) / `external`(string[]) 严格校验，非法值直接抛错 | `:86-100` `parseDshClient` |
| `external` 语义 | **只是"其它插件的 client 行"**，且不许写自己的包名；React 属于 baseline 模块表，**不需要也不允许**写进 external | `:472-494`（"a row must not declare its own package"）；本仓库只声明了 `inject`（`package.json:32-38`） |
| React 来源 | 由模块表提供，官方 bundle 里直接 `require("react")` 与 `require("react/jsx-runtime")`；无需安装、无需 CDN | 官方 `dsh-client-ui-theme/lib/client.js`、`dsh-client-ui-settings-plugins/lib/client.js` 均含 `require("react/jsx-runtime")`；`ui-plugin.md:9-11` |
| sourcemap | 官方产物末尾带 `//# sourceMappingURL=client.js.map`；loader 会**剥掉**这个 trailer，并在 `clientPath + ".map"` 读同名 map 文件、校验 Source Map v3（`sources`/`names`/`mappings`）后合成 combo map | `:194` `SOURCE_MAP_TRAILER`（注释：*emitted by tsdown*）、`:313-327` `prepareSource`、`:329-345` `readSourceMap` |
| 更新检测 | 每次构建后按 **mtime/size/ctime 的哈希**生成 artifactRevision，作为版本化资源 URL；文件改动即被视为新构建（页面刷新后生效） | `:222-229` `artifactRevision`、`:669-694` |
| 分块 | 额外支持按需 chunk 路由（`client.<hash>.js`），单文件也不必用 | `:197` `CLIENT_CHUNK`、`:306-311` |

结论：**TS/TSX 源码 → 单文件 `client.js`（CJS 包装）是完全可行的**，只要产物满足上表；`locale/*.json`、`icon.svg`、`package.json` 字段都不受影响。

### 2.3 编译产物对 Loader / Settings / 插件页的影响（逐条）

| 关注点 | 结论 | 依据 |
|---|---|---|
| Loader 能加载 `dist/index.js` 吗 | 能，按 `main`/`exports` 解析 | §2.1；探针 `tsc` 产物在 node 里 `import()` 成功（§5.3） |
| `.d.ts` 会增加启动开销吗 | 不会，运行期不读 | 安装包 0 个 `.d.ts`（§3.1） |
| Settings/插件页表单会变吗 | 不会，schema 来自运行期对象 | `host-plugin.md:57-64` + `Config.listConfigs`（`cordis_inspect_query`） |
| `cordis.patch.yml` 要不要改 | 不用 | `cordis.patch.yml:7-25` 无构建相关字段 |
| 插件页图标/locale 会变吗 | 不会，前提是 `exports`/`files` 继续导出 `./locale/*.json`、`./icon` | `host-plugin.md:44-49` |
| 客户端 bundle 需要打包成几个文件 | 1 个即可（+ 同名 `.map`） | §2.2 sourcemap 行 |
| 现有测试怎么看待产物 | 测试直接 `import(client.js)` 并断言注册形状（见 §5.4） | `test/client.test.js:194-204` |

---

## 3. 类型来源与解析（本报告最关键的发现）

### 3.1 安装包里没有 `.d.ts`，且 asar 不能当目录读

```
$ node scripts/asar-list.cjs '\.d\.ts$' --files
--- 0 match(es) ---            # 22103 个文件里 0 个 .d.ts
$ node scripts/asar-list.cjs '.' --files | (扩展名直方图)
js 7660 | ts 4369 | json 3138 | cjs 1581 | mjs 1540 | md 1373 | ... | cts 107
```

- `.d.cts` 存在（如 `node_modules/zod/index.d.cts`），`.d.ts` 全部缺失 → 打包流水线按 `*.d.ts` 做了排除（不是没发布，见下一条）。
- 包清单仍然声明了类型入口，例如 `dsh-token-meter/package.json`：`"types": "lib/types/index.d.ts"`、`"exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" } }`、`files` 含 `lib/types/**/*.d.ts` —— **只是打包进 Electron 时被剔除了**。
- `app.asar.unpacked/` 里也是 0 个 `.d.ts`（`Get-ChildItem -Recurse -Filter *.d.ts` 计数 0）。
- 普通 node/tsc 读不了 asar 内路径（§1），所以"让 tsc 直接指 asar"这条路**不通**。

### 3.2 npm 上有同版本、带 `.d.ts` 的公开包（但必须锁版本）

```
$ npm view @deepseek-ai/dsh-session versions --json | tail
  "0.2.1-rc.2", "0.2.1-rc.3", "0.2.1-rc.4", "0.2.1-rc.5",
  "0.2.2-alpha.2", "0.2.2-alpha.3", "0.2.2-rc.1"
$ npm view @deepseek-ai/dsh-session dist-tags
{ "latest": "0.0.1-rc.1", "next": "0.2.2-rc.1", "alpha": "0.2.2-alpha.3" }   # ❗latest 是错的占位包
```

安装版内各包实际版本（探针 `asar-pkg-versions.mjs` 直接读 asar 头）：

| 包 | 安装版版本 | `types` 字段 |
|---|---|---|
| `@deepseek-ai/cordis` | 4.1.0 | `lib/types/index.d.ts` |
| `@deepseek-ai/schemastery` | 3.19.0 | `lib/types/index.d.ts` |
| `@deepseek-ai/cosmokit` | 1.9.0 | `lib/types/index.d.ts` |
| `@deepseek-ai/dsh-session` / `-projection` / `-compaction` / `-llm` / `-token-meter` / `-commands` / `-agent` / `-host-webserver` / `-client-*` | 0.2.2-rc.1 | `lib/types/index.d.ts` |

→ **锁 `0.2.2-rc.1` + `cordis@4.1.0` + `schemastery@3.19.0`** 就与安装版一致。

### 3.3 三条取型路线的实测对比

探针（`F:\dev\GitHub\dsh-ts-probe`）用一段**模拟本插件真实用法**的 `src/probe.ts` 做对比：`import type { Context }`、`ctx.tokenMeter` / `ctx.compaction` / `ctx.sessions` / `ctx.llm` / `ctx.commands` / `ctx.inject(['webServer'])`、`ctx.on('session/event')` / `ctx.on('agent/pre-step')`、`z.object({...}).volatile()`。

| 路线 | 做法 | 实测结果 |
|---|---|---|
| **A. devDependencies（推荐）** | `npm i -D @deepseek-ai/{cordis,cordis-plugin-loader,schemastery,dsh-session,dsh-llm,dsh-compaction,dsh-token-meter,dsh-commands,dsh-agent,dsh-host-webserver,dsh-client-ui-slots} + typescript@5.9` | `npx tsc -p tsconfig.probe.json` → **exit 0**；`node_modules` 现装 **30.0 MB**（含 peer 自动安装；探针未含 cordis-plugin-loader，见 §3.3 第 1 条） |
| **B. vendor `.d.ts` + paths（零依赖）** | 脚本只拷 `node_modules/@deepseek-ai/*/lib/types/**/*.d.ts` + `package.json` 到 `types-vendor/`，`tsconfig.paths`：`"@deepseek-ai/*": ["./types-vendor/@deepseek-ai/*"]` | **101 个 `.d.ts` / 542.6 KiB / 14 个包**；`npx tsc -p tsconfig.vendor.json` → **exit 0**（模块 `ESNext` + `moduleResolution: Bundler`） |
| **C. 手写 ambient shim** | 只声明实际用到的 ~10 个服务方法与事件 | 可行但几乎全是 `any`，放弃 §3.4 的收益；仅在"完全不想碰 npm/构建"时作为过渡 |

路线 A 实测注意点（都会在真实迁移中复现）：

1. **必须显式加载声明合并**。只 `import type { Context } from '@deepseek-ai/cordis'` 时：
   `TS2339: Property 'tokenMeter' / 'compaction' / 'commands' / 'webServer' does not exist on type 'Context'`。
   解决：加一个 ambient 文件（本插件建议 `src/dsh-types.d.ts`）：
   ```ts
   import type {} from '@deepseek-ai/dsh-session'
   import type {} from '@deepseek-ai/dsh-token-meter'
   import type {} from '@deepseek-ai/dsh-compaction'
   import type {} from '@deepseek-ai/dsh-llm'
   import type {} from '@deepseek-ai/dsh-commands'
   import type {} from '@deepseek-ai/dsh-host-webserver'
   import type {} from '@deepseek-ai/dsh-agent'
   import type {} from '@deepseek-ai/cordis-plugin-loader'   // 见下：loader/volatile-update 在这里声明
   ```
   加上后 0 错误。
   **`loader/volatile-update` 的类型来源是个容易漏的点**：它不在任何 `dsh-*` 包里，而在 `@deepseek-ai/cordis-plugin-loader@1.1.0` 的 `lib/types/index.d.ts:19,29`：
   ```ts
   interface Events { 'loader/volatile-update'(paths: readonly (readonly string[])[]): void; }
   ```
   → 该包（与安装版同版本 1.1.0）必须进类型集合，否则 `index.js:60` 的 `ctx.on('loader/volatile-update', …)` 会报 `TS2345: not assignable to parameter of type 'keyof Events'`。
2. **`skipLibCheck: true` 是必需的**（不是偷懒）：`skipLibCheck: false` 时发布包自身的 `.d.ts` 会报
   `Cannot find module '@deepseek-ai/dsh-package-manifest'`（`dsh-llm` 的可选依赖）与 `Cannot find name 'Disposable'`（需 `lib: ["ESNext.Disposable"]`）。→ 类型配置里 `skipLibCheck: true` + `lib` 含 `ESNext.Disposable`。
3. `moduleResolution: NodeNext` 下**不需要** `allowImportingTsExtensions`：发布的 `.d.ts` 里 `from './types.ts'` 这类说明符在声明文件中能被 tsc 正确解析（A 路线 0 错误即是证据）。`allowImportingTsExtensions` 只在**你自己的 `.ts` 源码**用 `.ts` 后缀 import 时才需要。

### 3.4 能拿到什么样的类型（这才是重构的真正收益）

| 对象 | 证据 | 收益 |
|---|---|---|
| `ctx` 服务：`tokenMeter` / `compaction` / `sessions` / `llm` / `commands` / `webServer` | 各包 `declare module '@deepseek-ai/cordis' { interface Context { ... } }`，如 `@deepseek-ai/dsh-session/lib/types/index.d.ts:26-29`（`sessions: SessionStore`）、`@deepseek-ai/dsh-commands/lib/types/index.d.ts:63-65`（`commands: CommandRuntime`） | 现在 `src/` 里 `ctx.get?.('tokenMeter')` 全是 `any`；迁移后是 `TokenMeter \| undefined` |
| 事件与 payload | `dsh-session/index.d.ts:30-72` 声明了 `'session/created' \| 'session/disposed' \| 'session/event' \| 'session/flush'`，带 `@mode` 语义；`dsh-agent/lib/types/runtime-types.d.ts:254,267,279,332,422` 声明了 `agent/created`、`agent/disposed`、`agent/status`、`agent/pre-step`、`agent/turn-stopping`——**本插件用到的 7 个 `agent/*`+`session/*` 事件全部有类型**；`agent/pre-step` 的 payload 实测为 `{ agent, messages, turn, step, signal, modelSelection }`，`next()` 返回 `Promise<PreStepDecision>`；`loader/volatile-update` 在 `cordis-plugin-loader@1.1.0` 声明（见 §3.3） | 现在 `index.js:96-129` 一批 `payload?.agent` 的防御式写法可换成精确类型；`return next()` 在类型上被证明正确 |
| schemastery `.volatile()` | `@deepseek-ai/schemastery/lib/types/index.d.ts:156`：`volatile(): Schema<..., 'volatile'>`，`:205-207` 把 volatile 输出映射为 cosmokit 的 `Volatile<T>`（即 `{ get(): T }`） | `unwrapConfigRefs` 可以拿到 `Volatile<number>` 之类的**精确输入类型**，`DEFAULTS`/`resolveConfig` 也能返回 `Config` 而不是 `Record<string, any>` |
| `SessionId` 等 branded 类型 | `dsh-session` 的 `SessionId` 是 branded（探针里 `sessions.get('s1')` 被拒） | 编译期就能发现"用字符串拼 sessionId"的隐患 |
| Client slot props（可选） | `@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:347`（`'conversation.composer.dock'` 的 kind/scope 与派生 props）、`dsh-client-ui-settings/lib/types/config-form.d.ts:94`（`configForms: ConfigForms`） | 能拿到 slot 名与 props 的强类型、locale key 的联合类型 |
| **Client Context 缺口** | `dsh-client-ui-slots` 没有 `./client` 导出、也没有 `interface Context { slots: ... }` 声明（只导出 `SlotMap`/`LocaleNamespaceMap` 等类型契约）；已核对的 `dsh-client-ui-conversation` / `-locale` / `-plugin-manager` / `-settings` / `client-web` / `cordis-client-runner` 只各自 declare 自己的服务（`locale` 在 `dsh-client-locale/lib/types/client/index.d.ts:58-59`） | `ctx.slots` 的 augmentation 来源需在 Phase 4 用一次 `tsc --traceResolution` 或 shell 包核对确认；**兜底方案已探针验证**：在 `client/` 内写一个本地 `interface ClientContext { slots; locale; configForms }` 门面，类型收益仍在（slot 名/参数可复用 `SlotMap`） |

---

## 4. 构建工具：官方用 tsdown，但**没随安装包分发**

### 4.1 证据

- `dsh-client-modules/lib/index.js:194` 注释原文：`/** Source-map trailer emitted by tsdown at the end of every client bundle. */` → 官方客户端 bundle 由 **tsdown** 产出。
- 产物形态与 rolldown/tsdown 输出一致：`var module = { exports: {} }`、`//#region` 注释块、`Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })`（见 `dsh-client-ui-settings/lib/client.js:1-9`）。
- **但安装包里没有 tsdown/esbuild/rollup/vite 包目录**：路径索引扫描 `node_modules/(tsdown|esbuild|rollup|vite|rolldown|unbuild)` → `0 match`；337 个 `@deepseek-ai/*/package.json` 里没有任何包的 `scripts`/`devDependencies` 提到 tsdown（构建工具只出现在 **`dsh-web-frontend`（vite shell）** 的 devDependencies 文本中：`vite ^6.4.3`、`@vitejs/plugin-react ^4.7.0`、`typescript ^6.0.3`、`react ^18.2.0` —— 那是 **shell 应用**的依赖，不是插件 bundle 构建器，且未安装）。
- 因此：**"复用部署的 Client 构建工具"在本机不可行**，必须自建（这不算风险，因为契约已经完整反推出来了）。

### 4.2 自建方案（探针已验证）

**Host：`tsc`（首选，零额外依赖）**。理由：产物就是 16 个 ES 模块，`tsc` 天然保留 ESM 形状、`.js` 说明符、`declaration`；不需要打包器（插件本来就允许 `src/` 多文件）。

**Client：`esbuild` + 30 行包装脚本**（产物必须单文件 + CJS 包装）。探针 `build-client-probe.mjs`：

```js
await build({
  entryPoints: ['client-src/index.tsx'],
  bundle: true, format: 'cjs', platform: 'browser', target: ['es2020'],
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  outfile: 'dist/client.body.cjs',
  sourcemap: 'external',
})
// 包一层 loader 注册（等价于 tsdown 产物的外壳），再拼上 sourceMappingURL trailer
```

实测产物校验（`validate-client.mjs`，用 `node:vm` 模拟页面）：

```
registrations after script eval: 1
id: @local/dsh-ts-probe-client | factory is function: true
module table requests: [ 'react', 'react/jsx-runtime' ]
exports keys: [ 'apply' ] | apply: function
effect: probe dock
slots.inject: conversation.composer.dock
slots.register: conversation.composer.dock probe | component: function
effects registered: 1 | disposers: 1
```

体积：body 1666 B → 包装后 **1963 B**（探针玩具规模；按本插件 2015 行估约 60–90 KB，与当前 `client.js` 86 KB 同量级）。

**JSX 运行时的取舍（重要）**：

- 走 `jsx: 'automatic'` → 产物 `require("react")` + `require("react/jsx-runtime")`。官方包这么做，说明两者都在 baseline 模块表里（实锤：官方 `dsh-client-ui-theme`、`dsh-client-ui-settings-plugins` 的 `lib/client.js` 都有 `react/jsx-runtime` 请求）。
- 但现有 `test/client.test.js:201-204` 的假 `require` **只允许 `react`**，否则抛 `the bundle should only require react`。→ 两个选项：**(a) 同步放宽测试桩（1 行）**；**(b) `jsx: 'transform'` + `jsxFactory: 'h'`，每个 TSX 文件 `import { createElement as h } from 'react'`**，产物仍只请求 `react`（与现状 `client.js:37` 完全一致）。推荐 (b) 作为默认，风险最小。

### 4.3 推荐目录与配置（可落地模板）

```
dsh-pre-compact/
├─ src/                      # Host TS 源（原 src/*.js + index.js 迁入）
│  ├─ index.ts               # 原 index.js
│  ├─ config.ts  config-schema.ts  coordinator.ts  ...
│  └─ dsh-types.d.ts         # 声明合并装载（§3.3 第 1 条）
├─ client/                   # Browser half TS/TSX 源（原 client.js 拆分）
│  ├─ index.tsx              # 导出 apply() + __internals
│  ├─ ctx.d.ts               # 本地 ClientContext 门面（§3.4 缺口兜底）
│  ├─ chart.ts               # 纯图表模型（可被 node:test 直接测）
│  └─ components/*.tsx
├─ test/                     # 原测试，改为 import '../src/...js'（NodeNext 无需改后缀）
├─ types-vendor/             # 可选：抽取的 .d.ts 快照（零依赖 CI）
├─ scripts/
│  ├─ sync-types.mjs         # 从精确版本的 npm 包抽取 lib/types/**/*.d.ts → types-vendor/
│  └─ build-client.mjs       # esbuild + __ModuleLoader__ 包装
├─ dist/                     # 构建产物（Host: index.js + 模块 + .d.ts；client.js + .map）
├─ tsconfig.json             # Host + 测试
├─ tsconfig.client.json      # Client（DOM + jsx）
└─ package.json
```

`tsconfig.json`（Host，探针实测同款）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "ESNext.Disposable"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": []
  },
  "include": ["src", "test"]
}
```

`tsconfig.client.json`（Client）：

```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext", "moduleResolution": "Bundler",
    "jsx": "react-jsx",                  // 或 "react" + "jsxFactory": "h"（见 §4.2 取舍）
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "types": []
  },
  "include": ["client"]
}
```
（Client 另需 `devDependencies`：`react@18` + `@types/react@18`。）

`package.json` 关键字段（编译后）：

```json
{
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./client": "./dist/client.js",
    "./locale/*.json": "./locale/*.json",
    "./package.json": "./package.json",
    "./icon": "./icon.svg"
  },
  "files": ["dist", "locale/*.json", "icon.svg", "cordis.patch.yml", "README.md", "docs"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-plugin-manager"] }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json && node scripts/build-client.mjs",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json",
    "test": "node --import tsx --test \"test/**/*.test.ts\"",
    "pretest": "npm run build"
  }
}
```
> `dsh.client` 里**不要**加 `external: ["react"]`（React 是 baseline 模块，且 external 只用于其它插件的 client 行，见 §2.2）。

---

## 5. 测试与开发体验（Node 22.17.1 实测）

### 5.1 三种跑法对比

| 方式 | 命令 | 结果 |
|---|---|---|
| 原生、无参数 | `node --test test-probe/util.test.ts` | ❌ `ERR_UNKNOWN_FILE_EXTENSION ".ts"` |
| Node 22 类型剥离 | `node --experimental-strip-types --test test-probe/util.test.ts`（源码 import `./util.ts`） | ✅ 2/2 pass |
| 同上 + NodeNext 风格 `.js` 说明符 | 源码 `import './util.js'` | ❌ `ERR_MODULE_NOT_FOUND: .../util.js`（**strip-types 不重写说明符**） |
| tsx loader | `node --import tsx --test test-probe/js-specifier.test.ts` | ✅ 1/1 pass（`.js` → `.ts` 自动映射） |
| 编译后测试 | `tsc` → `dist/` → `node --test dist/**/*.test.js` | 未单独探针；与 strip-types 无关，最稳但循环慢 |

### 5.2 结论

- 本仓库现有 16 个源文件 + 18 个测试文件全部用 **NodeNext 风格的 `.js` 说明符**（如 `test/client.test.js:22` `import { DEFAULTS } from '../src/config.js'`）。为了不重写 7417 行测试里的 import，**推荐 `node --import tsx --test`**；`tsx` 只进 devDependencies，不参与运行时。
- 备选：若不愿引入 `tsx`，则统一用 `--experimental-strip-types` 并把所有相对 import 改成 `.ts` 后缀 + `allowImportingTsExtensions: true`（仅 `noEmit` 下合法）——改动面更大，且 `tsc` 产物仍需另一套 emit 配置。**不推荐**。
- CI 建议：`npm run typecheck`（Host + Client 两个 project）→ `npm run build` → `node --import tsx --test` → 可选 `node --test dist/**/*.test.js` 作为"产物级"回归。

### 5.3 Host 产物验证（探针实测）

`tsc -p tsconfig.emit.json` → exit 0，产物：

```
dist-host/index.js        292 B   ← ESM，保留 './probe.js' 说明符与顶层 await
dist-host/index.d.ts      192 B
dist-host/{config,probe}.{js,d.ts,js.map,d.ts.map}
```
- 静态运行期 import 扫描：**无任何 `@deepseek-ai/*` 静态 import**，只有 `await import('@deepseek-ai/schemastery')`（与现状 `src/config.js:212` 的兜底导入同形）。
- `node -e "import('./dist-host/index.js')"` → `exports: [ 'Config', 'apply' ] | Config: function`（动态 schemastery 解析成功、顶层 await 正常）。
- 相对路径风险为零：`src/`、`index.js`、`client.js` 中**没有** `import.meta.url` / `__dirname` / `readFileSync`（唯一的路径/环境依赖是 `src/config.js:219` 读 `DSH_PROFILE_DIR`/`DSH_HOME`，与 dist 层级无关）。

### 5.4 现有测试对 client 产物的硬约束（迁移必读）

`test/client.test.js`：
- `:196` 注入 `globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } }`；
- `:198` `await import(pathToFileURL(clientPath).href)`，`:199` 断言**恰好 1 次注册**；
- `:201-204` `captured[0].factory(id => { if (id === 'react') return React; throw ... })` → **产物只能 require `react`**；
- 之后读 `plugin.__internals`（`client.js:2007`）做纯函数/渲染测试。

→ 迁移约束：**client 产物必须仍然"1 次注册 + 仅 react + 导出 apply 与 `__internals`"**。这恰好是 §4.2 的构建脚本 + `jsxFactory: 'h'` 能保证的。基线：当前 `npm test` **263 个用例全绿，约 926 ms**。

---

## 6. 三种方案对比与推荐

| 维度 | **A. 完整 TS（Host .ts + Client .tsx）** | **B. TS 仅 Host，client 留 JS** | **C. JSDoc + checkJs 混合** |
|---|---|---|---|
| 类型覆盖 | `ctx` 服务/事件 payload/Config/slot props 全覆盖 | Host 全覆盖；client 仍 `any` | 靠 JSDoc，`ctx.get()` 仍 largely `any` |
| 运行时风险 | 低（产物形状已验证） | 最低（client 零改动） | 最低（不产生构建产物） |
| 构建链 | `tsc` + `esbuild` 包装脚本（~1 天） | `tsc` | 无（`tsc --noEmit` + `checkJs`） |
| 客户端重写量 | 2015 行 → TSX 组件（最大开销项） | 0 | 0 |
| 测试改动 | import 后缀 + `test/client.test.js` 路径（若 client 产物移到 `dist/`）+ tsx loader | 同左（client 不用动） | 加 `// @ts-check` / jsconfig |
| 长期收益 | 高（事件/服务/配置全部可校验） | 中（本插件 60% 复杂度在 coordinator） | 低（无法表达泛型、无法描述 `Volatile<T>`） |
| 估算 | **8–12 人日** | **4.5–6.5 人日** | **4–6 人日** |
| 回滚粒度 | 阶段级（7 段） | 阶段级（5 段） | 文件级，但收益不足以支撑后续演进 |

**推荐 A，但客户端分两步走**：

- **A1（先做）**：`client.js` → `client/index.ts`，**保留现有 `h()` 调用**，只把结构拆成 `chart.ts` / 组件函数并加类型。这一步收益最大（2015 行里最容易出错的是图表模型与表单状态机）、风险最低（产物形状与现在几乎一致，测试无需改断言）。
- **A2（可选后置）**：再把组件改成 `.tsx`。此时才引入 `jsxFactory`/`react-jsx` 的取舍与 `test/client.test.js` 的 require 白名单调整。

理由（对应任务里"三选一并说明理由"）：
1. 本插件的核心复杂度是**与宿主服务交互**（`tokenMeter.measure`、`compaction.compactNow/prepareCheckpoint`、`llm.stream`、`commands.register`、`webServer.register`、7 个 `agent/*` 事件）。这些恰好是 §3.4 里类型最完整的一层，而 JSDoc 方案无法得到事件 payload 与 branded 类型。
2. 客户端契约（§2.2）已经用 loader 源码 + 探针双重确认，产物可被现有测试直接验证——这是"低风险可验证"的典型形态，不做的唯一原因是工作量，而不是可行性。
3. 混合方案 C 会留下"`ctx.get()` 仍然是 `any`"的长期债务，260 个用例的保护面不变，收益不足以覆盖维护两套类型注释的成本。

---

## 7. 分阶段迁移清单（每阶段独立编译/测试/回滚）

> 通用验收：每阶段结束必须 `npm run typecheck` + `node --import tsx --test` 全绿；`git diff` 只含本阶段文件；产物可回滚（保留上一版 `dist/` 或直接 revert 提交）。

| 阶段 | 内容 | 验收命令 | 预估 |
|---|---|---|---|
| **P0 工具链与类型基线** | `tsconfig.json`/`tsconfig.client.json`、`types-vendor/`（或 devDeps）、`scripts/sync-types.mjs`、`allowJs+checkJs` 基线跑一遍 | `npx tsc -p tsconfig.json --noEmit`（记录报错数，作为估算校准） | 0.5–1 天 |
| **P1 纯函数层** | `util.ts`、`config.ts`、`config-schema.ts`、`internal-policy.ts`、`log.ts`（**580 行**，无 ctx 依赖） | `tsc` + `test/{log,config}.test.js` 通过；`src/config.js:210-273` 的动态 schemastery 行为不变 | 0.5–1 天 |
| **P2 数据/策略层** | `policy.ts`、`native-policy.ts`、`surface.ts`、`snapshot.ts`、`commit.ts`（**1178 行**，输入是纯数据结构 + `tokenMeter` 读取） | `test/{policy,native-policy,surface,commit}.test.js` 通过；`native-policy.ts` 的 `ctx.get('llm')` 拿到强类型 | 1–1.5 天 |
| **P3 协调器与手动钩子** | `coordinator.ts`（1391 行，最大）、`manual-hook.ts`、`summarizer.ts`（合计 **1702 行**）；7 个 `agent/*` 事件、`session/*` 事件全部换强类型 | `test/{lifecycle,manual-hook,e2e,summarizer}.test.js` 通过（`fake-harness.js` 保持 JS，可用 `// @ts-nocheck` 过渡） | 2–3 天 |
| **P4 端点与 index** | `history-endpoint.ts`、`logs-endpoint.ts`、`visual-status.ts`、`index.ts`（原 `index.js`，合计 **608 行**） | `test/{history-endpoint,logs-endpoint,visual-status,command}.test.js`；`npm run build` 后 `node -e "import('./dist/index.js')"` 能拿到 `Config`/`apply` | 1–1.5 天 |
| **P5 Client A1** | `client.js` → `client/index.ts`（保留 `h()`）、拆出 `chart.ts`；`scripts/build-client.mjs` 产出 `dist/client.js` + `.map` | 构建后 `validate`：1 次注册、require 只含 `react`、`__internals` 可用；`test/client.test.js`（改 clientPath 指向 dist）通过 | 2–3 天 |
| **P6 Client A2（可选）** | 组件改 `.tsx`；决定 `jsxFactory: 'h'` 还是 `react-jsx`（后者需改测试桩） | 同 P5 + 浏览器实机验证（插件页卡片 / composer dock / conversation view） | 1–2 天 |
| **P7 收尾** | `package.json` 字段切换、`files`、README 构建说明、CI 脚本、`docs/` 更新 | 全套 `build + typecheck + test`；profile 侧 `link:` 安装仍可加载（重启宿主后验证插件页/设置页/命令） | 0.5–1 天 |

**回滚点**：P1–P4 每阶段都可以只回滚该阶段的文件；P5 起 `package.json` 的 `main`/`exports` 切换是**唯一**的全局开关——建议先用 `"main": "./index.js"`（旧）+ 并行产出 `dist/`，等 P5 验证通过再切，切换出问题时一行 revert 即可。

---

## 8. 风险表与缓解

| # | 风险 | 证据 | 缓解 |
|---|---|---|---|
| R1 | **asar 无 `.d.ts` + 不能按路径读 asar**，导致"指向安装位置取型"失败 | §3.1 实测 0 命中、`ENOENT` | 走 npm 包（A）或抽取快照（B）；探针两条路均 0 错误 |
| R2 | **版本漂移**：DSH 升级（0.2.2 → 0.3）后类型与运行时不一致；npm `latest` tag 还是错的 0.0.1-rc.1 | §3.2 | 精确锁版本（`"0.2.2-rc.1"` 不带 `^`）；`scripts/sync-types.mjs` 记录来源版本；CI 里对比 app 版本（可从 `dsh/package.json` 读）并提示刷新 |
| R3 | 发布包自身 `.d.ts` 不完整（`@deepseek-ai/dsh-package-manifest` 缺失、`Disposable` 需 lib） | §3.3 第 2 条报错原文 | `skipLibCheck: true` + `lib: ["ESNext.Disposable"]`；不要 `skipLibCheck: false` |
| R4 | 事件 payload 的类型覆盖并非 100%（本插件用到的事件恰好都有，但 `agent/turn-stopping` 等声明的 `this: Scoped<Agent>`、`@mode` 语义与运行期派发严格对应，需逐一对齐） | 探针确认 7 个事件有类型；`test/fake-harness.js` 的事件形状需逐一对齐 | 迁移时保留"未知事件用本地 `interface` 收窄"的逃生舱；发现缺口就在 `src/dsh-types.d.ts` 里补 declare |
| R5 | `Config`/`.volatile()` 类型与运行期引用语义不一致（volatile 到 `apply` 时是 `{ get() }`） | `schemastery:156,205-207` + `src/config.js:189-201` | 用 `Volatile<T>` 显式表达 `apply` 入参；`resolveConfig` 返回值只用解引用后的普通对象类型（避免把 `Volatile` 漏进内部状态） |
| R6 | Client slot props 类型需要一长串 client 包（conversation/settings/plugin-manager/locale/store/primitives…），且 `ctx.slots` 的 augmentation 来源未在已核对包中找到 | §3.4 最后一行 | 允许"本地 `ClientContext` 门面 + 复用 `SlotMap` 类型"的降级；这是 A1 阶段的既定方案，不阻塞 |
| R7 | `devDependencies` 会不会在 `plugin_manager install_bundle` 时被装进 profile | §2.1 最后一行（pnpm `link:` 语义）+ `profiles/web/package.json:7` | P0 阶段实测一次 `install_bundle` 或 `pnpm add ./`；若被安装，改用 `types-vendor/`（B）并删除 devDeps |
| R8 | 客户端产物形状被改坏（多余 require、多次注册、顶层 export） | `test/client.test.js:196-204` 的断言 + §2.2 loader 契约 | 构建脚本末尾加断言（本报告 §4.2 的 `validate-client.mjs` 可直接搬进 `scripts/`），并在 P5 验收里跑 |
| R9 | sourcemap 不合规导致 combo map 报错 | `readSourceMap` 校验 v3 且 `sources/names/mappings` 必需（`:329-345`） | esbuild `sourcemap: 'external'` 产物天然合规（探针已验证）；trailer 用 `//# sourceMappingURL=client.js.map` |
| R10 | locale 资源/图标在重构中漏导出 | `host-plugin.md:44-49` | P7 用 `node -e "import(pkg)"` 检查 `exports` 键；安装后用插件页/Nodes 观察 title/description/icon |
| R11 | 体积/启动开销 | 现在 `client.js` 86 KB；探针产物包装后 1963 B（玩具规模） | 预计 60–90 KB，同量级；esbuild `minify: true` 可再降（官方产物未加密压缩，保留可读性亦可） |
| R12 | 构建产物与源码不同步（忘记 `npm run build` 就安装） | 现有 `npm test` 直接读根目录 `client.js` | `pretest` 里挂 `build`；`package.json` 的 `exports` 指向 `dist/`；README 写清"改完先 build" |

---

## 9. 工作量估算（按现状代码量）

基线：Host `src/` 16 个文件 **3721 行** + `index.js` **347 行**；Client `client.js` **2015 行**；测试 **18 个文件 7417 行 / 263 个用例**。

| 工作项 | 人日 | 说明 |
|---|---|---|
| P0 工具链/类型来源 | 0.5–1 | 已用探针把方案验证透，实际落地主要是配置与脚本 |
| P1 纯函数层（1267 行） | 0.5–1 | 类型收益最大、改动最机械 |
| P2 数据/策略层（1078 行） | 1–1.5 | 涉及 `tokenMeter`/`compaction` 强类型 |
| P3 coordinator + manual-hook（1508 行） | 2–3 | 事件语义最复杂，`fake-harness` 需对齐 |
| P4 端点 + index（约 900 行） | 1–1.5 | `commands.register` / `webServer.register` 签名核对 |
| P5 Client A1（2015 行 → TS + 拆分） | 2–3 | 保留 `h()`，构建脚本 ~0.5 天含在内 |
| P6 Client A2（可选，TSX） | 1–2 | 只在决定继续时投入 |
| P7 收尾（package/files/CI/文档/实机） | 0.5–1 | 含一次重启宿主验证 |
| **合计（完整 TS，含 A2）** | **8–12 人日** | 不含 A2 约 7–10 人日 |
| **B 方案（Host 只 + client 留 JS）** | **4.5–6.5 人日** | — |
| **C 方案（JSDoc + checkJs）** | **4–6 人日** | 收益最低 |

---

## 10. 建议的第一步（可直接执行）

1. 建 `tsconfig.json` + `tsconfig.client.json`（§4.3），`npm i -D typescript@5.9 tsx@4 react@18 @types/react@18 @deepseek-ai/cordis-plugin-loader@1.1.0`，并按 §3.3 精确锁 `@deepseek-ai/*` 版本。
2. 加 `src/dsh-types.d.ts`（声明合并装载）+ `npm run typecheck`。
3. **先开 `allowJs: true, checkJs: true` 对现有 JS 跑一次全量检查**，把报错数量与集中在哪几个文件记录下来 —— 这是校准 P1–P5 工期的唯一真实数据（本报告估算基于探针 + 代码规模，属于±30% 量级）。
4. 若报错集中在 `coordinator.js`/`client.js`（预期如此），就按 §7 的 P1→P2→P3→P5 顺序推进；否则可以先做"纯函数层"，用最低成本拿到类型红利。
5. 全程保持 `main`/`exports` 指向现有 JS，直到 P5 构建脚本验证通过后再切 `dist/`（§7 回滚点）。

---

### 附：本次探针可直接复用的命令清单

```powershell
# 1) asar 里有没有 .d.ts（答案：0）
node scripts/asar-list.cjs '\.d\.ts$' --files

# 2) 普通 node 能否按路径读 asar（答案：不能）
node -e "require('node:fs').readdirSync('D:/SOFT/tools/dsh/resources/app.asar/dsh')"

# 3) 安装版各包版本（读 asar 头）
node <probe>/asar-pkg-versions.mjs

# 4) 类型探针（A: devDeps；B: 抽取 .d.ts + paths）
npx tsc -p tsconfig.probe.json      # exit 0
npx tsc -p tsconfig.vendor.json     # exit 0

# 5) 客户端打包 + 契约验证
node build-client-probe.mjs && node validate-client.mjs

# 6) 测试运行方式对比
node --experimental-strip-types --test test-probe/util.test.ts   # ✅（import ./util.ts）
node --experimental-strip-types --test test-probe/js-specifier.test.ts  # ❌ ERR_MODULE_NOT_FOUND
node --import tsx --test test-probe/js-specifier.test.ts        # ✅
```
