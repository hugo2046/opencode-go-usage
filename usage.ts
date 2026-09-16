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
