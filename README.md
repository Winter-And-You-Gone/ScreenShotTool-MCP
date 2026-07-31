# ScreenShotTool MCP

> ⚠️ **截图很慢！每次 capture_window / capture_screen_region 需要 1-5 秒，且可能阻塞目标应用的渲染线程（PrintWindow 发 WM_PRINT 消息，目标必须同步响应）。**
> **优先用其他工具替代截图：** `list_windows` / `get_window_state` / `click_window` + 再次 `list_windows` 验证状态变化、从目标应用日志/文件读数据。**只在真正需要视觉内容时才截图。**

Windows 本地截图与窗口操控 MCP Server，供 Codex、Claude Code 等 MCP 客户端通过 stdio 调用。支持启动应用、发现窗口、截取窗口或屏幕区域、模拟鼠标/键盘操作、点击原生菜单。多数窗口操作支持 best-effort 后台模式：尽量不抢焦点、不移动鼠标、不改变用户当前前台窗口。

## 功能

- `launch_app` — 启动指定 `.exe`，可等待第一个可见窗口。`noActivate:true` 会在发现新窗口后恢复原前台窗口，并把目标窗口压到 z-order 底部；`startMinimized:true` 会在发现窗口后请求后台/最小化呈现。少数程序启动时仍可能短暂置顶或自行抢焦点。
- `list_windows` — 按 `pid`、进程名、标题关键字列出可见窗口。
- `capture_window` — ⚠️ 截图很慢（1-5s），尽量用其他工具替代。截取窗口。**默认使用 `captureMethod:"print"`（PrintWindow API）**，可截取被遮挡或最小化的窗口。仅当 `print` 模式抓不到的场景（如需要捕获 Qt ToolTip、Electron 子窗口等独立顶层弹窗）才改为 `captureMethod:"screen"`。`noActivate:true` 自动使用 PrintWindow，不操作 z-order，不闪烁。
- `capture_screen_region` — ⚠️ 截图很慢（1-5s），尽量避免使用。按屏幕绝对坐标截取矩形。
- `click_window` — 按窗口相对坐标投递鼠标点击消息，不移动主机物理鼠标。
- `move_mouse_window` — 按窗口相对坐标投递鼠标移动消息，不移动主机物理鼠标。
- `click_menu_item` — 按原生菜单路径触发菜单命令，支持中文菜单名，不移动主机物理鼠标。
- `close_app` — 用 `taskkill /T /F` 终止指定 `pid` 及其子进程树。
- `type_text` — 输入文本。`noActivate:true` 用 `PostMessage(WM_CHAR)` 直接投递到目标窗口的编辑控件，窗口无需焦点、无需前台。注意：对标准 Edit/RichEdit 控件可能走 `EM_REPLACESEL`，会**替换当前选区**而不是在光标处插入；若需要纯插入，先发一个取消选区的按键即可。
- `send_key` — 发送按键。`noActivate:true` 用 `PostMessage(WM_KEYDOWN/WM_KEYUP)`，窗口无需焦点。
- `read_clipboard` — 读取 Windows 剪贴板文本。无文本时返回 `available:false`。
- `write_clipboard` — 写文本到剪贴板（支持 Unicode、CJK、换行；传空串清空）。上限 1,000,000 字符。配合 `send_key` 的 Ctrl+V 比逐字符 `type_text` 快很多。
- `get_window_state` — 查询单个窗口的详细状态（minimized/maximized/foreground/topmost/layered/cloaked/style 等），比 `list_windows` 信息更全。
- `wait_for_window` — 阻塞等待匹配窗口出现 (`mode:"appear"`) 或消失 (`mode:"disappear"`)。超时返回 `found:false` 而不是抛错，比客户端轮询高效。

- **UI Automation 工具**（UIA 优先，详见下文 [UI Automation](#ui-automationuia) 章节）：`ui_inspect_tree` 读取控件树、`ui_query`/`ui_get` 查找控件、`ui_action` 通过 UIA Pattern 操作控件、`ui_wait` 等待状态变化、`profile_list`/`profile_resolve`/`profile_action` 操作应用 profile（如 VaporView）。这些工具不依赖截图或固定坐标，不移动真实鼠标。

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

## 后台模式

后台操作推荐显式传入 `noActivate:true`，截图时再配合 `captureMethod:"print"` 和 `focus:false`。这是一组 Win32 best-effort 策略，不是操作系统级沙箱：如果目标程序启动时主动调用 `SetForegroundWindow`、忽略窗口消息、或安全策略禁止后台输入，工具只能尽量恢复原前台窗口并把目标窗口压到底层。

| 工具 | noActivate 行为 |
|------|-----------------|
| `launch_app` | 新窗口出现后立即推到 `HWND_BOTTOM`，并恢复用户原来的前台窗口。发现窗口后会继续持续监控至少 8 秒，且不短于本次 `timeoutMs`：压制多窗口 app 的后续窗口、捕获 app 自激活恢复、以及覆盖较慢启动的窗口。使用 Alt 键技巧绕过 `SetForegroundWindow` 限制。当 app 启动超慢、`Wait-And-Suppress` 没能先发现窗口时，还有一个 fallback 阶段会对已找到的窗口补做持续压制。 |
| `capture_window` | 自动切换到 `PrintWindow` 模式，从窗口绘制表面直接捕获，无需操作 z-order，不会导致窗口闪现。 |
| `type_text` | 通过 `GetGUIThreadInfo` 定位焦点子控件（如 Scintilla、Edit），再用 `PostMessage(WM_CHAR)` 投递字符；窗口在后台时用 `EnumChildWindows` 按类名查找编辑控件。 |
| `send_key` | 用 `PostMessage(WM_KEYDOWN/WM_KEYUP)` 代替 `keybd_event`，无需前台焦点。 |

**完整示例——后台启动记事本、输入文字、截图、关闭：**

```json
// 1. 启动（best-effort 不抢焦点，并压到底层）
{ "exePath": "C:\\Windows\\System32\\notepad.exe", "waitForWindow": true, "noActivate": true, "startMinimized": true }

// 2. 输入文字（noActivate，PostMessage WM_CHAR 直达编辑控件）
{ "hwnd": "123456", "text": "Hello from background!", "noActivate": true }

// 3. 截图（默认 PrintWindow，不把窗口拉到前台）
{ "hwnd": "123456", "focus": false, "noActivate": true }

// 4. 关闭
{ "pid": 7890 }
```

VaporView 这类 Qt 程序建议使用同一套参数：

```json
// launch_app
{
  "exePath": "X:\\Project\\GPS\\VaporView\\build\\Release\\VaporView.exe",
  "waitForWindow": true,
  "timeoutMs": 10000,
  "noActivate": true,
  "startMinimized": true
}

// click_window: 本身使用窗口消息，不移动物理鼠标
{ "hwnd": "123456", "x": 535, "y": 50, "delayMs": 300 }

// capture_window（默认 PrintWindow）
{ "hwnd": "123456", "focus": false, "noActivate": true }
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

## 热重载

`npm start` 启动的 MCP server 默认启用工具层热重载：每次 `tools/list` 或工具调用前会检查 `dist/schemas.js`、`dist/windows.js` 和 `scripts/win-capture.ps1` 的修改时间；如果发生变化，会重新加载工具模块，并重启长驻 PowerShell helper。这样修改截图/点击/窗口操作逻辑后，通常不用重启 Codex 或 Inspector。

TypeScript 源码改动仍然需要先编译到 `dist/`。开发时可以另开一个终端运行：

```powershell
npm run build:watch
```

然后保持 MCP 客户端继续使用：

```powershell
npm start
```

热重载边界：

- `scripts/win-capture.ps1` 改动：下一次工具调用直接生效。
- `src/windows.ts` / `src/schemas.ts` 改动：`npm run build` 或 `npm run build:watch` 编译后，下一次工具调用生效。
- `src/index.ts`、依赖、启动参数、MCP transport 层改动：仍需重启 MCP server。
- 如需关闭热重载，可设置环境变量 `SCREENSHOTTOOL_HOT_RELOAD=0` 后再启动 server。

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
      "args": ["X:\\MCP\\ScreenShotTool\\dist\\index.js"],
      "cwd": "X:\\MCP\\ScreenShotTool"
    }
  }
}
```

开发期也可以用 `tsx` 直接运行 TypeScript 源码（无需每次构建）：

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

不同客户端的配置文件位置：
- **Claude Code**: `%APPDATA%\Claude\claude_desktop_config.json` 或 `~/.claude.json`
- **Codex CLI**: `~/.codex/config.toml`（TOML 格式，需要换种写法）
- **MCP Inspector**: `npm run inspect`

### 自检（不依赖客户端）

```powershell
# 单元测试
npm test                    # 期望全部通过

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
- ❌ 不要给 `type_text` 传超长字符串（单次最多 1000 字符，且会按 `delayMs + pressMs` 拒绝预计过慢的请求），分段发送更可靠
- ❌ 不要在 `click_window` 之后立刻 `capture_window`——加 `delayMs: 200` 给 UI 重绘时间

## UI Automation（UIA）

除了基于窗口坐标的操作，本工具还提供 **Microsoft UI Automation** 优先的控件读取与操作能力。UIA 通过控件的 `AutomationId` / `Name` / `ControlType` / `ClassName` / `FrameworkId` 定位，比截图或固定坐标更稳定，不受分辨率、DPI、窗口位置变化影响，也不需要移动物理鼠标。

### 为什么 UIA 优先于截图和固定坐标

- 截图很慢（1-5s）且只能看静态画面；UIA 直接读取控件树和状态，毫秒级返回。
- 固定坐标在 DPI 缩放、多显示器、窗口移动后会失效；UIA 控件定位与坐标无关。
- 截图无法读取控件值/状态（如文本框内容、勾选状态、下拉选中项）；UIA 通过 Pattern 直接读取。
- 截图不能"点击"；UIA 通过 `InvokePattern` / `ValuePattern` 等真正触发控件行为，且不移动真实鼠标。

### UIA 工具列表

| 工具 | 用途 |
|------|------|
| `ui_inspect_tree` | 读取目标窗口的 UIA 控件树（扁平 nodeId/parentNodeId 结构，带 patterns/boundingRect）。 |
| `ui_query` | 按 selector 查找控件，返回匹配元素及值/状态。 |
| `ui_get` | 读取**唯一**控件的状态（比 ui_query 轻）。0 个=found:false，1 个=状态，多个=ELEMENT_AMBIGUOUS。 |
| `ui_action` | 对控件执行动作（invoke/toggle/select/expand/setValue 等），优先用 UIA Pattern，坐标降级默认关闭。 |
| `ui_wait` | 等待 UI 状态变化（exists/enabled/valueEquals 等），不截图轮询。运行在独立 PowerShell 进程，不阻塞共享 worker。 |
| `profile_list` | 列出可用应用 profile（如 VaporView）。 |
| `profile_resolve` | 按 profile + 逻辑控件名解析为真实元素。 |
| `profile_action` | 对 profile 中的逻辑控件执行动作（内部复用 ui_action）。 |

### Selector 说明

`selector` 支持以下字段，至少提供一个定位字段：

| 字段 | 默认匹配 | 说明 |
|------|----------|------|
| `automationId` | exact | Qt 的 objectName、WPF 的 AutomationId。最稳定。 |
| `name` | exact | 控件显示文本（本地化敏感）。 |
| `controlType` | exact（不区分大小写） | 接受 `Button` / `ControlType.Button` / `button`。 |
| `className` | exact | Win32 窗口类名（如 `Edit`、`RICHEDIT50W`）。 |
| `frameworkId` | exact | `Win32` / `Qt` / `WPF` / `WinForm`。 |
| `match` | - | `exact`（默认）/ `contains` / `regex`。正则限长 256 字符。 |
| `caseSensitive` | false | 大小写敏感。 |
| `index` | - | 0-based。多匹配时必须提供，否则返回 ELEMENT_AMBIGUOUS。 |
| `visibleOnly` / `enabledOnly` | - | 过滤器（非定位字段）。 |
| `ancestor` | - | 祖先 selector，约束匹配元素的层级。 |
| `path` | - | 层级路径，从 root 逐级匹配（最多 12 级）。 |

> **不要把 `RuntimeId` 当作长期 selector**——它可能在 UI 重建后变化。`RuntimeId` 仅用于单次结果诊断。

### 各 Pattern 对应操作

| 控件类型 | 动作 | Pattern 优先级 |
|----------|------|----------------|
| 按钮 | invoke | InvokePattern → 坐标降级 |
| 开关/复选框 | toggle | TogglePattern → InvokePattern → 坐标降级 |
| 列表项/标签页 | select | SelectionItemPattern.Select → InvokePattern → 坐标降级 |
| 下拉框 | expand/collapse | ExpandCollapsePattern |
| 文本框 | setValue | ValuePattern（**不**用 WM_CHAR 替代） |
| 滑块 | setRangeValue | RangeValuePattern（**禁止**拖拽模拟） |
| 滚动到可见 | scrollIntoView | ScrollItemPattern |

> **LegacyIAccessiblePattern 不可用**：本工具使用的托管 `System.Windows.Automation` API 不暴露 `LegacyIAccessiblePattern`（它仅存在于 COM `IUIAutomation` 接口）。`legacyDefaultAction` 动作会退化为 InvokePattern，失败时按坐标降级（需显式开启）。这是 API 层限制，非缺陷。

### 坐标降级（默认关闭）

坐标降级是**严格受控的最终方案**，仅在以下条件**全部**满足时才使用：

1. 调用方显式传入 `allowCoordinateFallback: true`；
2. 元素唯一定位成功；
3. 元素有有效 BoundingRectangle；
4. 元素非 offscreen、宽高均 > 0；
5. 中心点位于目标窗口范围内；
6. UIA Pattern 不可用或调用失败。

降级时基于**当前** BoundingRectangle 动态计算中心点，转换为窗口相对坐标，复用 `click_window` 能力，**不移动真实鼠标**。profile 中**不允许**保存绝对屏幕坐标或固定分辨率坐标。

强制坐标点击需同时设置 `forceCoordinateClick: true` 和 `allowCoordinateFallback: true`。

### ui_inspect_tree 示例

```json
{
  "tool": "ui_inspect_tree",
  "arguments": {
    "processName": "VaporView",
    "interactiveOnly": true,
    "includeProcessPopups": true,
    "maxDepth": 10,
    "maxNodes": 1500
  }
}
```

返回扁平节点列表，每个节点含 `nodeId` / `parentNodeId` / `controlType` / `automationId` / `name` / `patterns` / `boundingRect`，以及 `truncated` 标记和 `elapsedMs`。

### ui_query 示例

```json
{
  "tool": "ui_query",
  "arguments": {
    "processName": "VaporView",
    "selector": {
      "controlType": "Button",
      "name": "设置"
    }
  }
}
```

### ui_action 示例

```json
{
  "tool": "ui_action",
  "arguments": {
    "processName": "VaporView",
    "selector": { "controlType": "Button", "name": "设置" },
    "action": "invoke",
    "allowCoordinateFallback": false
  }
}
```

### ui_wait 示例

```json
{
  "tool": "ui_wait",
  "arguments": {
    "processName": "VaporView",
    "selector": { "controlType": "Dialog" },
    "condition": "exists",
    "timeoutMs": 10000,
    "pollIntervalMs": 200
  }
}
```

超时返回 `matched:false`（不是错误）。`ui_wait` 运行在独立 PowerShell 进程，不会阻塞共享 worker 的其他工具调用。

### VaporView Profile

VaporView 的 profile（`vaporview`）通过源码中 `setObjectName()` 设置的稳定 AutomationId 映射关键控件，包括：

- `mainWindow`（标题为静态字符串 `"VaporView"`，FrameworkId 为 `Qt`）
- 窗口控制按钮：`windowMinimizeButton` / `windowMaximizeButton` / `windowCloseButton`
- 容器：`appCentralWidget` / `mainPageStack` / `appSidebar`
- 日志：`logTextEdit` / `logSidePanel`
- 设备配置下拉框：`epsilonPortCombo` / `pressurePortCombo` 等
- 菜单入口：`titleBarMenuButton` / `titleApplicationPanel`

```json
{
  "tool": "profile_action",
  "arguments": {
    "profile": "vaporview",
    "control": "windowCloseButton",
    "action": "invoke",
    "pid": 1234
  }
}
```

profile 找不到控件时会按候选 selector 顺序尝试，并返回每个候选的失败摘要。profile 层不直接调用 PowerShell，完全复用通用 UIA 层。

> **VaporView 需要管理员权限**：`VaporView.exe` 的 manifest 要求 `requireAdministrator`。非提权的 MCP server 无法读取其 UIA 树（完整性级别边界）。要让 profile 生效，**MCP server 必须以与 VaporView 相同的提权级别运行**（即以管理员身份启动）。

### VAPORVIEW_EXE 配置

VaporView smoke test 通过环境变量获取路径，不在源码中硬编码：

```powershell
$env:VAPORVIEW_EXE = "T:\VaporView\VaporView.exe"
# 可选启动参数
$env:VAPORVIEW_ARGS = "--no-hardware"
npm run smoke:uia-vaporview
```

未设置 `VAPORVIEW_EXE` 时输出 `SKIPPED`（不是失败）。路径不存在时报错退出。

### Qt 自绘控件的 UIA 限制

VaporView 等 Qt 应用的部分控件是自绘的（`QPainter` paintEvent），UIA 无法访问其内部视觉元素：

- `SegmentedSwitchButton`、`SingleLevelPopupMenuRow`、`VisualTextLabel` 等自绘控件只暴露整体对象，内部绘制内容不可访问。
- Qt 原生 `QMenuBar` 被 VaporView 隐藏（`menuBar()->hide()`），菜单项不作为标准 `MenuBar`/`MenuItem` 层级出现——需通过 `titleApplicationPanel` 或 `titleBarMenuButton` 操作。
- 标题栏工具栏按钮共享 objectName `titleBarButton`（非唯一），需通过 accessibleName/tooltip 区分，部分按钮未设置 accessibleName。

### 权限级别说明

UIA 跨进程访问受 **UIPI（User Interface Privilege Isolation）** 限制：

- **目标应用与 MCP server 的权限级别应尽量一致**。如果目标应用以管理员身份运行而 MCP server 是普通用户，UIA 读取会失败（返回空树或 `UIA_ROOT_UNAVAILABLE`）。
- **不要用管理员权限运行 `smoke:no-activate`** 等 `keybd_event` 测试（UAC 会阻止）。
- 如果 VaporView 必须以管理员运行，MCP server 也应以管理员启动。

### popup / tooltip 独立 HWND 说明

Qt 的下拉菜单、tooltip、弹出对话框通常是**独立顶层 HWND**（`Qt::Popup` / `Qt::Tool`），不在主窗口的子窗口树里：

- `includeProcessPopups: true`（默认）会枚举同 PID 的所有顶层窗口，每个作为独立 UIA Root 搜索。
- VaporView 的 `RtkConfigDialog`、`TrajectoryViewerDialog`、`Map3DWindow`、`SessionViewerWindow` 等都是同 PID 下的独立顶层窗口。
- QComboBox 弹出层（`SingleLevelPopupMenu` / `vaporViewComboPopupView`）是临时 `Qt::Popup` 顶层窗口，生命周期短。

### 调试控件树的方法

1. 先用 `ui_inspect_tree`（`automationIdOnly: true` 可只看有 AutomationId 的控件）了解结构。
2. 用 Windows 自带的 **Accessibility Insights for Windows** 或 **Inspect.exe** 交叉验证。
3. **不要高频调用 `ui_inspect_tree`**——每次都会遍历控件树，对大型 Qt 应用可能耗时几百毫秒到几秒。先 inspect 一次，记录稳定的 AutomationId，后续用 `ui_get` / `ui_query` 精确查询。
4. 不要把 `RuntimeId` 当作稳定 selector——它可能随 UI 重建变化。

### UIA smoke test 命令

```powershell
# 通用 UIA smoke test（用系统自带 WordPad/记事本，验证 inspect/query/setValue/invoke/wait 全流程）
npm run smoke:uia-notepad

# VaporView UIA smoke test（需设置 VAPORVIEW_EXE）
$env:VAPORVIEW_EXE = "T:\VaporView\VaporView.exe"
npm run smoke:uia-vaporview
```

`smoke:uia-notepad` 验证：启动 → inspect_tree → 找到 Document 控件 → ValuePattern 写入文字 → 读回值 → InvokePattern 点击 Close → ui_wait notExists → 物理鼠标未移动 → 前台窗口未被永久改变。

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

UI Automation smoke test（用系统自带 WordPad/记事本验证 UIA 全流程）：

```powershell
npm run smoke:uia-notepad
```

VaporView UIA smoke test（需设置 `VAPORVIEW_EXE`，未设置则输出 SKIPPED）：

```powershell
$env:VAPORVIEW_EXE = "T:\VaporView\VaporView.exe"
npm run smoke:uia-vaporview
```

用 MCP Inspector 手动验收：

```powershell
npm run build
npm run inspect
```

## 限制

- ⚠️ **不要尝试用 MCP 实现鼠标拖拽、拖动滑块、缩放、手势操作**——`click_window` 只发送按下+抬起消息，不支持连续移动。如果需要拖拽或任意复杂的鼠标操作，**直接请求人类用户手动完成**，你的描述清晰告诉用户需要做什么就好。
- ⚠️ **不要依赖 `move_mouse_window` 触发 tooltip、hover 效果、右键菜单等 UI 状态变化**——它只投递一个假的消息，不移动真实光标。Qt/Electron 等现代框架读取系统鼠标位置，不会响应假消息。需要此类交互时，**直接请求人类用户操作**。
- ⚠️ **截图很慢（1-5s），能不用就不用**——优先用 `list_windows` / `get_window_state` 或读应用日志替代。
- 只支持 Windows 桌面会话；需要 Node 20+。
- 不做 OCR、图像比对。
- `type_text` 的 `noActivate` 模式通过 `PostMessage(WM_CHAR)` 投递，少数自绘编辑控件可能不响应 `WM_CHAR`。
- `exePath` 要求绝对 `.exe` 路径。
- `args` 必须是字符串数组，不接受拼接后的命令行。
- 截图使用物理像素坐标；helper 会尝试启用 DPI aware，减少高 DPI 缩放偏差。
- 服务器进程持有一个长驻 PowerShell helper 进程，命中第一次启动后，后续每次工具调用约几十毫秒；helper 异常退出时会按需重启。
- **请求模型**：长驻 worker 是串行的——`list_windows`、点击、输入、剪贴板、窗口状态查询、`launch_app` 内部的 `wait-and-suppress` 等共享一个 stdin，worker 处理完前一个请求才会响应下一个。`capture_window`、`capture_screen_region`、`wait_for_window` 走独立 PS 进程，不阻塞其他工具。长时间操作（如超长 `type_text`，或 `launch_app noActivate` 的持续压制阶段）仍会占用共享 worker；相关 schema 和超时保护会限制单次请求的边界。
- **后台模式的极限**：`noActivate` 发现窗口后会持续压制至少 8 秒，且不短于本次 `timeoutMs`（默认约 10 秒）。如果目标应用在这段时间后才主动调用 `SetForegroundWindow`（极少见，多见于延迟加载插件或开机自启注册），窗口仍可能抢到前台。这是应用行为，工具侧已做到了合理覆盖。

### 截图模式与遮挡 / tooltip 的关键限制（Qt、Electron 类应用特别注意）

下面几条是 Win32 API 层面的硬限制，反复换参数也不会改变结果。**遇到这些场景时，应该在程序里换验证方式，而不是反复截图。**

- **`capture_window` 的 `screen` 模式按屏幕可见像素拷贝（`Graphics.CopyFromScreen`）**：它根本不看 hwnd，只看那块屏幕矩形当时显示了什么。如果目标窗口被遮挡、不在前台、或多显示器坐标偏移，就会抓到遮挡物。这是物理限制，工具层无法绕过。
- **`capture_window` 的 `print` 模式（`PrintWindow`）只绘制目标 hwnd 及其子窗口的客户区**：抓不到**独立顶层窗口**——典型例子是 Qt 的 `Qt::ToolTip`、`Qt::Popup` 弹窗、Electron 的子窗口、独立的下拉菜单。这些是带 `WS_EX_TOOLWINDOW` 的独立 hwnd，不在主窗口的子窗口树里，`EnumChildWindows` 也找不到。
- **`move_mouse_window` 用 `PostMessage(WM_MOUSEMOVE)` 投递窗口消息，但 Qt/Electron 的 tooltip 由 `QCursor::pos()` + hover 定时器驱动**：窗口消息不更新系统鼠标位置，所以 Qt 看到鼠标"还在别处"，不会启动 hover 计时器，**不会出现 tooltip**。这个工具对 Qt/Electron 的 hover 触发**基本无效**。
- **`capture_screen_region` 同 `screen` 模式**：按屏幕可见像素截取，受多显示器坐标、DPI、前台遮挡影响。如果目标区域被别的窗口盖住，截到的就是遮挡物。

**结论**：本工具适合抓**稳定的窗口内容**。对于「hover 触发 + 独立顶层 tooltip + 多显示器/遮挡」这类组合场景（典型如 Qt 应用），更可靠的验证方式是：
1. 在目标程序里临时加测试入口，强制显示 tooltip/弹窗后再截图；
2. 用真实鼠标 + 可交互录屏；
3. 让目标程序把要验证的 UI 状态写到日志/文件，工具读文件而非看图。
