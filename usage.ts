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
