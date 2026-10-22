# OpenCode V2 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 把 `opencode-go-usage` 从 OpenCode V1 TUI 插件 API 迁移到 OpenCode V2 CLI 插件 API，保留额度取数、刷新与三种样式，删除 V2 不支持的 `order`。

**Architecture:** `usage.ts` 保持纯逻辑数据层；`tui.tsx` 改为 `@opencode/plugin/tui` 的 `Plugin.define({ id, setup })`，用 `ctx.ui.slot({ append: "sidebar.content" })` 注册侧栏、`ctx.keymap.layer` 注册样式命令、`ctx.data.on("session.idle")` 驱动刷新，cleanup 负责取消订阅与定时器。当前 V1 状态已冻结在 tag `v0.1.0`。

**Tech Stack:** Bun 1.3.14、TypeScript、SolidJS、`@opencode/plugin@2.1.2`、`@opentui/core@0.6.6`、`@opentui/solid@0.6.6`。

---

## 实施前状态

- V1 tag：`v0.1.0`，指向 `57f4cb4`，注释已写明仅支持 OpenCode V1。
- 设计规格：`docs/superpowers/specs/2026-10-22-opencode-v2-migration-design.md`（commit `d4cc49e`）。
- 工作区干净，当前分支 `master`。
- 本机 OpenCode：`2.1.2`；`~/.config/opencode/cli.json` 已把本仓库的 `tui.tsx` 注册为 CLI 插件。

## 文件地图

| 文件 | 责任 | 本次动作 |
|---|---|---|
| `usage.ts` | 密钥、取数、刷新状态机、格式化 | 删除 `order` 解析 |
| `tui.tsx` | V2 CLI 插件入口与侧栏渲染 | 重写入口/主题/槽位/命令 |
| `tests/usage.test.ts` | 数据层单测 | 更新 `parseOptions` 断言 |
| `tests/tui.test.tsx` | TUI 接线测试 | 重写为 V2 假 context |
| `package.json` / `bun.lock` | 依赖与包元数据 | 升级到 V2 依赖，版本 0.2.0 |
| `README.md` / `README.en.md` | 安装、配置、兼容性 | 改为 `cli.json`，加版本兼容表 |
| `docs/安装指南_20260916.md` | 教程 | 改为 V2 三步安装 |
| `docs/排障指南_20260916.md` | 症状索引 | 改为 V2 加载/探针/配置 |
| `docs/OpenCodeGo样式切换指南_20260917.md` | 样式 how-to | 改配置示例与主题 token |
| `docs/配置与行为契约_20260916.md` | 行为契约 | 改槽位、主题、API 表面 |
| `docs/OpenCodeGo额度侧栏_手工验证清单_20260916.md` | 人工验收 | 改 V2 验证项 |
| `docs/superpowers/specs/OpenCodeGo额度侧栏_20260916.md` | 历史 V1 设计 | 顶部加历史标注 |

---

## Task 1: 升级依赖与包元数据

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`（由 `bun install` 生成）

- [x] **Step 1: 把 `package.json` 改成目标状态**

```json
{
  "name": "opencode-go-usage",
  "version": "0.2.0",
  "description": "opencode TUI 插件：在侧栏展示 OpenCode Go 的 5 小时 / 每周 / 每月额度",
  "type": "module",
  "private": true,
  "license": "MIT",
  "exports": {
    "./tui": "./tui.tsx"
  },
  "engines": {
    "opencode": ">=2.1.2"
  },
  "scripts": {
    "test": "bun test"
  },
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

- [x] **Step 2: 安装依赖**

Run:

```bash
bun install
```

Expected: `bun install` 成功，`node_modules/@opencode/plugin` 存在，`node_modules/@opentui/solid` 版本为 `0.6.6`。

- [x] **Step 3: 确认版本**

Run:

```bash
bun pm ls --all | grep -E "@opencode/plugin|@opentui/(core|solid)|@opencode/theme"
```

Expected: 输出包含 `@opencode/plugin@2.1.2`、`@opentui/core@0.6.6`、`@opentui/solid@0.6.6`、`@opencode/theme@2.1.2`。

- [x] **Step 4: 提交**

```bash
git add package.json bun.lock
git commit -m "build: 升级到 OpenCode V2 插件依赖"
```

---

## Task 2: 删除 `order` 配置（TDD）

**Files:**
- Modify: `tests/usage.test.ts:560-610`
- Modify: `usage.ts:530-575`

- [x] **Step 1: 把 `parseOptions` 测试改成只断言 `style`**

用下面的代码替换 `tests/usage.test.ts` 中整个 `describe("parseOptions", ...)` 块：

```ts
describe("parseOptions", () => {
  test("缺省时给出默认值：紧凑样式", () => {
    expect(parseOptions(undefined)).toEqual({ style: "compact" })
    expect(parseOptions(null)).toEqual({ style: "compact" })
    expect(parseOptions({})).toEqual({ style: "compact" })
  })

  test("识别三种样式", () => {
    expect(parseOptions({ style: "compact" }).style).toBe("compact")
    expect(parseOptions({ style: "detailed" }).style).toBe("detailed")
    expect(parseOptions({ style: "ledger" }).style).toBe("ledger")
  })

  test("样式写错时回退到 compact 而不是抛错", () => {
    for (const bad of ["Detailed", "bogus", "", 1, true, null, {}, []]) {
      expect(parseOptions({ style: bad }).style).toBe("compact")
    }
  })

  test("整体不是对象时也不抛错", () => {
    for (const bad of ["compact", 42, true, [], () => {}]) {
      expect(parseOptions(bad)).toEqual({ style: "compact" })
    }
  })

  test("忽略不认识的字段，包括已删除的 order", () => {
    expect(parseOptions({ style: "detailed", order: 600, nope: 1, barWidth: 99 })).toEqual({
      style: "detailed",
    })
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run:

```bash
bun test tests/usage.test.ts
```

Expected: FAIL。`parseOptions` 仍返回 `{ style, order }`，`toEqual({ style: "compact" })` 因多出 `order` 字段而失败。

- [x] **Step 3: 修改 `usage.ts`**

把 `PluginOptions` 定义改成：

```ts
/** 插件配置，全部有默认值。 */
export type PluginOptions = {
  /**
   * 展示样式。
   *
   * - `compact`（默认，样式 B）：一行一档 —— 标签、14 格实心条、百分比、紧凑倒计时
   * - `detailed`（样式 A）：三行一档 —— 标签与百分比一行、20 格实心条一行、完整中文倒计时一行
   * - `ledger`（样式 C）：5 小时窗口主指标 + 周/月次级账本行
   */
  style: StyleName
}
```

删除 `DEFAULT_ORDER` 常量：

```ts
/** `style` 缺省值。 */
const DEFAULT_STYLE: StyleName = "compact"
```

把 `parseOptions` 改成：

```ts
/**
 * 解析 cli.json 里传给插件的 options。
 *
 * 入参来自用户手写的 JSON，所以任何形状都不能让它抛错：整体不是对象、字段
 * 类型不对、样式名拼错，一律回退到默认值并继续渲染，而不是让插件加载失败。
 *
 * @param raw cli.json 中插件项的 options 对象
 * @returns 补全后的配置
 */
export function parseOptions(raw: unknown): PluginOptions {
  const source =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const style = source.style
  return {
    style:
      typeof style === "string" && (STYLE_NAMES as readonly string[]).includes(style)
        ? (style as StyleName)
        : DEFAULT_STYLE,
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run:

```bash
bun test tests/usage.test.ts
```

Expected: PASS，`0 fail`。

- [x] **Step 5: 提交**

```bash
git add usage.ts tests/usage.test.ts
git commit -m "refactor: 删除 V2 不支持的 order 配置"
```

---

## Task 3: 重写 TUI 测试为 V2（先失败）

**Files:**
- Modify: `tests/tui.test.tsx`（整文件替换）

- [x] **Step 1: 用 V2 假 context 重写测试**

把 `tests/tui.test.tsx` 替换为：

```tsx
import { afterEach, describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { JSX } from "@opentui/solid"

const originalFetch = globalThis.fetch
const originalApiKey = process.env.OPENCODE_GO_API_KEY
const renderers: Array<{ destroy: () => void }> = []

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy()
  globalThis.fetch = originalFetch
  if (originalApiKey === undefined) delete process.env.OPENCODE_GO_API_KEY
  else process.env.OPENCODE_GO_API_KEY = originalApiKey
})

function usageResponse() {
  return new Response(
    JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 14, resetsAt: "2099-01-01T00:00:00.000Z" },
        weekly: { status: "ok", percent: 23, resetsAt: "2099-01-02T00:00:00.000Z" },
        monthly: { status: "ok", percent: 42, resetsAt: "2099-02-01T00:00:00.000Z" },
      },
    }),
    { status: 200 },
  )
}

function color(hex: string) {
  return RGBA.fromHex(hex)
}

function fakeTheme() {
  return {
    text: {
      base: color("#eeeeee"),
      muted: color("#999999"),
      feedback: {
        error: { base: color("#ff5555") },
        warning: { base: color("#ffaa00") },
        success: { base: color("#66dd88") },
        info: { base: color("#66aaff") },
      },
      action: {
        primary: { base: color("#66dd88") },
      },
    },
    background: {
      base: color("#111111"),
      raised: { base: color("#1b1b1b") },
    },
    border: { base: color("#333333") },
  }
}

type Claim = {
  append?: string
  render: (input: { sessionID: string }) => JSX.Element
}

type Command = {
  id?: string
  slash?: { name: string }
  run: () => void
}

describe("V2 TUI 接线", () => {
  test("注册 sidebar.content、三个样式命令，并能在命令后切换布局", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"
    globalThis.fetch = async () => usageResponse()

    const { default: plugin } = await import("../tui.tsx")
    const claims: Claim[] = []
    const commands: Command[] = []
    const toasts: Array<{ message: string; variant?: string }> = []
    let offIdleCalls = 0

    const ctx = {
      options: { style: "compact" },
      theme: fakeTheme(),
      data: {
        on: (_type: string, _handler: () => void) => {
          return () => {
            offIdleCalls++
          }
        },
      },
      keymap: {
        layer: (factory: () => { commands?: readonly Command[] }) => {
          const layer = factory()
          commands.push(...(layer.commands ?? []))
        },
      },
      ui: {
        slot: (claim: Claim) => {
          claims.push(claim)
          return () => {}
        },
        toast: {
          show: (options: { message: string; variant?: string }) => {
            toasts.push(options)
          },
        },
      },
    }

    const cleanup = await plugin.setup(ctx as never)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(claims).toHaveLength(1)
    expect(claims[0]!.append).toBe("sidebar.content")
    expect(commands.map((command) => command.slash?.name)).toEqual([
      "go-usage-compact",
      "go-usage-detailed",
      "go-usage-ledger",
    ])

    const first = await testRender(() => claims[0]!.render({ sessionID: "ses_test" }), {
      width: 42,
      height: 30,
    })
    renderers.push(first.renderer)
    await first.waitForFrame((frame) => frame.includes("滚动"), { maxPasses: 20 })

    commands.find((command) => command.slash?.name === "go-usage-ledger")!.run()
    expect(toasts.at(-1)).toEqual({
      variant: "success",
      message: "OpenCode Go：已切换到 ledger 样式",
    })

    const switched = await testRender(() => claims[0]!.render({ sessionID: "ses_test" }), {
      width: 42,
      height: 30,
    })
    renderers.push(switched.renderer)
    await switched.waitForFrame((frame) => frame.includes("5 小时滚动窗口"), {
      maxPasses: 20,
    })
    expect(switched.captureCharFrame()).toContain("5 小时滚动窗口")

    await cleanup?.()
    expect(offIdleCalls).toBe(1)
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run:

```bash
bun test tests/tui.test.tsx
```

Expected: FAIL。旧 `tui.tsx` 仍导入已删除的 `@opencode-ai/plugin/tui`，错误信息通常是 `Cannot find module "@opencode-ai/plugin/tui"`；如果依赖仍能解析，则会进一步报 `plugin.setup is not a function`（旧入口只有 `plugin.tui`）。两种都说明测试尚未满足 V2 入口。

---

## Task 4: 重写 `tui.tsx` 为 V2 插件

**Files:**
- Modify: `tui.tsx`（整文件）

- [x] **Step 1: 替换导入**

把文件顶部的类型导入：

```tsx
import type { TuiPlugin, TuiPluginModule, TuiTheme } from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import { Show, createSignal } from "solid-js"
```

替换为：

```tsx
import { Plugin } from "@opencode/plugin/tui"
import type { ResolvedTheme } from "@opencode/theme/tui"
import type { JSX } from "@opentui/solid"
import { Show, createSignal } from "solid-js"
```

- [x] **Step 2: 替换主题辅助函数**

把 `toneColor` 与 `trackColor` 替换为：

```tsx
/**
 * 把色调名映射到当前主题色。
 *
 * @param theme V2 解析后的主题 token
 * @param tone 色调名
 * @returns 对应的 RGBA
 */
function toneColor(theme: ResolvedTheme, tone: Tone) {
  if (tone === "danger") return theme.text.feedback.error.base
  if (tone === "warn") return theme.text.feedback.warning.base
  return theme.text.feedback.success.base
}

/**
 * 进度条轨道（未用部分）的颜色。
 *
 * 优先用主题的 `border`：它的语义就是「在背景上可见的边框色」，任何主题都得
 * 保证这一点，所以深色浅色都能跟随，不需要按 themeMode 分叉。但个别主题
 * 可能把它设得和背景几乎一样，所以再做一次运行时亮度差检查，不合格就回退到
 * textMuted。
 *
 * @param theme V2 解析后的主题 token
 * @returns 轨道色
 */
function trackColor(theme: ResolvedTheme) {
  return pickTrackColor({
    border: theme.border.base,
    background: theme.background.base,
    textMuted: theme.text.muted,
  })
}
```

- [x] **Step 3: 把组件 props 的主题类型改为 `ResolvedTheme`**

对以下组件，把 `theme: TuiTheme` 改成 `theme: ResolvedTheme`：

- `Bar`
- `CompactRow`
- `DetailedRow`
- `LedgerPrimaryRow`
- `LedgerSecondaryRow`
- `UsageSection`

- [x] **Step 4: 替换组件里的主题 token**

在 `Bar`、`CompactRow`、`DetailedRow`、`LedgerPrimaryRow`、`LedgerSecondaryRow`、`UsageSection` 中做以下替换。**先替换 `textMuted`，再替换 `text`**——前者是后者的前缀，顺序反了会把 `textMuted` 改成 `text.baseMuted`：

| 旧 | 新 |
|---|---|
| `props.theme.current.textMuted` | `props.theme.text.muted` |
| `props.theme.current.text` | `props.theme.text.base` |
| `props.theme.current.backgroundPanel` | `props.theme.background.raised.base` |
| `props.theme.current.borderActive` | `props.theme.text.action.primary.base` |

`UsageSection` 里 `toneColor(props.theme, ...)` 与 `trackColor(props.theme)` 不变。

- [x] **Step 5: 用 V2 入口替换文件末尾的 `tui` 函数与默认导出**

删除从 `const tui: TuiPlugin = async (api, options) => {` 到文件末尾的全部内容，替换为：

```tsx
export default Plugin.define({
  id: "opencode-go-usage",
  setup(ctx) {
    // cli.json 里以对象形式传入的 options，见 parseOptions 的容错说明。
    // 启动时解析一次；配置不热更新，改完要重启 opencode。
    const opts = parseOptions(ctx.options)

    // 配置决定启动样式；slash command 只覆盖当前 TUI 会话，不改额度请求状态。
    const [style, setStyle] = createSignal<StyleName>(opts.style)
    const [usage, setUsage] = createSignal<Usage | null>(null)
    const [stale, setStale] = createSignal(false)
    const [now, setNow] = createSignal(Date.now())

    // 节流 / 单飞 / dead 闩锁这套状态机是纯逻辑，提取到 usage.ts 的 createRefresher
    // 里做了单测；这里只负责把 solid 的 setter 和真实的 resolveKey / fetchUsage /
    // Date.now 接进去。
    const { refresh } = createRefresher({
      // 惰性解析密钥：会话中途新增密钥也能被拾取。
      // V2 没有 api.state.path.state；auth.json 固定在 data 目录，
      // 与 defaultStateDir() 一致。
      resolveKey: () => resolveKey(defaultStateDir()),
      fetchUsage: (key) => fetchUsage(key, DEFAULT_BASE_URL),
      now: () => Date.now(),
      onUsage: (next) => {
        setUsage(next)
        setStale(false)
      },
      onDead: () => setUsage(null),
      onStale: (value) => setStale(value),
    })

    const offIdle = ctx.data.on("session.idle", () => void refresh(false))
    const fallback = setInterval(() => void refresh(true), FALLBACK_MS)
    const tick = setInterval(() => setNow(Date.now()), TICK_MS)

    // V2 用 keymap.layer 注册命令。命令是增强能力，注册失败不应影响侧栏。
    try {
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: STYLE_COMMANDS.map((command) => ({
          id: command.name,
          title: command.title,
          description: command.description,
          group: "OpenCode Go",
          palette: true as const,
          slash: { name: command.slashName },
          run: () => {
            setStyle(command.style)
            ctx.ui.toast.show({
              variant: "success" as const,
              message: "OpenCode Go：已切换到 " + command.style + " 样式",
            })
          },
        })),
      }))
    } catch {
      // keymap 是宿主增强 API；注册失败时保留静态配置样式和侧栏。
    }

    ctx.ui.slot({
      // V2 的 sidebar.content 没有 order，只能追加到内置小节之后。
      append: "sidebar.content",
      render: () => (
        <Show when={usage()}>
          {(data) => (
            <UsageSection
              theme={ctx.theme}
              data={data}
              style={style}
              stale={stale}
              now={now}
            />
          )}
        </Show>
      ),
    })

    void refresh(true)

    return () => {
      offIdle()
      clearInterval(fallback)
      clearInterval(tick)
    }
  },
})
```

- [x] **Step 6: 跑 TUI 测试确认通过**

Run:

```bash
bun test tests/tui.test.tsx
```

Expected: PASS，`1 pass`。

- [x] **Step 7: 跑全量测试与类型检查**

Run:

```bash
bun test
bunx tsc --noEmit
```

Expected: 全部测试 PASS，`tsc` 无输出、退出码 0。

- [x] **Step 8: 提交**

```bash
git add tui.tsx tests/tui.test.tsx
git commit -m "feat: 迁移 TUI 插件到 OpenCode V2 API"
```

---

## Task 5: 更新 README（中英文）

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`

- [x] **Step 1: 在 `README.md` 开头加版本兼容性表**

在标题与第一段之后插入：

```markdown
## 版本与兼容性

| 版本 | OpenCode | 说明 |
|---|---|---|
| `v0.1.0`（tag） | 1.x（≥1.18.30） | 仅支持 OpenCode V1 的 TUI 插件 API，已冻结；安装方式见该 tag 内的 README |
| `v0.2.x`（main） | 2.x（≥2.1.2） | 使用 OpenCode V2 的 `@opencode/plugin/tui` API，本文档描述此版本 |

OpenCode V2 不读取 V1 的 `tui.json` 插件入口，V1 也不读取 V2 的 `cli.json`。升级 OpenCode 前先确认插件版本。
```

- [x] **Step 2: 替换 `README.md` 的快速开始**

把“快速开始”整节替换为：

```markdown
## 快速开始

**前提**：OpenCode ≥ 2.1.2、[bun](https://bun.sh)，以及一个有效的 OpenCode Go 订阅（用 `opencode auth login` 登录过）。

**1. 克隆并安装依赖**

```bash
git clone https://github.com/hugo2046/opencode-go-usage.git
cd opencode-go-usage
bun install
echo "$PWD"   # 记下这个仓库目录的绝对路径，下一步要用
```

**2. 注册插件**

编辑 `~/.config/opencode/cli.json`（OpenCode V2 的终端客户端全局配置，没有项目级等价文件）：

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["<上一步打印的绝对路径>"]
}
```

如果已经有 `cli.json`，把路径追加到 `plugins` 数组，保留你原有的 `theme`、`session` 和其他插件。

> `plugins` 里必须是**插件目录**的绝对路径（仓库根目录），不能直接写 `tui.tsx` 文件；V2 会读取该目录的 `package.json`，通过 `exports["./tui"]` 找到入口。写成文件路径时日志会报 `configured plugin path must be a directory`。

**3. 重启 opencode**

侧栏底部会出现 `OpenCode Go` 小节。V2 的 `sidebar.content` 只能追加，无法插到内置小节之间。

**没看到？** 插件在没有密钥、没有订阅、密钥失效、没被加载这四种情况下都会整节不显示，而且不报错。[排障指南](docs/排障指南_20260916.md#先跑这一条数据层诊断)里有一条命令，能直接查出是哪一种。
```

- [x] **Step 3: 替换 `README.md` 的配置节**

把“配置”节替换为：

```markdown
## 配置

把 `cli.json` 里的插件项从字符串改成对象：

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "<仓库绝对路径>",
      "options": { "style": "ledger" }
    }
  ]
}
```

| 字段 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `style` | `"compact"` \| `"detailed"` \| `"ledger"` | `"compact"` | 启动时使用的样式 |

改完要**重启 opencode**，`cli.json` 只在客户端启动时读取。值写错不会报错，会悄悄回退到默认值。

V2 删除了 V1 的 `order` 选项：`sidebar.content` 没有排序能力，额度小节固定追加在内置小节之后。
```

- [x] **Step 4: 更新 `README.md` 的已知限制与开发节**

把“只在 opencode 1.18.30 和 1.18.31 上验证过”那条改成：

```markdown
- **仅在 OpenCode 2.1.2 上验证过**：V2 的 CLI 插件 API 仍可能随版本调整；升级 OpenCode 后请重新验证侧栏与命令。
```

把“侧栏位置依赖 opencode 内置小节的排序值”那条改成：

```markdown
- **侧栏位置固定在内置小节之后**：V2 的 `sidebar.content` 只支持 append/prepend，不能插到 `LSP` 与 `Todo` 之间。
```

把开发节的“`@opencode-ai/plugin`”相关描述改为：

```markdown
`tui.tsx` 使用 `@opencode/plugin/tui` 的 `Plugin.define({ id, setup })`；`@opentui/*` 与 `solid-js` 由 OpenCode 运行时提供，本地安装只用于类型检查和测试。
```

- [x] **Step 5: 同步更新 `README.en.md`**

按同样结构更新英文版：

- 加 `## Version compatibility` 表，内容与中文表一致。
- Quick start 改为 `~/.config/opencode/cli.json` 的 `plugins` 数组。
- Configuration 改为对象形式，只保留 `style`，删除 `order`。
- Known limitations 改为 “verified on OpenCode 2.1.2” 与 “V2 can only append to sidebar content”。

- [x] **Step 6: 检查旧引用**

Run:

```bash
grep -n "tui\.json\|1\.18\.3\|order" README.md README.en.md
```

Expected: 无输出（版本兼容表里的 `v0.1.0` 与 `1.x` 除外；如果命中，确认是历史兼容说明而不是安装指令）。

- [x] **Step 7: 提交**

```bash
git add README.md README.en.md
git commit -m "docs: README 改为 OpenCode V2 安装与兼容性说明"
```

---

## Task 6: 更新中文文档

**Files:**
- Modify: `docs/安装指南_20260916.md`
- Modify: `docs/排障指南_20260916.md`
- Modify: `docs/OpenCodeGo样式切换指南_20260917.md`
- Modify: `docs/配置与行为契约_20260916.md`
- Modify: `docs/OpenCodeGo额度侧栏_手工验证清单_20260916.md`
- Modify: `docs/superpowers/specs/OpenCodeGo额度侧栏_20260916.md`

- [x] **Step 1: 安装指南改为 V2**

`docs/安装指南_20260916.md`：

- 开头“紧跟在 `Context` / `MCP` / `LSP` 下面”改为“在侧栏内置小节之后”。
- “需要什么”表：opencode 要求改为 `≥ 2.1.2`，说明改为“V2 CLI 插件 API，在 2.1.2 上验证”。
- Step 2 整节替换为：

```markdown
## Step 2: 注册插件

V2 的 CLI 插件注册在 `~/.config/opencode/cli.json`。**不是** `opencode.json`——后者加载 server 端插件；CLI 插件要在 `cli.json` 的 `plugins` 数组里。

下面这条命令会创建该文件，或者在它已存在时把本插件**追加**进去（保留你原有的 `theme`、`session` 和其他插件），重复跑也不会写重复项：

```bash
CLI_JSON="$HOME/.config/opencode/cli.json" REPO="$REPO" python3 -c '
import json, os, pathlib
p = pathlib.Path(os.environ["CLI_JSON"]); repo = os.environ["REPO"]
entry = repo
p.parent.mkdir(parents=True, exist_ok=True)
cfg = json.loads(p.read_text()) if p.exists() else {"$schema": "https://opencode.ai/v2/cli.json"}
plugins = cfg.setdefault("plugins", [])
if entry not in plugins: plugins.append(entry)
p.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
print("已写入:", p)
'
```

全新安装时应该是：

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/Users/你/workspace/opencode-go-usage"]
}
```

想设置默认样式，把那一项从字符串改成对象：

```jsonc
"plugins": [
  {
    "package": "/绝对路径/opencode-go-usage",
    "options": { "style": "detailed" }
  }
]
```

V2 没有 `order` 选项；额度小节固定追加在内置小节之后。
```

- Step 3 的“`tui.json` 只在启动时读取”改为“`cli.json` 只在客户端启动时读取”；“`Context` / `MCP` / `LSP` 下面”改为“侧栏内置小节之后”。
- 数据层诊断命令不变（`usage.ts` 的 API 没变）。
- “下一步”里删除 `order` 链接，改为“V2 侧栏位置固定，见配置与行为契约 §5”。
- “卸载”改为从 `~/.config/opencode/cli.json` 的 `plugins` 数组里删除本插件项。

- [x] **Step 2: 排障指南改为 V2**

`docs/排障指南_20260916.md`：

- §1.1 的注册文件检查改为：

```bash
cat ~/.config/opencode/cli.json
```

期望：

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/绝对路径/opencode-go-usage"]
}
```

- 三个典型错误改为：
  - 文件不存在 → 按安装指南创建 `cli.json`。
  - 写进了 `opencode.json` → `opencode.json` 只加载 server 端插件；CLI 插件放进 `cli.json` 的 `plugins`。
  - 路径指向 `tui.tsx` 文件 → 日志报 `configured plugin path must be a directory`；V2 的 `plugins` 必须是**插件目录**（仓库根目录）。
  - 路径相对或写错 → `plugins` 里必须是插件目录的绝对路径。
- 版本检查改为 `opencode --version` 需要 `2.1.2` 或更高；V2 CLI 插件 API 在 2.1.2 上验证。
- 探针插件整段替换为 V2 版本：

```tsx
/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { appendFileSync } from "node:fs"

const log = (m: string) => {
  try { appendFileSync("/tmp/ocgo-probe.log", `${new Date().toISOString()} ${m}\n`) } catch {}
}

export default Plugin.define({
  id: "ocgo-probe",
  setup(ctx) {
    log("setup() called")
    log(`app.version = ${ctx.app.version}`)
    try {
      const unregister = ctx.ui.slot({ append: "sidebar.content", render: () => null })
      log(`ui.slot returned: ${typeof unregister}`)
    } catch (e) {
      log(`ui.slot THREW: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
})
```

临时加进 `cli.json` 的 `plugins` 数组，重启后看 `/tmp/ocgo-probe.log`；用完恢复备份。

- 删除整个“§2 小节位置不对”的 order 表与调参说明，替换为：

```markdown
## 2. 小节位置

V2 的 `sidebar.content` 只支持 `append` / `prepend`，没有 `order`。本插件使用 `append`，固定出现在内置小节之后。这是 V2 插槽模型的限制，不能通过配置改变。
```

- §7.1 配置示例改为 `cli.json` 对象形式，删除 `order` 行；症状表删除“位置没变”一行，改为“插件整个消失 → 检查对象形式是否写成 `{ "package": "...", "options": {...} }`”。
- §8 的“依赖装了但运行时报找不到模块”改为说明 V2 由 OpenCode 解析 `@opencode/plugin/tui` 与 `@opentui/*`；本地依赖只给类型检查和测试。
- “完全卸载”改为从 `cli.json` 的 `plugins` 数组删除本插件项。

- [x] **Step 3: 样式切换指南改为 V2**

`docs/OpenCodeGo样式切换指南_20260917.md`：

- 前置条件：OpenCode ≥ 2.1.2；`cli.json` 只在客户端启动时读取。
- “持久设置默认样式”改为：

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/绝对路径/opencode-go-usage",
      "options": { "style": "ledger" }
    }
  ]
}
```

- 删除“如果当前 plugin 还是字符串形式”与“order 不是样式开关……”两段。
- 命令段落的“重启后仍以 tui.json 的 style 为准”改为 `cli.json`。
- 主题段改为 V2 token：
  - 正常用量：`text.feedback.success.base`。
  - 70% 及以上：`text.feedback.warning.base`。
  - 90% 及以上或 rate-limited：`text.feedback.error.base`。
  - 未用轨道：`border.base`；对比不足时回退 `text.muted`。
  - ledger 主块：`background.raised.base` 与 `text.action.primary.base`。
- 验证步骤第 1 条改为“侧栏内置小节之后出现 OpenCode Go”。

- [x] **Step 4: 配置与行为契约改为 V2**

`docs/配置与行为契约_20260916.md`：

- §2 配置示例改为 `cli.json` 对象形式，字段表只保留 `style`；删除 `order` 行与 `order` 非法回退行；命令段落改为 `cli.json`。
- §3 密钥解析：删除 `api.state.path.state` 候选与相关表格行；说明插件调用点只传 `defaultStateDir()`（`resolveKey` 的多候选能力与对应单测保留）；把“早期版本……”的说明改为“V2 没有 `api.state.path.state`，插件只读 data 目录”。
- §5 整节替换为：

```markdown
## 5. 侧栏槽位契约

插件注册到 V2 的 `sidebar.content` slot：

```tsx
ctx.ui.slot({ append: "sidebar.content", render: ... })
```

V2 的槽位只支持 `prepend` / `append` / `before` / `after` / `replace`，没有 `order`。本插件使用 `append`，固定出现在内置侧栏小节之后。这是 V2 插槽模型的限制，不能通过配置改变。

其他与宿主的契约项：

| 项 | 值 |
|---|---|
| 注册文件 | `~/.config/opencode/cli.json` 的 `plugins` 数组 |
| 模块导出 | `export default Plugin.define({ id, setup })` |
| 插件 id | `opencode-go-usage` |
| JSX 运行时 | 首行 `/** @jsxImportSource @opentui/solid */` |
| slot 渲染器签名 | `(input: { sessionID: string }) => JSX.Element` |
| 事件订阅 | `ctx.data.on("session.idle", handler)` |
| 清理 | `setup` 返回 cleanup 函数 |
```

- §6 主题 token：`theme.current.error/warning/success` 改为 `theme.text.feedback.*.base`；`text` / `textMuted` 改为 `text.base` / `text.muted`；`backgroundPanel` / `borderActive` 改为 `background.raised.base` / `text.action.primary.base`；删除“`theme` 作为 `TuiTheme` 对象往下传，`.current` 在每个 JSX 调用点解引用”这句话，改为“颜色在 JSX 调用点从 `ResolvedTheme` 读取，随宿主主题更新”。
- §7 清理说明改为 `setup` 返回 cleanup。
- §9 `PluginOptions` 改为 `{ style: StyleName }`；`parseOptions` 说明改为“解析 cli.json 传入的 options”。
- §10 测试覆盖：`parseOptions` 从 8 例改为 5 例；总数以 `bun test` 实际输出为准；把“`tui.tsx` 渲染没有单测”改为“`tui.tsx` 用 V2 假 context 测槽位、命令与布局切换”。

- [x] **Step 5: 手工验证清单改为 V2**

`docs/OpenCodeGo额度侧栏_手工验证清单_20260916.md`：

- 开头“79/79”改为“以 `bun test` 实际输出为准”。
- 第 1 项改为：
  - 侧栏出现 `OpenCode Go`；
  - 位置在 `Context` / `MCP` / `LSP` / `Todo` / `Files` 之后（V2 只能 append）；
  - 三个窗口顺序不变；
  - 在 `cli.json` 里切换三种 `style`，重启后布局正确；
  - 删除 order 调参说明。
- 第 6 项主题 token 改为 V2 名称。
- 第 8 项末尾改为“重启后以 `cli.json` 的 `style` 为准”。
- 卸载改为从 `cli.json` 的 `plugins` 数组删除本插件项。

- [x] **Step 6: 给 V1 设计规格加历史标注**

在 `docs/superpowers/specs/OpenCodeGo额度侧栏_20260916.md` 标题下插入：

```markdown
> **历史文档：** 本规格描述 `v0.1.0`（OpenCode V1 TUI 插件 API）。V2 迁移见 [2026-10-22 迁移设计](2026-10-22-opencode-v2-migration-design.md)。
```

- [x] **Step 7: 检查旧引用**

Run:

```bash
grep -rn "tui\.json\|api\.state\.path\.state\|TuiPlugin\|order: 350\|order.*600\|1\.18\.3" docs README.md README.en.md
```

Expected: 只剩历史标注、版本兼容表里的 V1 说明，以及明确写着“V1”的对比文字。安装/配置/排障步骤里不应再有 `tui.json`。

- [x] **Step 8: 提交**

```bash
git add docs
git commit -m "docs: 中文文档迁移到 OpenCode V2"
```

---

## Task 7: 最终验证

**Files:**
- No code changes expected.

- [x] **Step 1: 全量测试**

Run:

```bash
bun test
```

Expected: 所有测试 PASS，`0 fail`。

- [x] **Step 2: 类型检查**

Run:

```bash
bunx tsc --noEmit
```

Expected: 无输出，退出码 0。

- [x] **Step 3: 检查空白错误**

Run:

```bash
git diff --check
```

Expected: 无输出。

- [x] **Step 4: 实际启动 OpenCode V2**

Run（在真实终端里，不要用非交互 shell）：

```bash
opencode
```

检查：

1. 侧栏内置小节之后出现 `OpenCode Go`。
2. 三档额度与倒计时正常显示。
3. 依次执行 `/go-usage-compact`、`/go-usage-detailed`、`/go-usage-ledger`，布局切换且 toast 出现。
4. 切换深色/浅色主题，颜色跟随。
5. 打开 Plugins 对话框，确认 `opencode-go-usage` 状态 active、无错误。

如果侧栏不出现，查看日志：

```bash
grep -i "opencode-go-usage\|tui plugin" ~/.local/share/opencode/log/opencode.log | tail -50
```

- [x] **Step 5: 确认 tag 与工作区状态**

Run:

```bash
git tag -n99 -l v0.1.0
git status --short
git log --oneline -8
```

Expected:

- `v0.1.0` 指向 `57f4cb4`，注释含“仅支持 OpenCode V1”。
- 工作区干净。
- 迁移相关 commit 在 `v0.1.0` 之后。

- [x] **Step 6: 不创建新 tag、不 push**

本计划只要求冻结 V1 tag。`v0.2.0` tag 与远端推送由用户决定。

---

## 完成标准

- `bun test` 全绿，`bunx tsc --noEmit` 干净。
- `tui.tsx` 默认导出 `Plugin.define({ id: "opencode-go-usage", setup })`。
- 侧栏通过 `ctx.ui.slot({ append: "sidebar.content" })` 注册。
- 三个 slash 命令通过 `ctx.keymap.layer` 注册。
- `usage.ts` 的取数、密钥、刷新、格式化行为与 V1 版本一致。
- `order` 从代码、测试、README 与文档中删除。
- README 中英文都有 V1/V2 兼容性表，并明确 `v0.1.0` 仅支持 OpenCode V1。
- `v0.1.0` tag 保留在原 V1 提交上。

## 执行记录（2026-10-22）

- `v0.1.0` 已创建在 `57f4cb4`，注释写明仅支持 OpenCode V1。
- `bun test`：76 pass / 0 fail；`bunx tsc --noEmit` 退出码 0；`git diff --check` 干净。
- 本机 `~/.config/opencode/cli.json` 的插件路径已从 `tui.tsx` 改为仓库目录；V2 要求插件目录，写成文件会报 `configured plugin path must be a directory`。
- OpenCode 2.1.2 的 Plugins 对话框中已能看到 `opencode-go-usage`（TUI / local）。
- 本机 `auth.json` 的 `opencode-go.key` 调真实 usage 端点返回 401，按 `dead` 设计整节隐藏；这不是迁移回归。
- 用本地 mock 端点（`http://127.0.0.1:18765`）做临时端到端验证：compact 和 ledger 布局都正确渲染，`/go-usage-ledger` 命令与 toast 正常，切换主题后侧栏颜色跟随。
- 验证结束后 `usage.ts` 已恢复为 `https://opencode.ai`，mock 进程已停止，`cli.json` 的 theme 恢复为 `ayu`。
