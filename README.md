# opencode-go-usage

opencode TUI 插件：在侧栏展示 OpenCode Go 套餐的 5 小时 / 每周 / 每月额度。

## 显示内容

```
OpenCode Go
5 小时用量             8%
██░░░░░░░░░░░░░░░░░░
重置于 31 分钟
每周用量              53%
███████████░░░░░░░░░
重置于 4 天 16 小时
每月用量              27%
█████░░░░░░░░░░░░░░░
重置于 27 天 23 小时
```

渲染在 `sidebar_content` slot，紧随 opencode 自带的 `Context` / `MCP` / `LSP` 小节之后。

## 安装

需要 opencode >= 1.18.0。

```bash
cd ~/workspace/opencode-go-usage && bun install
```

在 `~/.config/opencode/tui.json` 注册（**不是** `opencode.json`，后者只加载 server 端插件）：

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/Users/hugo/workspace/opencode-go-usage/tui.tsx"]
}
```

重启 opencode 生效。

## 密钥

按以下顺序解析，插件自身不存储任何副本：

1. 环境变量 `OPENCODE_GO_API_KEY`
2. opencode 自己的 `<stateDir>/auth.json` 里的 `opencode-go.key`

没有密钥、没有 Go 套餐、或密钥失效时，整节不渲染 —— 不占行、不报错。

## 刷新

- 助手每次回复结束（`session.idle`）后刷新，最小间隔 20 秒；
- 另有 5 分钟兜底定时刷新；
- 倒计时文本每 60 秒本地重算，不发请求；
- 网络错误或 5xx 时保留上次数值，标题显示为 `OpenCode Go !`。

## 已知限制

上游 `/zen/go/v1/usage` 只返回**整数**百分比与 `resetsAt`，不返回 token 数或金额。
opencode 官方 web dashboard 显示的一位小数（如 `8.1%`）来自另一条更精细的通路，
本插件无法取到，因此只显示 `8%`。

## 测试

```bash
bun test
```

只覆盖 `usage.ts` 的纯函数（密钥解析、取数三态、格式化）；`tui.tsx` 的渲染靠手工验证。
