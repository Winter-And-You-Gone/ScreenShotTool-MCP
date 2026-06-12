# ScreenShotTool MCP

Windows 本地截图与窗口操控 MCP Server，供 Codex、Claude Code 等 MCP 客户端通过 stdio 调用。支持启动应用、发现窗口、截取窗口或屏幕区域、模拟鼠标/键盘操作、点击原生菜单，所有操作均可不抢焦点、不闪窗口地在后台完成。

## 功能

- `launch_app` — 启动指定 `.exe`，可等待第一个可见窗口。`startMinimized:true` 让窗口最小化；`noActivate:true` 让窗口从出现瞬间就位于其他窗口后面，不抢占焦点、不遮挡当前屏幕。
- `list_windows` — 按 `pid`、进程名、标题关键字列出可见窗口。
- `capture_window` — 截取窗口。`captureMethod:"print"` 用 `PrintWindow` 拍被遮挡/最小化窗口；`noActivate:true` 自动使用 PrintWindow，不操作 z-order，不闪烁。
- `capture_screen_region` — 按屏幕绝对坐标截取矩形。
- `click_window` — 按窗口相对坐标投递鼠标点击消息，不移动主机物理鼠标。
- `move_mouse_window` — 按窗口相对坐标投递鼠标移动消息，不移动主机物理鼠标。
- `click_menu_item` — 按原生菜单路径触发菜单命令，支持中文菜单名，不移动主机物理鼠标。
- `close_app` — 用 `taskkill /T /F` 终止指定 `pid` 及其子进程树。
- `type_text` — 输入文本。`noActivate:true` 用 `PostMessage(WM_CHAR)` 直接投递到目标窗口的编辑控件，窗口无需焦点、无需前台。
- `send_key` — 发送按键。`noActivate:true` 用 `PostMessage(WM_KEYDOWN/WM_KEYUP)`，窗口无需焦点。

截图默认保存到：

```text
X:\MCP\ScreenShotTool\outputs\YYYYMMDD-HHMMSS-xxxxxx.png
```

工具返回 JSON 文本，包含：

```json
{
  "path": "X:\\MCP\\ScreenShotTool\\outputs\\20260524-120000-abc123.png",
  "width": 800,
  "height": 600,
  "target": "window:123456",
  "rect": { "x": 0, "y": 0, "width": 800, "height": 600 },
  "timestamp": "2026-05-24T04:00:00.0000000Z"
}
```

## noActivate 模式

所有涉及窗口交互的工具都支持 `noActivate:true`，实现**全程不打扰用户当前工作**：

| 工具 | noActivate 行为 |
|------|-----------------|
| `launch_app` | 新窗口出现后立刻推到所有窗口后面（`HWND_BOTTOM`），并恢复用户原来的前台窗口。使用独立的 PS 进程 + Alt 键技巧绕过 `SetForegroundWindow` 限制。 |
| `capture_window` | 自动切换到 `PrintWindow` 模式，从窗口绘制表面直接捕获，无需操作 z-order，不会导致窗口闪现。 |
| `type_text` | 通过 `GetGUIThreadInfo` 定位焦点子控件（如 Scintilla、Edit），再用 `PostMessage(WM_CHAR)` 投递字符；窗口在后台时用 `EnumChildWindows` 按类名查找编辑控件。 |
| `send_key` | 用 `PostMessage(WM_KEYDOWN/WM_KEYUP)` 代替 `keybd_event`，无需前台焦点。 |

**完整示例——后台启动记事本、输入文字、截图、关闭，全程不闪不抢焦点：**

```json
// 1. 启动（noActivate，不抢焦点）
{ "exePath": "C:\\Windows\\System32\\notepad.exe", "waitForWindow": true, "noActivate": true }

// 2. 输入文字（noActivate，PostMessage WM_CHAR 直达编辑控件）
{ "hwnd": "123456", "text": "Hello from background!", "noActivate": true }

// 3. 截图（noActivate，PrintWindow 无闪烁）
{ "hwnd": "123456", "noActivate": true, "captureMethod": "print" }

// 4. 关闭
{ "pid": 7890 }
```

## 安装与构建

```powershell
npm install
npm run build
```

开发时直接运行：

```powershell
npm run dev
```

构建后运行：

```powershell
npm start
```

---

## 🤖 给 AI Agent 的安装指引

> 这一节专门写给 Codex / Claude Code 等 AI Agent 阅读，按顺序执行即可完成安装和接入。

### 前置条件检查

```powershell
# 1. 必须是 Windows 桌面会话
[System.Environment]::OSVersion.Platform   # 期望: Win32NT

# 2. Node 版本必须 >= 20
node --version

# 3. 必须能调用 PowerShell（pwsh.exe 优先，否则 powershell.exe）
where.exe pwsh.exe
where.exe powershell.exe
```

如果 Node 缺失或版本过低，先告知用户并停止。**不要**自动安装 Node。

### 克隆 + 构建

```powershell
# 选一个目录（示例用 X:\MCP，你可以换成任意绝对路径）
cd X:\MCP
git clone git@github.com:Winter-And-You-Gone/ScreenShotTool-MCP.git
cd ScreenShotTool-MCP
npm install
npm run build
```

构建产物在 `dist/index.js`，**这就是 MCP 客户端要调用的入口**。

### 配置 MCP 客户端

把以下条目写入客户端的 `mcpServers` 配置（**绝对路径**必须用双反斜杠转义）：

```json
{
  "mcpServers": {
    "screenshottool": {
      "command": "node",
      "args": ["X:\\MCP\\ScreenShotTool-MCP\\dist\\index.js"],
      "cwd": "X:\\MCP\\ScreenShotTool-MCP"
    }
  }
}
```

不同客户端的配置文件位置：
- **Claude Code**: `%APPDATA%\Claude\claude_desktop_config.json` 或 `~/.claude.json`
- **Codex CLI**: `~/.codex/config.toml`（TOML 格式，需要换种写法）
- **MCP Inspector**: `npm run inspect`

### 自检（不依赖客户端）

```powershell
# 单元测试
npm test                    # 期望 24/24 通过

# 启动 + 关闭 Notepad 的端到端测试
npm run smoke:notepad

# 验证 noActivate 不抢焦点
npm run smoke:no-activate
```

如果 `smoke:no-activate` 失败，通常是因为：
1. 当前没有桌面会话（远程会话/服务模式跑不动）
2. UAC 阻止了 `keybd_event`（用普通用户权限运行即可，**不要**用管理员权限）

### 接入后的第一次调用

确认接入成功的最小调用：

```jsonc
// 1. 列出当前可见窗口（不会改变任何状态）
{ "tool": "list_windows", "arguments": {} }

// 2. noActivate 启动记事本（不抢焦点）
{ "tool": "launch_app", "arguments": {
    "exePath": "C:\\Windows\\System32\\notepad.exe",
    "waitForWindow": true,
    "noActivate": true
} }
```

返回的 `window.hwnd` 就是后续 `type_text`、`capture_window`、`click_window` 的目标。

### 常见错误

| 现象 | 原因 | 修复 |
|------|------|------|
| `exePath must be an absolute path` | 路径不是绝对路径 | 用 `C:\\Windows\\System32\\notepad.exe` 这类完整路径 |
| `outputPath must end with .png` | 输出路径后缀不对 | 省略 `outputPath` 让工具自动生成，或确保以 `.png` 结尾 |
| `PowerShell helper exited unexpectedly` | helper 进程崩溃（一般是首次启动慢） | 重试一次；持续失败查看 `outputs/` 同级是否有报错日志 |
| `noActivate` 模式下窗口仍然闪一下 | 极少数程序自身会调用 `SetForegroundWindow` | 这是程序行为，工具层面已尽力抑制 |
| 中文菜单匹配失败 | 旧版本 (< 73a9fa6) 的 ANSI 编码问题 | 拉取最新 main 重新构建 |

### 不要做的事

- ❌ 不要自动 `git pull` 升级——可能引入 break change
- ❌ 不要修改 `outputs/`、`dist/`、`.claude/` 目录——都被 gitignore
- ❌ 不要给 `type_text` 传超长字符串（>1000 字符），分段发送更可靠
- ❌ 不要在 `click_window` 之后立刻 `capture_window`——加 `delayMs: 200` 给 UI 重绘时间

---

## Codex / Claude Code 配置示例

构建后，把 MCP Server 配到客户端的 `mcpServers` 中：

```json
{
  "mcpServers": {
    "screenshottool": {
      "command": "node",
      "args": ["X:\\MCP\\ScreenShotTool\\dist\\index.js"],
      "cwd": "X:\\MCP\\ScreenShotTool"
    }
  }
}
```

也可以开发期使用 `tsx`：

```json
{
  "mcpServers": {
    "screenshottool": {
      "command": "npx",
      "args": ["tsx", "X:\\MCP\\ScreenShotTool\\src\\index.ts"],
      "cwd": "X:\\MCP\\ScreenShotTool"
    }
  }
}
```

## 示例调用

启动 Notepad：

```json
{
  "exePath": "C:\\Windows\\System32\\notepad.exe",
  "waitForWindow": true,
  "timeoutMs": 10000
}
```

截取窗口：

```json
{
  "hwnd": "123456",
  "focus": true
}
```

截图时保留已打开的菜单或浮层：

```json
{
  "hwnd": "123456",
  "focus": false
}
```

截取被遮挡/最小化的窗口（PrintWindow）：

```json
{
  "hwnd": "123456",
  "captureMethod": "print"
}
```

截取窗口内左上角区域：

```json
{
  "hwnd": "123456",
  "region": { "x": 0, "y": 0, "width": 300, "height": 200 }
}
```

截取屏幕区域：

```json
{
  "region": { "x": 0, "y": 0, "width": 800, "height": 600 }
}
```

点击窗口内按钮：

```json
{
  "titleContains": "VaporView",
  "x": 115,
  "y": 50,
  "button": "left",
  "delayMs": 300
}
```

`x` / `y` 是目标窗口左上角起算的物理像素坐标。`click_window` 会根据命中区域投递客户区或非客户区鼠标消息，不移动主机物理鼠标。常见流程是先 `capture_window` 看图，再估算要点击的窗口内坐标，调用 `click_window`，最后再次 `capture_window`。

点击原生菜单项（支持中文）：

```json
{
  "titleContains": "Notepad3",
  "path": ["帮助(&H)", "关于(&A)..."]
}
```

`path` 匹配会忽略 `&` 助记符、大小写和菜单文本中的快捷键后缀，例如 `帮助(&H)` 可以用 `帮助` 匹配。

悬停窗口内菜单项：

```json
{
  "titleContains": "VaporView",
  "x": 150,
  "y": 260,
  "delayMs": 300
}
```

## 测试

```powershell
npm test
```

Windows 桌面 smoke test 会打开并关闭 Notepad：

```powershell
npm run smoke:notepad
```

验证 noActivate 模式不抢焦点：

```powershell
npm run smoke:no-activate
```

验证无光标点击不会移动主机物理鼠标：

```powershell
npm run smoke:no-cursor-click
```

用 MCP Inspector 手动验收：

```powershell
npm run build
npm run inspect
```

## 限制

- 只支持 Windows 桌面会话；需要 Node 20+。
- 不做 OCR、图像比对。
- 鼠标点击/悬停使用窗口消息模拟，不调用 `SetCursorPos` / `mouse_event`，不会抢主机物理鼠标；少数程序可能忽略窗口消息。
- `type_text` 的 `noActivate` 模式通过 `PostMessage(WM_CHAR)` 投递，少数自绘编辑控件可能不响应 `WM_CHAR`。
- `exePath` 要求绝对 `.exe` 路径。
- `args` 必须是字符串数组，不接受拼接后的命令行。
- 截图使用物理像素坐标；helper 会尝试启用 DPI aware，减少高 DPI 缩放偏差。
- 服务器进程持有一个长驻 PowerShell helper 进程，命中第一次启动后，后续每次工具调用约几十毫秒；helper 异常退出时会按需重启。
