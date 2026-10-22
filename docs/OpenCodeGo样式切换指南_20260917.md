# How to 切换 OpenCode Go 额度侧栏样式

本指南说明如何在 OpenCode TUI 中选择额度侧栏的三种布局，并把实际运行截图与配置方式放在一起。你会看到 A、B、C 三个样式都保留，配置适合设置默认值，slash command 适合临时切换当前会话。

## 前置条件

- 已安装并注册 opencode-go-usage CLI 插件。
- OpenCode 版本 ≥ 2.1.2。
- 已重启 OpenCode。cli.json 只在客户端启动时读取。

## 三种样式

| 配置值 | 方向 | 适合场景 |
|---|---|---|
| compact | B · 一眼扫读 | 想用最少高度快速看三档百分比 |
| detailed | A · 终端原生 | 想完整看到每档标签、进度和重置语义 |
| ledger | C · 额度账本 | 最关心 5 小时窗口，同时保留周/月背景 |

其中 rolling 始终表示 5 小时滚动窗口，不是侧栏滚动位置。

### A · detailed

![OpenCode Go detailed 实际截图](../images/go-usage-detailed.png)

每个窗口占三行：标签与百分比、细线 meter、重置倒计时。它最适合需要完整语义的阅读方式。

### B · compact

![OpenCode Go compact 实际截图](../images/go-usage-compact.png)

三个窗口各占一行，滚动窗口明确标为 5 小时，适合在窄侧栏里扫读。

### C · ledger

![OpenCode Go ledger 实际截图](../images/go-usage-ledger.png)

5 小时窗口使用主指标块，周/月压缩为次级行。它比 detailed 节省高度，又比 compact 更突出当前窗口。

> 截图中的百分比、token 和倒计时是截图生成时的真实快照，不是文档里的固定示例值。

## 持久设置默认样式

编辑 OpenCode 的 CLI 配置文件：

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/绝对路径/opencode-go-usage",
      "options": { "style": "ledger" }
    }
  ]
}
```

把 style 改成 compact、detailed 或 ledger，然后完整退出并重新启动 OpenCode。

V2 没有 `order` 选项：槽位支持 `prepend` / `append` / `before` / `after` / `replace`，但无法插到内置小节之间；本插件固定用 `append`，额度小节出现在内置小节之后。

## 临时切换当前会话

在 OpenCode 的命令输入框或 command palette 中使用：

```text
/go-usage-compact
/go-usage-detailed
/go-usage-ledger
```

命令只改变当前 TUI 会话的布局，不重新请求额度、不改变密钥、不改变刷新间隔。重启后仍以 cli.json 的 style 为准。

这些命令使用 OpenCode 新版 TUI 的 keymap 注册入口；如果宿主没有可用的 keymap 能力，插件仍保留侧栏和配置切换。

## 浅色与深色主题

三种样式都从 OpenCode 当前主题读取颜色：

- 正常用量：`text.feedback.success.base`。
- 70% 及以上：`text.feedback.warning.base`。
- 90% 及以上或 rate-limited：`text.feedback.error.base`。
- 未用轨道：`border.base`；如果和背景对比不足，回退到 `text.muted`。
- ledger 主块：`background.raised.base` 与 `text.action.primary.base`。

切换主题后不需要改插件配置。若轨道仍然看不见，请先确认主题本身的 `text.muted` 与 `background.base` 是否有足够对比。

## 验证是否生效

1. 重启 OpenCode，确认侧栏内置小节之后出现 OpenCode Go。
2. 确认 rolling 标签对应 5 小时窗口。
3. 依次检查三种 style 的布局是否与上面的截图相符。
4. 在浅色和深色主题各检查一次文字、细线 meter、百分比和 ledger 主块。
5. 打开 command palette，搜索 OpenCode Go，确认三个样式命令出现。

数据诊断和密钥问题请看[排障指南](排障指南_20260916.md)；字段、刷新和主题 token 的完整契约请看[配置与行为契约](配置与行为契约_20260916.md)。

## 相关文档

- [安装指南](安装指南_20260916.md)
- [配置与行为契约](配置与行为契约_20260916.md)
- [手工验证清单](OpenCodeGo额度侧栏_手工验证清单_20260916.md)
