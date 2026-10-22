# OpenCode Go 额度侧栏 — V2 迁移设计

**日期：** 2026-10-22
**目标：** 把仓库从 OpenCode V1 的 TUI 插件 API 迁移到 OpenCode V2 的 CLI 插件 API。改造前先把当前 V1 状态冻结为 `v0.1.0` tag；主干此后只支持 OpenCode V2。

## 1. 背景与决策

### 1.1 当前状态

- 当前 HEAD 使用 `@opencode-ai/plugin@1.18.30`，默认导出 `{ id, tui }`，由 `~/.config/opencode/tui.json` 的 `plugin` 数组加载。
- 本机 OpenCode 已是 `2.1.2`；V2 的 CLI 插件 API 位于 `@opencode/plugin/tui`，默认导出 `Plugin.define({ id, setup })`。
- V2 的三处破坏性变化与本项目相关：CLI 插件实现 API、终端配置从 `tui.json(c)` 迁移到全局 `cli.json`、V2 槽位模型不再支持 `order`。

### 1.2 已确认的决策

| 决策 | 结果 |
|---|---|
| 支持范围 | **V2-only**；V1 代码只保留在 tag `v0.1.0` 中 |
| V1 tag | `v0.1.0`，注释写明“仅支持 OpenCode V1，不兼容 V2；V2 用户请用 v0.2.0+” |
| 版本号 | `0.2.0` |
| `order` 选项 | 删除；V2 固定 `append: "sidebar.content"`，容器追加在内置小节之后 |
| 数据层 | `usage.ts` 的取数、密钥、刷新状态机、格式化全部保留 |
| 分发方式 | 仍为本地插件，`exports["./tui"]` 指向 `tui.tsx`，通过 `cli.json` 的 `plugins` 加载 |

### 1.3 非目标

- 不实现 V1 + V2 双入口或运行时兼容层。
- 不改变额度接口、密钥查找顺序、刷新节流参数。
- 不新增持久化设置；slash 命令仍只影响当前 TUI 会话。
- 不重写历史设计文档；旧文档只加“历史文档”标注。

## 2. V2 API 映射

### 2.1 入口与生命周期

```tsx
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "opencode-go-usage",
  setup(ctx) {
    // 初始化
    return () => {
      // 取消订阅、清定时器
    }
  },
})
```

| V1 | V2 |
|---|---|
| `export default { id, tui }` | `export default Plugin.define({ id, setup })` |
| `tui(api, options, meta)` | `setup(ctx)` |
| `api.lifecycle.onDispose(fn)` | `setup` 返回 cleanup 函数 |
| `options` 第二个参数 | `ctx.options` |

### 2.2 槽位与命令

| V1 | V2 |
|---|---|
| `api.slots.register({ order: 350, slots: { sidebar_content } })` | `ctx.ui.slot({ append: "sidebar.content", render })` |
| `api.keymap.registerLayer({ commands, bindings })` | `ctx.keymap.layer(() => ({ mode: "global", commands }))` |
| 命令字段 `namespace: "palette"`、`name`、`desc`、`slashName` | 命令字段 `id`、`title`、`description`、`group`、`palette: true`、`slash: { name }` |
| `api.ui.toast({ variant, message })` | `ctx.ui.toast.show({ variant, message })` |
| `api.event.on("session.idle", handler)` | `ctx.data.on("session.idle", handler)` |

`sidebar.content` 的 render 入参为 `{ sessionID }`；本项目不使用该入参。

### 2.3 主题 token

V1 的 `TuiTheme` 换成 V2 的 `ResolvedTheme`。组件改为直接读取 V2 语义 token：

| 用途 | V1 | V2 |
|---|---|---|
| 标题与主文本 | `theme.current.text` | `theme.text.base` |
| 标签、次级文本 | `theme.current.textMuted` | `theme.text.muted` |
| 正常/警告/危险 | `theme.current.success` / `warning` / `error` | `theme.text.feedback.success.base` / `warning.base` / `error.base` |
| 进度条轨道候选 | `theme.current.border` | `theme.border.base` |
| 背景对比基准 | `theme.current.background` | `theme.background.base` |
| ledger 主块背景 | `theme.current.backgroundPanel` | `theme.background.raised.base` |
| ledger 主块边框 | `theme.current.borderActive` | `theme.text.action.primary.base` |

`pickTrackColor` 的亮度差判断（阈值 0.12）保留；V2 的 RGBA 分量仍是 0-1 刻度，`relativeLuma` 的刻度启发式继续适用。

## 3. 代码结构

### 3.1 `tui.tsx`

保持单文件 UI 入口，内部组件（`Bar`、`CompactRow`、`DetailedRow`、`LedgerPrimaryRow`、`LedgerSecondaryRow`、`UsageSection`）结构不变，只替换主题类型与 token。`setup` 流程：

1. `const opts = parseOptions(ctx.options)`，得到 `style`。
2. 建立 `style`、`usage`、`stale`、`now` 四个 Solid signal。
3. 用 `createRefresher` 接入 `resolveKey(() => resolveKey(defaultStateDir()))`、`fetchUsage`、`Date.now`。
4. `ctx.data.on("session.idle", () => void refresh(false))`。
5. `setInterval` 兜底刷新（300 秒）与倒计时重算（60 秒）。
6. `ctx.keymap.layer` 注册三个样式命令；`run` 中 `setStyle` 并 `ctx.ui.toast.show`。
7. `ctx.ui.slot({ append: "sidebar.content", render: ... })` 注册侧栏内容。
8. 启动时 `void refresh(true)`。
9. 返回 cleanup：取消 `session.idle` 订阅、清两个 interval。槽位与 keymap 由宿主在插件卸载时自动清理。

### 3.2 `usage.ts`

- `PluginOptions` 从 `{ style, order }` 改为 `{ style }`。
- `parseOptions` 删除 `order` 解析与默认值 `350`；未知字段继续忽略，非法输入继续回退 `compact`。
- 其余导出（`resolveKey`、`defaultStateDir`、`fetchUsage`、`createRefresher`、格式化函数、`STYLE_COMMANDS`、`pickTrackColor`）保持不变。
- `resolveKey` 的调用方只传 `defaultStateDir()` 一个候选。V2 没有 `api.state.path.state`；`auth.json` 仍位于 `~/.local/share/opencode`（macOS/Linux）或 `%LOCALAPPDATA%\opencode`（Windows）。

### 3.3 配置文件

V2 使用全局 `~/.config/opencode/cli.json`：

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/绝对路径/opencode-go-usage/tui.tsx"]
}
```

带配置时使用对象形式：

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/绝对路径/opencode-go-usage/tui.tsx",
      "options": { "style": "ledger" }
    }
  ]
}
```

`cli.json` 只存在于全局配置目录，没有项目级等价物。

## 4. 行为规格

以下行为与 V1 版本保持一致：

| 场景 | 行为 |
|---|---|
| 插件启动 | 立即请求一次额度（`force = true`） |
| `session.idle` | 刷新一次，距上次请求不足 20 秒时跳过 |
| 兜底定时器 | 每 300 秒强制刷新一次 |
| 倒计时 | 每 60 秒本地重算，不发请求 |
| `dead`（无套餐 / 401 / 403） | 隐藏整节，停止后续请求 |
| `soft-error`（网络、超时、5xx、格式异常） | 保留上次快照，标题显示 `OpenCode Go !` |
| 没有密钥 | 隐藏整节，后续刷新继续尝试解析 |
| 三种样式 | `compact` / `detailed` / `ledger`，由 `cli.json` 的 `style` 决定启动样式 |
| slash 命令 | `/go-usage-compact`、`/go-usage-detailed`、`/go-usage-ledger` 切换当前 TUI 会话样式，重启后回到配置值 |

唯一可见变化：额度小节不再能插到 `LSP` 与 `Todo` 之间，固定追加在侧栏内置内容之后。旧配置里的 `order` 会被忽略。

## 5. 打包与依赖

`package.json` 目标状态：

```jsonc
{
  "version": "0.2.0",
  "exports": { "./tui": "./tui.tsx" },
  "engines": { "opencode": ">=2.1.2" },
  "dependencies": {
    "@opencode/plugin": "2.1.2"
  },
  "peerDependencies": {
    "@opencode/theme": "2.1.2",
    "@opentui/core": ">=0.6.6",
    "@opentui/solid": ">=0.6.6",
    "solid-js": ">=1.9.0"
  },
  "devDependencies": {
    "@opencode/theme": "2.1.2",
    "@opentui/core": "0.6.6",
    "@opentui/solid": "0.6.6",
    "@types/bun": "^1.3.14",
    "solid-js": "1.9.12"
  }
}
```

`@opencode/theme` 只用于 `ResolvedTheme` 类型导入，运行时由宿主提供；放进 `peerDependencies` 与 `devDependencies`。`solid-js` 同理保留在 peer 与 dev 中。

## 6. 测试与验证

### 6.1 自动化

- `tests/usage.test.ts`：删除 `order` 相关断言与用例，其余保持；`parseOptions` 只断言 `style`。
- `tests/tui.test.tsx`：构造 V2 假 context：
  - `options: { style: "compact" }`
  - `theme`：用 `RGBA.fromHex` 构造 `text.base`、`text.muted`、`text.feedback.*`、`background.base`、`background.raised.base`、`border.base`、`text.action.primary.base`
  - `data.on: () => () => {}`
  - `keymap.layer(factory)`：执行一次 factory，收集 `commands`
  - `ui.slot(claim)`：收集 claim，返回 unsubscribe
  - `ui.toast.show`：记录消息
  - 其余字段用最小替身或 `as never`
- 测试步骤：
  1. `await plugin.setup(ctx)`，等待首次刷新完成。
  2. 断言 claim 使用 `append: "sidebar.content"`。
  3. `testRender` 渲染 claim，断言包含 `滚动`。
  4. 调用 `/go-usage-ledger` 命令的 `run`，重新渲染，断言包含 `5 小时滚动窗口`。
  5. 断言 toast 收到切换消息。
  6. 执行 cleanup，断言取消订阅与定时器不抛错。

### 6.2 命令

```bash
bun install
bun test
bunx tsc --noEmit
```

### 6.3 手工验证（本机 OpenCode 2.1.2）

1. `opencode` 启动，侧栏底部出现 `OpenCode Go` 小节。
2. 分别把 `cli.json` 的 `style` 设为三种值，重启后布局正确。
3. 依次执行三个 slash 命令，当前会话布局切换且 toast 出现。
4. 切换深色/浅色主题，颜色跟随。
5. 断开网络或改错密钥，确认 `!` 与整节隐藏两种错误态。
6. 打开 V2 的 Plugins 对话框，确认 `opencode-go-usage` 状态为 active，无加载错误。

## 7. 文档更新

| 文件 | 改动 |
|---|---|
| `README.md` / `README.en.md` | 安装改用 `cli.json`；删除 `order`；新增版本兼容性表；更新已知限制 |
| `docs/安装指南_20260916.md` | 三步安装流程改为 V2；`tui.json` → `cli.json` |
| `docs/排障指南_20260916.md` | 改为 V2 加载路径、Plugins 对话框、日志位置；删除 order 排障 |
| `docs/OpenCodeGo样式切换指南_20260917.md` | 配置示例改 `cli.json`；主题 token 更新；删除 order |
| `docs/配置与行为契约_20260916.md` | options 只保留 `style`；槽位、主题、生命周期改为 V2 契约 |
| `docs/OpenCodeGo额度侧栏_手工验证清单_20260916.md` | 改为 V2 验证项，新增 tag/兼容性检查 |
| `docs/superpowers/specs/OpenCodeGo额度侧栏_20260916.md` | 顶部加“历史文档，仅描述 v0.1.0 / OpenCode V1” |

README 兼容性表：

| 版本 | OpenCode | 说明 |
|---|---|---|
| `v0.1.0`（tag） | 1.x（≥1.18.30） | 仅支持 V1 TUI 插件 API，已冻结 |
| `v0.2.x`（main） | 2.x（≥2.1.2） | 使用 V2 `@opencode/plugin/tui` API |

## 8. 风险

| 风险 | 应对 |
|---|---|
| V2 主题对象是否随主题切换响应式 | 启动后实际切换深/浅主题验证；若宿主不重渲染，在 README 如实记录 |
| `@opentui/solid` 0.6.6 的 `testRender` 签名与 0.5.x 不同 | 以安装后的类型定义为准调整测试 |
| V2 后续版本调整 CLI 插件 API | `engines.opencode` 下限锁 `2.1.2`，README 记录验证版本 |
| 侧栏位置变化影响用户预期 | 文档明确说明 V2 只能追加；`order` 已删除 |
| 旧 `cli.json` 仍指向 V1 写法 | 迁移后首次启动即可暴露；文档给出正确的 V2 写法 |

## 9. 交付顺序

1. 在 `57f4cb4` 创建 `v0.1.0` tag（已完成）。
2. 提交本设计文档。
3. 改写 `tui.tsx`、`usage.ts`、`package.json`。
4. 更新测试并跑通 `bun test` / `bunx tsc --noEmit`。
5. 更新 README 与 5 份文档。
6. 启动 OpenCode 2.1.2 做手工验证。
7. 提交迁移改动（不 push，不打新 tag）。
