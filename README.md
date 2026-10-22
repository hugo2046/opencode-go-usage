# opencode-go-usage

**中文** | [English](README.en.md)

在 [opencode](https://opencode.ai) 终端界面的侧栏里，实时显示 **OpenCode Go** 套餐的剩余额度：5 小时滚动窗口、每周、每月三档，一眼就能看到还剩多少、多久重置。

## 版本与兼容性

| 版本 | OpenCode | 说明 |
|---|---|---|
| `v0.1.0`（tag） | 1.x（≥1.18.30） | 仅支持 OpenCode V1 的 TUI 插件 API，已冻结；安装方式见该 tag 内的 README |
| `v0.2.x`（main） | 2.x（≥2.1.2） | 使用 OpenCode V2 的 `@opencode/plugin/tui` API，本文档描述此版本 |

OpenCode V2 不读取 V1 的 `tui.json` 插件入口，V1 也不读取 V2 的 `cli.json`。升级 OpenCode 前先确认插件版本。

<table>
  <tr>
    <th>compact（默认）</th>
    <th>detailed</th>
    <th>ledger</th>
  </tr>
  <tr valign="top">
    <td><img src="images/go-usage-compact.png" width="260" alt="compact 样式：三档额度各占一行，标签、进度条、百分比、倒计时并排"></td>
    <td><img src="images/go-usage-detailed.png" width="260" alt="detailed 样式：每档三行，标签与百分比、进度条、完整的重置倒计时"></td>
    <td><img src="images/go-usage-ledger.png" width="260" alt="ledger 样式：5 小时窗口放在带边框的主面板里，周和月作为下方的次级行"></td>
  </tr>
</table>

## 为什么需要它

OpenCode Go 按三档额度限流：5 小时滚动窗口、每周、每月。opencode 的终端界面里看不到用了多少，想知道只能去网页控制台查，往往是请求被限流了才发现额度用完。

这个插件把三档额度直接放进侧栏，在 `Context` / `MCP` / `LSP` 等内置小节之后。写代码时顺眼就能看到，用量过 70% 进度条变黄，过 90% 变红。

## 特性

- **零配置**：直接复用 `opencode auth login` 登录后保存的密钥，不用再填一遍
- **三种样式**：在配置里设定默认样式，也能用 slash 命令在当前会话里临时切换
- **跟随主题**：所有颜色都取自 opencode 当前主题的语义色，切换深色或浅色主题会自动适配
- **不浪费请求**：只在助手回复结束后刷新（至少间隔 20 秒），另有 5 分钟兜底刷新；倒计时在本地计算
- **出错不打扰**：没有 Go 订阅或没有密钥时，整节不显示；网络抖动时保留上次的数值，标题加一个 `!`

## 快速开始

**前提**：OpenCode ≥ 2.1.2、[bun](https://bun.sh)，以及一个有效的 OpenCode Go 订阅（用 `opencode auth login` 登录过）。

**1. 克隆并安装依赖**

```bash
git clone https://github.com/hugo2046/opencode-go-usage.git
cd opencode-go-usage
bun install
echo "$PWD"   # 记下这个仓库目录的绝对路径，下一步要用
```

**2. 注册插件**

编辑 `~/.config/opencode/cli.json`（OpenCode V2 的终端客户端全局配置，没有项目级等价文件）：

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["<上一步打印的绝对路径>"]
}
```

如果已经有 `cli.json`，把路径追加到 `plugins` 数组，保留你原有的 `theme`、`session` 和其他插件。

**3. 重启 opencode**

侧栏内置小节之后会出现 `OpenCode Go` 小节。V2 的 `sidebar.content` 只能追加，无法插到内置小节之间。

**没看到？** 插件在没有密钥、没有订阅、密钥失效、没被加载这四种情况下都会整节不显示，而且不报错。[排障指南](docs/排障指南_20260916.md#先跑这一条数据层诊断)里有一条命令，能直接查出是哪一种。

## 配置

把 `cli.json` 里的插件项从字符串改成对象：

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "<仓库绝对路径>",
      "options": { "style": "ledger" }
    }
  ]
}
```

| 字段 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `style` | `"compact"` \| `"detailed"` \| `"ledger"` | `"compact"` | 启动时使用的样式 |

改完要**重启 opencode**，`cli.json` 只在客户端启动时读取。值写错不会报错，会悄悄回退到默认值。

V2 删除了 V1 的 `order` 选项：`sidebar.content` 没有排序能力，额度小节固定追加在内置小节之后。

### 样式

| 样式 | 高度 | 特点 | 临时切换命令 |
|---|---|---|---|
| `compact` | 最矮 | 每档一行，适合快速扫一眼 | `/go-usage-compact` |
| `detailed` | 中等 | 每档三行，完整显示进度和重置倒计时 | `/go-usage-detailed` |
| `ledger` | 最高 | 5 小时窗口放进带边框的主面板，周和月作为次级行 | `/go-usage-ledger` |

slash 命令只切换当前会话；重启后会回到 `cli.json` 里设定的样式。如果你的 opencode 版本不支持注册命令，侧栏照常显示，只是不能用命令切换。

截图与深浅主题的验证方法见[样式切换指南](docs/OpenCodeGo样式切换指南_20260917.md)。

## 工作原理

**数据来源**：`GET https://opencode.ai/zen/go/v1/usage`，用 `Authorization: Bearer <密钥>` 认证。这是 opencode 官方的接口，但没有写进公开文档。

**密钥**：按以下顺序查找，插件自己不保存任何副本：

1. 环境变量 `OPENCODE_GO_API_KEY`
2. opencode 数据目录里的 `auth.json`，取其中的 `opencode-go.key`（macOS / Linux 默认在 `~/.local/share/opencode`）

**刷新时机**：

| 触发 | 说明 |
|---|---|
| 插件启动 | 立即拉取一次 |
| 助手回复结束 | 刷新一次，但距上次请求不足 20 秒时跳过 |
| 每 5 分钟 | 兜底刷新，覆盖在其他地方消耗额度的情况 |
| 每 60 秒 | 只在本地重算倒计时，不发请求 |

**出错时**：

| 情况 | 侧栏表现 |
|---|---|
| 没有 Go 订阅，或密钥无效（401 / 403） | 整节隐藏，并停止后续请求 |
| 没有找到密钥 | 整节隐藏，之后每次刷新会重新找密钥 |
| 网络错误、超时（15 秒）、服务端 5xx | 保留上次数值，标题变成 `OpenCode Go !` |

## 已知限制

- **百分比只有整数**：接口返回的就是整数。网页控制台显示的一位小数（如 `8.1%`）来自另一条数据通道，插件拿不到。
- **没有绝对用量**：接口只给百分比和重置时间，不给 token 数或金额。
- **依赖未公开的接口**：如果 opencode 修改了这个接口，插件可能会失效。
- **只在 OpenCode 2.1.2 上验证过**：V2 的 CLI 插件 API 仍可能随版本调整；升级 OpenCode 后请重新验证侧栏与命令。
- **侧栏位置固定在内置小节之后**：V2 没有 `order`；槽位支持 `prepend`/`append`/`before`/`after`/`replace`，但 `sidebar.content` 这一层无法插到 `LSP` 与 `Todo` 之间，本插件固定用 `append`。

## 文档

| 文档 | 内容 |
|---|---|
| [安装指南](docs/安装指南_20260916.md) | 从零开始，三步看到额度 |
| [样式切换指南](docs/OpenCodeGo样式切换指南_20260917.md) | 配置、命令、截图、深浅主题验证 |
| [排障指南](docs/排障指南_20260916.md) | 装了看不到、位置不对、数字不更新 |
| [配置与行为契约](docs/配置与行为契约_20260916.md) | 每个常量、格式、出错情况的准确定义 |
| [手工验证清单](docs/OpenCodeGo额度侧栏_手工验证清单_20260916.md) | 需要人工确认的验收项 |
| [设计规格（V2 迁移）](docs/superpowers/specs/2026-10-22-opencode-v2-migration-design.md) | V2 迁移的背景、API 映射与交付顺序 |
| [设计规格（V1，历史）](docs/superpowers/specs/OpenCodeGo额度侧栏_20260916.md) | v0.1.0 的原始设计，含调研结论和明确不做的事 |

## 开发

```
usage.ts      纯逻辑：密钥解析、接口请求、刷新状态机、格式化（不依赖终端界面）
tui.tsx       终端界面：侧栏渲染、样式切换、slash 命令注册
tests/        bun test 测试
docs/         文档
```

```bash
bun test              # 运行测试
bunx tsc --noEmit     # 类型检查
```

`usage.ts` 不依赖终端界面，全部由单元测试覆盖。`tui.tsx` 使用 `@opencode/plugin/tui` 的 `Plugin.define({ id, setup })`；`@opentui/*` 与 `solid-js` 由 OpenCode 运行时提供，本地安装只用于类型检查和测试。测试用 V2 假 context 覆盖槽位、命令与布局切换。

## 卸载

从 `~/.config/opencode/cli.json` 的 `plugins` 数组里删掉本插件那一项（如果这个文件里只有本插件，也可以直接删掉整个文件），然后重启 opencode。本插件从不改动你的 `opencode.json`。

## 许可证

[MIT](LICENSE)
