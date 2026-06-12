# ScreenshotTool MCP

Windows 本地截图 MCP Server，供 Codex、Claude Code 等 MCP 客户端通过 stdio 调用。首版支持启动 `.exe`、发现窗口、截取窗口或屏幕区域，并把 PNG 保存到本地 `outputs/` 目录。

## 功能

- `launch_app`: 启动指定 `.exe`，可等待第一个可见窗口。可传 `startMinimized:true` 让窗口出现后立即最小化。
- `list_windows`: 按 `pid`、进程名、标题关键字列出可见窗口。
- `capture_window`: 按 `hwnd` / `pid` / 进程名 / 标题关键字截取窗口，可传窗口内相对矩形，也可用 `focus:false` 保留弹出菜单/浮层；`captureMethod:"print"` 切换为 `PrintWindow` 模式（带 `PW_RENDERFULLCONTENT`），可对被遮挡或最小化的窗口取图。
- `capture_screen_region`: 按屏幕绝对坐标截取矩形。
- `click_window`: 按窗口相对坐标投递鼠标点击消息，不移动主机物理鼠标。
- `move_mouse_window`: 按窗口相对坐标投递鼠标移动消息，不移动主机物理鼠标，可用于悬停菜单项后截图。
- `click_menu_item`: 按原生菜单路径触发菜单命令，不移动主机物理鼠标，不使用键盘快捷键。
- `close_app`: 用 `taskkill /T /F` 终止指定 `pid` 及其子进程树。
- `type_text`: 聚焦窗口后通过 `SendInput(KEYEVENTF_UNICODE)` 输入文本，支持任意 Unicode 字符（含中文、emoji）。
- `send_key`: 发送单个按键或带修饰键的快捷键。

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

点击原生菜单项：

```json
{
  "titleContains": "Notepad3",
  "path": ["帮助", "关于"]
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
- `type_text` 通过 `SendInput(KEYEVENTF_UNICODE)` 投递，绕过键盘布局，但可能被全局键盘钩子记录。
- `exePath` 要求绝对 `.exe` 路径。
- `args` 必须是字符串数组，不接受拼接后的命令行。
- 截图使用物理像素坐标；helper 会尝试启用 DPI aware，减少高 DPI 缩放偏差。
- 服务器进程持有一个长驻 PowerShell helper 进程，命中第一次启动后，后续每次工具调用约几十毫秒；helper 异常退出时会按需重启。
