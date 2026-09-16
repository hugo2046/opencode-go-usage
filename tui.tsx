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
