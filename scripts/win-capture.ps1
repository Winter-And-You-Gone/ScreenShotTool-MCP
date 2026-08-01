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

# Whether the managed UIA API is available. Callers that need UIA must check
# this and return UIA_ASSEMBLY_UNAVAILABLE rather than silently falling back
# to coordinate clicks.
function Test-UiaAvailable {
  return ($null -ne ("System.Windows.Automation.AutomationElement" -as [type]))
}

function Assert-UiaAvailable {
  if (-not (Test-UiaAvailable)) {
    Throw-UiaError "UIA_ASSEMBLY_UNAVAILABLE" "UIAutomationClient/Types assemblies could not be loaded in this PowerShell environment." ([ordered]@{ stage = "assembly-load" })
  }
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
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsChild(IntPtr hWndParent, IntPtr hWnd);

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
  param([switch]$IncludeUntitled)

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
    if (-not $IncludeUntitled -and [string]::IsNullOrWhiteSpace($title)) {
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
  # ApplicationFrameWindow wraps UWP apps and usually also exposes a child
  # Windows.UI.Core.CoreWindow that carries the real title. Both must be
  # excluded or we double-count UWP windows in Get-AllWindows (used by
  # wait_for_window / get_window_state).
  $excludedClasses = @(
    'ApplicationFrameWindow',
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

    if (-not [ScreenshotTool.Native]::IsWindow($hwnd)) {
      throw "No window found for hwnd $hwndText."
    }

    $isVisible = [ScreenshotTool.Native]::IsWindowVisible($hwnd)
    $isIconic = [ScreenshotTool.Native]::IsIconic($hwnd)
    if ($isVisible -or $IncludeHidden) {
      $rect = New-Object ScreenshotTool.Native+RECT
      if (-not [ScreenshotTool.Native]::GetWindowRect($hwnd, [ref]$rect)) {
        throw "Failed to get window rect for hwnd $hwndText."
      }
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

  $windows = if ($IncludeHidden) { Get-AllWindows } else { Get-VisibleWindows -IncludeUntitled }
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

  # ── TOPMOST trick ──
  # Temporarily setting HWND_TOPMOST then clearing HWND_NOTOPMOST is a
  # well-known Win32 pattern to reliably bring a window to the foreground
  # despite Windows' foreground-lock policy. The danger is that if the
  # NOTOPMOST call fails, the window is left with WS_EX_TOPMOST and stays
  # permanently above all other windows — "霸占顶层".
  #
  # We use try/finally + post-verification to guarantee the style is
  # always cleared, even if the process is interrupted between the two
  # SetWindowPos calls.
  try {
    [ScreenshotTool.Native]::SetWindowPos($hwnd, $hwndTopMost, 0, 0, 0, 0, $flags) | Out-Null
    [ScreenshotTool.Native]::SetWindowPos($hwnd, $hwndNoTopMost, 0, 0, 0, 0, $flags) | Out-Null
  } finally {
    # Verify TOPMOST was cleared, and if not, retry.
    $gwlExStyle = -20
    $wsExTopMost = [int64]0x00000008
    $exStyle = if ([IntPtr]::Size -eq 8) {
      [ScreenshotTool.Native]::GetWindowLong64($hwnd, $gwlExStyle).ToInt64()
    } else {
      [int64][ScreenshotTool.Native]::GetWindowLong32($hwnd, $gwlExStyle)
    }
    if (($exStyle -band $wsExTopMost) -ne 0) {
      [ScreenshotTool.Native]::SetWindowPos($hwnd, $hwndNoTopMost, 0, 0, 0, 0, $flags) | Out-Null
      # Log so we can detect patterns
      Write-Warning "Focus-Window: TOPMOST was stuck, retried NOTOPMOST for hwnd $($hwnd.ToInt64())"
    }
  }

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

  $captureMethod = "print"
  if ($Target.ContainsKey("captureMethod") -and $null -ne $Target.captureMethod) {
    $captureMethod = ([string]$Target.captureMethod).ToLowerInvariant()
  }
  if ($Target.ContainsKey("noActivate") -and [bool]$Target.noActivate) {
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
    if ($maxWidth -le 0 -or $maxHeight -le 0) {
      throw "Region is outside the window bounds."
    }
    $captureWidth = [Math]::Min([int]$region.width, $maxWidth)
    $captureHeight = [Math]::Min([int]$region.height, $maxHeight)
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

  $targetHwnd = Find-WindowTreePointTarget -Hwnd $Hwnd -ScreenX $ScreenX -ScreenY $ScreenY

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

function Find-WindowTreePointTarget {
  param(
    [IntPtr]$Hwnd,
    [int]$ScreenX,
    [int]$ScreenY
  )

  $script:pointTargetHwnd = $Hwnd
  $script:pointTargetArea = [int64]::MaxValue

  $enumProc = [ScreenshotTool.Native+EnumWindowsProc]{
    param([IntPtr]$Child, [IntPtr]$LParam)
    if (-not [ScreenshotTool.Native]::IsWindowVisible($Child)) {
      return $true
    }

    $rect = New-Object ScreenshotTool.Native+RECT
    if (-not [ScreenshotTool.Native]::GetWindowRect($Child, [ref]$rect)) {
      return $true
    }

    if ($ScreenX -lt $rect.Left -or $ScreenX -ge $rect.Right -or $ScreenY -lt $rect.Top -or $ScreenY -ge $rect.Bottom) {
      return $true
    }

    $width = [int64]($rect.Right - $rect.Left)
    $height = [int64]($rect.Bottom - $rect.Top)
    if ($width -le 0 -or $height -le 0) {
      return $true
    }

    $area = $width * $height
    if ($area -le $script:pointTargetArea) {
      $script:pointTargetArea = $area
      $script:pointTargetHwnd = $Child
    }
    return $true
  }

  [ScreenshotTool.Native]::EnumChildWindows($Hwnd, $enumProc, [IntPtr]::Zero) | Out-Null
  return $script:pointTargetHwnd
}

function Get-WindowFromScreenPoint {
  param(
    [int]$ScreenX,
    [int]$ScreenY
  )

  $screenPoint = New-Object ScreenshotTool.Native+POINT
  $screenPoint.X = $ScreenX
  $screenPoint.Y = $ScreenY
  return [ScreenshotTool.Native]::WindowFromPoint($screenPoint)
}

function Test-HwndInWindowTree {
  param(
    [IntPtr]$Root,
    [IntPtr]$Candidate
  )

  if ($Candidate -eq [IntPtr]::Zero) {
    return $false
  }

  return $Candidate -eq $Root -or [ScreenshotTool.Native]::IsChild($Root, $Candidate)
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
  if ($relativeX -lt 0 -or $relativeX -ge [int]$windowRect.width -or $relativeY -lt 0 -or $relativeY -ge [int]$windowRect.height) {
    throw "Coordinates ($relativeX, $relativeY) are outside the target window bounds (width=$($windowRect.width), height=$($windowRect.height)). Click coordinates are window-relative; out-of-bounds clicks would be routed to other windows."
  }
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

  $topAtPoint = Get-WindowFromScreenPoint -ScreenX $screenX -ScreenY $screenY
  $pointOwnedByTarget = Test-HwndInWindowTree -Root $hwnd -Candidate $topAtPoint
  $uiaInvoked = $false
  if ($pointOwnedByTarget) {
    $uiaInvoked = Invoke-MenuItemAtPoint -ScreenX $screenX -ScreenY $screenY
  }
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
  if ($relativeX -lt 0 -or $relativeX -ge [int]$windowRect.width -or $relativeY -lt 0 -or $relativeY -ge [int]$windowRect.height) {
    throw "Coordinates ($relativeX, $relativeY) are outside the target window bounds (width=$($windowRect.width), height=$($windowRect.height)). Move coordinates are window-relative; out-of-bounds moves would be routed to other windows."
  }
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

  # The send_key schema restricts characters to printable ASCII ([\x20-\x7E]),
  # so the shift map below is keyed on the US keyboard layout. That is the only
  # layout that can ever produce these characters from a single physical key
  # plus optional Shift, so this mapping is exhaustive for the accepted input
  # set regardless of the user's actual keyboard layout.
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

  $targetHwnd = $hwnd
  $targetClassName = ''
  $editClassDefs = @{
    'Scintilla'      = $false
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

  $pidValue = [uint32]0
  $threadId = [ScreenshotTool.Native]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
  $guiInfo = New-Object ScreenshotTool.Native+GUITHREADINFO
  $guiInfo.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($guiInfo)
  if ([ScreenshotTool.Native]::GetGUIThreadInfo([uint32]$threadId, [ref]$guiInfo)) {
    if ($guiInfo.hwndFocus -ne [IntPtr]::Zero) {
      $targetHwnd = $guiInfo.hwndFocus
    }
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

  $useWindowMessage = $noActivate -or $targetHwnd -ne $hwnd
  foreach ($ch in $text.ToCharArray()) {
    $scan = [uint16][int][char]$ch
    $sent = $false
    try {
      $sent = if ($useWindowMessage) {
        Post-CharMessage -Hwnd $targetHwnd -Char $scan
      } else {
        Send-UnicodeChar $scan
      }
    } catch {
      $sent = $false
    }
    if (-not $sent) {
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

function Minimize-Window {
  param([hashtable]$Target)

  $window = Resolve-TargetWindow -Target $Target -IncludeHidden
  $hwnd = [IntPtr]([int64]$window.hwnd)
  $SW_MINIMIZE = 6
  [ScreenshotTool.Native]::ShowWindow($hwnd, $SW_MINIMIZE) | Out-Null
  Start-Sleep -Milliseconds 50
  $minimized = [bool][ScreenshotTool.Native]::IsIconic($hwnd)

  return [ordered]@{
    minimized = $minimized
    target = "window:" + $window.hwnd
    hwnd = $window.hwnd
    title = $window.title
    pid = $window.pid
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
  }
}

function NoActivate-Minimize {
  param([hashtable]$Target)

  $window = Resolve-TargetWindow -Target $Target -IncludeHidden
  $hwnd = [IntPtr]([int64]$window.hwnd)

  # Minimize without activating, then keep the target behind other windows.
  $SW_SHOWMINNOACTIVE = 7
  $SWP_NOSIZE = [uint32]0x0001
  $SWP_NOMOVE = [uint32]0x0002
  $SWP_NOACTIVATE = [uint32]0x0010
  $hwndBottom = [IntPtr]1
  $flags = $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE

  [ScreenshotTool.Native]::ShowWindow($hwnd, $SW_SHOWMINNOACTIVE) | Out-Null
  [ScreenshotTool.Native]::SetWindowPos($hwnd, $hwndBottom, 0, 0, 0, 0, $flags) | Out-Null
  if ($Target.ContainsKey("previousForegroundHwnd") -and $null -ne $Target.previousForegroundHwnd) {
    $prevFg = [IntPtr]([int64]$Target.previousForegroundHwnd)
    if ($prevFg -ne [IntPtr]::Zero -and $prevFg -ne $hwnd -and [ScreenshotTool.Native]::IsWindow($prevFg)) {
      [ScreenshotTool.Native]::keybd_event([byte]0x12, 0, [uint32]0, [UIntPtr]::Zero)
      [ScreenshotTool.Native]::keybd_event([byte]0x12, 0, [uint32]2, [UIntPtr]::Zero)
      [ScreenshotTool.Native]::SetForegroundWindow($prevFg) | Out-Null
    }
  }
  Start-Sleep -Milliseconds 50
  $minimized = [bool][ScreenshotTool.Native]::IsIconic($hwnd)

  return [ordered]@{
    minimized = $minimized
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

  $styleHex = Format-WindowLongHex $style
  $exStyleHex = Format-WindowLongHex $exStyle

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
    style = $styleHex
    exStyle = $exStyleHex
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
  }
}

function Get-ForegroundWindow {
  $hwnd = [ScreenshotTool.Native]::GetForegroundWindow()
  return [ordered]@{
    hwnd = $hwnd.ToInt64().ToString()
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
  }
}

function Format-WindowLongHex {
  param([int64]$Value)

  $mask32 = [int64]4294967295
  if ($Value -lt 0) {
    $Value = $Value + 4294967296
  }
  $normalized = $Value -band $mask32
  return '0x{0:X8}' -f ([uint32]$normalized)
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

  # Pre-resolve the filter inputs so the polling loop can do the cheapest
  # possible check per candidate window. Get-Process (called inside
  # Get-AllWindows -> Get-WindowProcessName) is the dominant cost on a busy
  # desktop; with a 100ms poll and 300s timeout it can fire ~150k times.
  # Instead we enumerate raw windows here and only build the full WindowInfo
  # once we actually have a match.
  $filterHwnd = $null
  $filterPid = $null
  $filterProcessName = $null
  $filterTitleContains = $null
  $hasHwnd = $filters.ContainsKey('hwnd') -and $null -ne $filters.hwnd
  $hasPid = $filters.ContainsKey('pid') -and $null -ne $filters.pid
  $hasProcessName = $filters.ContainsKey('processName') -and -not [string]::IsNullOrWhiteSpace($filters.processName)
  $hasTitle = $filters.ContainsKey('titleContains') -and -not [string]::IsNullOrWhiteSpace($filters.titleContains)
  if ($hasHwnd)   { $filterHwnd = [int64]([string]$filters.hwnd).Trim() }
  if ($hasPid)    { $filterPid = [int]$filters.pid }
  if ($hasProcessName) { $filterProcessName = (Normalize-ProcessName $filters.processName) }
  if ($hasTitle)  { $filterTitleContains = [string]$filters.titleContains }

  # Excluded classes — keep in sync with Get-AllWindows. We can't reuse that
  # function because it constructs full objects + calls Get-Process per window.
  $excludedClasses = @(
    'ApplicationFrameWindow',
    'Windows.UI.Core.CoreWindow',
    'Shell_TrayWnd',
    'Shell_SecondaryTrayWnd',
    'WorkerW',
    'Progman',
    'TaskListThumbnailWnd',
    'MSCTFIME UI',
    'IME'
  )

  $matchWindowState = [ordered]@{ hwnd = [IntPtr]::Zero }
  $enumProc = [ScreenshotTool.Native+EnumWindowsProc]{
    param([IntPtr]$Hwnd, [IntPtr]$LParam)

    # Skip cloaked windows — but only when not filtering by hwnd. An hwnd
    # filter targets a specific known window and should still be visible to
    # the matcher even if cloaked.
    if (-not $hasHwnd -and (Test-WindowCloaked $Hwnd)) { return $true }

    $className = Get-WindowClassName $Hwnd
    if (-not $hasHwnd -and $excludedClasses -contains $className) { return $true }

    if ($hasHwnd) {
      if ($Hwnd.ToInt64() -ne $filterHwnd) { return $true }
    } else {
      $pidValue = [uint32]0
      [ScreenshotTool.Native]::GetWindowThreadProcessId($Hwnd, [ref]$pidValue) | Out-Null
      if ($hasPid -and [int]$pidValue -ne $filterPid) { return $true }
      if ($hasProcessName) {
        # Avoid Get-Process here unless the processName filter is the only
        # selector — resolving a process name per window per poll is the
        # exact cost we are trying to eliminate. Fall back to it only when
        # the caller actually asked for a processName match.
        $resolved = (Get-WindowProcessName $pidValue)
        if ($resolved -ine $filterProcessName) { return $true }
      }
      if ($hasTitle) {
        $title = Get-WindowTitle $Hwnd
        if ($title.IndexOf($filterTitleContains, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $true }
      } else {
        # No title filter: still require a visible, non-zero-area window so
        # we don't match stray WorkerW-style ghosts. Iconic windows ARE
        # accepted (disappear-mode must still see a minimized window).
        if (-not [ScreenshotTool.Native]::IsWindowVisible($Hwnd)) { return $true }
      }
    }

    $matchWindowState.hwnd = $Hwnd
    return $false
  }

  while ($true) {
    $matchWindowState.hwnd = [IntPtr]::Zero
    [ScreenshotTool.Native]::EnumWindows($enumProc, [IntPtr]::Zero) | Out-Null
    $matchedNow = $matchWindowState.hwnd -ne [IntPtr]::Zero

    $elapsed = [int]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $startMs)

    if ($mode -eq 'appear') {
      if ($matchedNow) {
        return [ordered]@{
          found = $true
          mode = $mode
          window = (Build-WindowInfoFromHwnd $matchWindowState.hwnd)
          elapsedMs = $elapsed
          timestamp = (Get-Date).ToUniversalTime().ToString("o")
        }
      }
    } else {
      if (-not $matchedNow) {
        return [ordered]@{
          found = $true
          mode = $mode
          window = $null
          elapsedMs = $elapsed
          timestamp = (Get-Date).ToUniversalTime().ToString("o")
        }
      }
    }

    if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $deadline) {
      return [ordered]@{
        found = $false
        mode = $mode
        window = $null
        elapsedMs = $elapsed
        timeoutMs = $timeoutMs
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
      }
    }

    Start-Sleep -Milliseconds $pollIntervalMs
  }
}


function Build-WindowInfoFromHwnd {
  param([IntPtr]$Hwnd)

  $rect = New-Object ScreenshotTool.Native+RECT
  if (-not [ScreenshotTool.Native]::GetWindowRect($Hwnd, [ref]$rect)) {
    throw "Failed to get window rect."
  }
  $pidValue = [uint32]0
  [ScreenshotTool.Native]::GetWindowThreadProcessId($Hwnd, [ref]$pidValue) | Out-Null
  $titleBuilder = New-Object System.Text.StringBuilder 256
  [ScreenshotTool.Native]::GetWindowText($Hwnd, $titleBuilder, $titleBuilder.Capacity) | Out-Null
  $classBuilder = New-Object System.Text.StringBuilder 256
  [ScreenshotTool.Native]::GetClassName($Hwnd, $classBuilder, $classBuilder.Capacity) | Out-Null

  return [ordered]@{
    hwnd        = $Hwnd.ToInt64().ToString()
    title       = $titleBuilder.ToString()
    pid         = [int]$pidValue
    processName = Get-WindowProcessName $pidValue
    className   = $classBuilder.ToString()
    rect        = Get-RectObject $rect
  }
}


function Wait-And-Suppress {
  param([hashtable]$Target)

  $targetPid = [int]$Target.pid
  $existingHwnds = New-Object System.Collections.Generic.HashSet[string]
  if ($Target.ContainsKey("existingHwnds") -and $null -ne $Target.existingHwnds) {
    foreach ($h in @($Target.existingHwnds)) { $existingHwnds.Add([string]$h) | Out-Null }
  }

  $timeoutMs = 10000
  if ($Target.ContainsKey("timeoutMs") -and $null -ne $Target.timeoutMs) {
    $timeoutMs = [int]$Target.timeoutMs
  }
  # After finding the first new window, continue suppressing for the rest
  # of the timeoutMs period (or at least 8s, whichever is longer). Many apps
  # — especially Qt-based ones like VaporView — take 5-10s to finish loading
  # plugins and may self-activate long after the first window appears.
  $SUSTAIN_MS = [Math]::Max(8000, $timeoutMs)

  # Prefer the foreground window captured before the target process was spawned.
  # If it is missing, fall back to the current foreground in this helper call.
  if ($Target.ContainsKey("previousForegroundHwnd") -and $null -ne $Target.previousForegroundHwnd) {
    $previousForegroundHwnd = [IntPtr]([int64]$Target.previousForegroundHwnd)
  } else {
    $previousForegroundHwnd = [ScreenshotTool.Native]::GetForegroundWindow()
  }

  $SWP_NOSIZE = [uint32]0x0001
  $SWP_NOMOVE = [uint32]0x0002
  $SWP_NOACTIVATE = [uint32]0x0010
  $hwndBottom = [IntPtr]1
  $pushFlags = $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE

  $startMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $deadline = $startMs + $timeoutMs

  # Known hwnds discovered *during this call* (for re-activation detection).
  $script:suppressKnownHwnds = New-Object System.Collections.Generic.HashSet[string]
  $script:suppressLastFoundWindow = $null
  $sustainDeadline = $null  # set after first new window is found

  $enumProc = [ScreenshotTool.Native+EnumWindowsProc]{
    param([IntPtr]$Hwnd, [IntPtr]$LParam)
    if (-not [ScreenshotTool.Native]::IsWindowVisible($Hwnd)) { return $true }
    $pidValue = [uint32]0
    [ScreenshotTool.Native]::GetWindowThreadProcessId($Hwnd, [ref]$pidValue) | Out-Null
    if ([int]$pidValue -ne $targetPid) { return $true }
    $hwndText = $Hwnd.ToInt64().ToString()
    if ($existingHwnds.Contains($hwndText)) { return $true }

    # ── Already-known window: foreground-steal check ──
    if ($script:suppressKnownHwnds.Contains($hwndText)) {
      if ([ScreenshotTool.Native]::GetForegroundWindow() -eq $Hwnd) {
        # App re-activated itself. Push to bottom and restore previous.
        [ScreenshotTool.Native]::SetWindowPos($Hwnd, [IntPtr]1, 0, 0, 0, 0, $pushFlags) | Out-Null
        if ($previousForegroundHwnd -ne [IntPtr]::Zero -and $previousForegroundHwnd -ne $Hwnd) {
          [ScreenshotTool.Native]::keybd_event([byte]0x12, 0, [uint32]0, [UIntPtr]::Zero)
          [ScreenshotTool.Native]::keybd_event([byte]0x12, 0, [uint32]2, [UIntPtr]::Zero)
          [ScreenshotTool.Native]::SetForegroundWindow($previousForegroundHwnd) | Out-Null
        }
      }
      return $true
    }

    # ── New window ──
    $rect = New-Object ScreenshotTool.Native+RECT
    if (-not [ScreenshotTool.Native]::GetWindowRect($Hwnd, [ref]$rect)) { return $true }
    if (($rect.Right - $rect.Left) -le 0 -or ($rect.Bottom - $rect.Top) -le 0) { return $true }

    # Push to HWND_BOTTOM immediately.
    [ScreenshotTool.Native]::SetWindowPos($Hwnd, $hwndBottom, 0, 0, 0, 0, $pushFlags) | Out-Null

    # Restore previous foreground (Alt-keybd_event trick).
    [ScreenshotTool.Native]::keybd_event([byte]0x12, 0, [uint32]0, [UIntPtr]::Zero)
    [ScreenshotTool.Native]::keybd_event([byte]0x12, 0, [uint32]2, [UIntPtr]::Zero)
    if ($previousForegroundHwnd -ne [IntPtr]::Zero -and $previousForegroundHwnd -ne $Hwnd) {
      [ScreenshotTool.Native]::SetForegroundWindow($previousForegroundHwnd) | Out-Null
    }

    # Register as known and build WindowInfo for return.
    $script:suppressKnownHwnds.Add($hwndText) | Out-Null
    $titleBuilder = New-Object System.Text.StringBuilder 256
    [ScreenshotTool.Native]::GetWindowText($Hwnd, $titleBuilder, $titleBuilder.Capacity) | Out-Null
    $classBuilder = New-Object System.Text.StringBuilder 256
    [ScreenshotTool.Native]::GetClassName($Hwnd, $classBuilder, $classBuilder.Capacity) | Out-Null
    $script:suppressLastFoundWindow = [ordered]@{
      hwnd        = $hwndText
      title       = $titleBuilder.ToString()
      pid         = [int]$pidValue
      processName = Get-WindowProcessName $pidValue
      className   = $classBuilder.ToString()
      rect        = Get-RectObject $rect
    }

    # Set sustain deadline from first discovery.
    if ($null -eq $sustainDeadline) {
      $sustainDeadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $SUSTAIN_MS
    }

    return $true
  }

  while ($true) {
    [ScreenshotTool.Native]::EnumWindows($enumProc, [IntPtr]::Zero) | Out-Null

    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($null -ne $sustainDeadline) {
      if ($now -ge $sustainDeadline) { break }
    } else {
      if ($now -ge $deadline) { break }
    }

    Start-Sleep -Milliseconds 50
  }

  $result = $script:suppressLastFoundWindow
  $script:suppressKnownHwnds = $null
  $script:suppressLastFoundWindow = $null

  if ($null -eq $result) {
    return [ordered]@{ found = $false; window = $null }
  }
  return [ordered]@{ found = $true; window = $result }
}

# ════════════════════════════════════════════════════════════════════════════
# UI Automation (UIA) backend.
#
# Uses the managed System.Windows.Automation API (UIAutomationClient/Types).
# LegacyIAccessiblePattern is NOT exposed by this managed API, so the action
# layer falls back from InvokePattern directly to coordinate click when no
# pattern is available.
#
# Design rules enforced here:
#  - Never cache AutomationElement across requests; resolve fresh each call.
#  - Every property read is individually try/caught so one bad getter cannot
#    fail a whole tree walk.
#  - Tree walks are bounded by maxDepth, maxNodes, and a per-call deadline.
#  - Structured errors are thrown as hashtables via Throw-UiaError; the
#    worker loop (Invoke-Action catch) re-emits them verbatim.
# ════════════════════════════════════════════════════════════════════════════

# Pattern identifiers used throughout. Cached once per process.
function Get-UiaPatternIds {
  return @{
    Invoke         = [System.Windows.Automation.InvokePattern]::Pattern
    Value          = [System.Windows.Automation.ValuePattern]::Pattern
    Toggle         = [System.Windows.Automation.TogglePattern]::Pattern
    SelectionItem  = [System.Windows.Automation.SelectionItemPattern]::Pattern
    Selection      = [System.Windows.Automation.SelectionPattern]::Pattern
    ExpandCollapse = [System.Windows.Automation.ExpandCollapsePattern]::Pattern
    RangeValue     = [System.Windows.Automation.RangeValuePattern]::Pattern
    ScrollItem     = [System.Windows.Automation.ScrollItemPattern]::Pattern
    Scroll         = [System.Windows.Automation.ScrollPattern]::Pattern
    Window         = [System.Windows.Automation.WindowPattern]::Pattern
    Text           = [System.Windows.Automation.TextPattern]::Pattern
    Transform      = [System.Windows.Automation.TransformPattern]::Pattern
    Grid           = [System.Windows.Automation.GridPattern]::Pattern
    Table          = [System.Windows.Automation.TablePattern]::Pattern
  }
}

function Throw-UiaError {
  param([string]$Code, [string]$Message, [hashtable]$Details = @{})
  $err = [ordered]@{ ok = $false; code = $Code; message = $Message }
  if ($Details.Count -gt 0) { $err.details = $Details }
  # Throw as a RuntimeException wrapping the hashtable so the worker catch
  # can detect and re-emit it verbatim (see Invoke-Action).
  $ex = New-Object System.Management.Automation.RuntimeException($Message)
  $ex.Data.Add("UiaError", $err)
  throw $ex
}

# Extract a structured UIA error from an error record/exception, if present.
function Get-UiaErrorFromRecord {
  param($ErrorRecord)
  try {
    if ($null -ne $ErrorRecord -and $null -ne $ErrorRecord.Exception -and $ErrorRecord.Exception.Data.Contains("UiaError")) {
      return $ErrorRecord.Exception.Data["UiaError"]
    }
  } catch {}
  return $null
}

# Resolve the target window for UIA. An explicit hwnd is authoritative. For
# process/title selectors, a single non-tool window is preferred as the main
# window; otherwise multiple candidates are an error rather than an arbitrary
# first-window choice.
function Resolve-UiaTargetWindow {
  param([hashtable]$Target)

  if ($Target.ContainsKey("hwnd") -and $null -ne $Target.hwnd) {
    try {
      return Resolve-TargetWindow -Target $Target -IncludeHidden
    } catch {
      Throw-UiaError "WINDOW_NOT_FOUND" "No window matched the provided hwnd." ([ordered]@{ window = $Target; stage = "resolve-window" })
    }
  }

  $windows = @(Get-AllWindows)
  $filtered = @(Filter-Windows $windows $Target)
  if ($filtered.Count -lt 1) {
    Throw-UiaError "WINDOW_NOT_FOUND" "No window matched the provided target." ([ordered]@{ window = $Target; stage = "resolve-window" })
  }
  if ($filtered.Count -eq 1) {
    return $filtered[0]
  }

  $preferred = [System.Collections.ArrayList]::new()
  foreach ($win in $filtered) {
    $hwnd = [IntPtr]([int64]$win.hwnd)
    $exStyle = if ([IntPtr]::Size -eq 8) {
      [ScreenshotTool.Native]::GetWindowLong64($hwnd, -20).ToInt64()
    } else {
      [int64][ScreenshotTool.Native]::GetWindowLong32($hwnd, -20)
    }
    $isToolWindow = (($exStyle -band [int64]0x00000080) -ne 0)
    if (-not $isToolWindow -and -not [string]::IsNullOrWhiteSpace([string]$win.title)) {
      $preferred.Add($win) | Out-Null
    }
  }

  if ($preferred.Count -eq 1) {
    return $preferred[0]
  }

  $candidates = @($filtered | Select-Object -First 10 | ForEach-Object {
    [ordered]@{
      hwnd = [string]$_.hwnd
      title = [string]$_.title
      pid = [int]$_.pid
      processName = [string]$_.processName
      className = [string]$_.className
    }
  })
  Throw-UiaError "WINDOW_AMBIGUOUS" "Multiple windows matched the provided target; specify hwnd or a more specific selector." ([ordered]@{
    window = $Target
    candidateCount = $filtered.Count
    candidates = $candidates
    stage = "resolve-window"
  })
}

# Enumerate all top-level HWNDs belonging to the same PID as the resolved
# window. Used to find Qt popups, dialogs, and combo-box menus that live as
# separate top-level windows. Returns an array of hwnd-int64 values.
function Get-ProcessTopLevelHwnds {
  param([int]$ProcessId)

  $hwnds = [System.Collections.ArrayList]::new()
  $enumProc = [ScreenshotTool.Native+EnumWindowsProc]{
    param([IntPtr]$Hwnd, [IntPtr]$LParam)
    $pidValue = [uint32]0
    [ScreenshotTool.Native]::GetWindowThreadProcessId($Hwnd, [ref]$pidValue) | Out-Null
    if ([int]$pidValue -eq $ProcessId) {
      $hwnds.Add($Hwnd.ToInt64()) | Out-Null
    }
    return $true
  }
  [ScreenshotTool.Native]::EnumWindows($enumProc, [IntPtr]::Zero) | Out-Null
  return @($hwnds.ToArray())
}

# Build the list of UIA root elements to search. The main resolved window is
# always first; when includeProcessPopups is true, other same-PID top-level
# windows are appended. Each root carries metadata for the result.
function Get-UiaRoots {
  param([hashtable]$Target, [bool]$IncludeProcessPopups)

  $mainWin = Resolve-UiaTargetWindow -Target $Target
  $mainHwnd = [int64]$mainWin.hwnd
  $mainPid = [int]$mainWin.pid

  $roots = [System.Collections.ArrayList]::new()
  $mainEl = $null
  try { $mainEl = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$mainHwnd) } catch {}
  if ($null -eq $mainEl) {
    Throw-UiaError "UIA_ROOT_UNAVAILABLE" "AutomationElement.FromHandle returned null for the main window." ([ordered]@{ hwnd = $mainWin.hwnd; stage = "from-handle" })
  }
  $roots.Add([ordered]@{
    element = $mainEl
    hwnd = $mainWin.hwnd
    title = $mainWin.title
    className = $mainWin.className
    processId = $mainPid
    isMain = $true
    isPopup = $false
    rootIndex = 1
  }) | Out-Null

  if (-not $IncludeProcessPopups) { return @($roots.ToArray()) }

  $allHwnds = Get-ProcessTopLevelHwnds -ProcessId $mainPid
  $idx = 1
  foreach ($h in $allHwnds) {
    if ($h -eq $mainHwnd) { continue }
    $el = $null
    try { $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$h) } catch {}
    if ($null -eq $el) { continue }
    $idx++
    $sb = New-Object System.Text.StringBuilder 256
    [ScreenshotTool.Native]::GetWindowText([IntPtr]$h, $sb, $sb.Capacity) | Out-Null
    $cb = New-Object System.Text.StringBuilder 256
    [ScreenshotTool.Native]::GetClassName([IntPtr]$h, $cb, $cb.Capacity) | Out-Null
    # Heuristic: a tool/popup/dialog window is non-main. Qt::Popup and
    # WS_EX_TOOLWINDOW tend to have empty or transient titles.
    $isPopup = [string]::IsNullOrWhiteSpace($sb.ToString())
    $roots.Add([ordered]@{
      element = $el
      hwnd = $h.ToString()
      title = $sb.ToString()
      className = $cb.ToString()
      processId = $mainPid
      isMain = $false
      isPopup = $isPopup
      rootIndex = $idx
    }) | Out-Null
  }
  return @($roots.ToArray())
}

function Get-UiaCurrent {
  param($Element, [string]$PropertyName)
  try { return $Element.Current.$PropertyName } catch { return $null }
}

# Read the full state of an element for ui_get / ui_query results. Each field
# is independently guarded; an unsupported pattern yields null (not an error).
#
# SECURITY: IsPassword is read BEFORE ValuePattern.Current.Value. When the
# element reports IsPassword=true, the value is NEVER read and is returned as
# null with valueProtected=true. This is the single chokepoint for password
# redaction - every state returned to the client goes through here.
function Get-UiaElementState {
  param($Element, [bool]$IncludePatterns = $true, [bool]$IncludeValues = $true)

  $pids = Get-UiaPatternIds
  $ct = Get-UiaCurrent $Element "ControlType"
  $ctName = if ($ct) { $ct.ProgrammaticName } else { "" }
  $rect = $null
  try {
    $r = $Element.Current.BoundingRectangle
    if ($r.Width -gt 0 -and $r.Height -gt 0) {
      $rect = [ordered]@{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
    }
  } catch {}

  $runtimeId = @()
  try { $runtimeId = @($Element.GetRuntimeId()) } catch {}

  $patterns = @()
  if ($IncludePatterns) {
    foreach ($key in @('Invoke','Value','Toggle','SelectionItem','Selection','ExpandCollapse','RangeValue','ScrollItem','Scroll','Window','Text','Transform','Grid','Table')) {
      try {
        $dummy = $null
        if ($Element.TryGetCurrentPattern($pids[$key], [ref]$dummy)) { $patterns += $pids[$key].ProgrammaticName }
      } catch {}
    }
  }

  # SECURITY: read IsPassword FIRST, before any value getter. A password
  # provider may return a Value via ValuePattern, but we must never surface it.
  $isPassword = $false
  try { $isPassword = [bool]$Element.Current.IsPassword } catch {}

  $value = $null; $isReadOnly = $null; $valueProtected = $isPassword
  $rangeValue = $null; $minimum = $null; $maximum = $null; $smallChange = $null; $largeChange = $null
  $toggleState = $null; $selected = $null; $expandState = $null

  if ($IncludeValues) {
    # ValuePattern - ONLY read the value when this is NOT a password field.
    try {
      $vp = $null
      if ($Element.TryGetCurrentPattern($pids.Value, [ref]$vp)) {
        # IsReadOnly is safe to read even for password fields.
        $isReadOnly = [bool]$vp.Current.IsReadOnly
        if ($isPassword) {
          # Deliberately do NOT call $vp.Current.Value. Mark as protected.
          $value = $null
          $valueProtected = $true
        } else {
          $value = [string]$vp.Current.Value
          $valueProtected = $false
        }
      }
    } catch {}
    # RangeValuePattern - numeric values are not considered secret; read normally.
    try {
      $rvp = $null
      if ($Element.TryGetCurrentPattern($pids.RangeValue, [ref]$rvp)) {
        $rangeValue = $rvp.Current.Value
        $minimum = $rvp.Current.Minimum
        $maximum = $rvp.Current.Maximum
        $smallChange = $rvp.Current.SmallChange
        $largeChange = $rvp.Current.LargeChange
      }
    } catch {}
    # TogglePattern
    try {
      $tp = $null
      if ($Element.TryGetCurrentPattern($pids.Toggle, [ref]$tp)) {
        $toggleState = [string]$tp.Current.ToggleState
      }
    } catch {}
    # SelectionItemPattern
    try {
      $sip = $null
      if ($Element.TryGetCurrentPattern($pids.SelectionItem, [ref]$sip)) {
        $selected = [bool]$sip.Current.IsSelected
      }
    } catch {}
    # ExpandCollapsePattern
    try {
      $ecp = $null
      if ($Element.TryGetCurrentPattern($pids.ExpandCollapse, [ref]$ecp)) {
        $expandState = [string]$ecp.Current.ExpandCollapseState
      }
    } catch {}
  } else {
    # Even without values, surface valueProtected so callers can tell a
    # password field is protected without reading the value.
    if ($isPassword) { $valueProtected = $true }
  }

  $nativeHandle = ""
  try { $nativeHandle = [string]$Element.Current.NativeWindowHandle } catch {}
  if ([string]::IsNullOrEmpty($nativeHandle) -or $nativeHandle -eq "0") { $nativeHandle = "" }

  return [ordered]@{
    automationId = (Get-UiaCurrent $Element "AutomationId")
    name = (Get-UiaCurrent $Element "Name")
    controlType = $ctName
    className = (Get-UiaCurrent $Element "ClassName")
    frameworkId = (Get-UiaCurrent $Element "FrameworkId")
    processId = (Get-UiaCurrent $Element "ProcessId")
    nativeWindowHandle = $nativeHandle
    enabled = (Get-UiaCurrent $Element "IsEnabled")
    offscreen = (Get-UiaCurrent $Element "IsOffscreen")
    focusable = (Get-UiaCurrent $Element "IsKeyboardFocusable")
    hasKeyboardFocus = (Get-UiaCurrent $Element "HasKeyboardFocus")
    isPassword = $isPassword
    valueProtected = $valueProtected
    isReadOnly = $isReadOnly
    boundingRect = $rect
    runtimeId = $runtimeId
    patterns = $patterns
    value = $value
    rangeValue = $rangeValue
    minimum = $minimum
    maximum = $maximum
    smallChange = $smallChange
    largeChange = $largeChange
    toggleState = $toggleState
    selected = $selected
    expandCollapseState = $expandState
  }
}

# Normalize a control-type string from the selector (already cleaned by TS) to
# the UIA ControlType programmatic name for comparison.
function ConvertTo-UiaControlTypeName {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  $v = $Value -replace "^ControlType\.", ""
  # Try to find a matching ControlType by short name (case-insensitive).
  foreach ($ct in [System.Windows.Automation.ControlType].GetFields([System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::Static)) {
    if ($ct.Name -ieq $v) { return $ct.GetValue($null).ProgrammaticName }
  }
  return $v
}

# Test whether an element matches a single selector (no ancestor/path).
function Test-UiaElementMatches {
  param($Element, [hashtable]$Selector)

  $match = "exact"
  if ($Selector.ContainsKey("match") -and $Selector.match) { $match = [string]$Selector.match }
  $caseSensitive = $false
  if ($Selector.ContainsKey("caseSensitive") -and $Selector.caseSensitive) { $caseSensitive = [bool]$Selector.caseSensitive }

  $cmp = if ($caseSensitive) {
    [System.StringComparison]::Ordinal
  } else {
    [System.StringComparison]::OrdinalIgnoreCase
  }

  if ($Selector.ContainsKey("automationId") -and $Selector.automationId) {
    $actual = ""
    try { $actual = [string]$Element.Current.AutomationId } catch {}
    if (-not (Test-StringMatch $actual $Selector.automationId $match $cmp)) { return $false }
  }
  if ($Selector.ContainsKey("name") -and $Selector.name) {
    $actual = ""
    try { $actual = [string]$Element.Current.Name } catch {}
    if (-not (Test-StringMatch $actual $Selector.name $match $cmp)) { return $false }
  }
  if ($Selector.ContainsKey("className") -and $Selector.className) {
    $actual = ""
    try { $actual = [string]$Element.Current.ClassName } catch {}
    if (-not (Test-StringMatch $actual $Selector.className $match $cmp)) { return $false }
  }
  if ($Selector.ContainsKey("frameworkId") -and $Selector.frameworkId) {
    $actual = ""
    try { $actual = [string]$Element.Current.FrameworkId } catch {}
    if (-not (Test-StringMatch $actual $Selector.frameworkId $match $cmp)) { return $false }
  }
  if ($Selector.ContainsKey("controlType") -and $Selector.controlType) {
    $actual = ""
    try { $actual = [string]$Element.Current.ControlType.ProgrammaticName } catch {}
    $expected = ConvertTo-UiaControlTypeName $Selector.controlType
    # ControlType is always exact-matched (no contains/regex).
    if (-not [string]::Equals($actual, $expected, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  }
  if ($Selector.ContainsKey("visibleOnly") -and $Selector.visibleOnly) {
    try { if ($Element.Current.IsOffscreen) { return $false } } catch {}
  }
  if ($Selector.ContainsKey("enabledOnly") -and $Selector.enabledOnly) {
    try { if (-not $Element.Current.IsEnabled) { return $false } } catch {}
  }
  return $true
}

function Test-StringMatch {
  param([string]$Actual, [string]$Expected, [string]$Match, [System.StringComparison]$Cmp)
  switch ($Match) {
    "exact" { return [string]::Equals($Actual, $Expected, $Cmp) }
    "contains" { return ($Actual.IndexOf($Expected, $Cmp) -ge 0) }
    "regex" {
      try {
        $opts = if ($Cmp -eq [System.StringComparison]::Ordinal) { [System.Text.RegularExpressions.RegexOptions]::None } else { [System.Text.RegularExpressions.RegexOptions]::IgnoreCase }
        return [System.Text.RegularExpressions.Regex]::IsMatch($Actual, $Expected, $opts)
      } catch { return $false }
    }
    default { return [string]::Equals($Actual, $Expected, $Cmp) }
  }
}

function Test-SelectorHasLocator {
  param([hashtable]$Selector)
  if ($null -eq $Selector) { return $false }
  foreach ($k in @('automationId','name','controlType','className','frameworkId')) {
    if ($Selector.ContainsKey($k) -and $Selector.$k) { return $true }
  }
  if ($Selector.ContainsKey("path") -and $Selector.path -and @($Selector.path).Count -gt 0) { return $true }
  if ($Selector.ContainsKey("ancestor") -and $Selector.ancestor -and (Test-SelectorHasLocator $Selector.ancestor)) { return $true }
  return $false
}

function Get-UiaChildren {
  param($Element, $Walker)

  $children = [System.Collections.ArrayList]::new()
  $child = $null
  try { $child = $Walker.GetFirstChild($Element) } catch { $child = $null }
  $count = 0
  while ($null -ne $child -and $count -lt 500) {
    $children.Add($child) | Out-Null
    $count++
    try { $child = $Walker.GetNextSibling($child) } catch { $child = $null }
  }
  return @($children.ToArray())
}

function Test-UiaAncestorChain {
  param($Element, [hashtable]$AncestorSelector, $Walker, [int]$MaxDepth)

  if ($null -eq $AncestorSelector) { return $true }
  $parent = $null
  try { $parent = $Walker.GetParent($Element) } catch { $parent = $null }
  $depth = 0
  while ($null -ne $parent -and $depth -lt $MaxDepth) {
    try {
      if (Test-UiaElementMatches -Element $parent -Selector $AncestorSelector) { return $true }
    } catch {}
    $depth++
    try { $parent = $Walker.GetParent($parent) } catch { $parent = $null }
  }
  return $false
}

function Find-UiaPathRecords {
  param($RootInfo, $Path, $Walker, [int]$MaxDepth, [int]$MaxNodes, $Deadline, $Visited)

  $current = @([pscustomobject]@{
    Element = $RootInfo.element
    Root = $RootInfo
    Parent = $null
    Depth = 0
  })
  $truncated = $false

  foreach ($segmentValue in @($Path)) {
    if ($current.Count -eq 0) { break }
    $segment = [hashtable]$segmentValue
    $next = [System.Collections.ArrayList]::new()
    foreach ($parentRecord in $current) {
      if ([DateTimeOffset]::UtcNow -gt $Deadline -or $Visited.Value -ge $MaxNodes) {
        $truncated = $true
        break
      }
      if ($parentRecord.Depth -ge $MaxDepth) { continue }
      foreach ($child in Get-UiaChildren -Element $parentRecord.Element -Walker $Walker) {
        if ([DateTimeOffset]::UtcNow -gt $Deadline -or $Visited.Value -ge $MaxNodes) {
          $truncated = $true
          break
        }
        $Visited.Value++
        $isMatch = $false
        try { $isMatch = Test-UiaElementMatches -Element $child -Selector $segment } catch { $isMatch = $false }
        if ($isMatch) {
          $next.Add([pscustomobject]@{
            Element = $child
            Root = $RootInfo
            Parent = $parentRecord
            Depth = ($parentRecord.Depth + 1)
          }) | Out-Null
        }
      }
      if ($truncated) { break }
    }
    $current = @($next.ToArray())
    if ($truncated) { break }
  }
  return [pscustomobject]@{
    records = @($current)
    truncated = [bool]$truncated
  }
}

function Resolve-UiaRecordsFromRoots {
  param(
    $Roots,
    [hashtable]$Selector,
    [int]$MaxDepth,
    [int]$MaxNodes,
    [int]$PerRootMs,
    [int]$MaxResults,
    [bool]$IncludePatterns,
    [bool]$IncludeValues
  )

  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $records = [System.Collections.ArrayList]::new()
  $visited = 0
  $truncated = $false
  $hasPath = $Selector.ContainsKey("path") -and $Selector.path -and @($Selector.path).Count -gt 0
  $ancestorSelector = $null
  if ($Selector.ContainsKey("ancestor") -and $Selector.ancestor -and (Test-SelectorHasLocator $Selector.ancestor)) {
    $ancestorSelector = [hashtable]$Selector.ancestor
  }

  foreach ($root in $Roots) {
    if ($records.Count -ge $MaxResults) { $truncated = $true; break }
    if ($visited -ge $MaxNodes) { $truncated = $true; break }
    $deadline = [DateTimeOffset]::UtcNow.AddMilliseconds($PerRootMs)

    if ($hasPath) {
      $pathResult = Find-UiaPathRecords -RootInfo $root -Path @($Selector.path) -Walker $walker -MaxDepth $MaxDepth -MaxNodes $MaxNodes -Deadline $deadline -Visited ([ref]$visited)
      if ($pathResult.truncated) { $truncated = $true }
      foreach ($record in @($pathResult.records)) {
        if ($records.Count -ge $MaxResults) { $truncated = $true; break }
        $finalMatch = $false
        try { $finalMatch = Test-UiaElementMatches -Element $record.Element -Selector $Selector } catch { $finalMatch = $false }
        if (-not $finalMatch) { continue }
        if ($null -ne $ancestorSelector -and -not (Test-UiaAncestorChain -Element $record.Element -AncestorSelector $ancestorSelector -Walker $walker -MaxDepth $MaxDepth)) { continue }
        $records.Add([pscustomobject]@{
          Element = $record.Element
          Root = $root
          State = (Get-UiaElementState -Element $record.Element -IncludePatterns $IncludePatterns -IncludeValues $IncludeValues)
          Depth = $record.Depth
          Parent = $record.Parent
        }) | Out-Null
      }
      continue
    }

    $stack = [System.Collections.Stack]::new()
    $stack.Push([pscustomobject]@{
      Element = $root.element
      Root = $root
      Parent = $null
      Depth = 0
    })

    while ($stack.Count -gt 0) {
      if ([DateTimeOffset]::UtcNow -gt $deadline) { $truncated = $true; break }
      if ($visited -ge $MaxNodes) { $truncated = $true; break }
      if ($records.Count -ge $MaxResults) { $truncated = $true; break }

      $node = $stack.Pop()
      $visited++
      $isMatch = $false
      try { $isMatch = Test-UiaElementMatches -Element $node.Element -Selector $Selector } catch { $isMatch = $false }
      if ($isMatch -and ($null -eq $ancestorSelector -or (Test-UiaAncestorChain -Element $node.Element -AncestorSelector $ancestorSelector -Walker $walker -MaxDepth $MaxDepth))) {
        $records.Add([pscustomobject]@{
          Element = $node.Element
          Root = $root
          State = (Get-UiaElementState -Element $node.Element -IncludePatterns $IncludePatterns -IncludeValues $IncludeValues)
          Depth = $node.Depth
          Parent = $node.Parent
        }) | Out-Null
      }

      if ($node.Depth -ge $MaxDepth) { continue }
      $children = @(Get-UiaChildren -Element $node.Element -Walker $walker)
      for ($i = $children.Count - 1; $i -ge 0; $i--) {
        $stack.Push([pscustomobject]@{
          Element = $children[$i]
          Root = $root
          Parent = $node
          Depth = ($node.Depth + 1)
        })
      }
    }
  }

  return [ordered]@{
    records = @($records.ToArray())
    visited = $visited
    truncated = [bool]$truncated
  }
}

# ── ui_inspect_tree ──
function Invoke-UiInspectTree {
  param([hashtable]$Target)

  Assert-UiaAvailable
  $includePopups = $true
  if ($Target.ContainsKey("includeProcessPopups") -and $null -ne $Target.includeProcessPopups) { $includePopups = [bool]$Target.includeProcessPopups }
  $maxDepth = 10
  if ($Target.ContainsKey("maxDepth")) { $maxDepth = [int]$Target.maxDepth }
  $maxNodes = 1500
  if ($Target.ContainsKey("maxNodes")) { $maxNodes = [int]$Target.maxNodes }
  $timeoutMs = 20000
  if ($Target.ContainsKey("timeoutMs")) { $timeoutMs = [int]$Target.timeoutMs }
  $interactiveOnly = $false
  if ($Target.ContainsKey("interactiveOnly")) { $interactiveOnly = [bool]$Target.interactiveOnly }
  $automationIdOnly = $false
  if ($Target.ContainsKey("automationIdOnly")) { $automationIdOnly = [bool]$Target.automationIdOnly }
  $includePatterns = $true
  if ($Target.ContainsKey("includePatterns")) { $includePatterns = [bool]$Target.includePatterns }
  $includeOffscreen = $true
  if ($Target.ContainsKey("includeOffscreen")) { $includeOffscreen = [bool]$Target.includeOffscreen }
  $controlTypes = $null
  if ($Target.ContainsKey("controlTypes") -and $Target.controlTypes) { $controlTypes = @($Target.controlTypes) }

  $windowSel = @{}
  foreach ($k in @('hwnd','pid','processName','titleContains')) { if ($Target.ContainsKey($k) -and $null -ne $Target.$k) { $windowSel[$k] = $Target.$k } }
  $roots = Get-UiaRoots -Target $windowSel -IncludeProcessPopups:$includePopups

  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $nodes = [System.Collections.ArrayList]::new()
  $visited = 0
  $truncated = $false
  $overallDeadline = [DateTimeOffset]::UtcNow.AddMilliseconds($timeoutMs)
  $perRootMs = [Math]::Max(500, [int]($timeoutMs / ([Math]::Max(1, $roots.Count))))
  $script:walkStop = $false

  $ctrlTypeFilterSet = $null
  if ($controlTypes) {
    $ctrlTypeFilterSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($ct in $controlTypes) { $ctrlTypeFilterSet.Add((ConvertTo-UiaControlTypeName $ct)) | Out-Null }
  }

  foreach ($root in $roots) {
    if ($script:walkStop) { break }
    $rootDeadline = [DateTimeOffset]::UtcNow.AddMilliseconds($perRootMs)
    $stack = [System.Collections.Stack]::new()
    $stack.Push([pscustomobject]@{ Element = $root.element; Depth = 0; ParentId = $null })
    while ($stack.Count -gt 0) {
      if ($script:walkStop) { break }
      if ($nodes.Count -ge $maxNodes) { $truncated = $true; break }
      if ($visited -ge ($maxNodes * 3)) { $truncated = $true; $script:walkStop = $true; break }
      if ([DateTimeOffset]::UtcNow -gt $rootDeadline -or [DateTimeOffset]::UtcNow -gt $overallDeadline) { $truncated = $true; $script:walkStop = $true; break }

      $node = $stack.Pop()
      $visited++
      $el = $node.Element
      $nodeId = $nodes.Count + 1

      $ct = $null; try { $ct = $el.Current.ControlType } catch {}
      $ctName = if ($ct) { $ct.ProgrammaticName } else { "" }
      $autoId = ""; $name = ""; $cls = ""; $fw = ""; $pidv = 0; $en = $true; $off = $true
      $focusable = $false; $hasFocus = $false
      try { $autoId = [string]$el.Current.AutomationId } catch {}
      try { $name = [string]$el.Current.Name } catch {}
      try { $cls = [string]$el.Current.ClassName } catch {}
      try { $fw = [string]$el.Current.FrameworkId } catch {}
      try { $pidv = [int]$el.Current.ProcessId } catch {}
      try { $en = [bool]$el.Current.IsEnabled } catch {}
      try { $off = [bool]$el.Current.IsOffscreen } catch {}
      try { $focusable = [bool]$el.Current.IsKeyboardFocusable } catch {}
      try { $hasFocus = [bool]$el.Current.HasKeyboardFocus } catch {}

      # Filtering: filters only affect whether the node is RETURNED, not
      # whether traversal continues past it.
      $include = $true
      if (-not $includeOffscreen -and $off) { $include = $false }
      if ($automationIdOnly -and [string]::IsNullOrEmpty($autoId)) { $include = $false }
      if ($interactiveOnly) {
        if ($off -or -not $en -or -not $focusable) { $include = $false }
      }
      if ($ctrlTypeFilterSet -and -not $ctrlTypeFilterSet.Contains($ctName)) { $include = $false }

      if ($include) {
        $rect = $null
        try { $r = $el.Current.BoundingRectangle; if ($r.Width -gt 0 -and $r.Height -gt 0) { $rect = [ordered]@{ x=[int]$r.X; y=[int]$r.Y; width=[int]$r.Width; height=[int]$r.Height } } } catch {}
        $pats = @()
        if ($includePatterns) { $pats = (Get-UiaElementState -Element $el -IncludePatterns $true -IncludeValues $false).patterns }
        $nativeHandle = ""
        try { $nh = $el.Current.NativeWindowHandle; if ($nh -ne 0) { $nativeHandle = [string]$nh } } catch {}
        $nodes.Add([ordered]@{
          nodeId = $nodeId
          parentNodeId = $node.ParentId
          depth = $node.Depth
          rootHwnd = [string]$root.hwnd
          rootIndex = [int]$root.rootIndex
          automationId = $autoId
          name = $name
          controlType = $ctName
          className = $cls
          frameworkId = $fw
          processId = $pidv
          nativeWindowHandle = $nativeHandle
          enabled = $en
          offscreen = $off
          focusable = $focusable
          hasKeyboardFocus = $hasFocus
          boundingRect = $rect
          patterns = $pats
        }) | Out-Null
      }

      if ($node.Depth -ge $maxDepth) { continue }
      $child = $null
      try { $child = $walker.GetFirstChild($el) } catch { $child = $null }
      $buf = [System.Collections.ArrayList]::new()
      $cc = 0
      while ($null -ne $child -and $cc -lt 500) {
        $buf.Insert(0, $child) | Out-Null
        $cc++
        try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
      }
      $parentId = if ($include) { $nodeId } else { $node.ParentId }
      foreach ($c in $buf) { $stack.Push([pscustomobject]@{ Element = $c; Depth = ($node.Depth + 1); ParentId = $parentId }) }
    }
  }

  $elapsed = [int]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - ($overallDeadline.ToUnixTimeMilliseconds() - $timeoutMs))
  return [ordered]@{
    roots = @($roots | ForEach-Object {
      [ordered]@{
        hwnd = [string]$_.hwnd
        title = [string]$_.title
        className = [string]$_.className
        processId = [int]$_.processId
        isMain = [bool]$_.isMain
        isPopup = [bool]$_.isPopup
        rootIndex = [int]$_.rootIndex
      }
    })
    nodes = @($nodes.ToArray())
    visitedNodes = $visited
    returnedNodes = $nodes.Count
    truncated = [bool]$truncated
    maxDepth = $maxDepth
    maxNodes = $maxNodes
    elapsedMs = $elapsed
  }
}

# ── ui_query / ui_get shared resolver ──
function Resolve-UiaSelector {
  param([hashtable]$Target, [bool]$Single, [bool]$IncludeValues)

  Assert-UiaAvailable
  $includePopups = $true
  if ($Target.ContainsKey("includeProcessPopups") -and $null -ne $Target.includeProcessPopups) { $includePopups = [bool]$Target.includeProcessPopups }
  $maxDepth = 15
  if ($Target.ContainsKey("maxDepth")) { $maxDepth = [int]$Target.maxDepth }
  $maxNodes = 2000
  if ($Target.ContainsKey("maxNodes") -and $null -ne $Target.maxNodes) { $maxNodes = [int]$Target.maxNodes }
  $timeoutMs = 15000
  if ($Target.ContainsKey("timeoutMs") -and $null -ne $Target.timeoutMs) { $timeoutMs = [int]$Target.timeoutMs }
  $includePatterns = $true
  if ($Target.ContainsKey("includePatterns") -and $null -ne $Target.includePatterns) { $includePatterns = [bool]$Target.includePatterns }
  $maxResults = 100
  if ($Target.ContainsKey("maxResults") -and $null -ne $Target.maxResults) { $maxResults = [int]$Target.maxResults }

  $selector = [hashtable]$Target.selector
  $index = $null
  if ($selector.ContainsKey("index") -and $null -ne $selector.index) { $index = [int]$selector.index }
  if ($Single -and $null -eq $index) {
    $maxResults = 2
  } elseif ($null -ne $index) {
    $maxResults = [Math]::Max(2, $index + 1)
  }
  $maxResults = [Math]::Min([Math]::Max(1, $maxResults), [Math]::Max(1, $maxNodes))

  $windowSel = @{}
  foreach ($k in @('hwnd','pid','processName','titleContains')) { if ($Target.ContainsKey($k) -and $null -ne $Target.$k) { $windowSel[$k] = $Target.$k } }
  $roots = Get-UiaRoots -Target $windowSel -IncludeProcessPopups:$includePopups

  $perRootMs = [Math]::Max(500, [int]($timeoutMs / ([Math]::Max(1, $roots.Count))))
  $result = Resolve-UiaRecordsFromRoots -Roots $roots -Selector $selector -MaxDepth $maxDepth -MaxNodes $maxNodes -PerRootMs $perRootMs -MaxResults $maxResults -IncludePatterns $includePatterns -IncludeValues $IncludeValues
  $records = @($result.records)

  if ($null -ne $index) {
    if ($index -ge $records.Count) {
      return [ordered]@{ records = @(); visited = $result.visited; truncated = [bool]$result.truncated; indexOutOfRange = $true }
    }
    $records = @($records[$index])
  }

  if ($Single -and $null -eq $index -and $records.Count -gt 1) {
    $candidates = @($records | Select-Object -First 10 | ForEach-Object {
      $candidate = $_.State
      [ordered]@{
        automationId = $candidate.automationId
        name = $candidate.name
        controlType = $candidate.controlType
        className = $candidate.className
        frameworkId = $candidate.frameworkId
        boundingRect = $candidate.boundingRect
        runtimeId = $candidate.runtimeId
        isPassword = $candidate.isPassword
        valueProtected = $candidate.valueProtected
      }
    })
    Throw-UiaError "ELEMENT_AMBIGUOUS" "Selector matched $($records.Count) elements; provide an index or a more specific selector." ([ordered]@{ selector = $selector; candidateCount = $records.Count; candidates = $candidates; stage = "resolve-element" })
  }

  return [ordered]@{ records = $records; visited = $result.visited; truncated = [bool]$result.truncated; indexOutOfRange = [bool]$false }
}

function Invoke-UiQuery {
  param([hashtable]$Target)
  $start = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $res = Resolve-UiaSelector -Target $Target -Single $false -IncludeValues $true
  $elapsed = [int]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $start)
  return [ordered]@{
    found = ($res.records.Count -gt 0)
    count = $res.records.Count
    elements = @($res.records | ForEach-Object { $_.State })
    truncated = [bool]$res.truncated
    visitedNodes = [int]$res.visited
    elapsedMs = $elapsed
  }
}

function Invoke-UiGet {
  param([hashtable]$Target)
  $start = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $res = Resolve-UiaSelector -Target $Target -Single $true -IncludeValues $true
  $elapsed = [int]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $start)
  if ($res.records.Count -eq 0) {
    return [ordered]@{ found = $false; element = $null; elapsedMs = $elapsed }
  }
  return [ordered]@{ found = $true; element = $res.records[0].State; elapsedMs = $elapsed }
}

# ── ui_action ──
function Invoke-UiAction {
  param([hashtable]$Target)

  Assert-UiaAvailable
  $action = [string]$Target.action
  $allowFallback = $false
  if ($Target.ContainsKey("allowCoordinateFallback")) { $allowFallback = [bool]$Target.allowCoordinateFallback }
  $forceClick = $false
  if ($Target.ContainsKey("forceCoordinateClick")) { $forceClick = [bool]$Target.forceCoordinateClick }

  $start = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  $res = Resolve-UiaSelector -Target $Target -Single $true -IncludeValues $true
  if ($res.records.Count -eq 0) {
    Throw-UiaError "ELEMENT_NOT_FOUND" "No element matched the selector for action '$action'." ([ordered]@{ selector = $Target.selector; stage = "action-resolve" })
  }
  $record = $res.records[0]
  $stateBefore = $record.State
  $live = $record.Element
  $targetHwnd = [IntPtr]([int64]$record.Root.hwnd)

  $method = ""
  $fallbackUsed = $false

  if ($forceClick) {
    $method = "coordinate_click_forced"
    $fallbackUsed = $true
    Invoke-CoordinateClick -Element $live -TargetHwnd $targetHwnd -AllowFallback $true
  } else {
    switch ($action) {
      "invoke" {
        if (Try-UiaPattern $live "Invoke" { param($p) $p.Invoke() }) { $method = "InvokePattern" }
        elseif ($allowFallback -and (Invoke-CoordinateClick -Element $live -TargetHwnd $targetHwnd -AllowFallback $true)) { $method = "coordinate_click_fallback"; $fallbackUsed = $true }
        else { Throw-UiaError "PATTERN_NOT_SUPPORTED" "Element does not support InvokePattern and coordinate fallback is disabled." ([ordered]@{ selector = $Target.selector; patterns = $stateBefore.patterns; stage = "invoke" }) }
      }
      "toggle" {
        if (Try-UiaPattern $live "Toggle" { param($p) $p.Toggle() }) { $method = "TogglePattern" }
        elseif (Try-UiaPattern $live "Invoke" { param($p) $p.Invoke() }) { $method = "InvokePattern" }
        elseif ($allowFallback -and (Invoke-CoordinateClick -Element $live -TargetHwnd $targetHwnd -AllowFallback $true)) { $method = "coordinate_click_fallback"; $fallbackUsed = $true }
        else { Throw-UiaError "PATTERN_NOT_SUPPORTED" "Element does not support Toggle/Invoke patterns and coordinate fallback is disabled." ([ordered]@{ selector = $Target.selector; patterns = $stateBefore.patterns; stage = "toggle" }) }
      }
      "select" { $method = Invoke-SelectionAction -Element $live -Action "Select" -AllowFallback $allowFallback -TargetHwnd $targetHwnd -Selector $Target.selector -StateBefore $stateBefore }
      "addToSelection" { $method = Invoke-SelectionAction -Element $live -Action "AddToSelection" -AllowFallback $allowFallback -TargetHwnd $targetHwnd -Selector $Target.selector -StateBefore $stateBefore }
      "removeFromSelection" { $method = Invoke-SelectionAction -Element $live -Action "RemoveFromSelection" -AllowFallback $allowFallback -TargetHwnd $targetHwnd -Selector $Target.selector -StateBefore $stateBefore }
      "expand" { $method = Invoke-ExpandCollapse -Element $live -Action "Expand" -Selector $Target.selector -StateBefore $stateBefore }
      "collapse" { $method = Invoke-ExpandCollapse -Element $live -Action "Collapse" -Selector $Target.selector -StateBefore $stateBefore }
      "setValue" {
        if (Try-UiaPattern $live "Value" { param($p) $p.SetValue([string]$Target.value) }) { $method = "ValuePattern" }
        else { Throw-UiaError "PATTERN_NOT_SUPPORTED" "Element does not support ValuePattern; cannot setValue." ([ordered]@{ selector = $Target.selector; patterns = $stateBefore.patterns; stage = "setValue" }) }
      }
      "setRangeValue" {
        if (Try-UiaPattern $live "RangeValue" { param($p) $p.SetValue([double]$Target.rangeValue) }) { $method = "RangeValuePattern" }
        else { Throw-UiaError "PATTERN_NOT_SUPPORTED" "Element does not support RangeValuePattern; cannot setRangeValue." ([ordered]@{ selector = $Target.selector; patterns = $stateBefore.patterns; stage = "setRangeValue" }) }
      }
      "scrollIntoView" {
        if (Try-UiaPattern $live "ScrollItem" { param($p) $p.ScrollIntoView() }) { $method = "ScrollItemPattern" }
        else { Throw-UiaError "PATTERN_NOT_SUPPORTED" "Element does not support ScrollItemPattern." ([ordered]@{ selector = $Target.selector; patterns = $stateBefore.patterns; stage = "scrollIntoView" }) }
      }
      "focus" {
        try { $live.SetFocus(); $method = "SetFocus" } catch { Throw-UiaError "ACTION_FAILED" "SetFocus failed: $($_.Exception.Message)" ([ordered]@{ selector = $Target.selector; stage = "focus" }) }
      }
      "legacyDefaultAction" {
        # LegacyIAccessiblePattern is not exposed by this managed API. Fall
        # back to InvokePattern; if unavailable, coordinate click (when
        # allowed). This is documented as an API limitation.
        if (Try-UiaPattern $live "Invoke" { param($p) $p.Invoke() }) { $method = "InvokePattern(legacy)" }
        elseif ($allowFallback -and (Invoke-CoordinateClick -Element $live -TargetHwnd $targetHwnd -AllowFallback $true)) { $method = "coordinate_click_fallback"; $fallbackUsed = $true }
        else { Throw-UiaError "PATTERN_NOT_SUPPORTED" "LegacyIAccessiblePattern is not available in this managed API and InvokePattern is unsupported; enable allowCoordinateFallback to use a coordinate click." ([ordered]@{ selector = $Target.selector; patterns = $stateBefore.patterns; stage = "legacyDefaultAction" }) }
      }
      "click" {
        # Caller-requested click, but still prefer patterns per spec.
        if (Try-UiaPattern $live "Invoke" { param($p) $p.Invoke() }) { $method = "InvokePattern" }
        elseif ($allowFallback -and (Invoke-CoordinateClick -Element $live -TargetHwnd $targetHwnd -AllowFallback $true)) { $method = "coordinate_click_fallback"; $fallbackUsed = $true }
        else { Throw-UiaError "COORDINATE_FALLBACK_DISABLED" "Element has no invokable pattern and allowCoordinateFallback is false." ([ordered]@{ selector = $Target.selector; patterns = $stateBefore.patterns; stage = "click" }) }
      }
      default { Throw-UiaError "ACTION_FAILED" "Unknown action: $action" ([ordered]@{ stage = "dispatch" }) }
    }
  }

  # Read post-state for diff (best-effort). Resolve through the same bounded
  # selector path; failures do not hide a successful action.
  $stateAfter = $null
  try {
    $after = Resolve-UiaSelector -Target $Target -Single $true -IncludeValues $true
    if ($after.records.Count -gt 0) { $stateAfter = $after.records[0].State }
  } catch {}

  $elapsed = [int]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $start)
  return [ordered]@{
    success = $true
    method = $method
    coordinateFallbackUsed = [bool]$fallbackUsed
    before = $stateBefore
    after = $stateAfter
    elapsedMs = $elapsed
  }
}

function Try-UiaPattern {
  param($Element, [string]$PatternName, [scriptblock]$Action)
  try {
    $pids = Get-UiaPatternIds
    $pat = $pids[$PatternName]
    if ($null -eq $pat) { return $false }
    $instance = $null
    if (-not $Element.TryGetCurrentPattern($pat, [ref]$instance)) { return $false }
    if ($null -eq $instance) { return $false }
    & $Action $instance
    return $true
  } catch {
    return $false
  }
}

function Invoke-SelectionAction {
  param($Element, [string]$Action, [bool]$AllowFallback, [IntPtr]$TargetHwnd, [hashtable]$Selector, $StateBefore)
  $pids = Get-UiaPatternIds
  try {
    $sip = $null
    if ($Element.TryGetCurrentPattern($pids.SelectionItem, [ref]$sip) -and $null -ne $sip) {
      switch ($Action) {
        "Select" { $sip.Select(); return "SelectionItemPattern.Select" }
        "AddToSelection" { $sip.AddToSelection(); return "SelectionItemPattern.AddToSelection" }
        "RemoveFromSelection" { $sip.RemoveFromSelection(); return "SelectionItemPattern.RemoveFromSelection" }
      }
    }
  } catch {}
  if (Try-UiaPattern $Element "Invoke" { param($p) $p.Invoke() }) { return "InvokePattern" }
  if ($AllowFallback -and (Invoke-CoordinateClick -Element $Element -TargetHwnd $TargetHwnd -AllowFallback $true)) { return "coordinate_click_fallback" }
  Throw-UiaError "PATTERN_NOT_SUPPORTED" "Element does not support SelectionItem/Invoke patterns and coordinate fallback is disabled." ([ordered]@{ selector = $Selector; patterns = $StateBefore.patterns; stage = "selection" })
}

function Invoke-ExpandCollapse {
  param($Element, [string]$Action, [hashtable]$Selector, $StateBefore)
  $pids = Get-UiaPatternIds
  try {
    $ecp = $null
    if ($Element.TryGetCurrentPattern($pids.ExpandCollapse, [ref]$ecp) -and $null -ne $ecp) {
      if ($Action -eq "Expand") { $ecp.Expand(); return "ExpandCollapsePattern.Expand" }
      else { $ecp.Collapse(); return "ExpandCollapsePattern.Collapse" }
    }
  } catch {}
  Throw-UiaError "PATTERN_NOT_SUPPORTED" "Element does not support ExpandCollapsePattern." ([ordered]@{ selector = $Selector; patterns = $StateBefore.patterns; stage = "expandCollapse" })
}

# Strictly-controlled coordinate fallback. Validates every safety condition
# before clicking. Returns $true if a click was performed, $false otherwise.
function Invoke-CoordinateClick {
  param($Element, [IntPtr]$TargetHwnd, [bool]$AllowFallback)

  if (-not $AllowFallback) { return $false }

  # Re-validate all safety conditions dynamically.
  try {
    $off = [bool]$Element.Current.IsOffscreen
    if ($off) { Throw-UiaError "INVALID_BOUNDING_RECT" "Element is offscreen; cannot use coordinate fallback." ([ordered]@{ stage = "coordinate-fallback" }) }
    $r = $Element.Current.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { Throw-UiaError "INVALID_BOUNDING_RECT" "Element has zero-size bounding rectangle." ([ordered]@{ stage = "coordinate-fallback" }) }
  } catch {
    if ($null -ne (Get-UiaErrorFromRecord $_)) { throw }
    Throw-UiaError "INVALID_BOUNDING_RECT" "Could not read element bounding rectangle." ([ordered]@{ stage = "coordinate-fallback" })
  }

  $rect = $Element.Current.BoundingRectangle
  $centerX = [int]([double]$rect.X + [double]$rect.Width / 2)
  $centerY = [int]([double]$rect.Y + [double]$rect.Height / 2)

  # Verify the center is within the target window's bounds.
  $winRect = New-Object ScreenshotTool.Native+RECT
  if (-not [ScreenshotTool.Native]::GetWindowRect($TargetHwnd, [ref]$winRect)) {
    Throw-UiaError "INVALID_BOUNDING_RECT" "Failed to read target window rect for coordinate fallback." ([ordered]@{ stage = "coordinate-fallback" })
  }
  if ($centerX -lt $winRect.Left -or $centerX -ge $winRect.Right -or $centerY -lt $winRect.Top -or $centerY -ge $winRect.Bottom) {
    Throw-UiaError "INVALID_BOUNDING_RECT" "Element center ($centerX,$centerY) is outside the target window bounds." ([ordered]@{ stage = "coordinate-fallback"; screenPoint = [ordered]@{ x = $centerX; y = $centerY }; windowRect = (Get-RectObject $winRect) })
  }

  # Convert screen -> window-relative and reuse the existing click_window path.
  $clientPoint = New-Object ScreenshotTool.Native+POINT
  $clientPoint.X = $centerX
  $clientPoint.Y = $centerY
  if (-not [ScreenshotTool.Native]::ScreenToClient($TargetHwnd, [ref]$clientPoint)) {
    Throw-UiaError "ACTION_FAILED" "ScreenToClient failed during coordinate fallback." ([ordered]@{ stage = "coordinate-fallback" })
  }

  $clickTarget = [ordered]@{
    hwnd = $TargetHwnd.ToInt64().ToString()
    x = [int]$clientPoint.X
    y = [int]$clientPoint.Y
    button = "left"
    delayMs = 0
  }
  Click-Window -Target $clickTarget | Out-Null
  return $true
}

# ── ui_wait ──
function Invoke-UiWait {
  param([hashtable]$Target)

  Assert-UiaAvailable
  $condition = [string]$Target.condition
  $timeoutMs = 10000
  if ($Target.ContainsKey("timeoutMs") -and $null -ne $Target.timeoutMs) { $timeoutMs = [int]$Target.timeoutMs }
  $pollMs = 200
  if ($Target.ContainsKey("pollIntervalMs") -and $null -ne $Target.pollIntervalMs) { $pollMs = [int]$Target.pollIntervalMs }
  if ($pollMs -lt 50) { $pollMs = 50 }
  $expectedValue = $null
  if ($Target.ContainsKey("expectedValue") -and $null -ne $Target.expectedValue) { $expectedValue = [string]$Target.expectedValue }
  $expectedCount = $null
  if ($Target.ContainsKey("expectedCount") -and $null -ne $Target.expectedCount) { $expectedCount = [int]$Target.expectedCount }
  $toggleExpected = $null
  if ($Target.ContainsKey("toggleState") -and $null -ne $Target.toggleState) { $toggleExpected = [string]$Target.toggleState }

  $start = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $deadline = $start + $timeoutMs
  $lastObs = $null

  while ($true) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $elapsed = [int]($now - $start)

    try {
      if ($condition -eq "notExists" -or $condition -eq "exists" -or $condition -eq "countEquals") {
        # These conditions are defined by the number of matches, so an ambiguous
        # selector is not an error. Environment/UIA errors still propagate.
        $res = Resolve-UiaSelector -Target $Target -Single $false -IncludeValues $true
        $count = @($res.records).Count
        $lastObs = [ordered]@{ count = $count }
        $matched = $false
        if ($condition -eq "exists" -and $count -gt 0) { $matched = $true }
        if ($condition -eq "notExists" -and $count -eq 0 -and -not [bool]$res.truncated) { $matched = $true }
        if ($condition -eq "countEquals" -and $null -ne $expectedCount -and $count -eq $expectedCount -and -not [bool]$res.truncated) { $matched = $true }
        if ($matched) {
          $completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
          return [ordered]@{
            matched = $true
            condition = $condition
            lastObservation = $lastObs
            elapsedMs = [int]($completedAt - $start)
            timeoutMs = $timeoutMs
            pollIntervalMs = $pollMs
            timedOut = $false
          }
        }
      } else {
        # State conditions require one element. A missing element is a normal
        # non-match; ambiguity and environment failures propagate to the caller.
        $res = Resolve-UiaSelector -Target $Target -Single $true -IncludeValues $true
        $state = $null
        if (@($res.records).Count -gt 0) { $state = $res.records[0].State }
        $lastObs = $state
        $matched = $false
        if ($null -ne $state) {
          switch ($condition) {
            "visible" { $matched = -not [bool]$state.offscreen }
            "hidden" { $matched = [bool]$state.offscreen }
            "enabled" { $matched = [bool]$state.enabled }
            "disabled" { $matched = -not [bool]$state.enabled }
            "valueEquals" { $matched = ($null -ne $state.value -and [string]$state.value -eq [string]$expectedValue) }
            "valueContains" { $matched = ($null -ne $state.value -and ([string]$state.value).IndexOf([string]$expectedValue, [System.StringComparison]::Ordinal) -ge 0) }
            "toggleStateEquals" { $matched = ($null -ne $state.toggleState -and [string]$state.toggleState -eq [string]$toggleExpected) }
            "selected" { $matched = ($null -ne $state.selected -and [bool]$state.selected) }
            "notSelected" { $matched = ($null -ne $state.selected -and -not [bool]$state.selected) }
            "expanded" { $matched = ($null -ne $state.expandCollapseState -and [string]$state.expandCollapseState -eq "Expanded") }
            "collapsed" { $matched = ($null -ne $state.expandCollapseState -and [string]$state.expandCollapseState -eq "Collapsed") }
          }
        }
        if ($matched) {
          $completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
          return [ordered]@{
            matched = $true
            condition = $condition
            lastObservation = $state
            elapsedMs = [int]($completedAt - $start)
            timeoutMs = $timeoutMs
            pollIntervalMs = $pollMs
            timedOut = $false
          }
        }
      }
    } catch {
      throw
    }

    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($now -ge $deadline) {
      return [ordered]@{
        matched = $false
        condition = $condition
        lastObservation = $lastObs
        elapsedMs = [int]($now - $start)
        timeoutMs = $timeoutMs
        pollIntervalMs = $pollMs
        timedOut = $true
      }
    }
    $remaining = [int]($deadline - $now)
    Start-Sleep -Milliseconds ([Math]::Min($pollMs, [Math]::Max(1, $remaining)))
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
      $includeUntitled = $filters.ContainsKey("pid") -or $filters.ContainsKey("processName")
      return @(Filter-Windows (Get-VisibleWindows -IncludeUntitled:$includeUntitled) $filters)
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
    "get-foreground-window" {
      return Get-ForegroundWindow
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
    "ui-inspect-tree" {
      return Invoke-UiInspectTree -Target $Request.target
    }
    "ui-query" {
      return Invoke-UiQuery -Target $Request.target
    }
    "ui-get" {
      return Invoke-UiGet -Target $Request.target
    }
    "ui-action" {
      return Invoke-UiAction -Target $Request.target
    }
    "ui-wait" {
      return Invoke-UiWait -Target $Request.target
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
        # Structured UIA errors are carried in Exception.Data["UiaError"];
        # emit that object verbatim so callers get {ok,code,message,details}
        # instead of an English stack trace.
        $uiaErr = Get-UiaErrorFromRecord $_
        if ($null -ne $uiaErr) {
          $response = $uiaErr
        } else {
          $response = [ordered]@{ ok = $false; error = $_.Exception.ToString() }
        }
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
  $uiaErr = Get-UiaErrorFromRecord $_
  if ($null -ne $uiaErr) {
    ConvertTo-Json -InputObject $uiaErr -Depth 8 -Compress
  } else {
    Write-Error $_.Exception.ToString()
    exit 1
  }
}
