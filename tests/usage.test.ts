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
  resolveKey,
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
