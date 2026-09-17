import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AUTH_PROVIDER,
  BAR_GLYPH,
  DEFAULT_BASE_URL,
  ROWS,
  ENV_KEY,
  createRefresher,
  defaultStateDir,
  fetchUsage,
  barFilled,
  formatBar,
  formatCountdown,
  formatCountdownShort,
  formatPercent,
  hasEnoughContrast,
  parseOptions,
  pickTrackColor,
  relativeLuma,
  resolveKey,
  STYLE_COMMANDS,
  toneOf,
  type Snapshot,
  type Usage,
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

  // 多候选目录：opencode 的 api.state.path.state 指向 XDG_STATE_HOME 下的
  // 运行时状态目录（kv.json / locks / model.json），而 auth.json 存在
  // XDG_DATA_HOME 下的数据目录。两者是不同目录，所以必须逐个候选去找。
  test("多个候选目录：第一个没有 auth.json 时继续找第二个", () => {
    const empty = makeStateDir()
    const withKey = makeStateDir(JSON.stringify({ [AUTH_PROVIDER]: { key: "sk-second" } }))
    expect(resolveKey([empty, withKey], {})).toBe("sk-second")
  })

  test("多个候选目录：第一个 auth.json 缺 opencode-go 时继续找第二个", () => {
    const other = makeStateDir(JSON.stringify({ anthropic: { key: "sk-other" } }))
    const withKey = makeStateDir(JSON.stringify({ [AUTH_PROVIDER]: { key: "sk-second" } }))
    expect(resolveKey([other, withKey], {})).toBe("sk-second")
  })

  test("多个候选目录：命中第一个就不再往后找", () => {
    const first = makeStateDir(JSON.stringify({ [AUTH_PROVIDER]: { key: "sk-first" } }))
    const second = makeStateDir(JSON.stringify({ [AUTH_PROVIDER]: { key: "sk-second" } }))
    expect(resolveKey([first, second], {})).toBe("sk-first")
  })

  test("多个候选目录：全都没有时返回 null", () => {
    expect(resolveKey([makeStateDir(), makeStateDir()], {})).toBeNull()
  })

  test("多个候选目录：环境变量仍然优先于所有目录", () => {
    const withKey = makeStateDir(JSON.stringify({ [AUTH_PROVIDER]: { key: "from-file" } }))
    expect(resolveKey([withKey], { [ENV_KEY]: "from-env" })).toBe("from-env")
  })

  test("多个候选目录：空字符串候选被跳过", () => {
    const withKey = makeStateDir(JSON.stringify({ [AUTH_PROVIDER]: { key: "sk-ok" } }))
    expect(resolveKey(["", withKey], {})).toBe("sk-ok")
  })

  test("空候选列表返回 null 而不抛错", () => {
    expect(resolveKey([], {})).toBeNull()
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

  test("响应头已到但 body 永不 resolve 时，超时后判为 soft-error 而非悬挂", async () => {
    // 模拟服务端只发了响应头就不发完 body：json() 永不 settle，
    // 除非 AbortController 触发。用一个很短的注入超时让测试跑得快。
    const impl = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined
      return {
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")))
          }),
      } as unknown as Response
    }) as unknown as typeof fetch
    const snapshot = await fetchUsage("sk-test", DEFAULT_BASE_URL, impl, 20)
    expect(snapshot.kind).toBe("soft-error")
  })
})

describe("createRefresher", () => {
  /** 复用实测响应体做假快照。 */
  const SAMPLE_USAGE: Usage = OK_BODY.usage

  test("节流窗口内的非 force 调用被拒（不发起请求）", async () => {
    // 初始 now 取一个远大于节流窗口的值，让第一次非 force 调用能通过
    // （lastAt 初始为 0，若 now 也从 0 起会被误判为落在节流窗口内）。
    let now = 1_000_000
    let calls = 0
    const { refresh } = createRefresher({
      resolveKey: () => "sk-test",
      fetchUsage: async (): Promise<Snapshot> => {
        calls++
        return { kind: "ok", usage: SAMPLE_USAGE }
      },
      now: () => now,
      onUsage: () => {},
      onDead: () => {},
      onStale: () => {},
    })
    await refresh(false)
    expect(calls).toBe(1)
    now += 1_000 // 远小于 20s 节流窗口
    await refresh(false)
    expect(calls).toBe(1)
  })

  test("force: true 穿透节流", async () => {
    let now = 1_000_000
    let calls = 0
    const { refresh } = createRefresher({
      resolveKey: () => "sk-test",
      fetchUsage: async (): Promise<Snapshot> => {
        calls++
        return { kind: "ok", usage: SAMPLE_USAGE }
      },
      now: () => now,
      onUsage: () => {},
      onDead: () => {},
      onStale: () => {},
    })
    await refresh(false)
    now += 1_000
    await refresh(true)
    expect(calls).toBe(2)
  })

  test("并发第二次调用被 inflight 挡住", async () => {
    let now = 0
    let calls = 0
    let resolveFirst: (snapshot: Snapshot) => void = () => {}
    const { refresh } = createRefresher({
      resolveKey: () => "sk-test",
      fetchUsage: (): Promise<Snapshot> => {
        calls++
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      },
      now: () => now,
      onUsage: () => {},
      onDead: () => {},
      onStale: () => {},
    })
    const first = refresh(true)
    const second = refresh(true) // 第一次尚未 settle，第二次应被 inflight 挡住
    expect(calls).toBe(1)
    resolveFirst({ kind: "ok", usage: SAMPLE_USAGE })
    await Promise.all([first, second])
    expect(calls).toBe(1)
  })

  test("dead 之后不再发起任何请求", async () => {
    let now = 0
    let calls = 0
    const { refresh } = createRefresher({
      resolveKey: () => "sk-test",
      fetchUsage: async (): Promise<Snapshot> => {
        calls++
        return { kind: "dead", message: "no subscription" }
      },
      now: () => now,
      onUsage: () => {},
      onDead: () => {},
      onStale: () => {},
    })
    await refresh(true)
    expect(calls).toBe(1)
    now += 100_000
    await refresh(true)
    expect(calls).toBe(1)
  })

  test("soft-error 时不调用 onUsage（保留上次快照）而是 onStale(true)", async () => {
    let now = 0
    const usageCalls: Usage[] = []
    const staleCalls: boolean[] = []
    const { refresh } = createRefresher({
      resolveKey: () => "sk-test",
      fetchUsage: async (): Promise<Snapshot> => ({ kind: "soft-error", message: "network" }),
      now: () => now,
      onUsage: (u) => usageCalls.push(u),
      onDead: () => {},
      onStale: (s) => staleCalls.push(s),
    })
    await refresh(true)
    expect(usageCalls).toHaveLength(0)
    expect(staleCalls).toEqual([true])
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

  test("打满时显示 MAX，并且同样是 4 列（紧凑布局的列宽预算）", () => {
    expect(formatPercent(100, "rate-limited")).toBe(" MAX")
    expect(formatPercent(100, "rate-limited").length).toBe(4)
  })

  test("所有正常百分比都恰好 4 列", () => {
    for (const p of [0, 1, 8, 55, 99, 100]) {
      expect(formatPercent(p, "ok").length).toBe(4)
    }
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

// ── 紧凑布局（方向 B）新增的纯函数 ──────────────────────────────

describe("formatCountdownShort", () => {
  /** 与 formatCountdown 用同一个参考时刻，便于对照 */
  const now = Date.parse("2026-09-16T07:51:00.000Z")

  test("不足一小时只给分钟", () => {
    expect(formatCountdownShort("2026-09-16T08:22:31.724Z", now)).toBe("31m")
  })

  test("不足一天给小时+分钟", () => {
    expect(formatCountdownShort("2026-09-16T12:05:00.000Z", now)).toBe("4h14m")
  })

  test("超过一天给天+小时", () => {
    expect(formatCountdownShort("2026-09-21T00:00:00.724Z", now)).toBe("4d16h")
    expect(formatCountdownShort("2026-10-14T07:37:52.724Z", now)).toBe("27d23h")
  })

  test("已过期与非法时间串都给占位符", () => {
    expect(formatCountdownShort("2026-09-16T07:00:00.000Z", now)).toBe("--")
    expect(formatCountdownShort("not-a-date", now)).toBe("--")
  })

  test("输出永不超过 6 列（侧栏布局预算依赖这一点）", () => {
    const cases = [
      "2026-09-16T07:52:00.000Z", // 1m
      "2026-09-16T08:50:00.000Z", // 59m
      "2026-09-16T08:51:00.000Z", // 1h0m
      "2026-09-17T07:50:00.000Z", // 23h59m
      "2026-09-17T07:52:00.000Z", // 1d0h
      "2026-12-31T23:59:00.000Z", // 106d16h
    ]
    for (const c of cases) {
      expect(formatCountdownShort(c, now).length).toBeLessThanOrEqual(6)
    }
  })
})

describe("relativeLuma", () => {
  test("黑白两端", () => {
    expect(relativeLuma({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5)
    expect(relativeLuma({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5)
  })

  test("同时接受 0-1 与 0-255 两种分量刻度", () => {
    expect(relativeLuma({ r: 1, g: 1, b: 1 })).toBeCloseTo(1, 5)
    expect(relativeLuma({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5)
  })

  test("ayu 实测值可复现", () => {
    // border #6c7380 与 background #0b0e14，实测 luma 0.45 / 0.05
    expect(relativeLuma({ r: 0x6c, g: 0x73, b: 0x80 })).toBeCloseTo(0.45, 2)
    expect(relativeLuma({ r: 0x0b, g: 0x0e, b: 0x14 })).toBeCloseTo(0.05, 2)
  })
})

describe("hasEnoughContrast", () => {
  test("ayu 的 border vs background 差值足够（0.40）", () => {
    expect(
      hasEnoughContrast({ r: 0x6c, g: 0x73, b: 0x80 }, { r: 0x0b, g: 0x0e, b: 0x14 }),
    ).toBe(true)
  })

  test("ayu 的 borderSubtle vs background 差值不足（0.03）—— 正是不能拿它做轨道的原因", () => {
    expect(
      hasEnoughContrast({ r: 0x11, g: 0x15, b: 0x1c }, { r: 0x0b, g: 0x0e, b: 0x14 }),
    ).toBe(false)
  })

  test("阈值可注入", () => {
    const a = { r: 128, g: 128, b: 128 }
    const b = { r: 100, g: 100, b: 100 }
    expect(hasEnoughContrast(a, b, 0.01)).toBe(true)
    expect(hasEnoughContrast(a, b, 0.9)).toBe(false)
  })

  test("非法输入按无对比度处理，不抛错", () => {
    expect(hasEnoughContrast(undefined, { r: 0, g: 0, b: 0 })).toBe(false)
    expect(hasEnoughContrast({ r: 0, g: 0, b: 0 }, undefined)).toBe(false)
  })
})

describe("barFilled", () => {
  test("与 formatBar 的字符数始终一致（同一处计算，不会算出两个结果）", () => {
    for (const p of [0, 1, 8, 26, 53, 55, 99, 100, -50, 250, Number.NaN]) {
      for (const w of [10, 14, 20]) {
        expect(barFilled(p, w)).toBe([...formatBar(p, w)].filter((c) => c === "█").length)
      }
    }
  })

  test("默认宽度取 BAR_WIDTH=14（方向 B 的布局预算）", () => {
    expect(barFilled(100)).toBe(14)
    expect(barFilled(50)).toBe(7)
    expect(barFilled(0)).toBe(0)
  })

  test("格数永不越界", () => {
    for (const p of [-999, 0, 100, 999, Number.NaN, Number.POSITIVE_INFINITY]) {
      const n = barFilled(p, 14)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThanOrEqual(14)
    }
  })
})

describe("TUI meter glyph", () => {
  test("使用细横线而不是整格背景柱", () => {
    expect(BAR_GLYPH).toBe("─")
  })
})

describe("parseOptions", () => {
  test("缺省时给出默认值：紧凑样式 + order 350", () => {
    expect(parseOptions(undefined)).toEqual({ style: "compact", order: 350 })
    expect(parseOptions(null)).toEqual({ style: "compact", order: 350 })
    expect(parseOptions({})).toEqual({ style: "compact", order: 350 })
  })

  test("识别三种样式", () => {
    expect(parseOptions({ style: "compact" }).style).toBe("compact")
    expect(parseOptions({ style: "detailed" }).style).toBe("detailed")
    expect(parseOptions({ style: "ledger" }).style).toBe("ledger")
  })

  test("样式写错时回退到 compact 而不是抛错", () => {
    for (const bad of ["Detailed", "bogus", "", 1, true, null, {}, []]) {
      expect(parseOptions({ style: bad }).style).toBe("compact")
    }
  })

  test("order 可覆盖", () => {
    expect(parseOptions({ order: 600 }).order).toBe(600)
    expect(parseOptions({ order: 0 }).order).toBe(0)
    expect(parseOptions({ order: -10 }).order).toBe(-10)
  })

  test("order 非有限数字时回退到 350", () => {
    for (const bad of ["600", Number.NaN, Number.POSITIVE_INFINITY, null, {}, []]) {
      expect(parseOptions({ order: bad }).order).toBe(350)
    }
  })

  test("两项可同时给", () => {
    expect(parseOptions({ style: "detailed", order: 600 })).toEqual({
      style: "detailed",
      order: 600,
    })
  })

  test("整体不是对象时也不抛错", () => {
    for (const bad of ["compact", 42, true, [], () => {}]) {
      expect(parseOptions(bad)).toEqual({ style: "compact", order: 350 })
    }
  })

  test("忽略不认识的字段", () => {
    expect(parseOptions({ style: "detailed", nope: 1, barWidth: 99 })).toEqual({
      style: "detailed",
      order: 350,
    })
  })
})

describe("ROWS 的两套标签", () => {
  test("每档都有紧凑标签与详细标签", () => {
    expect(ROWS.map((r) => r.label)).toEqual(["滚动", "本周", "本月"])
    expect(ROWS.map((r) => r.labelLong)).toEqual(["5 小时用量", "每周用量", "每月用量"])
  })

  test("紧凑标签都是 2 个中文字符（等宽 4 列，布局预算依赖这一点）", () => {
    for (const r of ROWS) expect(r.label.length).toBe(2)
  })
})

describe("STYLE_COMMANDS", () => {
  test("为三种样式提供独立的 slash 命令", () => {
    expect(STYLE_COMMANDS.map((command) => command.style)).toEqual([
      "compact",
      "detailed",
      "ledger",
    ])
    expect(STYLE_COMMANDS.map((command) => command.slashName)).toEqual([
      "go-usage-compact",
      "go-usage-detailed",
      "go-usage-ledger",
    ])
  })
})

describe("pickTrackColor", () => {
  test("浅色主题的可见边框直接作为轨道色", () => {
    const border = { r: 0.35, g: 0.35, b: 0.35 }
    const background = { r: 1, g: 1, b: 1 }
    const textMuted = { r: 0.55, g: 0.55, b: 0.55 }
    expect(pickTrackColor({ border, background, textMuted })).toEqual(border)
  })

  test("深浅主题的边框不可见时回退到 textMuted", () => {
    const border = { r: 0.11, g: 0.11, b: 0.11 }
    const background = { r: 0.1, g: 0.1, b: 0.1 }
    const textMuted = { r: 0.45, g: 0.45, b: 0.45 }
    expect(pickTrackColor({ border, background, textMuted })).toEqual(textMuted)
  })
})
