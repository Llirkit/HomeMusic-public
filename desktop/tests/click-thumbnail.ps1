param(
    [Parameter(Mandatory = $true)][long]$WindowHandle,
    [Parameter(Mandatory = $true)][ValidateRange(0, 2)][int]$Index
)

# Route the same WM_COMMAND notification that Explorer sends for a thumbnail click.
# This checks Electron's native callback registration, rather than calling a JS callback directly.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HomeMusicThumbnailTest {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
}
'@
$buttonId = 40001 + $Index
$notification = (0x1800 -shl 16) -bor $buttonId
[void][HomeMusicThumbnailTest]::SendMessageW([IntPtr]$WindowHandle, 0x0111, [IntPtr]$notification, [IntPtr]::Zero)
