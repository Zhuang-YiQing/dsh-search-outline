#requires -Version 7.0
<#
.SYNOPSIS
    把本插件（包名取自 package.json）接入一个 DSH profile（默认 desktop）。

.DESCRIPTION
    做两件事，都可重复执行（幂等）：
      1) 在 <profile>/node_modules 下建一个目录联接，指向本仓库；
      2) 在 <profile>/cordis.patch.yml 追加一段带标记的挂载行。
    不改 profile 的 package.json / pnpm-lock.yaml，卸载时按标记整段移除即可。

    装完需要**重启 DSH**（宿主半要重新加载），然后浏览器硬刷新。

.PARAMETER ProfileName
    profile 名（~/.dsh/profiles 下的目录名），默认 desktop。

.PARAMETER RepoPath
    本仓库路径，默认脚本所在目录的上一级。

.EXAMPLE
    pwsh -File scripts/install.ps1
    pwsh -File scripts/install.ps1 -ProfileName web
#>
param(
    [string]$ProfileName = 'desktop',
    [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path -LiteralPath $RepoPath).Path
$manifestPath = Join-Path $repo 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "找不到 package.json：$manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$pkgName = [string]$manifest.name
if ([string]::IsNullOrWhiteSpace($pkgName)) {
    throw "package.json 里没有 name"
}
if (-not (Test-Path -LiteralPath (Join-Path $repo 'lib\client.js'))) {
    throw "看起来不是 $pkgName 仓库：$repo"
}

$markerStart = "# >>> $pkgName (managed)"
$markerEnd = "# <<< $pkgName (managed)"

$dsHome = Join-Path $env:USERPROFILE '.dsh'
$profileDir = Join-Path $dsHome (Join-Path 'profiles' $ProfileName)
if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "找不到 profile 目录：$profileDir —— 先启动一次 DSH，让它初始化 profile。"
}

# 1) node_modules 目录联接
$nodeModules = Join-Path $profileDir 'node_modules'
New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null
$linkPath = Join-Path $nodeModules $pkgName
if (Test-Path -LiteralPath $linkPath) {
    $existing = Get-Item -LiteralPath $linkPath -Force
    $isLink = [bool]($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    if (-not $isLink) {
        throw "已存在同名真实目录，拒绝覆盖：$linkPath（先手工确认它是什么）"
    }
    [System.IO.Directory]::Delete($linkPath)
}
New-Item -ItemType Junction -Path $linkPath -Target $repo | Out-Null

# 2) cordis.patch.yml 挂载行
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $patchPath)) {
    [System.IO.File]::WriteAllText($patchPath, '', [System.Text.UTF8Encoding]::new($false))
}
$text = Get-Content -LiteralPath $patchPath -Raw
if ($text -notmatch [regex]::Escape($markerStart)) {
    $block = @"

$markerStart
- insert:
    - id: search-outline
      name: '$pkgName'
$markerEnd

"@
    [System.IO.File]::AppendAllText($patchPath, $block, [System.Text.UTF8Encoding]::new($false))
    Write-Host "已写入挂载行：$patchPath"
} else {
    Write-Host "挂载行已存在，跳过：$patchPath"
}

Write-Host "已接入：$linkPath -> $repo"
Write-Host ''
Write-Host '下一步：重启 DSH（不是刷新页面），然后硬刷新浏览器（Ctrl+Shift+R）。'
Write-Host '（可选）到设置 →「侧边卡片」→「文件预览」确认「大纲预览」卡片是开着的；'
Write-Host '这个卡片就是本插件，关掉它会回退到 better-sidebar 自带查看器。'

