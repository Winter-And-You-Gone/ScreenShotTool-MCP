param(
  [Parameter(Mandatory = $false)]
  [string]$InputJson,

  [Parameter(Mandatory = $false)]
  [switch]$Worker
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
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

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW", SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW", SetLastError = true)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
      public ushort wVk;
      public ushort wScan;
      public uint dwFlags;
      public uint time;
      public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
      public int dx;
      public int dy;
      public uint mouseData;
      public uint dwFlags;
      public uint time;
      public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT {
      public uint uMsg;
      public ushort wParamL;
      public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT_UNION {
      [FieldOffset(0)] public MOUSEINPUT mi;
      [FieldOffset(0)] public KEYBDINPUT ki;
      [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
      public uint type;
      public INPUT_UNION u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, [In] INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    // EM_REPLACESEL (and other standard messages) — Windows marshals the
    // string across process boundaries automatically.
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
    public static extern IntPtr SendMessageStr(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);

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

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetMenuStringW")]
    public static extern int GetMenuString(IntPtr hMenu, uint uIDItem, StringBuilder lpString, int nMaxCount, uint uFlag);

    [DllImport("user32.dll")]
    public static extern uint GetMenuItemID(IntPtr hMenu, int nPos);

    [DllImport("user32.dll")]
    public static extern bool GetMenuItemRect(IntPtr hWnd, IntPtr hMenu, uint uItem, out RECT lprcItem);

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int cx, int cy);

    [DllImport("gdi32.dll")]
    public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr hObject);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hWnd, uint dwAttribute, out int pvAttribute, int cbAttribute);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
      public int X;
      public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO {
      public uint cbSize;
      public uint flags;
      public IntPtr hwndActive;
      public IntPtr hwndFocus;
      public IntPtr hwndCapture;
      public IntPtr hwndMenuOwner;
      public IntPtr hwndMoveSize;
      public IntPtr hwndCaret;
      public RECT rcCaret;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetGUIThreadInfo(uint idThread, out GUITHREADINFO lpgui);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    public delegate void WinEventProc(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, WinEventProc lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnhookWinEvent(IntPtr hWinEventHook);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    // Clipboard APIs (Feature 5: read_clipboard / write_clipboard).
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool OpenClipboard(IntPtr hWndNewOwner);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EmptyClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetClipboardData(uint uFormat);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);

    [DllImport("user32.dll")]
    public static extern bool IsClipboardFormatAvailable(uint format);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalLock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GlobalUnlock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalFree(IntPtr hMem);

    [DllImport("kernel32.dll")]
    public static extern UIntPtr GlobalSize(IntPtr hMem);

    // Window state APIs (Feature 6: get_window_state).
    [DllImport("user32.dll")]
    public static extern bool IsZoomed(IntPtr hWnd);

    // GetWindowLongPtrW does not exist in 32-bit user32.dll; provide both
    // and let the caller pick at runtime.
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
    public static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    public static extern IntPtr GetWindowLong64(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetLayeredWindowAttributes(IntPtr hWnd, out uint crKey, out byte bAlpha, out uint dwFlags);
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

function Test-WindowCloaked {
  param([IntPtr]$Hwnd)

  $DWMWA_CLOAKED = [uint32]14
  $cloaked = 0
  $hr = [ScreenshotTool.Native]::DwmGetWindowAttribute($Hwnd, $DWMWA_CLOAKED, [ref]$cloaked, 4)
  if ($hr -ne 0) {
    return $false
  }
  return $cloaked -ne 0
}

function Get-AllWindows {
  $windows = [System.Collections.ArrayList]::new()
  $excludedClasses = @(
    'ApplicationFrameWindow_skip',
    'Windows.UI.Core.CoreWindow',
    'Shell_TrayWnd',
    'Shell_SecondaryTrayWnd',
    'WorkerW',
    'Progman',
    'TaskListThumbnailWnd',
    'MSCTFIME UI',
    'IME'
  )

  $callback = [ScreenshotTool.Native+EnumWindowsProc]{
    param([IntPtr]$Hwnd, [IntPtr]$LParam)

    if (Test-WindowCloaked $Hwnd) {
      return $true
    }

    $className = Get-WindowClassName $Hwnd
    if ($excludedClasses -contains $className) {
      return $true
    }

    $title = Get-WindowTitle $Hwnd
    $isVisible = [bool][ScreenshotTool.Native]::IsWindowVisible($Hwnd)
    $isIconic = [bool][ScreenshotTool.Native]::IsIconic($Hwnd)

    if ([string]::IsNullOrWhiteSpace($title) -and -not $isIconic) {
      return $true
    }

    $rect = New-Object ScreenshotTool.Native+RECT
    if (-not [ScreenshotTool.Native]::GetWindowRect($Hwnd, [ref]$rect)) {
      return $true
    }
    $width = [Math]::Max(0, $rect.Right - $rect.Left)
    $height = [Math]::Max(0, $rect.Bottom - $rect.Top)

    if (-not $isIconic -and ($width -le 0 -or $height -le 0)) {
      return $true
    }

    $pidValue = [uint32]0
    [ScreenshotTool.Native]::GetWindowThreadProcessId($Hwnd, [ref]$pidValue) | Out-Null

    $windows.Add([ordered]@{
      hwnd = $Hwnd.ToInt64().ToString()
      title = $title
      pid = [int]$pidValue
      processName = Get-WindowProcessName $pidValue
      className = $className
      rect = Get-RectObject $rect
      visible = $isVisible
      iconic = $isIconic
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
    $Windows,
    [hashtable]$Filters
  )

  $result = [System.Collections.ArrayList]::new()
  foreach ($win in $Windows) {
    if ($Filters.ContainsKey("pid") -and $null -ne $Filters.pid) {
      if ($win.pid -ne [int]$Filters.pid) { continue }
    }
    if ($Filters.ContainsKey("processName") -and -not [string]::IsNullOrWhiteSpace($Filters.processName)) {
      $processName = Normalize-ProcessName $Filters.processName
      if ($win.processName -ine $processName) { continue }
    }
    if ($Filters.ContainsKey("titleContains") -and -not [string]::IsNullOrWhiteSpace($Filters.titleContains)) {
      $needle = [string]$Filters.titleContains
      if ($win.title.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    }
    $result.Add($win) | Out-Null
  }
  return @($result.ToArray())
}

function Resolve-TargetWindow {
  param(
    [hashtable]$Target,
    [switch]$IncludeHidden
  )

  # Fast path: when an hwnd is provided, skip the expensive full window
  # enumeration and construct the WindowInfo directly from Win32 calls.
  if ($Target.ContainsKey("hwnd") -and $null -ne $Target.hwnd) {
    $hwndText = ([string]$Target.hwnd).Trim()
    $parsedInt64 = [int64]0
    if (-not [int64]::TryParse($hwndText, [ref]$parsedInt64)) {
      throw "Invalid hwnd value: '$hwndText'. Must be a numeric window handle."
    }
    $hwnd = [IntPtr]$parsedInt64

    $isVisible = [ScreenshotTool.Native]::IsWindowVisible($hwnd)
    $isIconic = [ScreenshotTool.Native]::IsIconic($hwnd)
    if ($isVisible -or $IncludeHidden) {
      $rect = New-Object ScreenshotTool.Native+RECT
      [ScreenshotTool.Native]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
      $pidValue = [uint32]0
      [ScreenshotTool.Native]::GetWindowThreadProcessId($hwnd, [ref]$pidValue) | Out-Null
      $titleBuilder = New-Object System.Text.StringBuilder 256
      [ScreenshotTool.Native]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity) | Out-Null
      $classBuilder = New-Object System.Text.StringBuilder 256
      [ScreenshotTool.Native]::GetClassName($hwnd, $classBuilder, $classBuilder.Capacity) | Out-Null

      return [ordered]@{
        hwnd        = $hwndText
        title       = $titleBuilder.ToString()
        pid         = [int]$pidValue
        processName = Get-WindowProcessName $pidValue
        className   = $classBuilder.ToString()
        rect        = Get-RectObject $rect
        visible     = $isVisible
        iconic      = $isIconic
      }
    }

    throw "No window found for hwnd $hwndText."
  }

  $windows = if ($IncludeHidden) { Get-AllWindows } else { Get-VisibleWindows }
  if ($null -eq $windows) { $windows = @() }
  $windows = @($windows)

  $filtered = @(Filter-Windows $windows $Target)
  if ($filtered.Count -lt 1) {
    throw "No window matched the provided target."
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

function Capture-WindowPrint {
  param(
    [object]$Window,
    [hashtable]$Region,
    [string]$OutputPath
  )

  $hwnd = [IntPtr]([int64]$Window.hwnd)
  $windowRect = $Window.rect

  $wasIconic = $false
  if ($Window.iconic) {
    $wasIconic = $true
    $SW_SHOWNOACTIVATE = 4
    $SWP_NOSIZE = 0x0001
    $SWP_NOMOVE = 0x0002
    $SWP_NOACTIVATE = 0x0010
    $hwndBottom = [IntPtr]1
    $flags = [uint32]($SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE)
    [ScreenshotTool.Native]::ShowWindow($hwnd, $SW_SHOWNOACTIVATE) | Out-Null
    [ScreenshotTool.Native]::SetWindowPos($hwnd, $hwndBottom, 0, 0, 0, 0, $flags) | Out-Null
    Start-Sleep -Milliseconds 300
    $updatedRect = New-Object ScreenshotTool.Native+RECT
    [ScreenshotTool.Native]::GetWindowRect($hwnd, [ref]$updatedRect) | Out-Null
    $windowRect = Get-RectObject $updatedRect
  }

  $fullWidth = [int]$windowRect.width
  $fullHeight = [int]$windowRect.height

  if ($fullWidth -le 0 -or $fullHeight -le 0) {
    throw "Window has no measurable area."
  }

  $directory = Split-Path -Parent $OutputPath
  if ($directory) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }

  $captureX = 0
  $captureY = 0
  $captureWidth = $fullWidth
  $captureHeight = $fullHeight

  if ($null -ne $Region) {
    $captureX = [Math]::Max(0, [int]$Region.x)
    $captureY = [Math]::Max(0, [int]$Region.y)
    $captureWidth = [Math]::Min([int]$Region.width, $fullWidth - $captureX)
    $captureHeight = [Math]::Min([int]$Region.height, $fullHeight - $captureY)

    if ($captureWidth -le 0 -or $captureHeight -le 0) {
      throw "Region is outside the window bounds."
    }
  }

  try {
    $hdcWindow = [ScreenshotTool.Native]::GetWindowDC($hwnd)
    if ($hdcWindow -eq [IntPtr]::Zero) {
      throw "Failed to get window DC."
    }

    try {
      $hdcMem = [ScreenshotTool.Native]::CreateCompatibleDC($hdcWindow)
      if ($hdcMem -eq [IntPtr]::Zero) {
        throw "Failed to create compatible DC."
      }

      try {
        $hBitmap = [ScreenshotTool.Native]::CreateCompatibleBitmap($hdcWindow, $fullWidth, $fullHeight)
        if ($hBitmap -eq [IntPtr]::Zero) {
          throw "Failed to create compatible bitmap."
        }

        try {
          $hOldBitmap = [ScreenshotTool.Native]::SelectObject($hdcMem, $hBitmap)
          $PW_RENDERFULLCONTENT = [uint32]0x00000002

          if (-not [ScreenshotTool.Native]::PrintWindow($hwnd, $hdcMem, $PW_RENDERFULLCONTENT)) {
            if (-not [ScreenshotTool.Native]::PrintWindow($hwnd, $hdcMem, [uint32]0)) {
              throw "PrintWindow failed for this window. The window may not support WM_PRINT."
            }
          }

          $fullBitmap = [System.Drawing.Image]::FromHbitmap($hBitmap)

          try {
            if ($captureWidth -ne $fullWidth -or $captureHeight -ne $fullHeight -or $captureX -ne 0 -or $captureY -ne 0) {
              $croppedBitmap = New-Object System.Drawing.Bitmap $captureWidth, $captureHeight
              $graphics = [System.Drawing.Graphics]::FromImage($croppedBitmap)
              try {
                $graphics.DrawImage($fullBitmap, -$captureX, -$captureY)
                $croppedBitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
              } finally {
                $graphics.Dispose()
                $croppedBitmap.Dispose()
              }
            } else {
              $fullBitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
            }
          } finally {
            $fullBitmap.Dispose()
          }
        } finally {
          if ($hOldBitmap -ne [IntPtr]::Zero) {
            [ScreenshotTool.Native]::SelectObject($hdcMem, $hOldBitmap) | Out-Null
          }
          [ScreenshotTool.Native]::DeleteObject($hBitmap) | Out-Null
        }
      } finally {
        [ScreenshotTool.Native]::DeleteDC($hdcMem) | Out-Null
      }
    } finally {
      [ScreenshotTool.Native]::ReleaseDC($hwnd, $hdcWindow) | Out-Null
    }
  } finally {
    if ($wasIconic) {
      $SW_MINIMIZE = 6
      [ScreenshotTool.Native]::ShowWindow($hwnd, $SW_MINIMIZE) | Out-Null
    }
  }

  $screenX = [int]$windowRect.x + $captureX
  $screenY = [int]$windowRect.y + $captureY

  $rect = [ordered]@{
    x = $screenX
    y = $screenY
    width = $captureWidth
    height = $captureHeight
    left = $screenX
    top = $screenY
    right = $screenX + $captureWidth
    bottom = $screenY + $captureHeight
  }

  return [ordered]@{
    path = (Resolve-Path $OutputPath).Path
    width = $captureWidth
    height = $captureHeight
    target = "window:" + $Window.hwnd
    rect = $rect
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
  }
}

function Capture-Window {
  param(
    [hashtable]$Target,
    [string]$OutputPath
  )

  $captureMethod = "screen"
  if ($Target.ContainsKey("captureMethod") -and $null -ne $Target.captureMethod) {
    $captureMethod = ([string]$Target.captureMethod).ToLowerInvariant()
  }

  $noActivate = $false
  if ($Target.ContainsKey("noActivate") -and $null -ne $Target.noActivate) {
    $noActivate = [bool]$Target.noActivate
  }

  # When noActivate is requested with screen capture, switch to PrintWindow
  # instead — no z-order juggling, no visual flash.
  if ($noActivate -and $captureMethod -eq "screen") {
    $captureMethod = "print"
  }

  $includeHidden = ($captureMethod -eq "print")
  $window = Resolve-TargetWindow -Target $Target -IncludeHidden:$includeHidden

  if ($captureMethod -eq "print") {
    $region = $null
    if ($Target.ContainsKey("region") -and $null -ne $Target.region) {
      $region = $Target.region
    }
    return Capture-WindowPrint -Window $window -Region $region -OutputPath $OutputPath
  }

  $focus = $true
  if ($Target.ContainsKey("focus") -and $null -ne $Target.focus) {
    $focus = [bool]$Target.focus
  }
  $hwnd = [IntPtr]([int64]$window.hwnd)
  $previousForeground = [IntPtr]::Zero

  if ($focus) {
    $previousForeground = [ScreenshotTool.Native]::GetForegroundWindow()
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
    # Clamp the region so it doesn't extend past the window bounds.
    # Without this, CopyFromScreen returns black pixels for out-of-bounds areas.
    $maxWidth = [int]$windowRect.width - [int]$region.x
    $maxHeight = [int]$windowRect.height - [int]$region.y
    $captureWidth = [Math]::Max(1, [Math]::Min([int]$region.width, $maxWidth))
    $captureHeight = [Math]::Max(1, [Math]::Min([int]$region.height, $maxHeight))
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

  try {
    return Save-Screenshot -X $captureX -Y $captureY -Width $captureWidth -Height $captureHeight -OutputPath $OutputPath -Target ("window:" + $window.hwnd) -Rect $rect
  } finally {
    if ($focus -and $previousForeground -ne [IntPtr]::Zero -and $previousForeground -ne ([IntPtr]([int64]$window.hwnd))) {
      [ScreenshotTool.Native]::SetForegroundWindow($previousForeground) | Out-Null
    }
  }
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

function Post-CharMessage {
  param(
    [IntPtr]$Hwnd,
    [uint16]$Char
  )

  $WM_CHAR = [uint32]0x0102
  $posted = [ScreenshotTool.Native]::PostMessage($Hwnd, $WM_CHAR, [IntPtr]$Char, [IntPtr]::Zero)
  if (-not $posted) {
    throw "Failed to post WM_CHAR for code $Char."
  }
  return $posted
}

function New-KeyLParam {
  param(
    [byte]$Vk,
    [bool]$Down
  )

  $scanCode = [byte][ScreenshotTool.Native]::MapVirtualKey([uint32]$Vk, [uint32]0)
  $extendedKeys = @{
    [byte]0x21 = $true; [byte]0x22 = $true; [byte]0x23 = $true; [byte]0x24 = $true
    [byte]0x25 = $true; [byte]0x26 = $true; [byte]0x27 = $true; [byte]0x28 = $true
    [byte]0x2C = $true; [byte]0x2D = $true; [byte]0x2E = $true
    [byte]0x5B = $true; [byte]0x5C = $true
  }
  $isExtended = $extendedKeys.ContainsKey($Vk)

  # lParam layout: bits 0-15 = repeat count (1), bits 16-23 = scan code,
  # bit 24 = extended key flag, bit 30 = previous key state, bit 31 = transition state
  $repeatCount = [uint32]1
  $scanField = [uint32]([uint32]$scanCode -shl 16)
  $extendedFlag = if ($isExtended) { [uint32]0x01000000 } else { [uint32]0 }
  # 0xC0000000 = bits 30+31 set (previous key down + transition state released).
  # PowerShell 5 treats hex literals > 0x7FFFFFFF as int64, which is fine for IntPtr.
  $prevAndTrans = if ($Down) { [long]0 } else { [long]0xC0000000 }

  $combined = [long]$repeatCount -bor [long]$scanField -bor [long]$extendedFlag -bor $prevAndTrans
  return [IntPtr]([long]$combined)
}

function Post-KeyMessage {
  param(
    [IntPtr]$Hwnd,
    [byte]$Vk,
    [bool]$Down
  )

  $WM_KEYDOWN = [uint32]0x0100
  $WM_KEYUP = [uint32]0x0101
  $msg = if ($Down) { $WM_KEYDOWN } else { $WM_KEYUP }
  $lParam = New-KeyLParam -Vk $Vk -Down $Down

  $posted = [ScreenshotTool.Native]::PostMessage($Hwnd, $msg, [IntPtr]$Vk, $lParam)
  if (-not $posted) {
    throw "Failed to post key message 0x$($msg.ToString('X4')) for VK 0x$($Vk.ToString('X2'))."
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
  $noActivate = $false
  if ($Target.ContainsKey("noActivate") -and $null -ne $Target.noActivate) {
    $noActivate = [bool]$Target.noActivate
  }

  if (-not $noActivate) {
    Focus-Window $window
  }

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

  $hwnd = [IntPtr]([int64]$window.hwnd)

  if ($noActivate) {
    # PostMessage WM_KEYDOWN / WM_KEYUP — no focus needed
    foreach ($mvk in $modVks) {
      Post-KeyMessage -Hwnd $hwnd -Vk ([byte]$mvk) -Down $true | Out-Null
    }
    Post-KeyMessage -Hwnd $hwnd -Vk $vk -Down $true | Out-Null
    Start-Sleep -Milliseconds $pressMs
    Post-KeyMessage -Hwnd $hwnd -Vk $vk -Down $false | Out-Null
    for ($i = $modVks.Count - 1; $i -ge 0; $i--) {
      Post-KeyMessage -Hwnd $hwnd -Vk ([byte]$modVks[$i]) -Down $false | Out-Null
    }
  } else {
    # keybd_event — global, requires foreground focus
    $KEYEVENTF_KEYDOWN = 0x0000
    $KEYEVENTF_KEYUP = 0x0002
    foreach ($mvk in $modVks) {
      [ScreenshotTool.Native]::keybd_event([byte]$mvk, 0, $KEYEVENTF_KEYDOWN, [UIntPtr]::Zero)
    }
    [ScreenshotTool.Native]::keybd_event($vk, 0, $KEYEVENTF_KEYDOWN, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds $pressMs
    [ScreenshotTool.Native]::keybd_event($vk, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
    for ($i = $modVks.Count - 1; $i -ge 0; $i--) {
      [ScreenshotTool.Native]::keybd_event([byte]$modVks[$i], 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
    }
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

function Send-UnicodeChar {
  param([uint16]$Scan)

  $INPUT_KEYBOARD = [uint32]1
  $KEYEVENTF_KEYUP = [uint32]0x0002
  $KEYEVENTF_UNICODE = [uint32]0x0004

  $down = New-Object ScreenshotTool.Native+INPUT
  $down.type = $INPUT_KEYBOARD
  $down.u.ki.wVk = [uint16]0
  $down.u.ki.wScan = $Scan
  $down.u.ki.dwFlags = $KEYEVENTF_UNICODE
  $down.u.ki.time = [uint32]0
  $down.u.ki.dwExtraInfo = [IntPtr]::Zero

  $up = New-Object ScreenshotTool.Native+INPUT
  $up.type = $INPUT_KEYBOARD
  $up.u.ki.wVk = [uint16]0
  $up.u.ki.wScan = $Scan
  $up.u.ki.dwFlags = ($KEYEVENTF_UNICODE -bor $KEYEVENTF_KEYUP)
  $up.u.ki.time = [uint32]0
  $up.u.ki.dwExtraInfo = [IntPtr]::Zero

  $inputs = [ScreenshotTool.Native+INPUT[]]@($down, $up)
  $sent = [ScreenshotTool.Native]::SendInput([uint32]2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type]([ScreenshotTool.Native+INPUT])))
  return $sent -eq 2
}

function Type-Text {
  param([hashtable]$Target)

  $window = Resolve-TargetWindow $Target
  $noActivate = $false
  if ($Target.ContainsKey("noActivate") -and $null -ne $Target.noActivate) {
    $noActivate = [bool]$Target.noActivate
  }

  if (-not $noActivate) {
    Focus-Window $window
  }
  $delayMs = 50
  $pressMs = 30

  if ($Target.ContainsKey("delayMs") -and $null -ne $Target.delayMs) {
    $delayMs = [int]$Target.delayMs
  }
  if ($Target.ContainsKey("pressMs") -and $null -ne $Target.pressMs) {
    $pressMs = [int]$Target.pressMs
  }

  $text = [string]$Target.text
  $skipped = [System.Collections.ArrayList]::new()
  $hwnd = [IntPtr]([int64]$window.hwnd)

  if ($noActivate) {
    # PostMessage WM_CHAR directly to the focused child control — no
    # activation, no flash, no foreground switch.
    #
    # Strategy to find the right target hwnd:
    #   1. GetGUIThreadInfo — works when the window is in the foreground.
    #   2. When the window is in the background, hwndFocus is NULL, so
    #      we fall back to enumerating child windows and picking the one
    #      whose class name looks like an edit control (Scintilla, Edit,
    #      RichEdit, TextBox, etc.).
    $targetHwnd = $hwnd
    $pidValue = [uint32]0
    $threadId = [ScreenshotTool.Native]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
    $guiInfo = New-Object ScreenshotTool.Native+GUITHREADINFO
    $guiInfo.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($guiInfo)
    if ([ScreenshotTool.Native]::GetGUIThreadInfo([uint32]$threadId, [ref]$guiInfo)) {
      if ($guiInfo.hwndFocus -ne [IntPtr]::Zero) {
        $targetHwnd = $guiInfo.hwndFocus
      }
    }

    # If GetGUIThreadInfo didn't give us a focus child (window is in
    # the background), search for an editable child control by class name.
    $targetClassName = ''
    # Edit class definitions: each entry maps a class name to whether it
    # supports EM_REPLACESEL for bulk text insertion.  Classes not listed
    # here default to replaceSel=$false and fall through to per-char WM_CHAR.
    $editClassDefs = @{
      'Scintilla'      = $true
      'Edit'           = $true
      'RichEdit20W'    = $true
      'RichEdit20A'    = $true
      'RICHEDIT50W'    = $true
      'RichEdit'       = $true
      'TEXTEDIT'       = $true
      'TextBox'        = $false
      'ATL:006C0280'   = $false
      'AfxWnd42su'     = $false
      'NetUIHWND'      = $false
    }
    if ($targetHwnd -eq $hwnd) {
      $script:foundEditChild = [IntPtr]::Zero
      $script:foundEditClass = ''
      $enumProc = [ScreenshotTool.Native+EnumWindowsProc]{
        param([IntPtr]$Child, [IntPtr]$LParam)
        $cn = New-Object System.Text.StringBuilder 256
        [ScreenshotTool.Native]::GetClassName($Child, $cn, $cn.Capacity) | Out-Null
        $className = $cn.ToString()
        foreach ($key in $editClassDefs.Keys) {
          if ($className -ieq $key) {
            $script:foundEditChild = $Child
            $script:foundEditClass = $className
            return $false
          }
        }
        return $true
      }
      [ScreenshotTool.Native]::EnumChildWindows($hwnd, $enumProc, [IntPtr]::Zero) | Out-Null
      if ($script:foundEditChild -ne [IntPtr]::Zero) {
        $targetHwnd = $script:foundEditChild
        $targetClassName = $script:foundEditClass
      }
    } else {
      $cnBuf = New-Object System.Text.StringBuilder 256
      [ScreenshotTool.Native]::GetClassName($targetHwnd, $cnBuf, $cnBuf.Capacity) | Out-Null
      $targetClassName = $cnBuf.ToString()
    }

    # Edit-style controls that support EM_REPLACESEL can receive the entire
    # text in one SendMessage call. The kernel marshals the string across
    # process boundaries automatically, so we don't need WriteProcessMemory.
    $EM_REPLACESEL = [uint32]0x00C2
    $useReplaceSel = $false
    if ($editClassDefs.ContainsKey($targetClassName)) {
      $useReplaceSel = $editClassDefs[$targetClassName]
    }

    if ($useReplaceSel -and $text.Length -gt 0) {
      [ScreenshotTool.Native]::SendMessageStr($targetHwnd, $EM_REPLACESEL, [IntPtr]1, $text) | Out-Null
      if ($delayMs -gt 0) {
        Start-Sleep -Milliseconds $delayMs
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

    foreach ($ch in $text.ToCharArray()) {
      $scan = [uint16][int][char]$ch
      if (-not (Post-CharMessage -Hwnd $targetHwnd -Char $scan)) {
        $skipped.Add([string]$ch) | Out-Null
        continue
      }

      if ($pressMs -gt 0) {
        Start-Sleep -Milliseconds $pressMs
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

function Minimize-Window {
  param([hashtable]$Target)

  $window = Resolve-TargetWindow -Target $Target -IncludeHidden
  $hwnd = [IntPtr]([int64]$window.hwnd)
  $SW_MINIMIZE = 6
  $ok = [bool][ScreenshotTool.Native]::ShowWindow($hwnd, $SW_MINIMIZE)

  return [ordered]@{
    minimized = $ok
    target = "window:" + $window.hwnd
    hwnd = $window.hwnd
    title = $window.title
    pid = $window.pid
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
  }
}

function NoActivate-Minimize {
  param([hashtable]$Target)

  $window = Resolve-TargetWindow -Target $Target
  $hwnd = [IntPtr]([int64]$window.hwnd)

  # Show without activating, then push to bottom of z-order without activating.
  $SW_SHOWNOACTIVATE = 4
  $SWP_NOSIZE = [uint32]0x0001
  $SWP_NOMOVE = [uint32]0x0002
  $SWP_NOACTIVATE = [uint32]0x0010
  $hwndBottom = [IntPtr]1
  $flags = $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE

  [ScreenshotTool.Native]::ShowWindow($hwnd, $SW_SHOWNOACTIVATE) | Out-Null
  [ScreenshotTool.Native]::SetWindowPos($hwnd, $hwndBottom, 0, 0, 0, 0, $flags) | Out-Null

  return [ordered]@{
    minimized = $true
    noActivate = $true
    target = "window:" + $window.hwnd
    hwnd = $window.hwnd
    title = $window.title
    pid = $window.pid
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
  }
}

function Open-ClipboardWithRetry {
  # OpenClipboard frequently fails when another process is briefly using the
  # clipboard (e.g. during a Ctrl+C). Retry up to ~500ms before giving up.
  $maxAttempts = 50
  for ($i = 0; $i -lt $maxAttempts; $i++) {
    if ([ScreenshotTool.Native]::OpenClipboard([IntPtr]::Zero)) {
      return $true
    }
    Start-Sleep -Milliseconds 10
  }
  return $false
}

function Read-Clipboard {
  # No target parameter — clipboard is a global resource.

  $CF_UNICODETEXT = [uint32]13
  $opened = $false
  try {
    if (-not (Open-ClipboardWithRetry)) {
      throw "Failed to open clipboard after multiple retries."
    }
    $opened = $true

    if (-not [ScreenshotTool.Native]::IsClipboardFormatAvailable($CF_UNICODETEXT)) {
      return [ordered]@{
        available = $false
        text = ''
        length = 0
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
      }
    }

    $hData = [ScreenshotTool.Native]::GetClipboardData($CF_UNICODETEXT)
    if ($hData -eq [IntPtr]::Zero) {
      return [ordered]@{
        available = $false
        text = ''
        length = 0
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
      }
    }

    $ptr = [ScreenshotTool.Native]::GlobalLock($hData)
    if ($ptr -eq [IntPtr]::Zero) {
      throw "Failed to lock clipboard memory."
    }
    try {
      $text = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($ptr)
      if ($null -eq $text) { $text = '' }
      return [ordered]@{
        available = $true
        text = $text
        length = $text.Length
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
      }
    } finally {
      [ScreenshotTool.Native]::GlobalUnlock($hData) | Out-Null
    }
  } finally {
    if ($opened) {
      [ScreenshotTool.Native]::CloseClipboard() | Out-Null
    }
  }
}

function Write-Clipboard {
  param([hashtable]$Target)

  $text = ''
  if ($Target.ContainsKey('text') -and $null -ne $Target.text) {
    $text = [string]$Target.text
  }

  $CF_UNICODETEXT = [uint32]13
  # GMEM_MOVEABLE (0x0002) | GMEM_ZEROINIT (0x0040) — required for SetClipboardData.
  $GMEM_FLAGS = [uint32]0x0042

  # UTF-16 byte count including the trailing null terminator.
  $charCount = $text.Length + 1
  $byteCount = $charCount * 2

  $opened = $false
  $hMem = [IntPtr]::Zero
  $ownershipTransferred = $false
  try {
    if (-not (Open-ClipboardWithRetry)) {
      throw "Failed to open clipboard after multiple retries."
    }
    $opened = $true

    if (-not [ScreenshotTool.Native]::EmptyClipboard()) {
      throw "Failed to empty clipboard."
    }

    $hMem = [ScreenshotTool.Native]::GlobalAlloc($GMEM_FLAGS, [UIntPtr]([uint64]$byteCount))
    if ($hMem -eq [IntPtr]::Zero) {
      throw "GlobalAlloc failed for $byteCount bytes."
    }

    $ptr = [ScreenshotTool.Native]::GlobalLock($hMem)
    if ($ptr -eq [IntPtr]::Zero) {
      throw "Failed to lock clipboard memory."
    }
    try {
      # Encode as UTF-16LE without BOM. The trailing null terminator is
      # already provided by GMEM_ZEROINIT (the buffer was zeroed at alloc).
      $encoder = New-Object System.Text.UnicodeEncoding($false, $false)
      $bytes = $encoder.GetBytes($text)
      if ($bytes.Length -gt 0) {
        [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
      }
    } finally {
      [ScreenshotTool.Native]::GlobalUnlock($hMem) | Out-Null
    }

    $setResult = [ScreenshotTool.Native]::SetClipboardData($CF_UNICODETEXT, $hMem)
    if ($setResult -eq [IntPtr]::Zero) {
      throw "SetClipboardData failed."
    }
    # Ownership transferred to the system — we must NOT free hMem.
    $ownershipTransferred = $true

    return [ordered]@{
      written = $true
      length = $text.Length
      timestamp = (Get-Date).ToUniversalTime().ToString("o")
    }
  } finally {
    if ($opened) {
      [ScreenshotTool.Native]::CloseClipboard() | Out-Null
    }
    if ($hMem -ne [IntPtr]::Zero -and -not $ownershipTransferred) {
      [ScreenshotTool.Native]::GlobalFree($hMem) | Out-Null
    }
  }
}

function Get-WindowState {
  param([hashtable]$Target)

  $window = Resolve-TargetWindow -Target $Target -IncludeHidden
  $hwnd = [IntPtr]([int64]$window.hwnd)

  $GWL_STYLE = -16
  $GWL_EXSTYLE = -20
  $WS_DISABLED = [int64]0x08000000
  $WS_EX_TOPMOST = [int64]0x00000008
  $WS_EX_TOOLWINDOW = [int64]0x00000080
  $WS_EX_LAYERED = [int64]0x00080000
  $WS_EX_TRANSPARENT = [int64]0x00000020
  $WS_EX_NOACTIVATE = [int64]0x08000000

  # GetWindowLongPtrW only exists in 64-bit builds; on 32-bit PowerShell,
  # fall back to GetWindowLongW. Use [IntPtr]::Size to detect at runtime.
  if ([IntPtr]::Size -eq 8) {
    $style = [ScreenshotTool.Native]::GetWindowLong64($hwnd, $GWL_STYLE).ToInt64()
    $exStyle = [ScreenshotTool.Native]::GetWindowLong64($hwnd, $GWL_EXSTYLE).ToInt64()
  } else {
    $style = [int64][ScreenshotTool.Native]::GetWindowLong32($hwnd, $GWL_STYLE)
    $exStyle = [int64][ScreenshotTool.Native]::GetWindowLong32($hwnd, $GWL_EXSTYLE)
  }
  $maximized = [bool][ScreenshotTool.Native]::IsZoomed($hwnd)
  $minimized = [bool][ScreenshotTool.Native]::IsIconic($hwnd)
  $visible = [bool][ScreenshotTool.Native]::IsWindowVisible($hwnd)
  $cloaked = Test-WindowCloaked $hwnd
  $foreground = ([ScreenshotTool.Native]::GetForegroundWindow() -eq $hwnd)
  $enabled = (($style -band $WS_DISABLED) -eq 0)
  $topmost = (($exStyle -band $WS_EX_TOPMOST) -ne 0)
  $toolWindow = (($exStyle -band $WS_EX_TOOLWINDOW) -ne 0)
  $layered = (($exStyle -band $WS_EX_LAYERED) -ne 0)
  $clickThrough = (($exStyle -band $WS_EX_TRANSPARENT) -ne 0)
  $noActivate = (($exStyle -band $WS_EX_NOACTIVATE) -ne 0)

  $alpha = 255
  if ($layered) {
    $crKey = [uint32]0
    $bAlpha = [byte]0
    $dwFlags = [uint32]0
    if ([ScreenshotTool.Native]::GetLayeredWindowAttributes($hwnd, [ref]$crKey, [ref]$bAlpha, [ref]$dwFlags)) {
      # LWA_ALPHA = 0x2 — alpha valid only when this flag is set.
      if (($dwFlags -band 0x2) -ne 0) {
        $alpha = [int]$bAlpha
      }
    }
  }

  return [ordered]@{
    hwnd = $window.hwnd
    title = $window.title
    pid = $window.pid
    processName = $window.processName
    className = $window.className
    rect = $window.rect
    visible = $visible
    minimized = $minimized
    maximized = $maximized
    foreground = $foreground
    enabled = $enabled
    topmost = $topmost
    toolWindow = $toolWindow
    layered = $layered
    clickThrough = $clickThrough
    noActivate = $noActivate
    cloaked = $cloaked
    alpha = $alpha
    style = ('0x{0:X8}' -f ([uint32]($style -band 0xFFFFFFFF)))
    exStyle = ('0x{0:X8}' -f ([uint32]($exStyle -band 0xFFFFFFFF)))
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
  }
}

function Wait-ForWindow {
  param([hashtable]$Target)

  $mode = 'appear'
  if ($Target.ContainsKey('mode') -and -not [string]::IsNullOrWhiteSpace($Target.mode)) {
    $mode = [string]$Target.mode
  }
  if ($mode -ne 'appear' -and $mode -ne 'disappear') {
    throw "mode must be 'appear' or 'disappear'."
  }

  # Default poll interval is 100ms — keep in sync with waitForWindowSchema
  # default in src/schemas.ts (the TS default normally wins because it's
  # always present in the request, but this is a defensive fallback).
  $timeoutMs = 30000
  if ($Target.ContainsKey('timeoutMs') -and $null -ne $Target.timeoutMs) {
    $timeoutMs = [int]$Target.timeoutMs
  }
  $pollIntervalMs = 100
  if ($Target.ContainsKey('pollIntervalMs') -and $null -ne $Target.pollIntervalMs) {
    $pollIntervalMs = [int]$Target.pollIntervalMs
    if ($pollIntervalMs -lt 50) { $pollIntervalMs = 50 }
  }

  # Build filter hashtable from selectors that are present.
  $filters = @{}
  foreach ($key in @('hwnd', 'pid', 'processName', 'titleContains')) {
    if ($Target.ContainsKey($key) -and $null -ne $Target[$key]) {
      $filters[$key] = $Target[$key]
    }
  }
  if ($filters.Count -eq 0) {
    throw "Provide at least one of hwnd, pid, processName, or titleContains."
  }

  $startMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $deadline = $startMs + $timeoutMs

  while ($true) {
    # Use Get-AllWindows so iconic/cloaked windows aren't silently skipped —
    # critical for `disappear` mode (else minimizing the window would falsely
    # report it gone) and for `appear` waiting on a window that starts
    # minimized.
    $matched = @(Filter-Windows (Get-AllWindows) $filters)

    if ($mode -eq 'appear') {
      if ($matched.Count -gt 0) {
        $elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $startMs
        return [ordered]@{
          found = $true
          mode = $mode
          window = $matched[0]
          elapsedMs = [int]$elapsed
          timestamp = (Get-Date).ToUniversalTime().ToString("o")
        }
      }
    } else {
      if ($matched.Count -eq 0) {
        $elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $startMs
        return [ordered]@{
          found = $true
          mode = $mode
          window = $null
          elapsedMs = [int]$elapsed
          timestamp = (Get-Date).ToUniversalTime().ToString("o")
        }
      }
    }

    if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $deadline) {
      $elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $startMs
      return [ordered]@{
        found = $false
        mode = $mode
        window = $null
        elapsedMs = [int]$elapsed
        timeoutMs = $timeoutMs
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
      }
    }

    Start-Sleep -Milliseconds $pollIntervalMs
  }
}


function Wait-And-Suppress {
  param([hashtable]$Target)

  # Poll for a new window from the target process and immediately push it
  # to HWND_BOTTOM on the very first sighting — all within the same PS
  # call so there is no round-trip delay that would let the window flash
  # on top of other windows.
  $targetPid = [int]$Target.pid
  $existingHwnds = New-Object System.Collections.Generic.HashSet[string]
  if ($Target.ContainsKey("existingHwnds") -and $null -ne $Target.existingHwnds) {
    foreach ($h in @($Target.existingHwnds)) { $existingHwnds.Add([string]$h) | Out-Null }
  }
  $timeoutMs = 10000
  if ($Target.ContainsKey("timeoutMs") -and $null -ne $Target.timeoutMs) {
    $timeoutMs = [int]$Target.timeoutMs
  }

  $SWP_NOSIZE = [uint32]0x0001
  $SWP_NOMOVE = [uint32]0x0002
  $SWP_NOACTIVATE = [uint32]0x0010
  $hwndBottom = [IntPtr]1
  $pushFlags = $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE

  $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $timeoutMs

  # Lean enumeration callback: skip object construction, only check the bare
  # minimum (PID + visibility + new hwnd + non-empty rect) and push to bottom
  # the instant we find a match.
  $foundHwnd = [IntPtr]::Zero
  $script:foundTargetHwnd = [IntPtr]::Zero
  $enumProc = [ScreenshotTool.Native+EnumWindowsProc]{
    param([IntPtr]$Hwnd, [IntPtr]$LParam)
    if (-not [ScreenshotTool.Native]::IsWindowVisible($Hwnd)) { return $true }
    $pidValue = [uint32]0
    [ScreenshotTool.Native]::GetWindowThreadProcessId($Hwnd, [ref]$pidValue) | Out-Null
    if ([int]$pidValue -ne $targetPid) { return $true }
    $hwndText = $Hwnd.ToInt64().ToString()
    if ($existingHwnds.Contains($hwndText)) { return $true }
    $rect = New-Object ScreenshotTool.Native+RECT
    if (-not [ScreenshotTool.Native]::GetWindowRect($Hwnd, [ref]$rect)) { return $true }
    if (($rect.Right - $rect.Left) -le 0 -or ($rect.Bottom - $rect.Top) -le 0) { return $true }
    $script:foundTargetHwnd = $Hwnd
    return $false
  }

  while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline) {
    $script:foundTargetHwnd = [IntPtr]::Zero
    [ScreenshotTool.Native]::EnumWindows($enumProc, [IntPtr]::Zero) | Out-Null
    if ($script:foundTargetHwnd -ne [IntPtr]::Zero) {
      $foundHwnd = $script:foundTargetHwnd
      break
    }
    Start-Sleep -Milliseconds 10
  }

  if ($foundHwnd -eq [IntPtr]::Zero) {
    return [ordered]@{
      found = $false
      window = $null
    }
  }

  # Restore previous foreground FIRST (so the user perceives no focus
  # change), then push the new window to the bottom of the z-order.
  if ($Target.ContainsKey("previousForegroundHwnd") -and $null -ne $Target.previousForegroundHwnd) {
    $prevFg = [IntPtr]([int64]$Target.previousForegroundHwnd)
    if ($prevFg -ne [IntPtr]::Zero -and $prevFg -ne $foundHwnd) {
      [ScreenshotTool.Native]::keybd_event([byte]0x12, 0, [uint32]0, [UIntPtr]::Zero)
      [ScreenshotTool.Native]::keybd_event([byte]0x12, 0, [uint32]2, [UIntPtr]::Zero)
      [ScreenshotTool.Native]::SetForegroundWindow($prevFg) | Out-Null
    }
  }
  [ScreenshotTool.Native]::SetWindowPos($foundHwnd, $hwndBottom, 0, 0, 0, 0, $pushFlags) | Out-Null

  # Now build the full WindowInfo for the response.
  $rectFinal = New-Object ScreenshotTool.Native+RECT
  [ScreenshotTool.Native]::GetWindowRect($foundHwnd, [ref]$rectFinal) | Out-Null
  $pidFinal = [uint32]0
  [ScreenshotTool.Native]::GetWindowThreadProcessId($foundHwnd, [ref]$pidFinal) | Out-Null
  $titleBuilder = New-Object System.Text.StringBuilder 256
  [ScreenshotTool.Native]::GetWindowText($foundHwnd, $titleBuilder, $titleBuilder.Capacity) | Out-Null
  $classBuilder = New-Object System.Text.StringBuilder 256
  [ScreenshotTool.Native]::GetClassName($foundHwnd, $classBuilder, $classBuilder.Capacity) | Out-Null

  $foundWindow = [ordered]@{
    hwnd        = $foundHwnd.ToInt64().ToString()
    title       = $titleBuilder.ToString()
    pid         = [int]$pidFinal
    processName = Get-WindowProcessName $pidFinal
    className   = $classBuilder.ToString()
    rect        = Get-RectObject $rectFinal
  }

  return [ordered]@{
    found = $true
    window = $foundWindow
  }
}

function Invoke-Action {
  param([hashtable]$Request)

  switch ($Request.action) {
    "list-windows" {
      $filters = @{}
      if ($Request.ContainsKey("filters") -and $null -ne $Request.filters) {
        $filters = $Request.filters
      }
      return @(Filter-Windows (Get-VisibleWindows) $filters)
    }
    "capture-window" {
      return Capture-Window -Target $Request.target -OutputPath $Request.outputPath
    }
    "capture-screen-region" {
      return Capture-ScreenRegion -Region $Request.region -OutputPath $Request.outputPath
    }
    "click-window" {
      return Click-Window -Target $Request.target
    }
    "click-menu-item" {
      return Click-MenuItem -Target $Request.target
    }
    "move-mouse-window" {
      return Move-MouseWindow -Target $Request.target
    }
    "type-text" {
      return Type-Text -Target $Request.target
    }
    "send-key" {
      return Send-Key -Target $Request.target
    }
    "minimize-window" {
      return Minimize-Window -Target $Request.target
    }
    "noactivate-minimize" {
      return NoActivate-Minimize -Target $Request.target
    }
    "wait-and-suppress" {
      return Wait-And-Suppress -Target $Request.target
    }
    "read-clipboard" {
      return Read-Clipboard -Target $Request.target
    }
    "write-clipboard" {
      return Write-Clipboard -Target $Request.target
    }
    "get-window-state" {
      return Get-WindowState -Target $Request.target
    }
    "wait-for-window" {
      return Wait-ForWindow -Target $Request.target
    }
    default {
      throw "Unknown action: $($Request.action)"
    }
  }
}

if ($Worker) {
  # Long-running worker mode: read newline-delimited JSON requests from stdin,
  # write newline-delimited JSON responses to stdout. Each response is one line:
  #   { "ok": true,  "result": ... }
  #   { "ok": false, "error": "..." }
  # An empty line or EOF terminates the worker cleanly.
  try {
    while ($true) {
      $line = [Console]::In.ReadLine()
      if ($null -eq $line) { break }
      $line = $line.Trim()
      if ($line.Length -eq 0) { continue }

      $response = $null
      $isArrayResult = $false
      try {
        $request = ConvertTo-Hashtable ($line | ConvertFrom-Json)
        $result = Invoke-Action -Request $request
        # Track whether the action returns a list so we can emit [] (not {}) for empty.
        $isArrayResult = ($request.action -eq "list-windows")
        $response = [ordered]@{ ok = $true; result = $result }
      } catch {
        $isArrayResult = $false
        $response = [ordered]@{ ok = $false; error = $_.Exception.ToString() }
      }

      $json = if ($response.ok -and $isArrayResult) {
        $items = @($response.result)
        if ($items.Count -eq 0) {
          '{"ok":true,"result":[]}'
        } elseif ($items.Count -eq 1) {
          $itemJson = ConvertTo-Json -InputObject $items[0] -Depth 8 -Compress
          '{"ok":true,"result":[' + $itemJson + ']}'
        } else {
          $arrJson = ConvertTo-Json -InputObject $items -Depth 8 -Compress
          '{"ok":true,"result":' + $arrJson + '}'
        }
      } else {
        ConvertTo-Json -InputObject $response -Depth 8 -Compress
      }
      [Console]::Out.WriteLine($json)
      [Console]::Out.Flush()
    }
  } catch {
    Write-Error $_.Exception.ToString()
    exit 1
  }
  exit 0
}

if ([string]::IsNullOrEmpty($InputJson)) {
  Write-Error "InputJson is required when -Worker is not set."
  exit 1
}

try {
  $request = ConvertTo-Hashtable ($InputJson | ConvertFrom-Json)
  $result = Invoke-Action -Request $request
  ConvertTo-Json -InputObject $result -Depth 8 -Compress
} catch {
  Write-Error $_.Exception.ToString()
  exit 1
}
