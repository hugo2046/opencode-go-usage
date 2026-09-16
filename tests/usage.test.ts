import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AUTH_PROVIDER, ENV_KEY, defaultStateDir, resolveKey } from "../usage.ts"

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
