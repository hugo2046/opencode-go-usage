# OpenCode Go 额度侧栏 — 设计规格

**日期：** 2026-09-16
**目标：** 一个 opencode TUI 插件，在侧栏 `sidebar_content` 区域（Context / MCP / LSP 之下）纵向展示 OpenCode Go 套餐的 5 小时 / 每周 / 每月三档额度，含进度条与重置倒计时。

## 1. 背景与调研结论

参考实现 `CangShui/dsh-plugin-collection/dsh-opencode-go-usage` 是 DSH Web GUI 的 Cordis 插件（host 轮询 + 浏览器拉快照），与 opencode 本体无关。从它身上唯一需要继承的是**数据源**。

### 1.1 数据源（已实测）

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OpenCode Go API Key>
Accept: application/json
```

实测响应（2026-09-16 15:53 CST）：

```json
{"usage":{
  "rolling": {"status":"ok","percent":8, "resetsAt":"2026-09-16T08:22:31.724Z"},
  "weekly":  {"status":"ok","percent":53,"resetsAt":"2026-09-21T00:00:00.724Z"},
  "monthly": {"status":"ok","percent":26,"resetsAt":"2026-10-14T07:37:52.724Z"}
}}
```

- `rolling` = 5 小时滚动窗口，`weekly` = 自然周，`monthly` = 计费月。
- 三个 `resetsAt` 的毫秒部分相同，说明服务端由同一个 `now` 加不同偏移算出，可当单次快照处理。
- `status` 取值 `"ok"` 或 `"rate-limited"`（该窗口已打满）。
- 无 Go 套餐时返回 `error.type === "EntitlementError"`（message: `OpenCode Go subscription required.`）。

### 1.2 已知限制：percent 只有整数精度

14 分钟内两次调用分别返回 8/53/26 与 10/54/27，`percent` 始终为整数。opencode 官方 web dashboard 同一时刻显示 8.1% / 53.4% / 26.7%，是同源数据的未取整版本。本端点返回的是向下取整值。

**结论：** TUI 只显示整数百分比。不追求小数位，不为此探测其他未公开端点。

端点也不返回 token 数或金额绝对值，因此 UI 上限就是"整数百分比 + 重置时间"。

### 1.3 opencode TUI 插件机制（已实测）

opencode 1.18.30 提供未写入官网文档的 TUI 插件 API，类型定义在 `@opencode-ai/plugin/dist/tui.d.ts`，slot 名已编译进 homebrew 二进制（`strings` 验证）。

| 事实 | 值 |
|---|---|
| 注册文件 | `~/.config/opencode/tui.json`（全局）或 `<project>/.opencode/tui.json`，schema `https://opencode.ai/tui.json` |
| 模块形状 | `export default { id, tui }`，`tui: (api, options, meta) => Promise<void>`；导出 `server` 会被拒 |
| JSX | `/** @jsxImportSource @opentui/solid */`，二进制自带 solid JSX 变换与 opentui 运行时 |
| 目标 slot | `sidebar_content`，props `{ session_id }`，**默认叠加模式**（可与其他插件共存） |
| 备选 slot | `sidebar_footer` 是 `single_winner` 模式，多插件时只有一个会渲染 — **不采用** |
| 主题 | `ctx.theme.current` 提供 `success` / `warning` / `error` / `textMuted` 等 RGBA |
| 刷新事件 | `api.event.on("session.idle", ...)`，助手回复结束时触发 |
| state 目录 | `api.state.path.state`（**注意**：这是 XDG state 目录，`auth.json` 不在这里，见 §3） |
| 清理 | `api.lifecycle.onDispose(fn)` |

`opencode.jsonc` 的 `plugin` 数组只加载 server 端插件，TUI 插件放进去无效。

## 2. UI 规格

节标题 `OpenCode Go`，下接三个窗口，每个窗口纵向占 3 行：

```
OpenCode Go
5 小时用量             8%
██░░░░░░░░░░░░░░░░░░
重置于 31 分钟
每周用量              53%
███████████░░░░░░░░░
重置于 4 天 16 小时
每月用量              27%
█████░░░░░░░░░░░░░░░
重置于 27 天 23 小时
```

- 中文标签：`5 小时用量` / `每周用量` / `每月用量`。
- 进度条固定 20 格，`█` 已用、`░` 剩余，格数 = `round(percent / 100 * 20)`。
- 百分比右对齐 4 字符宽（容纳 `100%`）；窗口 `status === "rate-limited"` 时显示 `已达上限`。
- 倒计时格式：`≥1 天` → `N 天 M 小时`；`≥1 小时` → `N 小时 M 分钟`；否则 `M 分钟`；已过期 → `即将重置`。
- 条子色调：`rate-limited` 或 `percent ≥ 90` → `theme.error`；`≥ 70` → `theme.warning`；否则 `theme.success`。标签、百分比、倒计时用 `theme.textMuted`，与现有 `Context` / `MCP` / `LSP` 小节同构。
- 倒计时文本每 60 秒重算一次（不发网络请求）。

## 3. 密钥来源

优先级：环境变量 `OPENCODE_GO_API_KEY` → `<stateDir>/auth.json` 的 `opencode-go.key`。

`auth.json` 在 opencode 的 **data** 目录（`XDG_DATA_HOME`/`~/.local/share` 下的 `opencode`，Windows 为 `LOCALAPPDATA/opencode`），**不是** `api.state.path.state` 指向的 state 目录（`~/.local/state/opencode`，里面是 kv.json / locks / model.json）。这两个是 XDG 规范里不同的位置。

因此 `resolveKey` 接受候选目录列表，按顺序取第一个能读到 `opencode-go.key` 的：先 data 目录，再 `api.state.path.state`（次选，防某些安装两者一致或宿主日后改动）。

> 修正记录：初版写成 `api.state.path.state || defaultStateDir()`，误把两者当同一目录。由于前者永远非空，回退永不触发，密钥永远找不到，整节永不渲染。真机探针（读 `api.state.path` 实际值）才暴露出来。

密钥在每次刷新时惰性解析，因此会话中途新增密钥也能被拾取。插件不复制、不打印、不落盘任何密钥副本。

## 4. 刷新策略

```
启动 ────────────────┐
session.idle 事件 ───┼──> 节流(≥20s) ──> fetchUsage ──> signal ──> 重渲染
5 分钟兜底 interval ─┘
```

- 事件驱动为主：额度只在助手回复消耗配额后才变化，`session.idle` 是最准的触发点。
- 20 秒节流下限：子 agent 场景下 `session.idle` 可能密集触发，防止刷爆未公开端点。
- 5 分钟兜底 interval（`force = true`，绕过节流），覆盖"别处消耗了额度"的情况。
- 同一时刻只允许一个请求在飞（`inflight` 标志）。
- 单次请求 15 秒 `AbortController` 超时。

## 5. 失败策略

| 情况 | 行为 |
|---|---|
| 无密钥 | 整节不渲染（返回 `null`），不占行、不报错 |
| `EntitlementError`（无 Go 套餐） | 标记 `dead`，整节不渲染，不再重试 |
| HTTP 401 / 403 | 标记 `dead`，整节不渲染，不再重试 |
| 网络错误 / 超时 / 5xx / 响应格式异常 | **保留上次快照**，标题变为 `OpenCode Go !`；下次触发再试 |

额度是慢变量，显示 5 分钟前的值远好于闪成空白。

## 6. 文件结构

```
opencode-go-usage/
├── package.json          # type:module, exports {"./tui":"./tui.tsx"}
├── tsconfig.json         # 仅供编辑器类型检查
├── usage.ts              # 纯逻辑：类型 / 密钥解析 / 取数 / 格式化（无 JSX、无 TUI 依赖）
├── tui.tsx               # TUI 粘合：signal / 事件 / 节流 / slot 注册 / 渲染
├── tests/usage.test.ts   # bun test，只测 usage.ts
└── README.md
```

逻辑与渲染分成两个文件，是为了让测试只导入 `usage.ts` — 不触发 JSX 运行时、不起 TUI、不打真实网络。

`usage.ts` 导出 `toneOf` 返回色调名 `"ok" | "warn" | "danger"` 而非 RGBA，保持纯函数；`tui.tsx` 负责把色调名映射到主题色。

## 7. 技术栈

| 依赖 | 版本 | 用途 |
|---|---|---|
| bun | 1.3.14（本机） | 运行时与测试框架 |
| `@opencode-ai/plugin` | 1.18.30（对齐本机 opencode） | `TuiPlugin` / `TuiPluginModule` 类型 |
| `@opentui/core` | 0.5.11 | JSX 元素类型（peer 要求 `>=0.4.5`） |
| `@opentui/solid` | 0.5.11 | JSX 运行时 |
| `solid-js` | 1.9.15 | `createSignal` / `Show` / `For` |

## 8. 测试策略

`bun test`，只测 `usage.ts` 的纯函数，不打真实网络（注入 `fetch` 实现）、不读真实 auth.json（用临时目录）：

- `resolveKey`：环境变量优先 / 从 auth.json 读取 / 缺 provider / 文件不存在 / JSON 损坏
- `defaultStateDir`：`XDG_DATA_HOME` 生效
- `fetchUsage`：正常 / `EntitlementError` → dead / 401 → dead / 500 → soft-error / fetch 抛错 → soft-error / `usage` 字段缺失 → soft-error / 请求 URL 与 Authorization 头正确
- `formatBar`：0 / 8 / 53 / 100 的格数，以及任意输入下总宽度不变
- `toneOf`：阈值边界 69 / 70 / 89 / 90 与 `rate-limited` 覆盖
- `formatPercent`：右对齐宽度、`rate-limited` 显示
- `formatCountdown`：分钟档 / 小时档 / 天档 / 已过期 / 非法时间串

`tui.tsx` 无单测，靠手工验证：注册进 `tui.json`，重启 opencode，肉眼核对侧栏。

## 9. 安装

```jsonc
// ~/.config/opencode/tui.json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/Users/hugo/workspace/opencode-go-usage/tui.tsx"]
}
```

重启 opencode 生效。不要加到 `opencode.jsonc`。

## 10. 明确不做（YAGNI）

- 不显示 token / 金额绝对值 —— 端点不提供。
- 不做小数百分比 —— 端点只给整数。
- 不做"显示详情"展开 —— 端点没有更细数据可展开。
- 不做配置项（baseUrl / 刷新间隔 / 条宽）—— 单人自用，需要时改常量即可。
- 不做 `sidebar_footer` / `app_bottom` 的额外展示位。
- 不自建密钥存储 —— 复用 opencode 的 auth.json。
