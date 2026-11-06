# 给打包出来的 exe 补图标 + 版本信息。
#
# ★ 为什么需要这个:
#   electron-builder 的 win.signAndEditExecutable 被我们关掉了 —— 那一步要解压
#   winCodeSign 工具包,而包里有 darwin 符号链接,Windows 非管理员解压不了
#   (ERROR: Cannot create symbolic link : 客户端没有所需特权)。
#
#   关掉它的代价:exe 只有 Electron 默认图标,没有产品名/版本号。
#   这个脚本用 electron-builder 自己缓存里的 rcedit 把图标补回去 ——
#   rcedit 是纯 exe,不涉及符号链接,普通用户能跑。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts/set-exe-icon.ps1
#   (或直接双击运行,默认处理 dist-app/win-unpacked/DesktopPet.exe)

[CmdletBinding()]
param(
    [string]$ExePath = "",
    [string]$IconPath = "",
    [string]$ProductName = "DesktopPet",
    [string]$FileVersion = "0.1.0",
    [string]$CompanyName = "local",
    [string]$Description = "Desktop Pet"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Split-Path -Parent $scriptDir

if ([string]::IsNullOrWhiteSpace($ExePath)) {
    $ExePath = Join-Path $appDir "dist-app\win-unpacked\DesktopPet.exe"
}
if ([string]::IsNullOrWhiteSpace($IconPath)) {
    $IconPath = Join-Path $appDir "build\icon.ico"
}

if (-not (Test-Path $ExePath)) {
    Write-Error "找不到 exe: $ExePath"
    exit 1
}
if (-not (Test-Path $IconPath)) {
    Write-Error "找不到图标: $IconPath"
    exit 1
}

# ---- 找 rcedit ----
# electron-builder 下载 winCodeSign 时会一起把 rcedit 放进缓存。
# 这里扫缓存目录,找最新的那个 rcedit-x64.exe。
$cacheRoot = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign"
$rcedit = $null
if (Test-Path $cacheRoot) {
    $candidates = Get-ChildItem -Path $cacheRoot -Filter "rcedit-x64.exe" -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    if ($candidates) {
        $rcedit = $candidates[0].FullName
    }
}
if (-not $rcedit) {
    Write-Error "找不到 rcedit-x64.exe(缓存目录: $cacheRoot)。请先跑一次 electron-builder 让它下载 winCodeSign。"
    exit 1
}

Write-Host "exe    : $ExePath"
Write-Host "icon   : $IconPath"
Write-Host "rcedit : $rcedit"
Write-Host ""

& $rcedit $ExePath --set-icon $IconPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "设置图标失败 (exit=$LASTEXITCODE)"
    exit 1
}

# 版本信息:几个字段分开设置,少一个都不写
& $rcedit $ExePath --set-version-string "ProductName" $ProductName
& $rcedit $ExePath --set-version-string "FileDescription" $Description
& $rcedit $ExePath --set-version-string "CompanyName" $CompanyName
& $rcedit $ExePath --set-file-version $FileVersion
& $rcedit $ExePath --set-product-version $FileVersion

if ($LASTEXITCODE -ne 0) {
    Write-Error "写版本信息失败 (exit=$LASTEXITCODE)"
    exit 1
}

Write-Host ""
Write-Host "✅ 图标和版本信息已写入"
exit 0
