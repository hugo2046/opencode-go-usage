/** @jsxImportSource @opentui/solid */
/** opencode TUI 插件：在侧栏纵向展示 OpenCode Go 的 5 小时 / 每周 / 每月额度。 */

import type { TuiPlugin, TuiPluginModule, TuiTheme } from "@opencode-ai/plugin/tui"
import { For, Show, createSignal } from "solid-js"
import {
  DEFAULT_BASE_URL,
  ROWS,
  createRefresher,
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

  // 节流 / 单飞 / dead 闩锁这套状态机是纯逻辑，提取到 usage.ts 的 createRefresher
  // 里做了单测；这里只负责把 solid 的 setter 和真实的 resolveKey / fetchUsage /
  // Date.now 接进去，行为与提取前完全等价。
  const { refresh } = createRefresher({
    // 惰性解析密钥：会话中途新增密钥也能被拾取。
    //
    // 两个候选目录，data 目录优先：auth.json 存在 opencode 的 **data** 目录
    // （XDG_DATA_HOME，即 defaultStateDir() 算出的 ~/.local/share/opencode），
    // 而 api.state.path.state 指向的是 **state** 目录（XDG_STATE_HOME，
    // ~/.local/state/opencode，里面是 kv.json / locks / model.json）。
    // 这是 XDG 规范里两个不同的目录，早期版本误当同一个，导致密钥永远找不到、
    // 整节永不渲染。state 目录留作次选，以防某些安装两者一致或宿主日后改动。
    resolveKey: () => resolveKey([defaultStateDir(), api.state?.path?.state ?? ""]),
    fetchUsage: (key) => fetchUsage(key, DEFAULT_BASE_URL),
    now: () => Date.now(),
    onUsage: (next) => {
      setUsage(next)
      setStale(false)
    },
    onDead: () => setUsage(null),
    onStale: (value) => setStale(value),
  })

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
    // 内置侧栏小节的 order（从 opencode 1.18.30 二进制的 strings 表解出，
    // 是与宿主的隐式契约，宿主调整内置 order 时需要同步复核这张表）：
    //   internal:sidebar-context = 100, internal:sidebar-mcp = 200,
    //   internal:sidebar-lsp = 300, internal:sidebar-todo = 400,
    //   internal:sidebar-files = 500
    // 350 落在 lsp(300) 与 todo(400) 之间，满足 spec/README 的
    // "紧随 Context / MCP / LSP 小节之后"；不用 600，否则会排在 Todo/Files 之上。
    order: 350,
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
