# ScreenShotTool MCP

### 截图与结构化状态工具的选择

当任务需要查看视觉内容、检查布局、验证渲染效果、生成图像结果，
或用户明确要求截图时，直接使用 `capture_window` 或
`capture_screen_region`。

当任务需要读取控件值、判断选中状态、定位语义控件或验证业务
后置条件时，使用 `resolve_semantic_control`、`ui_get`、
`ui_query` 或 profile action。

两类工具互补，不设固定的全局优先级。可以先用结构化状态验证
操作结果，再用截图提供视觉证据。当用户明确要求截图、图像或视觉
验证时，执行截图而不是用状态查询代替。

一个**通用的 Windows UI Automation MCP Server**，供 Codex、Claude Code 等 MCP 客户端通过 stdio 调用。核心能力：

- 启动应用、发现窗口、截取窗口或屏幕区域、投递鼠标/键盘消息（不移动物理鼠标）。
- **结构化 UI Automation（UIA）能力**：读取控件结构、状态、值和业务后置条件；按 selector 查询控件、通过 UIA Pattern 操作控件、等待状态变化。
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

## 模型推荐调用路径

工具选择由契约（tools/list 的 description / inputSchema / outputSchema）与
`app_pack_describe` 返回的 `usageGuidance` 引导。通用推荐顺序：

**已知 App Pack 时**

```
app_pack_describe → profile_launch → 使用 targetRef 的 profile_action
                  → 业务后置条件验证（ui_wait / expect）
                  → 按任务需要 capture_window（视觉证据/布局检查/用户要求截图时）
```

用户已明确指定 Profile 时可直接 `profile_launch → profile_action`，不强制先调用
`app_pack_list`。**用户已经明确提供目标 EXE 绝对路径时，首次 `profile_launch` 应直接
传 `exePath`；不要先依赖 `executableEnv` 或自动解析再失败重试。**
`profile_launch` 返回的 `targetRef` 是后续动作的首选目标绑定：
窗口重建后它会自动重新绑定到新窗口，无需手工换 HWND。**targetRef 是 session 身份**：
只要拿到 targetRef，后续目标窗口工具（profile_action / ui_query / capture_window /
click_window / get_window_state / type_text / send_key 等）一律复用 targetRef，而不是
把返回的 hwnd 跨调用携带——hwnd 是诊断性/临时性的，可能变化。

**自然语言复合目标（推荐主路径）**

用户用自然语言描述目标（例如 "RD105 通道1 传感器配置"）时：

```
profile_launch → resolve_semantic_control("RD105 通道1 传感器配置")
              → 按 suggestedPath 依次 profile_action（selection group 控件用 ensureSelected）
              → 业务后置条件验证
              → 按任务需要 capture_window（视觉证据/布局检查/用户要求截图时）
```

`resolve_semantic_control` 是纯解析（不执行动作）：它把自然语言映射到逻辑控件路径
（suggestedPath）和推荐动作（selection-group 控件自动推荐 `ensureSelected`——幂等且
验证 before/after 状态，而不是 raw invoke）。**不要**为自然语言目标猜控件 ID 直接调用
profile_action；用户已明确给出控件 ID 时才可直接 profile_action。

**查找未知控件**

```
profile controls（profile_resolve / profile_action）→ scoped ui_query
（rootSelector / ancestorSelector / nameContains / fields / maxResults）
→ ui_catalog → scoped ui_inspect_tree
```

`ui_catalog` 与 `ui_inspect_tree` 是诊断 fallback：不要为了定位一个已知语义控件
枚举整棵应用树。`ui_query` 支持 `depthStrategy=auto` 自动从浅到深扩展搜索深度。
`ui_query` 要求**至少一个查询范围**（selector / rootSelector / ancestorSelector
三选一；`nameContains` 只是过滤条件，不能单独作为 selector root）——公开 JSON Schema
与运行时一致，非法调用在 tools/list 阶段即被拒绝。

**禁止的反模式**

- 有 Profile/App Pack 仍先用 `launch_app`（launch_app 是低层 fallback）。
- 每次动作都重新抓整棵树（用 profile controls 或 scoped ui_query）。
- 把旧 hwnd 永久复用（窗口重建后用 targetRef，绑定会自动刷新）。
- 手工换算 screen/client 坐标（boundingRect 标注 `coordinateSpace:"screen"`，
  点击工具只接受 client-area 坐标并标注 `coordinateSpace`）。
- 把窗口消息点击描述成真实鼠标点击（结果明确 `physicalCursorMoved:false`）。
- 看到没有窗口就断言应用崩溃（区分 `processAlive` / `windowAlive` /
  `profileWindowMatched`；`WINDOW_NOT_FOUND_FOR_PROCESS` 不代表进程退出）。
- 为自然语言目标猜控件 ID（先 `resolve_semantic_control` 并跟随 suggestedPath）。
- 对 selection-group 控件用 raw invoke 而不使用推荐的 `ensureSelected`。
- 给 capture_window 编造输出路径（用户没指定时省略 `outputPath`，服务器写入默认
  outputs/ 目录并返回路径；不要猜磁盘根目录如 `X:\...`）。

## 错误输出契约

所有工具的业务错误都以统一结构返回，且满足该工具公开的 outputSchema
（不会再出现 `-32602 output schema mismatch` 掩盖真实错误码）：

```json
{
  "success": false,
  "error": {
    "code": "ELEMENT_NOT_FOUND",
    "message": "No element matched selector: ...",
    "suggestion": "Use scoped ui_query within the nearest known profile control...",
    "retryable": false
  }
}
```

常见错误码都带 `suggestion`（TARGET_REQUIRED / WINDOW_NOT_FOUND /
WINDOW_NOT_FOUND_FOR_PROCESS / STALE_WINDOW_HANDLE / ELEMENT_NOT_FOUND /
ELEMENT_AMBIGUOUS / FOREGROUND_REQUIRED / MAX_DEPTH_EXCEEDED /
ACTION_STATE_INCONSISTENT / BACKGROUND_CAPTURE_UNAVAILABLE / TREE_OUTPUT_TOO_LARGE）。

控件解析失败（profile_action 的 ELEMENT_NOT_FOUND）会升级为
`PROFILE_CONTROL_UNRESOLVED`，携带语义诊断上下文：
`page` / `component` / `parent` / `group` / `candidatesTried` /
`diagnosticScope`（机器可用的 scoped ui_query 建议：`{rootControl, maxResults}`），
让模型在最近的已知语义范围内诊断，而不是枚举整棵树。

目标进程退出（targetRef 解析失败）返回 `TARGET_PROCESS_EXITED`，携带结构化证据：
`processAlive` / `windowAlive` / `startedByMcp` / `exitCode`（尽力而为）/
`exitObservedAt` / `lastOperation`（工具名 + 时间戳）/ `causality: "unknown"`。
`lastOperation` 是时间相关性诊断上下文，**不代表工具导致退出**——措辞规则：
只有真实观测到正常退出才能写 "Observed normal process exit."；有异常 exit code 时写
"Observed abnormal process termination shortly after <op>. The temporal association
is recorded, but causality is not proven."；证据不足时写 "Target disappeared; root
cause remains unknown."。禁止写 "MCP crashed the app" / "UIA caused the crash"。

`profile_launch` 可选返回 `packCompatibility`（App Pack ↔ EXE 兼容性）：
`verified`（sha256 等强身份匹配）/ `compatible-unverified`（有版本信息但无法完全证明
binary 身份）/ `mismatch`（Pack 声明的已验证 binary 与当前 binary 不一致，**警告**，
不阻止启动）/ `not-declared`（Pack 未声明 testedAgainst）。`mismatch` 时控件解析失败
应优先怀疑 App Pack selector 漂移，而不是 UIA 核心故障。

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
├─ controls.json    逻辑控件名 → UIA selector 候选（含语义元数据、搜索作用域、滚动关系、业务后置条件）
├─ actions.json     控件+动作契约（幂等、可重试、defaultExpect）
├─ workflows.json   可复用命名工作流
├─ pages.json       可选：页面语义地图（页面、导航入口、就绪标志、选择组）
├─ components.json  可选：卡片/区域语义地图（组件、子控件、映射状态）
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
- `catalogVisibility`：`session`（对客户端可见）/ `hidden`（知道 id 可调用，不列出）。`internal` 已移除（无组合引擎，internal 不可达）。
- selector 支持 `automationId` / `name` / `controlType` / `className` / `frameworkId` + `match`（exact/contains/regex）+ `ancestor` / `path` / `index`。

### 语义地图（pages.json / components.json）

声明了 `pages.json` / `components.json` 的 Pack 会获得**语义发现**能力：模型先取紧凑地图，再通过通用工具组合动作，而不是为每个任务写 Workflow。

- **页面**：导航入口（`navigationControl`）、页面根（`rootControl`）、**内容级就绪标志**（`readyMarkers`，验证页面内容可见而非仅按钮选中态）、滚动容器。
- **选择组**：互斥的通道/标签/模式（`selectionGroups`，成员引用控件 id）。
- **组件/卡片**：真实 UI 结构（`components`），带根控件、子控件和映射状态（`mappingStatus: "partial"` + `reason`）。
- **控件语义元数据**（controls.json 条目）：`aliases`（自然语言别名）、`page` / `parent` / `group`、`role`、`search`（**局部**搜索作用域与深度，绝不全局提升）、`visibility`（所属滚动容器与滚动策略，供通用 `ensureVisible`）、`controlState`（控件自身状态）、`postconditions`（**业务后置条件**：引用内容标志控件，`ensureSelected` 必须同时满足控件状态与业务状态——UIA toggleState 单独不能证明内容已切换）、`supportedActions`、`fallbackPolicy`（禁止物理鼠标/全局键盘）。

发现工具：`app_pack_describe`（`include`/`page`/`compact` 参数返回语义地图）、`resolve_semantic_control`（自然语言 → 逻辑控件路径，纯解析不执行动作）。
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
- `app_pack_reload` 原子重载：新配置校验失败时保留旧配置；正在运行的管道继续使用启动时快照。**语义校验也是原子的**：候选 Pack 存在任何 error（未知工具/不存在的 control/未知动作/错误 workflow 引用/无效输出路径/不安全 retry/重复 ID/目录逃逸/Schema 错误）时整体 `reloaded=false`，旧 Registry 与旧 validation cache 原样保留——`app_pack_list` / `app_pack_describe` / `app_pack_validate` / `workflow_catalog` / `run_workflow` / `profile_launch` / `profile_action` 始终看到同一活动版本；warning 允许加载。

## 验证 Pack

```jsonc
// 校验已加载的 Pack
{ "pack": "example-app" }
// 本地校验一个目录（不安装）
{ "packPath": "X:\\Private\\AppPacks\\example-app" }
```

检查项：manifest/profile/controls/actions/workflows 的 Schema、control 引用、workflow 工具名、参数 Schema、输出引用路径、循环/前向引用、敏感字段、目录逃逸、绝对路径、重复 ID、未知动作、不安全重试（非幂等 + retrySafe）。返回 `{ valid, errors[], warnings[], checked[] }`。

App Pack validator 会对**可执行参数位置**中疑似硬编码的凭据值发出 `SENSITIVE_VALUE` 警告（profile、workflow steps/finally/captureBefore 参数、嵌套 inputSchema 的 default/example/examples/const/enum、action 字面量参数），并精确标注来源文件（profile.json / workflows.json / actions.json）。控件标识符、selector、显示名称、描述与明确的环境变量**名称**字段（如 `executableEnv`）不会被当作凭据；全大写文本也不会自动视为环境变量引用。只有 App Pack 正式支持的 `${...}` 引用语法（如 `${env.APP_PASSWORD}`）被视为非字面量引用。请使用输入或环境变量引用代替字面量秘密。

## 生成 Pack 草稿

```jsonc
{ "pid": 12345, "includeProcessPopups": true }
```

`app_pack_probe` 返回：候选主窗口规则、可操作控件（稳定 automationId、推荐 selector、Patterns）、可能的菜单层级、输入控件、Dialog、无法访问控件，以及 `controls.json` / `profile.json` 草稿（可写入临时目录）。草稿**不会自动安装**。

## 使用 Workflow

```jsonc
{ "pack": "example-app", "workflow": "open_settings", "inputs": {} }
```

- 输入按 workflow 的 `inputSchema` 完整校验（type / required / enum / minimum / maximum / minLength / maxLength / pattern / 嵌套对象 / 数组 items / additionalProperties），错误返回 `WORKFLOW_INPUT_INVALID` + `validationErrors:[{path,message}]`；校验使用与工具 outputSchema 相同的统一 Schema 校验器，不存在第二套手写 workflow 校验器。
- `${pack.id}` 服务端注入；`${inputs.x}` 引用工作流输入。
- Pack 的 `defaultExpect` 自动生效；步骤可引用前序步骤：`${launch.pid}`。
- 返回 `runId`、命名步骤结果、`exports`、`finallyResults`。
- `internal` 可见性**已移除**（没有组合引擎时 internal 工作流不可达）：`visibility` 只接受 `session` / `hidden`；声明 `internal` 的 Pack 在加载时被拒绝。
- Workflow `visibility` 语义：`session`（默认）出现在 `workflow_catalog` 且可直接调用；`hidden` **不出现在** `workflow_catalog`，但知道准确 Pack ID + Workflow ID 时仍可通过 `run_workflow` 调用。

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
  details 列出 `unsafeSteps: [{stepId, section, backgroundPolicy, suggestedMode}]`。
  **预检同时覆盖主流程 steps 与 finally**：即使 finally 含强制前台步骤，整条管道也会在
  启动应用/执行第一步之前被拒绝。`continue_run` 续跑前对剩余主步骤和 finally 使用同一套预检。
  `bestEffort` 步骤允许执行，运行时失败再返回明确错误。禁止执行到中途突然抢前台。
- **集中后台策略表**：通用工具的 backgroundPolicy 由单一策略表定义（只读 UIA 查询 = `safe`；
  UIA Pattern 操作 / PrintWindow 截图 / 定向 PostMessage / 剪贴板 / 启动 = `bestEffort`；
  屏幕区域截图与全局键盘输入 = `foregroundRequired`）。步骤显式 `noActivate:true` 把
  `send_key` / `type_text` 从 foregroundRequired 降为 bestEffort（允许后台执行），但**绝不**
  把全局输入错误标成 safe。`workflow_catalog` 的后台能力与运行时使用同一套计算
  （`backgroundUnsafePipelineSteps`，同时检查 steps 与 finally），目录与预检永远不会不一致。
- 后台截图空白帧 → `BACKGROUND_CAPTURE_UNAVAILABLE`（不自动置顶重试）。
- 后台启动时若应用自身抢前台，核心尝试恢复原前台窗口并如实报告
  `foregroundChanged:true` / `foregroundRestored:true`；无法恢复时返回 warning，绝不谎报。

### 统一结果元数据 interaction

高层工具与管道结果新增 `interaction` 报告：

```jsonc
{ "interaction": { "requestedMode": "background", "effectiveMode": "background",
    "backgroundPolicy": "safe", "method": "InvokePattern",
    "foregroundBefore": "0x1A2B3C", "foregroundAfter": "0x1A2B3C",
    "foregroundChanged": false, "foregroundChangedDuringRun": true,
    "foregroundRestored": true,
    "targetActivated": false, "physicalCursorMoved": false } }
```

管道顶层报告在**开始时与全部步骤/restore/finally 结束后真实读取前台 HWND**，并汇总所有
步骤、finally 与恢复动作的 interaction：

- `foregroundChanged` = 结束时前台与开始时不同（最终差异）。
- `foregroundChangedDuringRun` = 过程中**任何时刻**发生过前台变化——即使最终已恢复也如实
  保留（不得因恢复成功而隐藏过程变化）。
- `foregroundRestored` = 最终前台读回与开始时相同（以最终读取为准，不只相信子步骤布尔值）。
- `targetActivated` / `physicalCursorMoved` = 汇总真实步骤结果。
- background 管道结束时前台未恢复 → `foregroundChanged:true` / `foregroundRestored:false` +
  warning `BACKGROUND_FOREGROUND_NOT_RESTORED`（不影响已完成业务步骤的成功语义）。

`continue_run` **继承原运行已解析的交互上下文**（interactionMode / foregroundDemo 选项
restorePreviousForeground / stepDelayMs / allowForegroundFallback），不根据当前 Pack 默认值
重新推导；旧格式快照回退为 Pack 默认并返回 `RUN_INTERACTION_CONTEXT_MISSING` warning。

覆盖 `profile_launch` / `profile_action` / `profile_run_steps` / `run_workflow` /
`continue_run` / `capture_window`（截图还报告真实 `captureMethod`）。`workflow_catalog` 与
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

续接前检查：run 未过期（内存保留 10 分钟，最多 20 个）→ Pack 版本未变（`RUN_PACK_VERSION_CHANGED`）→ **进程仍存在且窗口仍有效**（`RUN_PROCESS_EXITED` / `RUN_WINDOW_RECREATED` / `RUN_WINDOW_UNAVAILABLE`——进程存活用 OpenProcess/GetExitCodeProcess 真实查询，绝不用"是否还有顶层窗口"代表进程存活）→ 快照可续接（`RUN_NOT_CONTINUABLE`）。续接从失败步骤重放，已完成步骤的**最小投影**（后续步骤引用的字段 + pipe-safe 字段 + exports）复用，不重复执行、不保存完整原始结果。超大的快照（含被引用的巨型字段）如实标记 `continuable:false` + `continuationReason:"RUN_SNAPSHOT_TRUNCATED"`，绝不伪装成可恢复。

### 续跑的统一生命周期

续跑是一条**单一 run**：开始计算一次总截止时间（沿用原 `maxTotalMs`），剩余主步骤、expect、retry、restore、finally 与 foregroundDemo 的 `stepDelayMs` 全部共享该 deadline——**不允许每个步骤重新获得完整预算**。续跑结束时：

- **restore**：用 RunSnapshot 中保存的**原运行捕获状态**重放恢复动作并重新验证 UI；快照没有可用状态时如实返回 `RESTORE_STATE_UNAVAILABLE`，绝不静默跳过并谎报 cleanup 成功。已由原运行执行的 finally/restore 不会重复执行：RunSnapshot 记录 `finallyRan`（finally 步骤 key）与 `capturedState`（原捕获值），续跑只执行原运行未到达的 finally 步骤、只重放并验证 restore。
- **finally**：续跑成功**或**失败都执行一次；原失败运行在进入 finally 前停止时，由续跑执行；原运行已执行完成的 finally 步骤报告为 `alreadyRan`，不重复执行。
- 续跑段 exports 按**全局步骤索引**记录（不是从 0 开始的段内索引），多次续接不会错位。

## 输出 Schema 与 structuredContent

每个工具在 `src/contracts.ts` 有统一 `ToolContract`：`description`、`inputSchema`、`outputSchema`、`pipeSafeFields`、`annotations`（readOnly / destructive / idempotent / retrySafe / needsExpect）。**Schema 校验是结构性子集**（type / required / properties / items / enum / anyOf / additionalProperties / minimum / maximum / minLength / maxLength / pattern），并非完整 JSON Schema 实现；未声明的关键字被忽略，额外字段默认允许。

稳定公共输出字段：`schemaVersion / success / pid / hwnd / title / found / count / element / elements / value / matched / timedOut / code / message / details`。

- 工具成功结果同时返回 `content`（JSON 文本，保持兼容）与 `structuredContent`（机器可读对象）。业务错误同样结构化：`isError:true` + text 内容（旧客户端兼容）+ `structuredContent:{ success:false, error:{ code, message, details } }`。
- 管道中每个步骤的结果都会用该工具的 `outputSchema` 做运行时校验，不符合返回 `TOOL_OUTPUT_SCHEMA_MISMATCH`，**无效结果不会流入后续步骤**。
- **数组工具的 canonical 输出**：`list_windows` / `profile_list` / `app_pack_list` / `workflow_catalog` / `tool_contract_list` 等数组型工具在普通调用、structuredContent、管道步骤结果、exports 与 run snapshot 中**统一返回 `{ items: [...] }`**，与 `tools/list` 的 outputSchema 完全一致：`${step.items.0.hwnd}` 可静态验证并运行。旧的 `${0.0.hwnd}` 裸数组引用保持兼容（引用解析器自动把顶层数字段映射到 `items.N`）。

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

热重载边界：默认启用（`SCREENSHOTTOOL_HOT_RELOAD=0` 关闭），但**只对实际动态加载的模块生效**：
`src/schemas.ts`、`src/windows.ts`、`src/profiles/registry.ts` 与 `scripts/win-capture.ps1`。
修改其他核心源码（pipeline / contracts / executor / app-packs / interaction 等）后**建议重启 MCP
服务器**——这些模块是静态导入的，运行中不承诺热重载，混合新旧模块状态不受支持。
App Pack JSON 通过 `app_pack_reload` 独立热重载。

## 限制（真实，已实机确认）

- `click_window` / `move_mouse_window` 只投递窗口消息：不支持拖拽、手势、真实 hover。Qt/Electron 应用读取系统光标位置，假消息不会触发 tooltip/右键菜单——需要时请请求人类操作。
- PrintWindow 无法捕获独立顶层弹窗（Qt ToolTip、菜单面板、Electron 子窗口）；`captureMethod:"screen"` 捕获的是屏幕可见内容，可能被遮挡。
- **严格 background 模式使用非激活的 PrintWindow**。如果 PrintWindow 返回 blank frame 或明显异常的窗口几何，而用户确实需要可见屏幕截图，可针对同一 targetRef 显式重试：`captureMethod="screen"` + `interactionMode="foregroundDemo"`。**不要只修改 captureMethod**，因为 background 模式会继续强制使用 PrintWindow。
- UIA 依赖目标应用的无障碍实现：无 ValuePattern 的编辑控件不能 setValue；自定义绘制的菜单/ComboBox 只能走声明在 Pack 中的降级路径；某些控件如实标记 `unsupported`（如 popup 内未暴露的 QLineEdit）。
- 前台被游戏/全屏程序占用时，光标与焦点相关断言可能假失败。
