# OpenCode Go 额度侧栏 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个 opencode TUI 插件，在侧栏纵向展示 OpenCode Go 套餐的 5 小时 / 每周 / 每月额度百分比、进度条与重置倒计时。

**Architecture:** 单包两文件。`usage.ts` 是纯逻辑层（密钥解析、上游取数、展示格式化），无 JSX 无 TUI 依赖，全部单测覆盖；`tui.tsx` 是 TUI 粘合层（solid signal、`session.idle` 事件驱动刷新、20 秒节流、`sidebar_content` slot 渲染），靠手工验证。分成两个文件是为了让 `bun test` 只导入 `usage.ts`，不触发 JSX 运行时、不起 TUI、不打真实网络。

**Tech Stack:** bun 1.3.14 + TypeScript；`@opencode-ai/plugin@1.18.30`（类型）；`@opentui/core@0.5.11` / `@opentui/solid@0.5.11`（JSX）；`solid-js@1.9.15`（响应式）。

**Spec:** `docs/superpowers/specs/OpenCodeGo额度侧栏_20260916.md`

## Global Constraints

- 工作目录：`/Users/hugo/workspace/opencode-go-usage`（当前非 git 仓库，Task 1 负责 `git init`）。
- 上游端点固定为 `GET https://opencode.ai/zen/go/v1/usage`，请求头 `authorization: Bearer <key>` 与 `accept: application/json`。
- 上游 `percent` **只有整数精度**。不实现小数百分比，不探测其他未公开端点。
- 上游不返回 token 数或金额绝对值。UI 只呈现"整数百分比 + 进度条 + 重置倒计时"。
- 密钥优先级固定为：环境变量 `OPENCODE_GO_API_KEY` → `<stateDir>/auth.json` 的 `opencode-go.key`。插件不复制、不打印、不落盘任何密钥副本。
- 目标 slot 固定为 `sidebar_content`（默认叠加模式）。**不得**使用 `sidebar_footer`（`single_winner` 模式，多插件时会静默消失）。
- 插件注册文件是 `~/.config/opencode/tui.json`。**不得**写进 `~/.config/opencode/opencode.jsonc`（那里只加载 server 端插件）。
- 模块必须 `export default { id, tui }`，且**不得**同时导出 `server`（会被 loader 拒绝）。
- `tui.tsx` 首行必须是 `/** @jsxImportSource @opentui/solid */`。
- 进度条固定 20 格，字符为 `█`（已用）与 `░`（剩余）。
- 中文标签固定为 `5 小时用量` / `每周用量` / `每月用量`；节标题固定为 `OpenCode Go`。
- 文档注释遵循 Sphinx 风格的参数/返回值说明，关键逻辑加中文注释。
- 每个 commit 结尾附：
  ```
  Co-Authored-By: Hugo <shen.lan123@gmail.com>
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

---

### Task 1: 项目骨架与密钥解析

**Files:**
- Create: `/Users/hugo/workspace/opencode-go-usage/package.json`
- Create: `/Users/hugo/workspace/opencode-go-usage/tsconfig.json`
- Create: `/Users/hugo/workspace/opencode-go-usage/.gitignore`
- Create: `/Users/hugo/workspace/opencode-go-usage/usage.ts`
- Test: `/Users/hugo/workspace/opencode-go-usage/tests/usage.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `export type UsageWindow = { status: string; percent: number; resetsAt: string }`
  - `export type Usage = { rolling: UsageWindow; weekly: UsageWindow; monthly: UsageWindow }`
  - `export const ENV_KEY = "OPENCODE_GO_API_KEY"`
  - `export const AUTH_PROVIDER = "opencode-go"`
  - `export function defaultStateDir(env?: Record<string, string | undefined>, platform?: string, home?: string): string`
  - `export function resolveKey(stateDir: string, env?: Record<string, string | undefined>): string | null`

- [ ] **Step 1: 初始化仓库与依赖清单**

```bash
cd /Users/hugo/workspace/opencode-go-usage
git init
mkdir -p tests
```

写 `package.json`：

```json
{
  "name": "opencode-go-usage",
  "version": "0.1.0",
  "description": "opencode TUI 插件：在侧栏展示 OpenCode Go 的 5 小时 / 每周 / 每月额度",
  "type": "module",
  "private": true,
  "license": "MIT",
  "exports": {
    "./tui": "./tui.tsx"
  },
  "engines": {
    "opencode": ">=1.18.0"
  },
  "scripts": {
    "test": "bun test"
  },
  "dependencies": {
    "@opencode-ai/plugin": "1.18.30",
    "@opentui/core": "0.5.11",
    "@opentui/solid": "0.5.11",
    "solid-js": "1.9.15"
  },
  "devDependencies": {
    "@types/bun": "^1.3.14"
  }
}
```

写 `tsconfig.json`（`allowImportingTsExtensions` 是必需的——代码里显式写 `./usage.ts` 后缀）：

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM"],
    "jsx": "preserve",
    "jsxImportSource": "@opentui/solid",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["*.ts", "*.tsx", "tests/**/*.ts"]
}
```

写 `.gitignore`：

```
node_modules/
.DS_Store
```

- [ ] **Step 2: 安装依赖**

Run: `cd /Users/hugo/workspace/opencode-go-usage && bun install`
Expected: 生成 `bun.lock` 与 `node_modules/`，退出码 0。

`@opentui/*` 与 `solid-js` 在运行时由 opencode 二进制提供，这里装它们是为了类型检查与本地解析兜底。

- [ ] **Step 3: 写失败测试**

写 `tests/usage.test.ts`：

```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AUTH_PROVIDER, ENV_KEY, defaultStateDir, resolveKey } from "../usage.ts"

/**
 * 建一个临时 state 目录。
 *
 * @param authJson 要写入的 auth.json 文本；省略则不创建该文件
 * @returns 临时目录绝对路径
 */
function makeStateDir(authJson?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocgo-"))
  if (authJson !== undefined) writeFileSync(join(dir, "auth.json"), authJson, "utf8")
  return dir
}

describe("resolveKey", () => {
  test("环境变量优先于 auth.json", () => {
    const dir = makeStateDir(JSON.stringify({ [AUTH_PROVIDER]: { key: "from-file" } }))
    expect(resolveKey(dir, { [ENV_KEY]: "from-env" })).toBe("from-env")
  })

  test("环境变量缺失时从 auth.json 读取", () => {
    const dir = makeStateDir(JSON.stringify({ [AUTH_PROVIDER]: { type: "api", key: "sk-test" } }))
    expect(resolveKey(dir, {})).toBe("sk-test")
  })

  test("auth.json 里没有 opencode-go 时返回 null", () => {
    const dir = makeStateDir(JSON.stringify({ anthropic: { type: "api", key: "sk-other" } }))
    expect(resolveKey(dir, {})).toBeNull()
  })

  test("auth.json 不存在时返回 null", () => {
    expect(resolveKey(makeStateDir(), {})).toBeNull()
  })

  test("auth.json 是损坏 JSON 时返回 null 而不抛错", () => {
    const dir = makeStateDir("{ this is not json")
    expect(resolveKey(dir, {})).toBeNull()
  })

  test("纯空白的密钥视为没有密钥", () => {
    const dir = makeStateDir(JSON.stringify({ [AUTH_PROVIDER]: { key: "   " } }))
    expect(resolveKey(dir, { [ENV_KEY]: "  " })).toBeNull()
  })
})

describe("defaultStateDir", () => {
  test("XDG_DATA_HOME 生效", () => {
    expect(defaultStateDir({ XDG_DATA_HOME: "/xdg" }, "darwin", "/home/u")).toBe("/xdg/opencode")
  })

  test("XDG_DATA_HOME 缺失时回退到 ~/.local/share", () => {
    expect(defaultStateDir({}, "darwin", "/home/u")).toBe("/home/u/.local/share/opencode")
  })

  test("Windows 使用 LOCALAPPDATA", () => {
    expect(defaultStateDir({ LOCALAPPDATA: "C:\\AppData" }, "win32", "C:\\Users\\u")).toBe(
      join("C:\\AppData", "opencode"),
    )
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd /Users/hugo/workspace/opencode-go-usage && bun test`
Expected: FAIL，报错形如 `Cannot find module '../usage.ts'`。

- [ ] **Step 5: 写最小实现**

写 `usage.ts`：

```ts
/** OpenCode Go 额度数据层：密钥解析、上游取数与展示格式化，不含任何 TUI / JSX 依赖。 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** 单个额度窗口。 */
export type UsageWindow = {
  /** 上游状态，"ok" 或 "rate-limited"。 */
  status: string
  /** 已用百分比，上游只给整数。 */
  percent: number
  /** 该窗口重置时刻，ISO 8601 字符串。 */
  resetsAt: string
}

/** 三档额度窗口：5 小时滚动窗口、自然周、计费月。 */
export type Usage = {
  rolling: UsageWindow
  weekly: UsageWindow
  monthly: UsageWindow
}

/** 环境变量形式的密钥名。 */
export const ENV_KEY = "OPENCODE_GO_API_KEY"

/** opencode auth.json 中对应的 provider 名。 */
export const AUTH_PROVIDER = "opencode-go"

/**
 * opencode 默认 state 目录，用于 api.state.path.state 尚未就绪时兜底。
 *
 * @param env 环境变量表
 * @param platform 平台标识
 * @param home 用户主目录
 * @returns state 目录绝对路径
 */
export function defaultStateDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "opencode")
  }
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "opencode")
}

/**
 * 解析 OpenCode Go 的 API Key：环境变量优先，其次 opencode 自己的 auth.json。
 *
 * @param stateDir opencode 的 state 目录
 * @param env 环境变量表
 * @returns key 字符串；找不到、为空白或文件损坏时返回 null
 */
export function resolveKey(
  stateDir: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const fromEnv = env[ENV_KEY]?.trim()
  if (fromEnv) return fromEnv
  try {
    const raw = readFileSync(join(stateDir, "auth.json"), "utf8")
    const parsed = JSON.parse(raw) as Record<string, { key?: string } | undefined>
    const key = parsed[AUTH_PROVIDER]?.key?.trim()
    return key ? key : null
  } catch {
    // 文件缺失、无权限、JSON 损坏一律视为"没有密钥"，由调用方静默隐藏 UI
    return null
  }
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd /Users/hugo/workspace/opencode-go-usage && bun test`
Expected: PASS，9 个测试全绿。

- [ ] **Step 7: 提交**

```bash
cd /Users/hugo/workspace/opencode-go-usage
git add .gitignore package.json bun.lock tsconfig.json usage.ts tests/usage.test.ts
git commit -m "$(cat <<'MSG'
feat: 初始化插件骨架与 OpenCode Go 密钥解析

建立 bun + TypeScript 项目骨架，实现 usage.ts 的类型定义与密钥解析：
环境变量 OPENCODE_GO_API_KEY 优先，其次读 opencode 自己的
auth.json 里的 opencode-go.key。defaultStateDir 在 TUI 的
api.state.path.state 尚未就绪时兜底，避免插件永久静默。

Co-Authored-By: Hugo <shen.lan123@gmail.com>
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: 上游取数层

**Files:**
- Modify: `/Users/hugo/workspace/opencode-go-usage/usage.ts`（在文件末尾追加）
- Test: `/Users/hugo/workspace/opencode-go-usage/tests/usage.test.ts`（追加 describe 块并扩充 import）

**Interfaces:**
- Consumes: Task 1 的 `Usage`、`UsageWindow`
- Produces:
  - `export const DEFAULT_BASE_URL = "https://opencode.ai"`
  - `export type Snapshot = { kind: "ok"; usage: Usage } | { kind: "soft-error"; message: string } | { kind: "dead"; message: string }`
  - `export async function fetchUsage(key: string, baseUrl?: string, fetchImpl?: typeof fetch): Promise<Snapshot>`

`Snapshot` 三态的语义是整个失败策略的核心：`soft-error` 表示可重试，调用方保留上次快照；`dead` 表示永久失效（无 Go 套餐、密钥无效），调用方停止重试并隐藏 UI。

- [ ] **Step 1: 写失败测试**

在 `tests/usage.test.ts` 的 import 区块替换为（新增 `DEFAULT_BASE_URL` 与 `fetchUsage`）：

```ts
import {
  AUTH_PROVIDER,
  DEFAULT_BASE_URL,
  ENV_KEY,
  defaultStateDir,
  fetchUsage,
  resolveKey,
} from "../usage.ts"
```

在文件末尾追加：

```ts
/** 实测过的正常响应体，作为测试基准。 */
const OK_BODY = {
  usage: {
    rolling: { status: "ok", percent: 8, resetsAt: "2026-09-16T08:22:31.724Z" },
    weekly: { status: "ok", percent: 53, resetsAt: "2026-09-21T00:00:00.724Z" },
    monthly: { status: "ok", percent: 26, resetsAt: "2026-10-14T07:37:52.724Z" },
  },
}

/**
 * 造一个返回固定 JSON 的 fetch 替身，并记录调用参数。
 *
 * @param status HTTP 状态码
 * @param body 响应体对象
 * @returns fetch 替身与调用记录
 */
function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe("fetchUsage", () => {
  test("正常响应返回 ok 快照", async () => {
    const { impl } = stubFetch(200, OK_BODY)
    const snapshot = await fetchUsage("sk-test", DEFAULT_BASE_URL, impl)
    expect(snapshot.kind).toBe("ok")
    if (snapshot.kind !== "ok") throw new Error("unreachable")
    expect(snapshot.usage.weekly.percent).toBe(53)
    expect(snapshot.usage.rolling.resetsAt).toBe("2026-09-16T08:22:31.724Z")
  })

  test("请求打到正确 URL 并带 Bearer 头", async () => {
    const { impl, calls } = stubFetch(200, OK_BODY)
    await fetchUsage("sk-test", "https://opencode.ai/", impl)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://opencode.ai/zen/go/v1/usage")
    const headers = calls[0]!.init!.headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer sk-test")
    expect(headers.accept).toBe("application/json")
  })

  test("EntitlementError 判为 dead", async () => {
    const { impl } = stubFetch(403, {
      error: { type: "EntitlementError", message: "OpenCode Go subscription required." },
    })
    const snapshot = await fetchUsage("sk-test", DEFAULT_BASE_URL, impl)
    expect(snapshot.kind).toBe("dead")
    if (snapshot.kind !== "dead") throw new Error("unreachable")
    expect(snapshot.message).toContain("subscription required")
  })

  test("401 判为 dead", async () => {
    const { impl } = stubFetch(401, {})
    expect((await fetchUsage("sk-bad", DEFAULT_BASE_URL, impl)).kind).toBe("dead")
  })

  test("500 判为 soft-error", async () => {
    const { impl } = stubFetch(500, {})
    expect((await fetchUsage("sk-test", DEFAULT_BASE_URL, impl)).kind).toBe("soft-error")
  })

  test("fetch 抛错判为 soft-error 并带上原因", async () => {
    const impl = (async () => {
      throw new Error("ECONNRESET")
    }) as unknown as typeof fetch
    const snapshot = await fetchUsage("sk-test", DEFAULT_BASE_URL, impl)
    expect(snapshot.kind).toBe("soft-error")
    if (snapshot.kind !== "soft-error") throw new Error("unreachable")
    expect(snapshot.message).toContain("ECONNRESET")
  })

  test("响应缺少 usage 字段判为 soft-error", async () => {
    const { impl } = stubFetch(200, { hello: "world" })
    expect((await fetchUsage("sk-test", DEFAULT_BASE_URL, impl)).kind).toBe("soft-error")
  })

  test("窗口字段类型不对判为 soft-error", async () => {
    const { impl } = stubFetch(200, {
      usage: {
        rolling: { status: "ok", percent: "8", resetsAt: "2026-09-16T08:22:31.724Z" },
        weekly: OK_BODY.usage.weekly,
        monthly: OK_BODY.usage.monthly,
      },
    })
    expect((await fetchUsage("sk-test", DEFAULT_BASE_URL, impl)).kind).toBe("soft-error")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/hugo/workspace/opencode-go-usage && bun test`
Expected: FAIL，报错形如 `export 'fetchUsage' not found in '../usage.ts'`。

- [ ] **Step 3: 写最小实现**

在 `usage.ts` 末尾追加：

```ts
/** 上游 API 基地址。 */
export const DEFAULT_BASE_URL = "https://opencode.ai"

/** 额度端点路径。 */
const USAGE_PATH = "/zen/go/v1/usage"

/** 单次请求超时。 */
const TIMEOUT_MS = 15_000

/**
 * 一次取数的结果。
 *
 * - `ok`：拿到快照
 * - `soft-error`：可重试（网络、超时、5xx、格式异常），调用方应保留上次快照
 * - `dead`：永久失效（无 Go 套餐、密钥无效），调用方应停止重试并隐藏 UI
 */
export type Snapshot =
  | { kind: "ok"; usage: Usage }
  | { kind: "soft-error"; message: string }
  | { kind: "dead"; message: string }

/**
 * 运行时校验单个窗口对象。
 *
 * @param value 待校验值
 * @returns 是否为合法窗口
 */
function isUsageWindow(value: unknown): value is UsageWindow {
  if (value === null || typeof value !== "object") return false
  const w = value as Record<string, unknown>
  return (
    typeof w.status === "string" &&
    typeof w.percent === "number" &&
    typeof w.resetsAt === "string"
  )
}

/**
 * 运行时校验三档窗口齐全。
 *
 * @param value 待校验值
 * @returns 是否为合法 Usage
 */
function isUsage(value: unknown): value is Usage {
  if (value === null || typeof value !== "object") return false
  const u = value as Record<string, unknown>
  return isUsageWindow(u.rolling) && isUsageWindow(u.weekly) && isUsageWindow(u.monthly)
}

/**
 * 拉取一次额度快照。
 *
 * @param key API Key
 * @param baseUrl API 基地址
 * @param fetchImpl fetch 实现，注入以便测试
 * @returns 三态取数结果
 */
export async function fetchUsage(
  key: string,
  baseUrl: string = DEFAULT_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<Snapshot> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response: Response
  try {
    response = await fetchImpl(baseUrl.replace(/\/$/, "") + USAGE_PATH, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: controller.signal,
    })
  } catch (error) {
    return {
      kind: "soft-error",
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }

  // 先看业务错误：无 Go 套餐返回 EntitlementError，且可能伴随 4xx，
  // 所以必须排在状态码判断之前，否则会丢掉上游给的具体原因。
  const bodyError = (body as { error?: { type?: string; message?: string } } | null)?.error
  if (bodyError?.type === "EntitlementError") {
    return { kind: "dead", message: bodyError.message ?? "OpenCode Go subscription required." }
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "dead", message: `HTTP ${response.status}：密钥无效或无权访问` }
  }
  if (!response.ok) {
    return { kind: "soft-error", message: `HTTP ${response.status}` }
  }
  const usage = (body as { usage?: unknown } | null)?.usage
  if (!isUsage(usage)) {
    return { kind: "soft-error", message: "响应缺少 usage 字段" }
  }
  return { kind: "ok", usage }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/hugo/workspace/opencode-go-usage && bun test`
Expected: PASS，17 个测试全绿。

- [ ] **Step 5: 提交**

```bash
cd /Users/hugo/workspace/opencode-go-usage
git add usage.ts tests/usage.test.ts
git commit -m "$(cat <<'MSG'
feat: 实现 OpenCode Go 额度取数层

fetchUsage 请求 /zen/go/v1/usage 并把结果归为三态：ok /
soft-error（可重试）/ dead（无套餐或密钥失效，停止重试）。
EntitlementError 的判断排在状态码之前，以保留上游给出的具体原因。
响应做运行时结构校验，格式异常降级为 soft-error 而非抛错。

Co-Authored-By: Hugo <shen.lan123@gmail.com>
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: 展示格式化层

**Files:**
- Modify: `/Users/hugo/workspace/opencode-go-usage/usage.ts`（在文件末尾追加）
- Test: `/Users/hugo/workspace/opencode-go-usage/tests/usage.test.ts`（追加 describe 块并扩充 import）

**Interfaces:**
- Consumes: Task 1 的 `Usage`
- Produces:
  - `export const BAR_WIDTH = 20`
  - `export const ROWS`：`readonly [{ key: "rolling"; label: "5 小时用量" }, { key: "weekly"; label: "每周用量" }, { key: "monthly"; label: "每月用量" }]`
  - `export type Tone = "ok" | "warn" | "danger"`
  - `export function formatBar(percent: number, width?: number): string`
  - `export function toneOf(percent: number, status: string): Tone`
  - `export function formatPercent(percent: number, status: string): string`
  - `export function formatCountdown(resetsAt: string, now?: number): string`

`toneOf` 刻意返回色调名而非 RGBA，这样它是纯函数、不依赖主题对象；`tui.tsx` 负责把色调名映射到 `theme.current` 的颜色。

- [ ] **Step 1: 写失败测试**

把 `tests/usage.test.ts` 的 import 区块替换为：

```ts
import {
  AUTH_PROVIDER,
  DEFAULT_BASE_URL,
  ENV_KEY,
  defaultStateDir,
  fetchUsage,
  formatBar,
  formatCountdown,
  formatPercent,
  resolveKey,
  toneOf,
} from "../usage.ts"
```

在文件末尾追加：

```ts
describe("formatBar", () => {
  test("0% 全空", () => {
    expect(formatBar(0, 20)).toBe("░".repeat(20))
  })

  test("100% 全满", () => {
    expect(formatBar(100, 20)).toBe("█".repeat(20))
  })

  test("8% 四舍五入到 2 格", () => {
    expect(formatBar(8, 20)).toBe("██" + "░".repeat(18))
  })

  test("53% 四舍五入到 11 格", () => {
    expect(formatBar(53, 20)).toBe("█".repeat(11) + "░".repeat(9))
  })

  test("26% 四舍五入到 5 格", () => {
    expect(formatBar(26, 20)).toBe("█".repeat(5) + "░".repeat(15))
  })

  test("越界与非法输入被夹住且总宽不变", () => {
    for (const p of [-50, 0, 1, 33, 99, 100, 250, Number.NaN]) {
      expect([...formatBar(p, 20)]).toHaveLength(20)
    }
  })
})

describe("toneOf", () => {
  test("69% 仍为正常", () => {
    expect(toneOf(69, "ok")).toBe("ok")
  })

  test("70% 起为警告", () => {
    expect(toneOf(70, "ok")).toBe("warn")
  })

  test("89% 仍为警告", () => {
    expect(toneOf(89, "ok")).toBe("warn")
  })

  test("90% 起为危险", () => {
    expect(toneOf(90, "ok")).toBe("danger")
  })

  test("rate-limited 无论百分比都是危险", () => {
    expect(toneOf(3, "rate-limited")).toBe("danger")
  })
})

describe("formatPercent", () => {
  test("右对齐到 4 字符", () => {
    expect(formatPercent(8, "ok")).toBe("  8%")
    expect(formatPercent(53, "ok")).toBe(" 53%")
    expect(formatPercent(100, "ok")).toBe("100%")
  })

  test("打满时显示已达上限", () => {
    expect(formatPercent(100, "rate-limited")).toBe("已达上限")
  })
})

describe("formatCountdown", () => {
  /** 实测快照对应的参考时刻。 */
  const now = Date.parse("2026-09-16T07:51:00.000Z")

  test("不足一小时只显示分钟", () => {
    expect(formatCountdown("2026-09-16T08:22:31.724Z", now)).toBe("重置于 31 分钟")
  })

  test("不足一天显示小时与分钟", () => {
    expect(formatCountdown("2026-09-16T12:05:00.000Z", now)).toBe("重置于 4 小时 14 分钟")
  })

  test("超过一天显示天与小时", () => {
    expect(formatCountdown("2026-09-21T00:00:00.724Z", now)).toBe("重置于 4 天 16 小时")
    expect(formatCountdown("2026-10-14T07:37:52.724Z", now)).toBe("重置于 27 天 23 小时")
  })

  test("已过期显示即将重置", () => {
    expect(formatCountdown("2026-09-16T07:00:00.000Z", now)).toBe("即将重置")
  })

  test("非法时间串不抛错", () => {
    expect(formatCountdown("not-a-date", now)).toBe("重置时间未知")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/hugo/workspace/opencode-go-usage && bun test`
Expected: FAIL，报错形如 `export 'formatBar' not found in '../usage.ts'`。

- [ ] **Step 3: 写最小实现**

在 `usage.ts` 末尾追加：

```ts
/** 进度条格数。 */
export const BAR_WIDTH = 20

/** 侧栏三行的渲染顺序与中文标签。 */
export const ROWS = [
  { key: "rolling", label: "5 小时用量" },
  { key: "weekly", label: "每周用量" },
  { key: "monthly", label: "每月用量" },
] as const

/** 进度条色调，由 tui.tsx 映射到主题色。 */
export type Tone = "ok" | "warn" | "danger"

/**
 * 渲染定宽进度条。
 *
 * @param percent 已用百分比，越界或非法值会被夹到 0-100
 * @param width 格数
 * @returns 由 █ 与 ░ 组成的定长字符串
 */
export function formatBar(percent: number, width: number = BAR_WIDTH): string {
  const safe = Number.isFinite(percent) ? percent : 0
  const clamped = Math.min(100, Math.max(0, safe))
  const filled = Math.round((clamped / 100) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

/**
 * 判定进度条色调。
 *
 * @param percent 已用百分比
 * @param status 上游 status 字段
 * @returns 色调名
 */
export function toneOf(percent: number, status: string): Tone {
  if (status === "rate-limited" || percent >= 90) return "danger"
  if (percent >= 70) return "warn"
  return "ok"
}

/**
 * 格式化行右侧的百分比文本。
 *
 * @param percent 已用百分比
 * @param status 上游 status 字段
 * @returns 打满时为 "已达上限"，否则是右对齐到 4 字符的百分比
 */
export function formatPercent(percent: number, status: string): string {
  if (status === "rate-limited") return "已达上限"
  return `${Math.round(percent)}%`.padStart(4, " ")
}

/**
 * 格式化重置倒计时整行文本。
 *
 * @param resetsAt ISO 8601 时间串
 * @param now 当前时间戳
 * @returns 形如 "重置于 4 天 16 小时" 的文本
 */
export function formatCountdown(resetsAt: string, now: number = Date.now()): string {
  const target = new Date(resetsAt).getTime()
  if (!Number.isFinite(target)) return "重置时间未知"
  const ms = target - now
  if (ms <= 0) return "即将重置"
  // 统一折算到分钟再拆分，避免秒级抖动导致文本反复变化
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `重置于 ${days} 天 ${hours} 小时`
  if (hours > 0) return `重置于 ${hours} 小时 ${minutes} 分钟`
  return `重置于 ${minutes} 分钟`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/hugo/workspace/opencode-go-usage && bun test`
Expected: PASS，35 个测试全绿。

- [ ] **Step 5: 提交**

```bash
cd /Users/hugo/workspace/opencode-go-usage
git add usage.ts tests/usage.test.ts
git commit -m "$(cat <<'MSG'
feat: 实现额度展示格式化层

formatBar 渲染 20 格定宽进度条，toneOf 按 70/90 阈值与 rate-limited
判定色调（返回色调名而非 RGBA 以保持纯函数），formatPercent 右对齐
到 4 字符，formatCountdown 按天/小时/分钟三档输出中文倒计时。
倒计时折算到分钟再拆分，避免秒级抖动导致文本反复变化。

Co-Authored-By: Hugo <shen.lan123@gmail.com>
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: TUI 渲染、刷新与安装

**Files:**
- Create: `/Users/hugo/workspace/opencode-go-usage/tui.tsx`
- Create: `/Users/hugo/workspace/opencode-go-usage/README.md`
- Create: `/Users/hugo/.config/opencode/tui.json`

**Interfaces:**
- Consumes: Task 1-3 的全部导出 —— `DEFAULT_BASE_URL`、`ROWS`、`Tone`、`Usage`、`UsageWindow`、`defaultStateDir`、`fetchUsage`、`formatBar`、`formatCountdown`、`formatPercent`、`resolveKey`、`toneOf`
- Produces: `export default { id: "opencode-go-usage", tui }`，供 opencode 的 TUI plugin loader 读取

本任务无单测（渲染依赖 opencode 进程内的 TUI 运行时，无法在 `bun test` 里可靠模拟），靠 Step 4 的手工验证把关。

- [ ] **Step 1: 写 tui.tsx**

```tsx
/** @jsxImportSource @opentui/solid */
/** opencode TUI 插件：在侧栏纵向展示 OpenCode Go 的 5 小时 / 每周 / 每月额度。 */

import type { TuiPlugin, TuiPluginModule, TuiTheme } from "@opencode-ai/plugin/tui"
import { For, Show, createSignal } from "solid-js"
import {
  DEFAULT_BASE_URL,
  ROWS,
  defaultStateDir,
  fetchUsage,
  formatBar,
  formatCountdown,
  formatPercent,
  resolveKey,
  toneOf,
  type Tone,
  type Usage,
  type UsageWindow,
} from "./usage.ts"

/** 兜底刷新间隔：覆盖"额度在别处被消耗"的情况。 */
const FALLBACK_MS = 300_000

/** 两次上游请求的最小间隔，防止 session.idle 密集触发时刷爆端点。 */
const THROTTLE_MS = 20_000

/** 倒计时文本重算间隔，不发网络请求。 */
const TICK_MS = 60_000

/**
 * 把色调名映射到当前主题色。
 *
 * @param theme TUI 主题对象
 * @param tone 色调名
 * @returns 对应的 RGBA
 */
function toneColor(theme: TuiTheme, tone: Tone) {
  if (tone === "danger") return theme.current.error
  if (tone === "warn") return theme.current.warning
  return theme.current.success
}

/**
 * 单个额度窗口的三行展示：标签与百分比、进度条、重置倒计时。
 *
 * @param props.theme TUI 主题对象（传对象而非 current，以保持主题切换的响应式）
 * @param props.label 中文标签
 * @param props.win 取窗口数据的 accessor
 * @param props.now 取当前时间戳的 accessor，驱动倒计时重算
 */
function UsageRow(props: {
  theme: TuiTheme
  label: string
  win: () => UsageWindow
  now: () => number
}) {
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={props.theme.current.textMuted}>{props.label}</text>
        <box flexGrow={1} />
        <text fg={props.theme.current.textMuted}>
          {formatPercent(props.win().percent, props.win().status)}
        </text>
      </box>
      <text fg={toneColor(props.theme, toneOf(props.win().percent, props.win().status))}>
        {formatBar(props.win().percent)}
      </text>
      <text fg={props.theme.current.textMuted}>
        {formatCountdown(props.win().resetsAt, props.now())}
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const [usage, setUsage] = createSignal<Usage | null>(null)
  const [stale, setStale] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())

  /** 永久失效标记：无 Go 套餐或密钥无效后不再请求。 */
  let dead = false
  /** 同一时刻只允许一个请求在飞。 */
  let inflight = false
  /** 上次发起请求的时刻，用于节流。 */
  let lastAt = 0

  /**
   * 刷新一次额度。
   *
   * @param force 跳过节流；启动与兜底定时器用 true，事件触发用 false
   */
  const refresh = async (force: boolean) => {
    if (dead || inflight) return
    const at = Date.now()
    if (!force && at - lastAt < THROTTLE_MS) return
    // 惰性解析密钥：会话中途新增密钥也能被拾取；state 未就绪时回退到平台默认目录
    const key = resolveKey(api.state.path.state || defaultStateDir())
    if (!key) return
    inflight = true
    lastAt = at
    try {
      const snapshot = await fetchUsage(key, DEFAULT_BASE_URL)
      if (snapshot.kind === "dead") {
        dead = true
        setUsage(null)
        return
      }
      if (snapshot.kind === "ok") {
        setUsage(snapshot.usage)
        setStale(false)
        return
      }
      // soft-error：保留上次快照，只在标题上打一个感叹号
      setStale(true)
    } finally {
      inflight = false
    }
  }

  const offIdle = api.event.on("session.idle", () => void refresh(false))
  const fallback = setInterval(() => void refresh(true), FALLBACK_MS)
  const tick = setInterval(() => setNow(Date.now()), TICK_MS)
  api.lifecycle.onDispose(() => {
    offIdle()
    clearInterval(fallback)
    clearInterval(tick)
  })
  void refresh(true)

  api.slots.register({
    order: 100,
    slots: {
      sidebar_content: (ctx) => (
        <Show when={usage()}>
          {(data) => (
            <box flexDirection="column" paddingTop={1}>
              <text fg={ctx.theme.current.textMuted}>
                {stale() ? "OpenCode Go !" : "OpenCode Go"}
              </text>
              <For each={ROWS}>
                {(row) => (
                  <UsageRow
                    theme={ctx.theme}
                    label={row.label}
                    win={() => data()[row.key]}
                    now={now}
                  />
                )}
              </For>
            </box>
          )}
        </Show>
      ),
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id: "opencode-go-usage", tui }

export default plugin
```

- [ ] **Step 2: 类型检查**

Run: `cd /Users/hugo/workspace/opencode-go-usage && bunx tsc --noEmit`
Expected: 无错误退出。若 `<box>` / `<text>` 报 "JSX element implicitly has type 'any'"，说明 `@opentui/core` 的 JSX 命名空间没被加载 —— 在 `tsconfig.json` 的 `compilerOptions.types` 里补上 `"@opentui/core"`，再跑一次。

- [ ] **Step 3: 注册插件**

创建 `~/.config/opencode/tui.json`（该文件当前不存在；**不要**改 `opencode.jsonc`）：

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/Users/hugo/workspace/opencode-go-usage/tui.tsx"]
}
```

- [ ] **Step 4: 手工验证**

重启 opencode，进入任意会话，核对侧栏（`Context` / `MCP` / `LSP` 之下）出现：

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

逐项确认：
1. 三个窗口都在，顺序是 5 小时 → 每周 → 每月；
2. 百分比与命令行直接调用端点的结果一致 ——
   `curl -s -H "authorization: Bearer $OPENCODE_GO_API_KEY" https://opencode.ai/zen/go/v1/usage`
   （或从 `~/.local/share/opencode/auth.json` 的 `opencode-go.key` 取密钥）；
3. 百分比右对齐贴在侧栏右边缘；若 `flexGrow` 的弹性间隔没生效（百分比紧跟标签），把 `UsageRow` 里的 `<box flexGrow={1} />` 换成 `<box style={{ flexGrow: 1 }} />` 再试；
4. 倒计时数值与 `resetsAt` 相符，且等一分钟后分钟数会变；
5. 发一条消息让助手回复完成，观察百分比在回复结束后数秒内更新（`session.idle` 驱动）；
6. 主题切换（`/theme`）后颜色跟着变。

- [ ] **Step 5: 写 README**

写 `README.md`（外层用四个反引号围栏，内部的三反引号代码块才不会破损；实际文件里只写围栏内的内容）：

````markdown
# opencode-go-usage

opencode TUI 插件：在侧栏展示 OpenCode Go 套餐的 5 小时 / 每周 / 每月额度。

## 显示内容

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

渲染在 `sidebar_content` slot，紧随 opencode 自带的 `Context` / `MCP` / `LSP` 小节之后。

## 安装

需要 opencode >= 1.18.0。

```bash
cd ~/workspace/opencode-go-usage && bun install
```

在 `~/.config/opencode/tui.json` 注册（**不是** `opencode.json`，后者只加载 server 端插件）：

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/Users/hugo/workspace/opencode-go-usage/tui.tsx"]
}
```

重启 opencode 生效。

## 密钥

按以下顺序解析，插件自身不存储任何副本：

1. 环境变量 `OPENCODE_GO_API_KEY`
2. opencode 自己的 `<stateDir>/auth.json` 里的 `opencode-go.key`

没有密钥、没有 Go 套餐、或密钥失效时，整节不渲染 —— 不占行、不报错。

## 刷新

- 助手每次回复结束（`session.idle`）后刷新，最小间隔 20 秒；
- 另有 5 分钟兜底定时刷新；
- 倒计时文本每 60 秒本地重算，不发请求；
- 网络错误或 5xx 时保留上次数值，标题显示为 `OpenCode Go !`。

## 已知限制

上游 `/zen/go/v1/usage` 只返回**整数**百分比与 `resetsAt`，不返回 token 数或金额。
opencode 官方 web dashboard 显示的一位小数（如 `8.1%`）来自另一条更精细的通路，
本插件无法取到，因此只显示 `8%`。

## 测试

```bash
bun test
```

只覆盖 `usage.ts` 的纯函数（密钥解析、取数三态、格式化）；`tui.tsx` 的渲染靠手工验证。
````

- [ ] **Step 6: 跑全量测试**

Run: `cd /Users/hugo/workspace/opencode-go-usage && bun test`
Expected: PASS，35 个测试全绿（Task 4 未新增测试，此步是回归确认）。

- [ ] **Step 7: 提交**

```bash
cd /Users/hugo/workspace/opencode-go-usage
git add tui.tsx README.md
git commit -m "$(cat <<'MSG'
feat: 侧栏渲染 OpenCode Go 额度并接入事件刷新

注册到 sidebar_content slot（默认叠加模式，不与其他插件互斥），
纵向展示三档额度的中文标签、百分比、20 格进度条与重置倒计时。
刷新由 session.idle 事件驱动并做 20 秒节流，另有 5 分钟兜底定时器；
倒计时每 60 秒本地重算不发请求。无密钥/无套餐/密钥失效时整节不渲染，
网络类错误保留上次快照并在标题打感叹号。

Co-Authored-By: Hugo <shen.lan123@gmail.com>
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## 完成标准

1. `bun test` 35 个测试全绿。
2. `bunx tsc --noEmit` 无错误。
3. opencode 侧栏 `Context` / `MCP` / `LSP` 之下出现 `OpenCode Go` 小节，三档额度的百分比与直接 curl 端点的结果一致。
4. 助手回复结束后百分比会自动更新。
5. 临时 `unset` 密钥并把 `auth.json` 里的 `opencode-go` 改名后重启，整节消失且 TUI 无报错；改回后恢复。
