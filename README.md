# ScreenShotTool MCP

> ⚠️ **截图很慢！** 每次 `capture_window` / `capture_screen_region` 需要 1-5 秒，且可能阻塞目标应用的渲染线程（PrintWindow 发 WM_PRINT 消息，目标必须同步响应）。
> **优先用其他工具替代截图：** `list_windows` / `get_window_state` / `ui_get` / `ui_wait` 验证状态变化，或从目标应用日志/文件读数据。**只在真正需要视觉内容时才截图。**

一个**通用的 Windows UI Automation MCP Server**，供 Codex、Claude Code 等 MCP 客户端通过 stdio 调用。核心能力：

- 启动应用、发现窗口、截取窗口或屏幕区域、投递鼠标/键盘消息（不移动物理鼠标）。
- **UI Automation（UIA）优先**：读取控件树、按 selector 查询控件、通过 UIA Pattern 操作控件、等待状态变化。
- **App Pack 声明式适配**：任何桌面软件都可以通过一个 JSON 目录（App Pack）接入，无需修改 MCP 源码。
- **管道引擎**：`run_steps` / `profile_run_steps` / `run_workflow` 服务端串联多步操作，支持命名步骤、`exports`、后置条件（expect）、重试、finally 清理、状态恢复与失败续接（continue_run）。
- **机器可读工具契约**：`tools/list` 直接返回每个工具的 `inputSchema`、`outputSchema` 与标准 `annotations`（readOnlyHint/destructiveHint/idempotentHint/openWorldHint），`pipeSafeFields` 通过 `_meta` 携带；另有 `tool_contract_list` / `tool_contract_describe` 高层发现接口。所有工具调用（普通调用与管道步骤）都经过统一执行器做 input + output Schema 运行时校验。

## 目录

1. [快速开始](#快速开始)
2. [App Pack 是什么](#app-pack-是什么)
3. [创建自己的 App Pack](#创建自己的-app-pack)
4. [App Pack 文件格式](#app-pack-文件格式)
5. [加载本地私有 Pack](#加载本地私有-pack)
6. [验证 Pack](#验证-pack)
7. [生成 Pack 草稿](#生成-pack-草稿)
8. [使用 Workflow](#使用-workflow)
9. [profile_run_steps](#profile_run_steps)
10. [交互模式（interactionMode）](#交互模式interactionmode)
11. [命名步骤与 exports](#命名步骤与-exports)
12. [expect / retry / finally](#expect--retry--finally)
13. [续接失败的 run](#续接失败的-run)
14. [输出 Schema 与 structuredContent](#输出-schema-与-structuredcontent)
15. [安全限制](#安全限制)
16. [私有 Pack 与公共仓库](#私有-pack-与公共仓库)
17. [测试](#测试)

## 快速开始

前置条件：Windows 桌面会话、Node.js >= 20、可调用 PowerShell（pwsh.exe 优先）。

```powershell
git clone https://github.com/Winter-And-You-Gone/ScreenShotTool-MCP.git
cd ScreenShotTool-MCP
npm install
npm run build
npm test
```

在 MCP 客户端配置（stdio）：

```json
{
  "mcpServers": {
    "screenshottool": {
      "command": "node",
      "args": ["X:\\MCP\\ScreenShotTool\\dist\\index.js"],
      "env": { "MY_APP_EXE": "X:\\path\\to\\your-app.exe" }
    }
  }
}
```

首次接入推荐顺序（模型第一次使用时）：

```
已加载 App Pack：  app_pack_list → app_pack_describe → workflow_catalog → run_workflow
                  或 app_pack_describe → profile_run_steps
未知应用：         launch_app → ui_catalog → app_pack_probe → 创建 App Pack
                  → app_pack_validate → 加载 Pack
底层高级用户：     validate_steps → run_steps → continue_run
```

## App Pack 是什么

App Pack 是一个**声明式 JSON 目录**，把"某个软件的启动方式、窗口识别、逻辑控件名、UIA selector、动作契约、默认后置条件、可复用工作流"全部描述为数据。任何用户都可以为自己的 Windows 软件创建一个 App Pack，**不需要修改 MCP 源码**。

核心不包含任何具体软件的硬编码（启动、窗口、菜单、控件、工作流全部来自 Pack）。公共仓库只附带两个**通用示例 Pack**：

- `app-packs/examples/notepad/` — 记事本/编辑器（演示 launch、窗口识别、多候选 selector、剪贴板验证的输入工作流）。
- `app-packs/examples/generic-qt/` — 通用 Qt 应用（演示菜单路由 hints、模态对话框、ComboBox 契约）。

## 创建自己的 App Pack

1. 启动目标应用。
2. `app_pack_probe { "pid": <pid> }` 生成草稿（候选主窗口规则 + 控件清单 + controls.json 草稿）。
3. 复制 `app-packs/templates/` 到你的包目录，按草稿填写。
4. `app_pack_validate { "packPath": "你的包目录" }` 本地校验（不安装）。
5. 通过 `SCREENSHOT_MCP_APP_PACK_DIRS` 或本地目录加载，用 `run_workflow` / `profile_run_steps` 验证。

```powershell
$env:SCREENSHOT_MCP_APP_PACK_DIRS = "X:\Private\AppPacks;D:\Team\AppPacks"
```

## App Pack 文件格式

每个 App Pack 是一个目录，其中 `manifest.json` 与 `profile.json` 必须存在，其余文件可选：

```text
<pack-directory>/
├─ manifest.json    必选：id、版本、可见性、文件引用
├─ profile.json     必选：可执行文件、主窗口规则、启动与安全参数
├─ controls.json    逻辑控件名 → UIA selector 候选
├─ actions.json     控件+动作契约（幂等、可重试、defaultExpect）
├─ workflows.json   可复用命名工作流
└─ README.md        说明
```

完整 JSON Schema 见 `app-packs/schemas/`（`manifest.schema.json`、`profile.schema.json`、`controls.schema.json`、`actions.schema.json`、`workflows.schema.json`），模板见 `app-packs/templates/`。

```jsonc
// manifest.json
{ "schemaVersion": 1, "id": "example-app", "displayName": "Example App",
  "version": "1.0.0", "catalogVisibility": "session", "enabled": true }

// profile.json —— 禁止保存绝对路径、PID、HWND、坐标、凭据
{ "id": "example-app", "executableNames": ["Example.exe"],
  "executableEnv": "EXAMPLE_APP_EXE",
  "mainWindow": { "title": "^Example App$", "titleMatch": "regex", "frameworkId": "Qt" },
  "security": { "requiresAsInvoker": false } }

// controls.json
{ "controls": {
    "mainWindow": { "selectors": [{ "controlType": "Window", "name": "^Example App$", "match": "regex" }],
                    "confidence": "runtime-verified" },
    "confirmButton": { "selectors": [{ "automationId": "confirmButton$", "match": "regex", "controlType": "Button" }],
                       "confidence": "runtime-verified" } } }

// actions.json —— 幂等/可重试/默认后置条件
{ "contracts": [ { "control": "confirmButton", "action": "invoke",
                   "idempotent": false, "retrySafe": false,
                   "defaultExpect": { "profileControl": "resultPanel", "condition": "exists",
                                      "timeoutMs": 5000 } } ] }

// workflows.json —— ${pack.id} 由服务端注入
{ "workflows": [ { "id": "open_settings", "safe": true, "tested": true,
                   "steps": [
                     { "id": "launch", "tool": "profile_launch", "args": { "profile": "${pack.id}" },
                       "exports": { "pid": "pid" } },
                     { "id": "openSettings", "tool": "profile_action",
                       "args": { "profile": "${pack.id}", "pid": "${launch.pid}",
                                 "control": "settingsButton", "action": "invoke" } } ] } ] }
```

要点：

- `id` 必须匹配 `^[a-z][a-z0-9._-]{0,63}$`，与 profile.json 一致。
- `catalogVisibility`：`session`（对客户端可见）/ `hidden`（知道 id 可调用，不列出）/ `internal`（仅 Pack 内部工作流可用）。
- selector 支持 `automationId` / `name` / `controlType` / `className` / `frameworkId` + `match`（exact/contains/regex）+ `ancestor` / `path` / `index`。
- confidence 支持 `stable` / `conditionally-stable` / `fragile` / `source-derived` / `runtime-verified` / `unsupported` / `action-limited`。
- 菜单类控件用 `menu` hints 声明：`opensSubmenu`（键盘 Right 打开子菜单）、`invokeMode:"keyboard-enter"`（模态对话框命令的非阻塞触发）、`panelControl`（接收键盘事件的菜单面板窗口）、`sectionControl`（openMenu 枚举 section 的 selector）。

## 加载本地私有 Pack

加载来源优先级从高到低：

```text
1. 命令行 --app-pack-dir <dir>
2. 环境变量 SCREENSHOT_MCP_APP_PACK_DIRS（平台路径分隔符分号/冒号分隔多目录）
3. %APPDATA%\ScreenShotTool-MCP\app-packs
4. <项目>/local-app-packs/           （私有 Pack，gitignored）
5. <项目>/app-packs/examples/        （公共示例）
```

规则：

- 只扫描每个来源的**直接子目录**，每个子目录必须含 `manifest.json`。
- 同名 Pack 报 `PACK_ID_CONFLICT`，不静默覆盖。
- 引用文件必须位于 Pack 根目录内；`../` 与符号链接逃逸被拒绝（`PATH_ESCAPE`）。
- Pack 只包含 JSON，**不执行任何代码**。
- `app_pack_reload` 原子重载：新配置校验失败时保留旧配置；正在运行的管道继续使用启动时快照。

## 验证 Pack

```jsonc
// 校验已加载的 Pack
{ "pack": "example-app" }
// 本地校验一个目录（不安装）
{ "packPath": "X:\\Private\\AppPacks\\example-app" }
```

检查项：manifest/profile/controls/actions/workflows 的 Schema、control 引用、workflow 工具名、参数 Schema、输出引用路径、循环/前向引用、敏感字段、目录逃逸、绝对路径、重复 ID、未知动作、不安全重试（非幂等 + retrySafe）。返回 `{ valid, errors[], warnings[], checked[] }`。

## 生成 Pack 草稿

```jsonc
{ "pid": 12345, "includeProcessPopups": true }
```

`app_pack_probe` 返回：候选主窗口规则、可操作控件（稳定 automationId、推荐 selector、Patterns）、可能的菜单层级、输入控件、Dialog、无法访问控件，以及 `controls.json` / `profile.json` 草稿（可写入临时目录）。草稿**不会自动安装**。

## 使用 Workflow

```jsonc
{ "pack": "example-app", "workflow": "open_settings", "inputs": {} }
```

- 输入按 workflow 的 `inputSchema` 校验（required / additionalProperties）。
- `${pack.id}` 服务端注入；`${inputs.x}` 引用工作流输入。
- Pack 的 `defaultExpect` 自动生效；步骤可引用前序步骤：`${launch.pid}`。
- 返回 `runId`、命名步骤结果、`exports`、`finallyResults`。
- `internal` 可见性的工作流只能被 Pack 内部工作流调用，直接调用返回 `WORKFLOW_INTERNAL`。

## profile_run_steps

模型不需要重复传 `profile` / `pid` / `includeProcessPopups`：

```jsonc
{ "profile": "example-app", "launch": { "reuseIfRunning": true },
  "steps": [
    { "id": "openMenu", "control": "mainMenuButton", "action": "openMenu" },
    { "id": "openSettings", "control": "settingsButton", "action": "invoke" } ] }
```

服务端自动：`profile_launch`（可复用运行中实例）→ 注入 profile/pid/hwnd → 按 Pack selector 解析控件 → 复合动作（`selectByName` / `selectByIndex` / `openMenu` / `openSubmenu` / `ensureSelected`）处理同 PID popup 并验证前后状态 → 应用 `defaultExpect` → finally 清理。**永不移动物理鼠标。**

## 交互模式（interactionMode）

统一交互模式控制"是否允许把目标应用带到前台"。核心保持**通用**：未配置的软件
保持 `auto`（旧行为不变）；只有 App Pack 声明默认值或调用方显式传入时才改变行为。

三个模式：

- `auto`（默认）——旧行为，不做任何强制、不做任何承诺。
- `background`——严格后台：不抢占前台、不置顶、不移动物理鼠标、不用全局键盘输入；
  截图不要求目标窗口位于屏幕顶层；后台方法失败时**绝不静默升级为前台**。
- `foregroundDemo`——仅调用方**显式**指定时生效：允许恢复/激活/置顶目标窗口，允许菜单、
  弹窗在顶层出现；演示结束时**默认恢复用户原来的前台窗口**（`restorePreviousForeground`
  默认 `true`）。

### 优先级

```text
调用方显式 interactionMode → workflow 配置（workflows.json interactionMode）
→ App Pack profile 默认值（profile.json interaction.defaultMode）→ auto
```

### 支持的参数

以下高层工具支持可选参数（显式 `interactionMode` 优先级高于旧的
`noActivate` / `focus` 参数，两者统一换算为 interaction policy）：

```jsonc
{ "interactionMode": "background" }
{ "interactionMode": "foregroundDemo",
  "foregroundDemo": { "restorePreviousForeground": true, "stepDelayMs": 200 } }
```

- `profile_launch` / `profile_action` / `capture_window` / `run_steps` /
  `profile_run_steps` / `run_workflow`。

### Pack 声明：profile.json

```jsonc
{ "interaction": {
    "defaultMode": "background",
    "allowForegroundFallback": false,   // 必须保持 false：核心从不静默升级前台
    "backgroundPresentation": "behind", // 后台显示在用户当前前台窗口之后（默认）
    "restorePreviousForeground": true } }
```

### Pack 声明：actions.json backgroundPolicy

每个动作契约可声明后台能力：

```jsonc
{ "control": "sampleButton", "action": "invoke", "backgroundPolicy": "safe" }
```

- `safe`——已确认不需要激活窗口或全局输入。
- `bestEffort`——通常能后台完成，但应用或 UIA Provider 可能拒绝；失败返回明确错误，
  不自动升级前台。
- `foregroundRequired`——background 模式下执行前直接拒绝（`FOREGROUND_REQUIRED`）。

### 错误与管道预检

- background 无可用后台方法 → `FOREGROUND_REQUIRED`
  （details：`requestedMode/effectiveMode/foregroundChanged/reason/suggestedMode:"foregroundDemo"`）。
- 管道（`run_steps` / `profile_run_steps` / `run_workflow`）在 background 模式下包含
  `foregroundRequired` 步骤 → **执行任何步骤之前**返回 `PIPELINE_NOT_BACKGROUND_SAFE`，
  details 列出 `unsafeSteps: [{stepId, backgroundPolicy, suggestedMode}]`。
  `bestEffort` 步骤允许执行，运行时失败再返回明确错误。禁止执行到中途突然抢前台。
- 后台截图空白帧 → `BACKGROUND_CAPTURE_UNAVAILABLE`（不自动置顶重试）。
- 后台启动时若应用自身抢前台，核心尝试恢复原前台窗口并如实报告
  `foregroundChanged:true` / `foregroundRestored:true`；无法恢复时返回 warning，绝不谎报。

### 统一结果元数据 interaction

高层工具与管道结果新增 `interaction` 报告：

```jsonc
{ "interaction": { "requestedMode": "background", "effectiveMode": "background",
    "backgroundPolicy": "safe", "method": "InvokePattern",
    "foregroundBefore": "0x1A2B3C", "foregroundAfter": "0x1A2B3C",
    "foregroundChanged": false, "foregroundRestored": true,
    "targetActivated": false, "physicalCursorMoved": false } }
```

覆盖 `profile_launch` / `profile_action` / `profile_run_steps` / `run_workflow` /
`capture_window`（截图还报告真实 `captureMethod`）。`workflow_catalog` 与
`app_pack_describe` 公开 `defaultInteractionMode` / `backgroundPolicy` /
`foregroundRequiredSteps`，模型第一次使用时即可判断哪些 Workflow 可完全后台运行。

## 命名步骤与 exports

```jsonc
{ "steps": [
    { "id": "app", "tool": "profile_launch", "args": { "profile": "example-app" },
      "exports": { "pid": "pid", "hwnd": "hwnd" } },
    { "id": "check", "tool": "ui_wait",
      "args": { "pid": "${app.pid}", "selector": { "controlType": "Window" }, "condition": "exists" } } ] }
```

- 引用：`${app.pid}`（命名）、`${0.pid}`（旧数字引用，保持兼容）、`${pack.id}`、`${inputs.x}`。
- Step id 规则 `^[A-Za-z][A-Za-z0-9_-]{0,63}$`，必须唯一；保留名 `vars/env/steps/results/run/pack/inputs`。
- exports 在步骤完成后立即校验：路径存在、中间节点非 null、类型正确、**敏感字段名禁止**（password/token/credential/secret/authorization/cookie）。错误码 `EXPORT_PATH_NOT_FOUND` / `EXPORT_VALUE_NULL` / `EXPORT_SENSITIVE_VALUE_BLOCKED` 等。
- 限制：每步最多 32 个 exports、路径 ≤256 字符、嵌套深度 ≤16、单字符串 ≤64 KiB。

## expect / retry / finally

**步骤成功 = 工具执行成功 AND 后置条件匹配。** 仅 InvokePattern 未报错不算完成。

```jsonc
{ "id": "openDialog", "tool": "profile_action",
  "args": { "profile": "example-app", "pid": "${app.pid}", "control": "settingsButton", "action": "invoke" },
  "expect": { "profileControl": "settingsDialog", "condition": "exists", "timeoutMs": 5000 },
  "retry": { "maxAttempts": 3, "delayMs": 200, "onlyCodes": ["ELEMENT_NOT_AVAILABLE", "POPUP_NOT_READY"] } }
```

- 条件：`exists/notExists/visible/hidden/enabled/disabled/valueEquals/valueContains/toggleStateEquals/selected/notSelected/expanded/collapsed/countEquals`。
- 超时错误：`STEP_POSTCONDITION_TIMEOUT`。
- `actions.json` 的 `defaultExpect` 在调用方未提供 expect 时自动生效；显式 expect 优先；`expect:false` 关闭（返回 warning）。
- 默认可重试：`ELEMENT_NOT_AVAILABLE / UIA_ROOT_UNAVAILABLE / TARGET_WINDOW_NOT_READY / POPUP_NOT_READY / PROVIDER_BUSY`。**不可重试**（除非 `onlyCodes` 显式列出）：`ELEMENT_AMBIGUOUS / WINDOW_AMBIGUOUS / INVALID_SELECTOR / INVALID_PARAMS / PATTERN_NOT_SUPPORTED / PASSWORD_VALUE_PROTECTED / TOOL_OUTPUT_SCHEMA_MISMATCH`。非幂等动作不自动重试；`validate_steps` 对非幂等 + retry 报 `UNSAFE_RETRY`。
- finally：主流程成功或失败都执行；失败单独记录、不覆盖主错误；`ignoreCodes` 容忍指定错误码。
- 状态恢复：`captureBefore` 在操作前读取控件的**类型化状态**（value / toggle / selection / range / expanded / visibility / page），`restore: "always" | "never" | "onFailure"` 在 finally 用匹配的反向动作恢复（setValue / setChecked / selectByName / setRangeValue / expand|collapse / ensureSelected），恢复后**重新查询 UI 验证**（真实重读，绝不用保存值自证）。密码控件禁止捕获/恢复/导出（`RESTORE_SENSITIVE_STATE_BLOCKED`）；无法可靠读取的状态不执行猜测式恢复（`RESTORE_STATE_UNAVAILABLE`）。旧格式 `{saveAs, read}` 自动映射为 `value` 类型；`{saveAs, state:"auto"}` 按控件状态自动检测。
- **selection 恢复**：捕获的是操作前**真实选中项**（`element.value`/`selectedName` + provider 暴露的 `selectedIndex`，必要时通过列表项扫描读取），绝不使用步骤的目标 `value`/`index` 参数。恢复顺序：有可靠 name → `selectByName` 并验证；name 失败且有原始 index → `selectByIndex(originalIndex)` 并验证；两者皆不可得 → `RESTORE_STATE_UNAVAILABLE`（不猜测）。
- **page 恢复**：页面组由控件/动作契约的可选 `selectionGroup` 声明（同组控件互斥）。捕获在动作前逐个查询同组控件，找到**唯一**选中（toggleState On / selected true）的作为原页面——绝不把动作目标当原页面；0 个或多个选中 → `RESTORE_STATE_UNAVAILABLE`。恢复对原页面 `ensureSelected`，验证时重查原页面 selected 且目标页面不再 selected。
- restore 结果包含 `{kind, attempted, success, verified, code, message}`；错误码：`RESTORE_STATE_UNAVAILABLE`（原状态不可读，不执行恢复）/ `RESTORE_VERIFICATION_FAILED`（已恢复但状态不匹配）/ `RESTORE_SENSITIVE_STATE_BLOCKED`（密码/敏感状态禁止捕获）。

## 续接失败的 run

`run_steps` / `profile_run_steps` / `run_workflow` 都返回 `runId`。失败后：

```jsonc
{ "runId": "run_abc123", "continueFrom": "openSettings" }
```

续接前检查：run 未过期（内存保留 10 分钟，最多 20 个）→ Pack 版本未变（`RUN_PACK_VERSION_CHANGED`）→ 进程仍存在（`RUN_PROCESS_EXITED`）→ HWND 仍有效（`RUN_WINDOW_RECREATED`）→ 快照可续接（`RUN_NOT_CONTINUABLE`）。续接从失败步骤重放，已完成步骤的**最小投影**（后续步骤引用的字段 + pipe-safe 字段 + exports）复用，不重复执行、不保存完整原始结果。超大的快照（含被引用的巨型字段）如实标记 `continuable:false` + `continuationReason:"RUN_SNAPSHOT_TRUNCATED"`，绝不伪装成可恢复。

## 输出 Schema 与 structuredContent

每个工具在 `src/contracts.ts` 有统一 `ToolContract`：`description`、`inputSchema`、`outputSchema`、`pipeSafeFields`、`annotations`（readOnly / destructive / idempotent / retrySafe / needsExpect）。

稳定公共输出字段：`schemaVersion / success / pid / hwnd / title / found / count / element / elements / value / matched / timedOut / code / message / details`。

- 工具成功结果同时返回 `content`（JSON 文本，保持兼容）与 `structuredContent`（机器可读对象）。
- 管道中每个步骤的结果都会用该工具的 `outputSchema` 做运行时校验，不符合返回 `TOOL_OUTPUT_SCHEMA_MISMATCH`，**无效结果不会流入后续步骤**。

## 安全限制

- 每条管道 ≤50 步、finally ≤20 步、每步 ≤32 exports、引用深度 ≤16、单步结果 ≤1 MiB、整条结果 ≤5 MiB、默认总超时 120s、最大重试 5 次、最多 20 个 run、TTL 10 分钟。
- 最多加载 64 个 Pack；每个 Pack ≤1000 controls、≤200 workflows。
- 禁止：`eval` / `Function` 构造器 / 任意脚本 / 任意 PowerShell / JSONPath 脚本表达式 / 从 Pack 读取环境变量值 / 访问 Pack 外文件 / 从 Pack 发起网络请求 / 跨 run 未授权引用 / 密码写入日志。
- 禁止：`SetCursorPos`、真实鼠标 SendInput、固定坐标点击、OCR 坐标点击、图像模板点击。降级链全部使用窗口消息或键盘输入，`physicalCursorMoved` 恒为 false。

## 私有 Pack 与公共仓库

- `local-app-packs/`、`private-app-packs/`、`runtime-app-pack-cache/`、`outputs/` 已被 `.gitignore` 忽略。
- **私有 Pack 不得提交到公共仓库**：本机绝对路径、控件清单、工作流细节属于私有时，不要放入公共 README 或测试。
- 本仓库的实机验证使用本地 Qt 应用 App Pack（通过环境变量提供可执行文件路径），其配置不包含在公共仓库中。公共测试脚本只读取 `SCREENSHOT_MCP_TEST_PACK` / `SCREENSHOT_MCP_TEST_EXE` / `SCREENSHOT_MCP_APP_PACK_DIRS` 环境变量，不写死任何私有应用名。

## 测试

```powershell
npm test                          # 单元测试（App Pack / pipeline / executor / contracts / workflows / runs / piping / schemas / UIA）
npm run smoke:app-pack            # App Pack + 管道 e2e（公共示例 Pack；含 reload 坏配置 → reloaded:false）
npm run smoke:run-steps           # run_steps 顺序/管道/停链语义
npm run smoke:continue-run        # runId / continue_run e2e
npm run smoke:workflow            # workflow_catalog / run_workflow e2e
npm run smoke:first-use-pipeline  # fresh-process 稳定性基准（默认 20 次迭代）
npm run smoke:public-contract-pipeline  # 公开契约驱动管道测试（不读取源码）
npm run smoke:page-fixture          # 页面恢复实机 fixture（临时 WPF 应用，3 页互斥导航）
npm run smoke:uia-notepad         # 通用 UIA smoke（系统编辑器）
npm run smoke:private-app-pack    # 私有 Pack 驱动（读 SCREENSHOT_MCP_TEST_PACK 等环境变量）
# 以及既有 smoke：notepad / type-text / menu-click / no-cursor-click / print-capture /
# p1-fixes / perf / no-activate / clipboard / window-state / wait-for-window
```

### 关于 benchmark 的准确表述

- `smoke:first-use-pipeline` 是 **fresh-process pipeline stability benchmark**（固定工作流的进程级稳定性）与 **contract-driven first-use simulation**（公开契约驱动的首次使用模拟）：每次迭代启动全新服务器进程，仅通过 `tools/list`、`app_pack_describe`、`workflow_catalog` 等公开能力驱动固定工作流。它**不是**真实大模型自主生成管道的测试。
- 统计严格区分：`workflowFirstAttemptSuccessRate` / `pipelineFirstAttemptSuccessRate`（首次尝试，不含 continue 恢复）、`*EventuallySuccessRate`（最终成功，允许一次 continue_run 恢复）、`continueRecoverySuccessRate`、`cleanupSuccessRate`（finally 独立）、`infrastructureFailureCount`（服务器/传输失败，不计为工作流失败）。
- `continueRecoverySuccessRate` 的分母是 **`continueAttempts`（实际 continue_run 调用次数）**，不是迭代次数；`continueRecoverySuccessCount` 表示**成功的 continue_run 调用次数**（同一 iteration 内多次 continue 各自独立计数），而非发生过恢复成功的 iteration 数量；0 次尝试时返回 `null`（绝不用 0 伪装成"恢复全部失败"）。continue 成功从不改变 firstAttempt 统计。
- 环境前提：键盘类步骤（type_text / send_key）依赖前台焦点。残留的编辑器实例（多个同进程名窗口）或前台全屏程序会抢占焦点并拉低 first-attempt 成功率（实测：清理残留实例后 20/20）。
- 真实不同模型的自主生成成功率需要单独评测：仅凭公开工具契约构造合法管道由 `smoke:public-contract-pipeline` 证明——该测试不导入任何 `src/` 实现，只通过 MCP 客户端读取契约并构造、校验、执行管道。

热重载：默认启用（`SCREENSHOTTOOL_HOT_RELOAD=0` 关闭）。修改 `src/` 或 `scripts/win-capture.ps1` 后无需重启。

## 限制（真实，已实机确认）

- `click_window` / `move_mouse_window` 只投递窗口消息：不支持拖拽、手势、真实 hover。Qt/Electron 应用读取系统光标位置，假消息不会触发 tooltip/右键菜单——需要时请请求人类操作。
- PrintWindow 无法捕获独立顶层弹窗（Qt ToolTip、菜单面板、Electron 子窗口）；`captureMethod:"screen"` 捕获的是屏幕可见内容，可能被遮挡。
- UIA 依赖目标应用的无障碍实现：无 ValuePattern 的编辑控件不能 setValue；自定义绘制的菜单/ComboBox 只能走声明在 Pack 中的降级路径；某些控件如实标记 `unsupported`（如 popup 内未暴露的 QLineEdit）。
- 前台被游戏/全屏程序占用时，光标与焦点相关断言可能假失败。
