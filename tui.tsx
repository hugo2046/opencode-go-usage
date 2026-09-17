/** @jsxImportSource @opentui/solid */
/** opencode TUI 插件：在侧栏展示 OpenCode Go 的三档额度，支持紧凑、详细与账本三种样式。 */

import type { TuiPlugin, TuiPluginModule, TuiTheme } from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import { Show, createSignal } from "solid-js"
import {
  BAR_WIDTH,
  BAR_WIDTH_DETAILED,
  BAR_GLYPH,
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
  pickTrackColor,
  parseOptions,
  resolveKey,
  STYLE_COMMANDS,
  toneOf,
  type Tone,
  type StyleName,
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
  return pickTrackColor({
    border: c.border,
    background: c.background,
    textMuted: c.textMuted,
  })
}

/**
 * 三种样式共用的进度条：两段主题前景色细线。
 *
 * 用细横线 glyph 而不是整行背景色空格，避免终端字符格高度让柱体显得过粗。
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
      <text fg={toneColor(props.theme, props.tone())}>{BAR_GLYPH.repeat(filled())}</text>
      <text fg={trackColor(props.theme)}>{BAR_GLYPH.repeat(props.width - filled())}</text>
    </box>
  )
}

/**
 * 紧凑样式（样式 B）：一行一档。
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
 * 详细样式（样式 A）：三行一档 —— 标签与百分比一行、进度条一行、完整倒计时一行。
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

/**
 * 账本样式的 5 小时主窗口。
 *
 * @param props.theme TUI 主题对象，所有背景、边框与文字颜色都从当前主题读取
 * @param props.win 取 5 小时窗口数据的 accessor
 * @param props.now 取当前时间戳的 accessor
 */
function LedgerPrimaryRow(props: {
  theme: TuiTheme
  win: () => UsageWindow
  now: () => number
}) {
  const tone = () => toneOf(props.win().percent, props.win().status)
  return (
    <box
      flexDirection="column"
      gap={1}
      padding={1}
      backgroundColor={props.theme.current.backgroundPanel}
      border={true}
      borderColor={props.theme.current.borderActive}
    >
      <box flexDirection="row">
        <text fg={props.theme.current.text}>
          <b>5 小时滚动窗口</b>
        </text>
        <box flexGrow={1} />
        <text fg={toneColor(props.theme, tone())}>
          <b>{formatPercent(props.win().percent, props.win().status)}</b>
        </text>
      </box>
      <Bar
        theme={props.theme}
        percent={() => props.win().percent}
        tone={tone}
        width={BAR_WIDTH_DETAILED}
      />
      <box flexDirection="row">
        <text fg={props.theme.current.textMuted}>重置于 {formatCountdownShort(props.win().resetsAt, props.now())}</text>
        <box flexGrow={1} />
        <text fg={props.theme.current.textMuted}>rolling</text>
      </box>
    </box>
  )
}

/**
 * 账本样式的周/月次级窗口。
 *
 * @param props.theme TUI 主题对象，颜色跟随 OpenCode 当前浅色或深色主题
 * @param props.label 窗口短标签
 * @param props.period 窗口英文语义标签
 * @param props.win 取窗口数据的 accessor
 * @param props.now 取当前时间戳的 accessor
 */
function LedgerSecondaryRow(props: {
  theme: TuiTheme
  label: string
  period: string
  win: () => UsageWindow
  now: () => number
}) {
  const tone = () => toneOf(props.win().percent, props.win().status)
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={props.theme.current.text}>{props.label}</text>
        <Bar
          theme={props.theme}
          percent={() => props.win().percent}
          tone={tone}
          width={BAR_WIDTH}
        />
        <text fg={toneColor(props.theme, tone())}>
          {formatPercent(props.win().percent, props.win().status)}
        </text>
      </box>
      <text fg={props.theme.current.textMuted}>
        {props.period} · 重置于 {formatCountdownShort(props.win().resetsAt, props.now())}
      </text>
    </box>
  )
}

/**
 * 额度侧栏内容组件。
 *
 * 把样式分支放在独立组件内，避免 Solid 的 Show children 回调 untrack 外部
 * style accessor，确保 slash command 切换后已经挂载的侧栏会重新布局。
 *
 * @param props.theme TUI 主题对象
 * @param props.data 当前额度快照 accessor
 * @param props.style 当前布局样式 accessor
 * @param props.stale 是否沿用旧快照的 accessor
 * @param props.now 当前时间戳 accessor
 */
function UsageSection(props: {
  theme: TuiTheme
  data: () => Usage
  style: () => StyleName
  stale: () => boolean
  now: () => number
}) {
  // 作为 box 的函数子节点插入，OpenTUI Solid 会为它建立 render effect。
  // 因此 style / stale 在命令或刷新状态变化后都会重新计算，而不是只在
  // 外层 Show 第一次挂载时读取一次。
  const renderContent = () => {
    const currentStyle = props.style()
    const title = (
      <text fg={props.theme.current.text}>
        <b>{props.stale() ? "OpenCode Go !" : "OpenCode Go"}</b>
      </text>
    )

    if (currentStyle === "ledger") {
      return [
        title,
        <LedgerPrimaryRow
          theme={props.theme}
          win={() => props.data().rolling}
          now={props.now}
        />,
        <LedgerSecondaryRow
          theme={props.theme}
          label="周"
          period="weekly"
          win={() => props.data().weekly}
          now={props.now}
        />,
        <LedgerSecondaryRow
          theme={props.theme}
          label="月"
          period="monthly"
          win={() => props.data().monthly}
          now={props.now}
        />,
      ]
    }

    return [
      title,
      ...ROWS.map((row) =>
        currentStyle === "detailed" ? (
          <DetailedRow
            theme={props.theme}
            label={row.labelLong}
            win={() => props.data()[row.key]}
            now={props.now}
          />
        ) : (
          <CompactRow
            theme={props.theme}
            label={row.label}
            win={() => props.data()[row.key]}
            now={props.now}
          />
        ),
      ),
    ]
  }

  return (
    <box flexDirection="column">{renderContent as unknown as JSX.Element}</box>
  )
}

const tui: TuiPlugin = async (api, options) => {
  // tui.json 里以 [spec, options] 形式传入的配置，见 parseOptions 的容错说明。
  // 启动时解析一次；配置不热更新，改完要重启 opencode。
  const opts = parseOptions(options)

  // 配置决定启动样式；slash command 只覆盖当前 TUI 会话，不改额度请求状态。
  const [style, setStyle] = createSignal<StyleName>(opts.style)
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

  // OpenCode 新版使用 keymap 注册命令。这里做运行时能力守卫：命令是增强能力，
  // 即使某个宿主没有 registerLayer，也不能影响额度侧栏本身注册。
  const keymapApi = (
    api as unknown as {
      keymap?: {
        registerLayer?: (layer: {
          commands: ReadonlyArray<{
            namespace: "palette"
            name: string
            title: string
            desc: string
            category: string
            slashName: string
            run: () => void
          }>
          bindings: never[]
        }) => void | (() => void)
      }
    }
  ).keymap

  try {
    keymapApi?.registerLayer?.({
      commands: STYLE_COMMANDS.map((command) => ({
        namespace: "palette" as const,
        name: command.name,
        title: command.title,
        desc: command.description,
        category: "OpenCode Go",
        slashName: command.slashName,
        run: () => {
          setStyle(command.style)
          api.ui.toast?.({
            variant: "success",
            message: "OpenCode Go：已切换到 " + command.style + " 样式",
          })
        },
      })),
      bindings: [],
    })
  } catch {
    // keymap 是宿主增强 API；注册失败时保留静态配置样式和侧栏。
  }

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
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id: "opencode-go-usage", tui }

export default plugin
