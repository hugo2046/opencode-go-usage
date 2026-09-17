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
  stateDir: string | readonly string[],
  env: Record<string, string | undefined> = process.env,
): string | null {
  const fromEnv = env[ENV_KEY]?.trim()
  if (fromEnv) return fromEnv
  // 多候选：opencode 的 api.state.path.state 指向 XDG_STATE_HOME 下的运行时
  // 状态目录（kv.json / locks / model.json），而 auth.json 存在 XDG_DATA_HOME
  // 下的数据目录。两者是 XDG 规范里不同的目录，所以要逐个候选去找。
  const dirs = typeof stateDir === "string" ? [stateDir] : stateDir
  for (const dir of dirs) {
    if (!dir) continue
    try {
      const raw = readFileSync(join(dir, "auth.json"), "utf8")
      const parsed = JSON.parse(raw) as Record<string, { key?: string } | undefined>
      const key = parsed[AUTH_PROVIDER]?.key?.trim()
      if (key) return key
    } catch {
      // 该候选目录的 auth.json 缺失、无权限或 JSON 损坏，试下一个候选
    }
  }
  return null
}

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
 * @param timeoutMs 超时时长（毫秒），覆盖从请求发起到 body 读取完成的整个过程；默认 15 秒
 * @returns 三态取数结果
 */
export async function fetchUsage(
  key: string,
  baseUrl: string = DEFAULT_BASE_URL,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = TIMEOUT_MS,
): Promise<Snapshot> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  let body: unknown = null
  try {
    response = await fetchImpl(baseUrl.replace(/\/$/, "") + USAGE_PATH, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: controller.signal,
    })
    try {
      // body 读取必须仍在同一个 AbortController 的保护范围内：
      // 服务端可能只发响应头就不发完 body，若此时超时定时器已被清除，
      // response.json() 会永久悬挂，进而拖死上层的 inflight 状态机。
      body = await response.json()
    } catch {
      body = null
    }
  } catch (error) {
    return {
      kind: "soft-error",
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
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

/** 两次上游请求的最小间隔，防止刷新事件密集触发时打爆未公开端点。 */
const THROTTLE_MS = 20_000

/** {@link createRefresher} 的依赖注入表：时钟与 IO 全部由调用方提供，工厂本身不含 TUI 原语。 */
export type RefresherDeps = {
  /** 惰性解析密钥；返回 null 表示暂时没有可用密钥，本次刷新直接跳过。 */
  resolveKey: () => string | null
  /** 用密钥换一次快照；baseUrl / 真实 fetch 由调用方在闭包里绑定好。 */
  fetchUsage: (key: string) => Promise<Snapshot>
  /** 当前时间戳，用于节流判断；测试可注入假时钟，不必真等。 */
  now: () => number
  /** 拿到新快照（`ok`）时回调。 */
  onUsage: (usage: Usage) => void
  /** 命中 `dead`（无 Go 套餐 / 密钥无效）时回调，调用方应据此隐藏整节 UI。 */
  onDead: () => void
  /** stale 标记变化时回调：`soft-error` 时置 true，拿到新快照时置 false。 */
  onStale: (stale: boolean) => void
  /** 节流下限（毫秒），默认 20 秒；测试可覆盖成更小的值以缩短断言路径。 */
  throttleMs?: number
}

/** {@link createRefresher} 返回的句柄。 */
export type Refresher = {
  /**
   * 刷新一次额度。
   *
   * @param force 跳过节流；启动与兜底定时器用 true，事件触发用 false
   */
  refresh: (force: boolean) => Promise<void>
}

/**
 * 创建 spec §4 描述的刷新状态机：20 秒节流下限、`force` 绕过节流、
 * `inflight` 单飞、`dead` 闩锁后不再请求、`soft-error` 保留上次快照。
 *
 * 纯逻辑工厂，不引入任何 TUI / JSX / solid 依赖；时钟与网络 IO 均由 `deps` 注入，
 * 因此可以用假时钟与假 fetchUsage 在单测里驱动，不需要真等 20 秒或打真实网络。
 * `dead` 与 `inflight` 是工厂内部闭包状态，不对调用方暴露。
 *
 * @param deps 依赖注入表，见 {@link RefresherDeps}
 * @returns 带 `refresh` 方法的句柄
 */
export function createRefresher(deps: RefresherDeps): Refresher {
  const throttleMs = deps.throttleMs ?? THROTTLE_MS
  // dead 闩锁：命中一次 dead 后永久生效，后续 refresh 直接短路
  let dead = false
  // 单飞标志：同一时刻只允许一个请求在飞
  let inflight = false
  // 上次实际发起请求（非被节流拦下）的时刻
  let lastAt = 0

  const runRefresh = async (force: boolean): Promise<void> => {
    if (dead || inflight) return
    const at = deps.now()
    if (!force && at - lastAt < throttleMs) return
    const key = deps.resolveKey()
    if (!key) return
    inflight = true
    lastAt = at
    try {
      const snapshot = await deps.fetchUsage(key)
      if (snapshot.kind === "dead") {
        dead = true
        deps.onDead()
        return
      }
      if (snapshot.kind === "ok") {
        deps.onUsage(snapshot.usage)
        deps.onStale(false)
        return
      }
      // soft-error：保留上次快照，只把 stale 标记打开
      deps.onStale(true)
    } finally {
      inflight = false
    }
  }

  const refresh = async (force: boolean): Promise<void> => {
    try {
      await runRefresh(force)
    } catch {
      // 兜底：resolveKey / fetchUsage 理论上不应抛出，但 TUI 宿主状态未就绪等
      // 意外场景仍可能同步抛错。整体吞掉，避免 TUI 进程出现未处理 rejection
      // 污染渲染画面；不打印到 stdout/stderr，避免泄露密钥相关信息。
    }
  }

  return { refresh }
}

/** 进度条格数。 */
export const BAR_WIDTH = 14

/** TUI meter 使用的细线字符，避免整格背景色造成柱体过粗。 */
export const BAR_GLYPH = "─"

/** 侧栏三行的渲染顺序与中文标签。 */
export const ROWS = [
  { key: "rolling", label: "滚动", labelLong: "5 小时用量" },
  { key: "weekly", label: "本周", labelLong: "每周用量" },
  { key: "monthly", label: "本月", labelLong: "每月用量" },
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
/**
 * 进度条里「已用」的格数，TUI meter 与字符版共用这一处计算。
 *
 * @param percent 已用百分比，越界或非法值会被夹到 0-100
 * @param width 总格数
 * @returns 0 到 width 之间的整数
 */
export function barFilled(percent: number, width: number = BAR_WIDTH): number {
  const safe = Number.isFinite(percent) ? percent : 0
  const clamped = Math.min(100, Math.max(0, safe))
  return Math.round((clamped / 100) * width)
}

/**
 * 渲染定宽进度条的字符版本。
 *
 * TUI 渲染走的是细线 glyph（见 tui.tsx 的 Bar），不用这个；
 * 它留给脱离终端的场景——排障文档里那条数据层诊断命令就靠它在普通 stdout
 * 上打出条子。格数与 TUI meter 共用 {@link barFilled}，两者不会算出不同结果。
 *
 * @param percent 已用百分比，越界或非法值会被夹到 0-100
 * @param width 格数
 * @returns 由 █ 与 ░ 组成的定长字符串
 */
export function formatBar(percent: number, width: number = BAR_WIDTH): string {
  const filled = barFilled(percent, width)
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
  // 紧凑布局的百分比列只有 4 显示列，中文「已达上限」占 8 列会撑破排版，
  // 所以打满时用 3 字母的 MAX，右对齐后同样是 4 列。
  if (status === "rate-limited") return " MAX"
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

/** 标签列的显示宽度（中文按 2 列算，"滚动"/"本周"/"本月" 各 4 列，右侧留 2 列间距）。 */
export const LABEL_WIDTH = 6

/** 倒计时列的显示宽度，formatCountdownShort 保证不超过它。 */
export const COUNTDOWN_WIDTH = 6

/**
 * 紧凑倒计时，给一行式布局用（formatCountdown 的长文本版留给需要完整措辞的地方）。
 *
 * 输出宽度恒 ≤ COUNTDOWN_WIDTH 列，这是侧栏布局预算的前提：
 * 天数达到三位时省略小时（`106d`），否则最长是 `99d23h` / `23h59m`。
 *
 * @param resetsAt ISO 8601 时间串
 * @param now 当前时间戳
 * @returns 形如 `27d23h` / `4h14m` / `31m` 的短文本；已过期或无法解析给 `--`
 */
export function formatCountdownShort(resetsAt: string, now: number = Date.now()): string {
  const target = new Date(resetsAt).getTime()
  if (!Number.isFinite(target)) return "--"
  const ms = target - now
  if (ms <= 0) return "--"
  // 与 formatCountdown 一致：先折算到分钟再拆分，避免秒级抖动
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days >= 100) return `${days}d`
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${minutes}m`
  return `${minutes}m`
}

/** 颜色的 RGB 分量。分量可以是 0-1（opentui 的 RGBA 用这个刻度）或 0-255。 */
export type RgbLike = { r: number; g: number; b: number }

/**
 * 相对亮度，0（黑）到 1（白），用 Rec.709 权重。
 *
 * 分量刻度用启发式判断：≤1 视为 0-1 刻度并乘 255，否则视为 0-255。
 * 代价是 0-255 刻度下的极暗色（如 rgb(1,1,1)）会被当成 0-1 刻度的白，
 * 但 opentui 的 RGBA 统一是 0-1，实测 ayu 的 border 按此还原为 #6c7380 正确。
 *
 * @param color 颜色；null/undefined 或分量非有限值时返回 NaN
 * @returns 0-1 的亮度，无法计算时为 NaN
 */
export function relativeLuma(color: RgbLike | undefined | null): number {
  if (!color) return Number.NaN
  const to255 = (v: unknown) => {
    const n = typeof v === "number" ? v : Number.NaN
    if (!Number.isFinite(n)) return Number.NaN
    return n <= 1 ? n * 255 : n
  }
  const r = to255(color.r)
  const g = to255(color.g)
  const b = to255(color.b)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return Number.NaN
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/**
 * 两个颜色的亮度差是否够大。
 *
 * 用来在运行时挑进度条轨道色：主题的 `border` 语义上应当在背景上可见，
 * 但个别主题可能把它设得和背景几乎一样（ayu 的 `borderSubtle` 与
 * `background` 只差 0.03，拿来做轨道会完全看不见）。这个判断让渲染层
 * 能在真实颜色不合格时回退，而不是靠猜主题是深色还是浅色。
 *
 * @param a 颜色 A
 * @param b 颜色 B
 * @param minDelta 亮度差下限
 * @returns 任一颜色无法计算亮度时为 false
 */
export function hasEnoughContrast(
  a: RgbLike | undefined | null,
  b: RgbLike | undefined | null,
  minDelta: number = 0.12,
): boolean {
  const la = relativeLuma(a)
  const lb = relativeLuma(b)
  if (!Number.isFinite(la) || !Number.isFinite(lb)) return false
  return Math.abs(la - lb) >= minDelta
}

/** 主题色输入，用于选择在当前背景上可见的未使用轨道色。 */
export type TrackColorInput<Color extends RgbLike = RgbLike> = {
  /** 主题边框色。 */
  border: Color
  /** 主题背景色。 */
  background: RgbLike
  /** 主题弱文本色，作为边框不可见时的回退。 */
  textMuted: Color
}

/**
 * 为进度条选择能适配浅色和深色主题的轨道色。
 *
 * @param colors 当前主题的边框、背景与弱文本色
 * @returns 在背景上有足够亮度差的边框色，或 textMuted 回退色
 */
export function pickTrackColor<Color extends RgbLike>(colors: TrackColorInput<Color>): Color {
  return hasEnoughContrast(colors.border, colors.background) ? colors.border : colors.textMuted
}

/** 详细样式（样式 A）的进度条格数：它独占一行，所以可以比紧凑样式长。 */
export const BAR_WIDTH_DETAILED = 20

/** 可选的展示样式。 */
export type StyleName = "compact" | "detailed" | "ledger"

/** 可通过 OpenCode command palette / slash command 切换的样式命令。 */
export type StyleCommand = {
  /** 命令切换到的样式。 */
  readonly style: StyleName
  /** keymap 中的稳定命令名。 */
  readonly name: string
  /** command palette 中显示的标题。 */
  readonly title: string
  /** command palette 中显示的说明。 */
  readonly description: string
  /** slash command 名称，不含前导斜杠。 */
  readonly slashName: string
}

/** 三种布局的命令元数据；命令只切换布局，不触发额度请求。 */
export const STYLE_COMMANDS: readonly StyleCommand[] = [
  {
    style: "compact",
    name: "opencode-go-usage.style.compact",
    title: "OpenCode Go：紧凑样式",
    description: "三条横向用量条，适合快速扫读",
    slashName: "go-usage-compact",
  },
  {
    style: "detailed",
    name: "opencode-go-usage.style.detailed",
    title: "OpenCode Go：详细样式",
    description: "完整显示每档额度的进度与重置倒计时",
    slashName: "go-usage-detailed",
  },
  {
    style: "ledger",
    name: "opencode-go-usage.style.ledger",
    title: "OpenCode Go：账本样式",
    description: "突出 5 小时窗口，周/月作为次级信息",
    slashName: "go-usage-ledger",
  },
]

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
  /** 侧栏 slot 的 order，决定小节排在哪两个内置小节之间。 */
  order: number
}

/** `style` 缺省值。 */
const DEFAULT_STYLE: StyleName = "compact"

/** `order` 缺省值：落在内置 lsp(300) 与 todo(400) 之间。 */
const DEFAULT_ORDER = 350

/** 合法样式名集合，用于校验用户手写的配置。 */
const STYLE_NAMES: readonly StyleName[] = ["compact", "detailed", "ledger"]

/**
 * 解析 tui.json 里传给插件的 options。
 *
 * 入参来自用户手写的 JSON，所以任何形状都不能让它抛错：整体不是对象、字段
 * 类型不对、样式名拼错，一律回退到默认值并继续渲染，而不是让插件加载失败。
 *
 * @param raw tui.json 中 `[spec, options]` 的第二项
 * @returns 补全后的配置
 */
export function parseOptions(raw: unknown): PluginOptions {
  const source =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const style = source.style
  const order = source.order
  return {
    style:
      typeof style === "string" && (STYLE_NAMES as readonly string[]).includes(style)
        ? (style as StyleName)
        : DEFAULT_STYLE,
    order: typeof order === "number" && Number.isFinite(order) ? order : DEFAULT_ORDER,
  }
}
