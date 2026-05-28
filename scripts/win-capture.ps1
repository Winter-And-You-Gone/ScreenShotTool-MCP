param(
  [Parameter(Mandatory = $true)]
  [string]$InputJson
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Drawing
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
} catch {
}

if (-not ("ScreenshotTool.Native" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace ScreenshotTool {
  public static class Native {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
      public int Left;
      public int Top;
      public int Right;
      public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT Point);

    [DllImport("user32.dll")]
    public static extern IntPtr GetMenu(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetSubMenu(IntPtr hMenu, int nPos);

    [DllImport("user32.dll")]
    public static extern int GetMenuItemCount(IntPtr hMenu);

    [DllImport("user32.dll")]
    public static extern int GetMenuString(IntPtr hMenu, uint uIDItem, StringBuilder lpString, int nMaxCount, uint uFlag);

    [DllImport("user32.dll")]
    public static extern uint GetMenuItemID(IntPtr hMenu, int nPos);

    [DllImport("user32.dll")]
    public static extern bool GetMenuItemRect(IntPtr hWnd, IntPtr hMenu, uint uItem, out RECT lprcItem);

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
      public int X;
      public int Y;
    }
  }
}
"@
}

try {
  [ScreenshotTool.Native]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
} catch {
  try {
    [ScreenshotTool.Native]::SetProcessDPIAware() | Out-Null
  } catch {
  }
}

function ConvertTo-Hashtable {
  param([Parameter(ValueFromPipeline = $true)]$InputObject)

  process {
    if ($null -eq $InputObject) {
      return $null
    }

    if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string] -and $InputObject -isnot [System.Collections.IDictionary]) {
      $collection = @()
      foreach ($item in $InputObject) {
        $collection += ConvertTo-Hashtable $item
      }
      return $collection
    }

    if ($InputObject -is [pscustomobject]) {
      $hash = @{}
      foreach ($property in $InputObject.PSObject.Properties) {
        $hash[$property.Name] = ConvertTo-Hashtable $property.Value
      }
      return $hash
    }

    return $InputObject
  }
}

function Get-WindowTitle {
  param([IntPtr]$Hwnd)

  $length = [ScreenshotTool.Native]::GetWindowTextLength($Hwnd)
  if ($length -le 0) {
    return ""
  }

  $builder = New-Object System.Text.StringBuilder ($length + 1)
  [ScreenshotTool.Native]::GetWindowText($Hwnd, $builder, $builder.Capacity) | Out-Null
  return $builder.ToString()
}

function Get-WindowClassName {
  param([IntPtr]$Hwnd)

  $builder = New-Object System.Text.StringBuilder 256
  [ScreenshotTool.Native]::GetClassName($Hwnd, $builder, $builder.Capacity) | Out-Null
  return $builder.ToString()
}

function Get-WindowProcessName {
  param([uint32]$ProcessIdValue)

  try {
    return (Get-Process -Id $ProcessIdValue -ErrorAction Stop).ProcessName
  } catch {
    return "[access-denied:" + $ProcessIdValue + "]"
  }
}

function Get-RectObject {
  param([ScreenshotTool.Native+RECT]$Rect)

  $width = [Math]::Max(0, $Rect.Right - $Rect.Left)
  $height = [Math]::Max(0, $Rect.Bottom - $Rect.Top)

  return [ordered]@{
    x = $Rect.Left
    y = $Rect.Top
    width = $width
    height = $height
    left = $Rect.Left
    top = $Rect.Top
    right = $Rect.Right
    bottom = $Rect.Bottom
  }
}

function Get-VisibleWindows {
  $windows = [System.Collections.ArrayList]::new()

  $callback = [ScreenshotTool.Native+EnumWindowsProc]{
    param([IntPtr]$Hwnd, [IntPtr]$LParam)

    if (-not [ScreenshotTool.Native]::IsWindowVisible($Hwnd)) {
      return $true
    }

    if ([ScreenshotTool.Native]::IsIconic($Hwnd)) {
      return $true
    }

    $title = Get-WindowTitle $Hwnd
    if ([string]::IsNullOrWhiteSpace($title)) {
      return $true
    }

    $rect = New-Object ScreenshotTool.Native+RECT
    if (-not [ScreenshotTool.Native]::GetWindowRect($Hwnd, [ref]$rect)) {
      return $true
    }

    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) {
      return $true
    }

    $pidValue = [uint32]0
    [ScreenshotTool.Native]::GetWindowThreadProcessId($Hwnd, [ref]$pidValue) | Out-Null

    $windows.Add([ordered]@{
      hwnd = $Hwnd.ToInt64().ToString()
      title = $title
      pid = [int]$pidValue
      processName = Get-WindowProcessName $pidValue
      className = Get-WindowClassName $Hwnd
      rect = Get-RectObject $rect
    }) | Out-Null

    return $true
  }

  [ScreenshotTool.Native]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  return @($windows.ToArray())
}

function Normalize-ProcessName {
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name)) {
    return $Name
  }

  return [IO.Path]::GetFileNameWithoutExtension($Name)
}

function Filter-Windows {
  param(
    [array]$Windows,
    [hashtable]$Filters
  )

  $items = @($Windows)

  if ($Filters.ContainsKey("pid") -and $null -ne $Filters.pid) {
    $pidValue = [int]$Filters.pid
    $items = @($items | Where-Object { $_.pid -eq $pidValue })
  }

  if ($Filters.ContainsKey("processName") -and -not [string]::IsNullOrWhiteSpace($Filters.processName)) {
    $processName = Normalize-ProcessName $Filters.processName
    $items = @($items | Where-Object { $_.processName -ieq $processName })
  }

  if ($Filters.ContainsKey("titleContains") -and -not [string]::IsNullOrWhiteSpace($Filters.titleContains)) {
    $needle = [string]$Filters.titleContains
    $items = @($items | Where-Object { $_.title.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  }

  return @($items)
}

function Resolve-TargetWindow {
  param([hashtable]$Target)

  $windows = Get-VisibleWindows

  if ($Target.ContainsKey("hwnd") -and $null -ne $Target.hwnd) {
    $hwndText = ([string]$Target.hwnd).Trim()
    $match = @($windows | Where-Object { $_.hwnd -eq $hwndText }) | Select-Object -First 1
    if ($null -ne $match) {
      return $match
    }
    throw "No visible window found for hwnd $hwndText."
  }

  $filtered = Filter-Windows $windows $Target
  if ($filtered.Count -lt 1) {
    throw "No visible window matched the provided target."
  }

  return $filtered[0]
}

function Focus-Window {
  param([object]$Window)

  $hwnd = [IntPtr]([int64]$Window.hwnd)
  $swRestore = 9
  $swpNoSize = 0x0001
  $swpNoMove = 0x0002
  $hwndTopMost = [IntPtr](-1)
  $hwndNoTopMost = [IntPtr](-2)
  $flags = [uint32]($swpNoSize -bor $swpNoMove)

  [ScreenshotTool.Native]::ShowWindow($hwnd, $swRestore) | Out-Null
  [ScreenshotTool.Native]::SetWindowPos($hwnd, $hwndTopMost, 0, 0, 0, 0, $flags) | Out-Null
  [ScreenshotTool.Native]::SetWindowPos($hwnd, $hwndNoTopMost, 0, 0, 0, 0, $flags) | Out-Null
  [ScreenshotTool.Native]::BringWindowToTop($hwnd) | Out-Null
  [ScreenshotTool.Native]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 150
}

function Save-Screenshot {
  param(
    [int]$X,
    [int]$Y,
    [int]$Width,
    [int]$Height,
    [string]$OutputPath,
    [string]$Target,
    [hashtable]$Rect
  )

  if ($Width -le 0 -or $Height -le 0) {
    throw "Capture width and height must be positive."
  }

  $directory = Split-Path -Parent $OutputPath
  if (-not [string]::IsNullOrWhiteSpace($directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }

  $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

  try {
    $graphics.CopyFromScreen($X, $Y, 0, 0, [System.Drawing.Size]::new($Width, $Height))
    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }

  return [ordered]@{
    path = (Resolve-Path $OutputPath).Path
    width = $Width
    height = $Height
    target = $Target
    rect = $Rect
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
  }
}

function Capture-Window {
  param(
    [hashtable]$Target,
    [string]$OutputPath
  )

  $window = Resolve-TargetWindow $Target
  $focus = $true
  if ($Target.ContainsKey("focus") -and $null -ne $Target.focus) {
    $focus = [bool]$Target.focus
  }
  if ($focus) {
    Focus-Window $window
  }
  $windowRect = $window.rect

  $captureX = [int]$windowRect.x
  $captureY = [int]$windowRect.y
  $captureWidth = [int]$windowRect.width
  $captureHeight = [int]$windowRect.height

  if ($Target.ContainsKey("region") -and $null -ne $Target.region) {
    $region = $Target.region
    $captureX += [int]$region.x
    $captureY += [int]$region.y
    $captureWidth = [int]$region.width
    $captureHeight = [int]$region.height
  }

  $rect = [ordered]@{
    x = $captureX
    y = $captureY
    width = $captureWidth
    height = $captureHeight
    left = $captureX
    top = $captureY
    right = $captureX + $captureWidth
    bottom = $captureY + $captureHeight
  }

  return Save-Screenshot -X $captureX -Y $captureY -Width $captureWidth -Height $captureHeight -OutputPath $OutputPath -Target ("window:" + $window.hwnd) -Rect $rect
}

function Capture-ScreenRegion {
  param(
    [hashtable]$Region,
    [string]$OutputPath
  )

  $rect = [ordered]@{
    x = [int]$Region.x
    y = [int]$Region.y
    width = [int]$Region.width
    height = [int]$Region.height
    left = [int]$Region.x
    top = [int]$Region.y
    right = [int]$Region.x + [int]$Region.width
    bottom = [int]$Region.y + [int]$Region.height
  }

  return Save-Screenshot -X $rect.x -Y $rect.y -Width $rect.width -Height $rect.height -OutputPath $OutputPath -Target "screen" -Rect $rect
}

function New-MouseLParam {
  param(
    [int]$X,
    [int]$Y
  )

  return [IntPtr]((($Y -band 0xFFFF) -shl 16) -bor ($X -band 0xFFFF))
}

function Get-MouseMessageSet {
  param([string]$Button)

  switch ($Button) {
    "left" {
      return [pscustomobject][ordered]@{
        down = 0x0201
        up = 0x0202
        doubleClick = 0x0203
        ncDown = 0x00A1
        ncUp = 0x00A2
        ncDoubleClick = 0x00A3
        buttonState = 0x0001
      }
    }
    "right" {
      return [pscustomobject][ordered]@{
        down = 0x0204
        up = 0x0205
        doubleClick = 0x0206
        ncDown = 0x00A4
        ncUp = 0x00A5
        ncDoubleClick = 0x00A6
        buttonState = 0x0002
      }
    }
    "middle" {
      return [pscustomobject][ordered]@{
        down = 0x0207
        up = 0x0208
        doubleClick = 0x0209
        ncDown = 0x00A7
        ncUp = 0x00A8
        ncDoubleClick = 0x00A9
        buttonState = 0x0010
      }
    }
    default {
      throw "Unsupported mouse button: $Button"
    }
  }
}

function Resolve-MouseMessageTarget {
  param(
    [IntPtr]$Hwnd,
    [int]$ScreenX,
    [int]$ScreenY
  )

  $screenPoint = New-Object ScreenshotTool.Native+POINT
  $screenPoint.X = $ScreenX
  $screenPoint.Y = $ScreenY
  $targetHwnd = [ScreenshotTool.Native]::WindowFromPoint($screenPoint)
  if ($targetHwnd -eq [IntPtr]::Zero) {
    $targetHwnd = $Hwnd
  }

  $screenLParam = New-MouseLParam -X $ScreenX -Y $ScreenY
  $hitTest = [ScreenshotTool.Native]::SendMessage($targetHwnd, 0x0084, [IntPtr]::Zero, $screenLParam).ToInt32()
  $htClient = 1

  if ($hitTest -eq $htClient) {
    $clientPoint = New-Object ScreenshotTool.Native+POINT
    $clientPoint.X = $ScreenX
    $clientPoint.Y = $ScreenY
    if (-not [ScreenshotTool.Native]::ScreenToClient($targetHwnd, [ref]$clientPoint)) {
      throw "Failed to convert screen coordinates to client coordinates."
    }

    return [pscustomobject][ordered]@{
      hwnd = $targetHwnd
      client = $true
      wParam = 0
      lParam = (New-MouseLParam -X $clientPoint.X -Y $clientPoint.Y)
    }
  }

  return [pscustomobject][ordered]@{
    hwnd = $targetHwnd
    client = $false
    wParam = $hitTest
    lParam = $screenLParam
  }
}

function Post-MouseMessage {
  param(
    [IntPtr]$Hwnd,
    [uint32]$Message,
    [int]$ButtonState,
    [IntPtr]$LParam,
    [bool]$Required = $true
  )

  $posted = [ScreenshotTool.Native]::PostMessage($Hwnd, $Message, [IntPtr]$ButtonState, $LParam)
  if (-not $posted -and $Required) {
    throw "Failed to post mouse message 0x$($Message.ToString('X4'))."
  }

  return $posted
}

function Get-NativeMenuText {
  param(
    [IntPtr]$Menu,
    [int]$Index
  )

  $mfByPosition = 0x00000400
  $builder = New-Object System.Text.StringBuilder 256
  [ScreenshotTool.Native]::GetMenuString($Menu, [uint32]$Index, $builder, $builder.Capacity, [uint32]$mfByPosition) | Out-Null
  return $builder.ToString()
}

function Normalize-NativeMenuText {
  param([string]$Text)

  if ($null -eq $Text) {
    return ""
  }

  $withoutShortcut = ([string]$Text) -replace "`t.*$", ""
  $placeholder = [char]0xE000
  $withoutAccelerators = $withoutShortcut.Replace("&&", [string]$placeholder).Replace("&", "").Replace([string]$placeholder, "&")
  return $withoutAccelerators.Trim()
}

function Test-NativeMenuTextMatch {
  param(
    [string]$Actual,
    [string]$Expected
  )

  $actualText = Normalize-NativeMenuText $Actual
  $expectedText = Normalize-NativeMenuText $Expected
  if ([string]::IsNullOrWhiteSpace($actualText) -or [string]::IsNullOrWhiteSpace($expectedText)) {
    return $false
  }

  return $actualText.Equals($expectedText, [StringComparison]::OrdinalIgnoreCase) `
    -or $actualText.IndexOf($expectedText, [StringComparison]::OrdinalIgnoreCase) -ge 0 `
    -or $expectedText.IndexOf($actualText, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-NativeMenuItemCommandId {
  param(
    [IntPtr]$Menu,
    [int]$Index
  )

  $commandId = [int64]([ScreenshotTool.Native]::GetMenuItemID($Menu, $Index))
  if ($commandId -lt 0 -or $commandId -eq 4294967295) {
    return $null
  }

  return [int]$commandId
}

function Find-NativeMenuItem {
  param(
    [IntPtr]$Menu,
    [string]$Text
  )

  $count = [ScreenshotTool.Native]::GetMenuItemCount($Menu)
  for ($i = 0; $i -lt $count; $i++) {
    $itemText = Get-NativeMenuText -Menu $Menu -Index $i
    if (-not (Test-NativeMenuTextMatch -Actual $itemText -Expected $Text)) {
      continue
    }

    return [pscustomobject][ordered]@{
      index = $i
      text = $itemText
      normalizedText = Normalize-NativeMenuText $itemText
      commandId = Get-NativeMenuItemCommandId -Menu $Menu -Index $i
      subMenu = [ScreenshotTool.Native]::GetSubMenu($Menu, $i)
    }
  }

  return $null
}

function To-NativeMenuResult {
  param([object]$Item)

  return [ordered]@{
    index = [int]$Item.index
    text = [string]$Item.text
    normalizedText = [string]$Item.normalizedText
    commandId = $Item.commandId
  }
}

function Get-TopMenuItemAtPoint {
  param(
    [IntPtr]$Hwnd,
    [int]$ScreenX,
    [int]$ScreenY
  )

  $menu = [ScreenshotTool.Native]::GetMenu($Hwnd)
  if ($menu -eq [IntPtr]::Zero) {
    return $null
  }

  $count = [ScreenshotTool.Native]::GetMenuItemCount($menu)
  for ($i = 0; $i -lt $count; $i++) {
    $rect = New-Object ScreenshotTool.Native+RECT
    if (-not [ScreenshotTool.Native]::GetMenuItemRect($Hwnd, $menu, [uint32]$i, [ref]$rect)) {
      continue
    }

    if ($ScreenX -ge $rect.Left -and $ScreenX -lt $rect.Right -and $ScreenY -ge $rect.Top -and $ScreenY -lt $rect.Bottom) {
      return [pscustomobject][ordered]@{
        index = $i
        text = Get-NativeMenuText -Menu $menu -Index $i
        normalizedText = Normalize-NativeMenuText (Get-NativeMenuText -Menu $menu -Index $i)
        commandId = Get-NativeMenuItemCommandId -Menu $menu -Index $i
      }
    }
  }

  return $null
}

function Invoke-NativeMenuPath {
  param(
    [object]$Window,
    [array]$Path
  )

  if ($Path.Count -lt 1) {
    throw "Menu path must contain at least one item."
  }

  $hwnd = [IntPtr]([int64]$Window.hwnd)
  $menu = [ScreenshotTool.Native]::GetMenu($hwnd)
  if ($menu -eq [IntPtr]::Zero) {
    throw "Target window does not expose a native menu."
  }

  $currentMenu = $menu
  $resolvedPath = @()
  $lastIndex = $Path.Count - 1

  for ($depth = 0; $depth -le $lastIndex; $depth++) {
    $segment = [string]$Path[$depth]
    $item = Find-NativeMenuItem -Menu $currentMenu -Text $segment
    if ($null -eq $item) {
      throw "Menu item not found: $segment"
    }

    $resolvedPath += (To-NativeMenuResult $item)

    if ($depth -lt $lastIndex) {
      if ($item.subMenu -eq [IntPtr]::Zero) {
        throw "Menu item has no submenu: $($item.text)"
      }

      $currentMenu = $item.subMenu
      continue
    }

    if ($null -eq $item.commandId) {
      throw "Menu item is not an invokable command: $($item.text)"
    }

    Post-MouseMessage -Hwnd $hwnd -Message 0x0111 -ButtonState ([int]$item.commandId) -LParam ([IntPtr]::Zero) | Out-Null
    return [pscustomobject][ordered]@{
      menuPath = @($resolvedPath)
      commandId = [int]$item.commandId
    }
  }

  throw "Menu path was not invokable."
}

function Invoke-MenuItemAtPoint {
  param(
    [int]$ScreenX,
    [int]$ScreenY
  )

  $automationElementType = "System.Windows.Automation.AutomationElement" -as [type]
  if ($null -eq $automationElementType) {
    return $false
  }

  $point = [System.Windows.Point]::new($ScreenX, $ScreenY)
  $element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
  if ($null -eq $element) {
    return $false
  }

  if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::MenuItem) {
    return $false
  }

  $expandPattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expandPattern)) {
    if ($expandPattern.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) {
      $expandPattern.Expand()
      return $true
    }
  }

  $invokePattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {
    $invokePattern.Invoke()
    return $true
  }

  return $false
}

function Click-Window {
  param([hashtable]$Target)

  $window = Resolve-TargetWindow $Target
  $windowRect = $window.rect
  $relativeX = [int]$Target.x
  $relativeY = [int]$Target.y
  $screenX = [int]$windowRect.x + $relativeX
  $screenY = [int]$windowRect.y + $relativeY
  $button = "left"
  $doubleClick = $false
  $delayMs = 200

  if ($Target.ContainsKey("button") -and -not [string]::IsNullOrWhiteSpace($Target.button)) {
    $button = ([string]$Target.button).ToLowerInvariant()
  }
  if ($Target.ContainsKey("doubleClick") -and $null -ne $Target.doubleClick) {
    $doubleClick = [bool]$Target.doubleClick
  }
  if ($Target.ContainsKey("delayMs") -and $null -ne $Target.delayMs) {
    $delayMs = [int]$Target.delayMs
  }

  $hwnd = [IntPtr]([int64]$window.hwnd)
  $messages = Get-MouseMessageSet $button
  $messageTarget = Resolve-MouseMessageTarget -Hwnd $hwnd -ScreenX $screenX -ScreenY $screenY

  if ($messageTarget.client) {
    Post-MouseMessage -Hwnd $messageTarget.hwnd -Message 0x0200 -ButtonState 0 -LParam $messageTarget.lParam -Required $false | Out-Null
    Post-MouseMessage -Hwnd $messageTarget.hwnd -Message $messages.down -ButtonState $messages.buttonState -LParam $messageTarget.lParam | Out-Null
  } else {
    Post-MouseMessage -Hwnd $messageTarget.hwnd -Message 0x00A0 -ButtonState $messageTarget.wParam -LParam $messageTarget.lParam -Required $false | Out-Null
    Post-MouseMessage -Hwnd $messageTarget.hwnd -Message $messages.ncDown -ButtonState $messageTarget.wParam -LParam $messageTarget.lParam | Out-Null
  }
  Start-Sleep -Milliseconds 30
  if ($messageTarget.client) {
    Post-MouseMessage -Hwnd $messageTarget.hwnd -Message $messages.up -ButtonState 0 -LParam $messageTarget.lParam | Out-Null
  } else {
    Post-MouseMessage -Hwnd $messageTarget.hwnd -Message $messages.ncUp -ButtonState $messageTarget.wParam -LParam $messageTarget.lParam | Out-Null
  }

  if ($doubleClick) {
    Start-Sleep -Milliseconds 80
    if ($messageTarget.client) {
      Post-MouseMessage -Hwnd $messageTarget.hwnd -Message $messages.doubleClick -ButtonState $messages.buttonState -LParam $messageTarget.lParam | Out-Null
    } else {
      Post-MouseMessage -Hwnd $messageTarget.hwnd -Message $messages.ncDoubleClick -ButtonState $messageTarget.wParam -LParam $messageTarget.lParam | Out-Null
    }
    Start-Sleep -Milliseconds 30
    if ($messageTarget.client) {
      Post-MouseMessage -Hwnd $messageTarget.hwnd -Message $messages.up -ButtonState 0 -LParam $messageTarget.lParam | Out-Null
    } else {
      Post-MouseMessage -Hwnd $messageTarget.hwnd -Message $messages.ncUp -ButtonState $messageTarget.wParam -LParam $messageTarget.lParam | Out-Null
    }
  }

  $uiaInvoked = Invoke-MenuItemAtPoint -ScreenX $screenX -ScreenY $screenY
  $nativeMenu = $null
  if (-not $uiaInvoked -and -not $messageTarget.client -and [int]$messageTarget.wParam -eq 5) {
    $nativeMenu = Get-TopMenuItemAtPoint -Hwnd $hwnd -ScreenX $screenX -ScreenY $screenY
  }

  if ($delayMs -gt 0) {
    Start-Sleep -Milliseconds $delayMs
  }

  return [ordered]@{
    clicked = $true
    target = "window:" + $window.hwnd
    hwnd = $window.hwnd
    title = $window.title
    pid = $window.pid
    button = $button
    doubleClick = $doubleClick
    method = "post_message"
    messageTarget = [ordered]@{
      hwnd = $messageTarget.hwnd.ToInt64().ToString()
      className = Get-WindowClassName $messageTarget.hwnd
      client = [bool]$messageTarget.client
      hitTest = [int]$messageTarget.wParam
      uiaInvoked = [bool]$uiaInvoked
    }
    nativeMenu = $nativeMenu
    windowPoint = [ordered]@{
      x = $relativeX
      y = $relativeY
    }
    screenPoint = [ordered]@{
      x = $screenX
      y = $screenY
    }
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
  }
}

function Click-MenuItem {
  param([hashtable]$Target)

  $window = Resolve-TargetWindow $Target
  $delayMs = 500
  if ($Target.ContainsKey("delayMs") -and $null -ne $Target.delayMs) {
    $delayMs = [int]$Target.delayMs
  }

  $result = Invoke-NativeMenuPath -Window $window -Path @($Target.path)

  if ($delayMs -gt 0) {
    Start-Sleep -Milliseconds $delayMs
  }

  return [ordered]@{
    clicked = $true
    target = "window:" + $window.hwnd
    hwnd = $window.hwnd
    title = $window.title
    pid = $window.pid
    method = "native_menu_command"
    menuPath = @($result.menuPath)
    commandId = [int]$result.commandId
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
  }
}

function Move-MouseWindow {
  param([hashtable]$Target)

  $window = Resolve-TargetWindow $Target
  $windowRect = $window.rect
  $relativeX = [int]$Target.x
  $relativeY = [int]$Target.y
  $screenX = [int]$windowRect.x + $relativeX
  $screenY = [int]$windowRect.y + $relativeY
  $delayMs = 200

  if ($Target.ContainsKey("delayMs") -and $null -ne $Target.delayMs) {
    $delayMs = [int]$Target.delayMs
  }

  $hwnd = [IntPtr]([int64]$window.hwnd)
  $messageTarget = Resolve-MouseMessageTarget -Hwnd $hwnd -ScreenX $screenX -ScreenY $screenY
  if ($messageTarget.client) {
    Post-MouseMessage -Hwnd $messageTarget.hwnd -Message 0x0200 -ButtonState 0 -LParam $messageTarget.lParam | Out-Null
  } else {
    Post-MouseMessage -Hwnd $messageTarget.hwnd -Message 0x00A0 -ButtonState $messageTarget.wParam -LParam $messageTarget.lParam | Out-Null
  }

  if ($delayMs -gt 0) {
    Start-Sleep -Milliseconds $delayMs
  }

  return [ordered]@{
    moved = $true
    target = "window:" + $window.hwnd
    hwnd = $window.hwnd
    title = $window.title
    pid = $window.pid
    method = "post_message"
    windowPoint = [ordered]@{
      x = $relativeX
      y = $relativeY
    }
    screenPoint = [ordered]@{
      x = $screenX
      y = $screenY
    }
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
  }
}

function Get-NamedVirtualKey {
  param([string]$Key)

  $map = @{
    'esc' = 0x1B; 'escape' = 0x1B
    'tab' = 0x09; 'enter' = 0x0D; 'return' = 0x0D
    'space' = 0x20; ' ' = 0x20
    'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
    'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73
    'f5' = 0x74; 'f6' = 0x75; 'f7' = 0x76; 'f8' = 0x77
    'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
    'backspace' = 0x08; 'bs' = 0x08
    'delete' = 0x2E; 'del' = 0x2E
    'home' = 0x24; 'end' = 0x23
    'pageup' = 0x21; 'pagedown' = 0x22
  }

  $lookupKey = $Key.ToLowerInvariant()
  if ($map.ContainsKey($lookupKey)) {
    return [byte]$map[$lookupKey]
  }

  return $null
}

function Resolve-CharacterKey {
  param([string]$Character)

  if ($Character.Length -ne 1) {
    return $null
  }

  $keyMap = @{
    '0' = 0x30; '1' = 0x31; '2' = 0x32; '3' = 0x33; '4' = 0x34
    '5' = 0x35; '6' = 0x36; '7' = 0x37; '8' = 0x38; '9' = 0x39
    'a' = 0x41; 'b' = 0x42; 'c' = 0x43; 'd' = 0x44; 'e' = 0x45
    'f' = 0x46; 'g' = 0x47; 'h' = 0x48; 'i' = 0x49; 'j' = 0x4A
    'k' = 0x4B; 'l' = 0x4C; 'm' = 0x4D; 'n' = 0x4E; 'o' = 0x4F
    'p' = 0x50; 'q' = 0x51; 'r' = 0x52; 's' = 0x53; 't' = 0x54
    'u' = 0x55; 'v' = 0x56; 'w' = 0x57; 'x' = 0x58; 'y' = 0x59
    'z' = 0x5A
    ' ' = 0x20; '-' = 0xBD; '=' = 0xBB; '[' = 0xDB; ']' = 0xDD
    '\' = 0xDC; ';' = 0xBA; "'" = 0xDE; ',' = 0xBC; '.' = 0xBE
    '/' = 0xBF; '`' = 0xC0
  }
  $keyMap[[string][char]0x0A] = 0x0D
  $keyMap[[string][char]0x0D] = 0x0D
  $keyMap[[string][char]0x09] = 0x09

  $shiftMap = @{
    '~' = '`'; '!' = '1'; '@' = '2'; '#' = '3'; '$' = '4'
    '%' = '5'; '^' = '6'; '&' = '7'; '*' = '8'; '(' = '9'
    ')' = '0'; '_' = '-'; '+' = '='; '{' = '['; '}' = ']'
    '|' = '\'; ':' = ';'; '"' = "'"; '<' = ','; '>' = '.'
    '?' = '/'
  }

  $lower = 'abcdefghijklmnopqrstuvwxyz'
  foreach ($ch in $lower.ToCharArray()) {
    $shiftMap[([string]$ch).ToUpper()] = [string]$ch
  }

  $needShift = $false
  $baseChar = $Character
  if ($shiftMap.ContainsKey($Character)) {
    $needShift = $true
    $baseChar = $shiftMap[$Character]
  }

  $lookupKey = $baseChar.ToLowerInvariant()
  if (-not $keyMap.ContainsKey($lookupKey)) {
    return $null
  }

  return [pscustomobject][ordered]@{
    vk = [byte]$keyMap[$lookupKey]
    shift = $needShift
  }
}

function Send-Key {
  param([hashtable]$Target)

  $window = Resolve-TargetWindow $Target
  Focus-Window $window

  $key = [string]$Target.key
  $modifiers = @()
  if ($Target.ContainsKey("modifiers") -and $null -ne $Target.modifiers) {
    $modifiers = @($Target.modifiers)
  }

  $pressMs = 30
  if ($Target.ContainsKey("pressMs") -and $null -ne $Target.pressMs) {
    $pressMs = [int]$Target.pressMs
  }
  $delayMs = 50
  if ($Target.ContainsKey("delayMs") -and $null -ne $Target.delayMs) {
    $delayMs = [int]$Target.delayMs
  }

  $KEYEVENTF_KEYDOWN = 0x0000
  $KEYEVENTF_KEYUP = 0x0002
  $VK_SHIFT = 0x10
  $VK_CONTROL = 0x11
  $VK_MENU = 0x12
  $VK_LWIN = 0x5B

  $vk = Get-NamedVirtualKey $key
  $needShift = $false
  if ($null -eq $vk) {
    $stroke = Resolve-CharacterKey $key
    if ($null -eq $stroke) {
      throw "Unsupported key: $key"
    }
    $vk = [byte]$stroke.vk
    $needShift = [bool]$stroke.shift
  }

  $modVks = @()
  foreach ($mod in $modifiers) {
    switch ($mod.ToLowerInvariant()) {
      'alt'   { $modVks += $VK_MENU }
      'ctrl'  { $modVks += $VK_CONTROL }
      'shift' { $modVks += $VK_SHIFT }
      'win'   { $modVks += $VK_LWIN }
    }
  }

  if ($needShift -and -not ($modVks -contains $VK_SHIFT)) {
    $modVks += $VK_SHIFT
  }

  foreach ($mvk in $modVks) {
    [ScreenshotTool.Native]::keybd_event([byte]$mvk, 0, $KEYEVENTF_KEYDOWN, [UIntPtr]::Zero)
  }

  [ScreenshotTool.Native]::keybd_event($vk, 0, $KEYEVENTF_KEYDOWN, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds $pressMs
  [ScreenshotTool.Native]::keybd_event($vk, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)

  for ($i = $modVks.Count - 1; $i -ge 0; $i--) {
    [ScreenshotTool.Native]::keybd_event([byte]$modVks[$i], 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  }

  if ($delayMs -gt 0) {
    Start-Sleep -Milliseconds $delayMs
  }

  return [ordered]@{
    sent = $true
    key = $key
    modifiers = $modifiers
    target = "window:" + $window.hwnd
    hwnd = $window.hwnd
    title = $window.title
    pid = $window.pid
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
  }
}

function Type-Text {
  param([hashtable]$Target)

  $window = Resolve-TargetWindow $Target
  Focus-Window $window
  $delayMs = 50
  $pressMs = 30

  if ($Target.ContainsKey("delayMs") -and $null -ne $Target.delayMs) {
    $delayMs = [int]$Target.delayMs
  }
  if ($Target.ContainsKey("pressMs") -and $null -ne $Target.pressMs) {
    $pressMs = [int]$Target.pressMs
  }

  $text = [string]$Target.text
  $KEYEVENTF_KEYDOWN = 0x0000
  $KEYEVENTF_KEYUP = 0x0002
  $VK_SHIFT = 0x10

  $skipped = [System.Collections.ArrayList]::new()

  foreach ($ch in $text.ToCharArray()) {
    $chText = [string]$ch
    $stroke = Resolve-CharacterKey $chText
    if ($null -eq $stroke) {
      $skipped.Add([string]$ch) | Out-Null
      continue
    }
    $vk = [byte]$stroke.vk
    $needShift = [bool]$stroke.shift

    if ($needShift) {
      [ScreenshotTool.Native]::keybd_event($VK_SHIFT, 0, $KEYEVENTF_KEYDOWN, [UIntPtr]::Zero)
    }

    [ScreenshotTool.Native]::keybd_event($vk, 0, $KEYEVENTF_KEYDOWN, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds $pressMs
    [ScreenshotTool.Native]::keybd_event($vk, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)

    if ($needShift) {
      [ScreenshotTool.Native]::keybd_event($VK_SHIFT, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
    }

    if ($delayMs -gt 0) {
      Start-Sleep -Milliseconds $delayMs
    }
  }

  return [ordered]@{
    typed = $true
    target = "window:" + $window.hwnd
    hwnd = $window.hwnd
    title = $window.title
    pid = $window.pid
    textLength = $text.Length
    skipped = @($skipped.ToArray())
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
  }
}

try {
  $request = ConvertTo-Hashtable ($InputJson | ConvertFrom-Json)

  switch ($request.action) {
    "list-windows" {
      $filters = @{}
      if ($request.ContainsKey("filters") -and $null -ne $request.filters) {
        $filters = $request.filters
      }
      $result = @(Filter-Windows (Get-VisibleWindows) $filters)
    }
    "capture-window" {
      $result = Capture-Window -Target $request.target -OutputPath $request.outputPath
    }
    "capture-screen-region" {
      $result = Capture-ScreenRegion -Region $request.region -OutputPath $request.outputPath
    }
    "click-window" {
      $result = Click-Window -Target $request.target
    }
    "click-menu-item" {
      $result = Click-MenuItem -Target $request.target
    }
    "move-mouse-window" {
      $result = Move-MouseWindow -Target $request.target
    }
    "type-text" {
      $result = Type-Text -Target $request.target
    }
    "send-key" {
      $result = Send-Key -Target $request.target
    }
    default {
      throw "Unknown action: $($request.action)"
    }
  }

  ConvertTo-Json -InputObject $result -Depth 8 -Compress
} catch {
  Write-Error $_.Exception.ToString()
  exit 1
}
