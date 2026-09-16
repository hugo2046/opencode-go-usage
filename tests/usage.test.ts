import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
