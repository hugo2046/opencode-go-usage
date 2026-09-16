/** @jsxImportSource @opentui/solid */
/** opencode TUI 插件：在侧栏展示 OpenCode Go 的三档额度，支持紧凑与详细两种样式。 */

import type { TuiPlugin, TuiPluginModule, TuiTheme } from "@opencode-ai/plugin/tui"
import { For, Show, createSignal } from "solid-js"
import {
  BAR_WIDTH,
  BAR_WIDTH_DETAILED,
  COUNTDOWN_WIDTH,
  DEFAULT_BASE_URL,
  ROWS,
  barFilled,
  createRefresher,
  defaultStateDir,
  fetchUsage,
  formatCountdown,
  formatCountdownShort,
  formatPercent,
  hasEnoughContrast,
  parseOptions,
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
 * 进度条轨道（未用部分）的颜色。
 *
 * 优先用主题的 `border`：它的语义就是「在背景上可见的边框色」，任何主题都得
 * 保证这一点，所以深色浅色都能跟随，不需要按 theme.mode() 分叉。但个别主题
 * 可能把它设得和背景几乎一样，所以再做一次运行时亮度差检查，不合格就回退到
 * textMuted。不能用 borderSubtle / backgroundElement —— 它们的语义是「几乎
 * 不可见的分隔」，ayu 下与 background 的亮度差只有 0.03 / 0.01，做轨道等于没画。
 *
 * @param theme TUI 主题对象
 * @returns 轨道色
 */
function trackColor(theme: TuiTheme) {
  const c = theme.current
  return hasEnoughContrast(c.border, c.background) ? c.border : c.textMuted
}

/**
 * 两种样式共用的进度条：两段带背景色的实心色块。
 *
 * 用 bg + 空格而不是 █ 字符——色块之间没有字形缝隙，观感是连续实心条。
 *
 * @param props.theme TUI 主题对象
 * @param props.percent 取已用百分比的 accessor
 * @param props.tone 取色调名的 accessor
 * @param props.width 总格数（紧凑样式 14，详细样式 20）
 */
function Bar(props: {
  theme: TuiTheme
  percent: () => number
  tone: () => Tone
  width: number
}) {
  const filled = () => barFilled(props.percent(), props.width)
  return (
    <box flexDirection="row">
      <text bg={toneColor(props.theme, props.tone())}>{" ".repeat(filled())}</text>
      <text bg={trackColor(props.theme)}>{" ".repeat(props.width - filled())}</text>
    </box>
  )
}

/**
 * 紧凑样式（样式 A）：一行一档。
 *
 * 布局预算（侧栏可用 37 列，实测自宿主 width:42 减去两侧 padding）：
 * 标签 4 + gap 1 + 条 14 + gap 1 + 百分比 4 + gap 1 + 倒计时 6 = 31 列。
 *
 * 标签排版靠 flex gap 而不是 padEnd —— 中文字符 length 是 1 但显示占 2 列，
 * padEnd 会按 length 补空格从而排错。三个紧凑标签都是 2 个中文字符、等宽 4 列。
 *
 * @param props.theme TUI 主题对象（传对象而非 current，以保持主题切换的响应式）
 * @param props.label 紧凑标签
 * @param props.win 取窗口数据的 accessor
 * @param props.now 取当前时间戳的 accessor，驱动倒计时重算
 */
function CompactRow(props: {
  theme: TuiTheme
  label: string
  win: () => UsageWindow
  now: () => number
}) {
  const tone = () => toneOf(props.win().percent, props.win().status)
  return (
    <box flexDirection="row" gap={1}>
      <text fg={props.theme.current.textMuted}>{props.label}</text>
      <Bar
        theme={props.theme}
        percent={() => props.win().percent}
        tone={tone}
        width={BAR_WIDTH}
      />
      <text fg={toneColor(props.theme, tone())}>
        {formatPercent(props.win().percent, props.win().status)}
      </text>
      <text fg={props.theme.current.textMuted}>
        {formatCountdownShort(props.win().resetsAt, props.now()).padStart(COUNTDOWN_WIDTH)}
      </text>
    </box>
  )
}

/**
 * 详细样式（样式 B）：三行一档 —— 标签与百分比一行、进度条一行、完整倒计时一行。
 *
 * 条子独占一行所以放得下 20 格；标签用长版本（`5 小时用量`），倒计时用完整
 * 中文措辞（`重置于 4 天 16 小时`）。百分比靠 flexGrow 弹性间隔推到右边缘。
 *
 * @param props.theme TUI 主题对象
 * @param props.label 长标签
 * @param props.win 取窗口数据的 accessor
 * @param props.now 取当前时间戳的 accessor
 */
function DetailedRow(props: {
  theme: TuiTheme
  label: string
  win: () => UsageWindow
  now: () => number
}) {
  const tone = () => toneOf(props.win().percent, props.win().status)
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={props.theme.current.textMuted}>{props.label}</text>
        <box flexGrow={1} />
        <text fg={toneColor(props.theme, tone())}>
          {formatPercent(props.win().percent, props.win().status)}
        </text>
      </box>
      <Bar
        theme={props.theme}
        percent={() => props.win().percent}
        tone={tone}
        width={BAR_WIDTH_DETAILED}
      />
      <text fg={props.theme.current.textMuted}>
        {formatCountdown(props.win().resetsAt, props.now())}
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api, options) => {
  // tui.json 里以 [spec, options] 形式传入的配置，见 parseOptions 的容错说明。
  // 启动时解析一次；配置不热更新，改完要重启 opencode。
  const opts = parseOptions(options)

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
    // 内置侧栏小节的 order（从 opencode 二进制的 strings 表解出，1.18.30 与
    // 1.18.31 一致；这是与宿主的隐式契约，宿主调整内置 order 时需要复核这张表）：
    //   internal:sidebar-context = 100, internal:sidebar-mcp = 200,
    //   internal:sidebar-lsp = 300, internal:sidebar-todo = 400,
    //   internal:sidebar-files = 500
    // 默认 350 落在 lsp(300) 与 todo(400) 之间，满足"紧随 Context / MCP / LSP
    // 之后"；想沉到侧栏最底可在配置里设成 600。
    order: opts.order,
    slots: {
      sidebar_content: (ctx) => (
        <Show when={usage()}>
          {(data) => (
            <box flexDirection="column">
              {/* 与宿主的 Context / MCP / LSP 小节标题保持一致：
                  fg 用 theme.text（不是 textMuted，那是内容行的颜色），
                  文本包一层 <b> 取粗体。外层 box 不加 paddingTop —— 节之间
                  的间距由宿主的 slot 容器 gap 提供，自己再加会变成双倍空行。
                  依据：opencode 二进制里 internal:sidebar-lsp 的实现为
                  <text fg={theme.current.text}><b>LSP</b></text>。 */}
              <text fg={ctx.theme.current.text}>
                <b>{stale() ? "OpenCode Go !" : "OpenCode Go"}</b>
              </text>
              <For each={ROWS}>
                {(row) =>
                  opts.style === "detailed" ? (
                    <DetailedRow
                      theme={ctx.theme}
                      label={row.labelLong}
                      win={() => data()[row.key]}
                      now={now}
                    />
                  ) : (
                    <CompactRow
                      theme={ctx.theme}
                      label={row.label}
                      win={() => data()[row.key]}
                      now={now}
                    />
                  )
                }
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
