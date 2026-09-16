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
