# OpenCode Go 额度侧栏 — 手工验证清单

**日期：** 2026-09-16
**对应实施计划：** `docs/superpowers/plans/OpenCodeGo额度侧栏_20260916.md` Task 4 Step 4 与"完成标准"

自动化部分已全部通过：`bunx tsc --noEmit` 干净、`bun test` 64/64、数据层已在真实上游端点端到端验证。
以下 7 项是**只有你能判断**的部分（需重启 opencode、肉眼核对视觉与主题），实现过程中刻意未执行，
以免中断你正在进行的 opencode 会话。

## 1. 小节位置与顺序

重启 opencode，进入任意会话，确认侧栏出现 `OpenCode Go` 小节，且：

- 位置在 `Context` / `MCP` / `LSP` **之下**；
- 若当前会话有 todo 或文件改动，`OpenCode Go` 应在 **Todo / Files 之上**（插件 `order: 350`，落在内置 `lsp`=300 与 `todo`=400 之间）；
- 三个窗口顺序是 **滚动 → 本周 → 本月**，每档一行（标签、实心进度条、百分比、倒计时）。

> 如果你更希望额度沉到侧栏最底（排在 Todo / Files 之下），把 `tui.tsx` 里的 `order: 350` 改成 `order: 600` 即可。

## 2. 百分比交叉核对

```bash
curl -s -H "authorization: Bearer $OPENCODE_GO_API_KEY" https://opencode.ai/zen/go/v1/usage
```

未设 `OPENCODE_GO_API_KEY` 环境变量时，密钥在 `~/.local/share/opencode/auth.json` 的 `opencode-go.key` 字段（不要把密钥值贴到聊天或日志里）。

比对返回 JSON 的 `rolling` / `weekly` / `monthly` 三个 `percent` 与侧栏显示是否一致。

> 上游只返回**整数** `percent`。opencode 官方 web dashboard 显示的一位小数（如 `8.1%`）来自另一条更精细的通路，本插件取不到。

## 3. 各列对齐与配色

确认三行的进度条、百分比、倒计时**各列竖直对齐**（列宽固定：标签 4 + 条 14 + 百分比 4 + 倒计时 6）。

同时确认：

- 节标题 `OpenCode Go` 的颜色与粗细和 `Context` / `MCP` / `LSP` **一致**（亮色粗体）；
- 进度条是**连续实心色块**，不是一格格的字符；
- 进度条的**轨道**（未用部分）看得见，没有完全融进背景；
- 百分比的颜色**跟进度条一致**（正常态绿、≥70% 黄、≥90% 或打满红），不是灰色。

## 4. 倒计时

确认三行倒计时与同一次 curl 返回的 `resetsAt` 相符；等一分钟后再看，分钟数应该会变（倒计时文本每 60 秒本地重算，不发请求）。

## 5. 事件驱动刷新

在会话里发一条消息，等助手回复完成，观察百分比是否在回复结束后数秒内自动更新（由 `session.idle` 驱动，20 秒节流内不重复请求；另有 5 分钟兜底刷新）。

## 6. 主题跟随

用 `/theme` 切换主题，确认文字与进度条颜色跟着变：正常态 `success` 色，≥70% `warning`，≥90% 或 `rate-limited` `error`。

## 7. 密钥失效场景

临时 `unset OPENCODE_GO_API_KEY`，并把 `auth.json` 里的 `opencode-go` 键改名（如 `opencode-go-bak`），重启 opencode，确认 `OpenCode Go` 整节**消失**且 TUI 无报错。改回原名（并按需恢复环境变量）后重启，确认恢复显示。

## 卸载

删除 `~/.config/opencode/tui.json` 即可完全回退。该文件由本次工作新建，你原有的 `opencode.jsonc` 未被改动。
