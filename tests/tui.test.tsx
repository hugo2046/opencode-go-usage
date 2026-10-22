import { afterEach, describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { JSX } from "@opentui/solid"

const originalFetch = globalThis.fetch
const originalApiKey = process.env.OPENCODE_GO_API_KEY
const renderers: Array<{ destroy: () => void }> = []

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy()
  globalThis.fetch = originalFetch
  if (originalApiKey === undefined) delete process.env.OPENCODE_GO_API_KEY
  else process.env.OPENCODE_GO_API_KEY = originalApiKey
})

function usageResponse() {
  return new Response(
    JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 14, resetsAt: "2099-01-01T00:00:00.000Z" },
        weekly: { status: "ok", percent: 23, resetsAt: "2099-01-02T00:00:00.000Z" },
        monthly: { status: "ok", percent: 42, resetsAt: "2099-02-01T00:00:00.000Z" },
      },
    }),
    { status: 200 },
  )
}

function color(hex: string) {
  return RGBA.fromHex(hex)
}

function fakeTheme() {
  return {
    text: {
      base: color("#eeeeee"),
      muted: color("#999999"),
      feedback: {
        error: { base: color("#ff5555") },
        warning: { base: color("#ffaa00") },
        success: { base: color("#66dd88") },
        info: { base: color("#66aaff") },
      },
      action: {
        primary: { base: color("#66dd88") },
      },
    },
    background: {
      base: color("#111111"),
      raised: { base: color("#1b1b1b") },
    },
    border: { base: color("#333333") },
  }
}

type Claim = {
  append?: string
  render: (input: { sessionID: string }) => JSX.Element
}

type Command = {
  id?: string
  slash?: { name: string }
  run: () => void
}

describe("V2 TUI 接线", () => {
  test("注册 sidebar.content、三个样式命令，并能在命令后切换布局", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"
    globalThis.fetch = async () => usageResponse()

    const { default: plugin } = await import("../tui.tsx")
    const claims: Claim[] = []
    const commands: Command[] = []
    const toasts: Array<{ message: string; variant?: string }> = []
    let offIdleCalls = 0

    const ctx = {
      options: { style: "compact" },
      theme: fakeTheme(),
      data: {
        on: (_type: string, _handler: () => void) => {
          return () => {
            offIdleCalls++
          }
        },
      },
      keymap: {
        layer: (factory: () => { commands?: readonly Command[] }) => {
          const layer = factory()
          commands.push(...(layer.commands ?? []))
        },
      },
      ui: {
        slot: (claim: Claim) => {
          claims.push(claim)
          return () => {}
        },
        toast: {
          show: (options: { message: string; variant?: string }) => {
            toasts.push(options)
          },
        },
      },
    }

    const cleanup = await plugin.setup(ctx as never)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(claims).toHaveLength(1)
    expect(claims[0]!.append).toBe("sidebar.content")
    expect(commands.map((command) => command.slash?.name)).toEqual([
      "go-usage-compact",
      "go-usage-detailed",
      "go-usage-ledger",
    ])

    const first = await testRender(() => claims[0]!.render({ sessionID: "ses_test" }), {
      width: 42,
      height: 30,
    })
    renderers.push(first.renderer)
    await first.waitForFrame((frame) => frame.includes("滚动"), { maxPasses: 20 })

    commands.find((command) => command.slash?.name === "go-usage-ledger")!.run()
    expect(toasts.at(-1)).toEqual({
      variant: "success",
      message: "OpenCode Go：已切换到 ledger 样式",
    })

    const switched = await testRender(() => claims[0]!.render({ sessionID: "ses_test" }), {
      width: 42,
      height: 30,
    })
    renderers.push(switched.renderer)
    await switched.waitForFrame((frame) => frame.includes("5 小时滚动窗口"), {
      maxPasses: 20,
    })
    expect(switched.captureCharFrame()).toContain("5 小时滚动窗口")

    await cleanup?.()
    expect(offIdleCalls).toBe(1)
  })
})
