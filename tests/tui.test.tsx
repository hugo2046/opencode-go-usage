import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"

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

function fakeTheme() {
  return {
    mode: () => "dark" as const,
    selected: "dark",
    ready: true,
    has: () => true,
    set: () => true,
    install: async () => {},
    current: {
      text: "#eeeeee",
      textMuted: "#999999",
      error: "#ff5555",
      warning: "#ffaa00",
      success: "#66dd88",
      border: "#333333",
      background: "#111111",
      backgroundPanel: "#1b1b1b",
      borderActive: "#66dd88",
    },
  }
}

describe("TUI 样式命令", () => {
  test("命令注册提供三个样式入口，宿主重新解析 slot 后使用新布局", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"
    globalThis.fetch = async () => usageResponse()

    const { default: plugin } = await import("../tui.tsx")
    const commands: Array<{ slashName: string; run: () => void }> = []
    const entries: Array<{ slots: { sidebar_content: (ctx: { theme: unknown }) => unknown } }> = []
    const cleanups: Array<() => void> = []
    const api = {
      state: { path: { state: "" } },
      event: { on: () => () => {} },
      lifecycle: { onDispose: (fn: () => void) => cleanups.push(fn) },
      keymap: {
        registerLayer: (layer: { commands: Array<{ slashName: string; run: () => void }> }) => {
          commands.push(...layer.commands)
          return () => {}
        },
      },
      ui: { toast: () => {} },
      slots: {
        register: (entry: { slots: { sidebar_content: (ctx: { theme: unknown }) => unknown } }) => {
          entries.push(entry)
          return "slot"
        },
      },
    }

    await plugin.tui(api as never, { style: "compact" }, {} as never)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const setup = await testRender(
      () => entries[0]!.slots.sidebar_content({ theme: fakeTheme() }),
      { width: 42, height: 30 },
    )
    renderers.push(setup.renderer)
    await setup.waitForFrame((frame) => frame.includes("滚动"), { maxPasses: 20 })

    commands.find((command) => command.slashName === "go-usage-ledger")!.run()

    const switched = await testRender(
      () => entries[0]!.slots.sidebar_content({ theme: fakeTheme() }),
      { width: 42, height: 30 },
    )
    renderers.push(switched.renderer)
    await switched.waitForFrame((frame) => frame.includes("5 小时滚动窗口"), { maxPasses: 20 })
    expect(switched.captureCharFrame()).toContain("5 小时滚动窗口")

    for (const cleanup of cleanups) cleanup()
  })
})
