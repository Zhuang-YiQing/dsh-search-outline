#requires -Version 7.0
<#
.SYNOPSIS
    撤销 scripts/install.ps1 做的接入（目录联接 + 挂载行），包名取自 package.json。

.DESCRIPTION
    只删除本插件自己的东西：
      - <profile>/cordis.patch.yml 里对应标记块；
      - <profile>/node_modules 下指向本仓库的目录联接。
    不会碰 node_modules 里的真实目录。

.EXAMPLE
    pwsh -File scripts/uninstall.ps1
#>
param(
    [string]$ProfileName = 'desktop',
    [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'

$manifestPath = Join-Path (Resolve-Path -LiteralPath $RepoPath).Path 'package.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$pkgName = [string]$manifest.name
if ([string]::IsNullOrWhiteSpace($pkgName)) {
    throw "package.json 里没有 name"
}

$markerStart = "# >>> $pkgName (managed)"
$markerEnd = "# <<< $pkgName (managed)"

$profileDir = Join-Path (Join-Path $env:USERPROFILE '.dsh') (Join-Path 'profiles' $ProfileName)
if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "找不到 profile 目录：$profileDir"
}

$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if (Test-Path -LiteralPath $patchPath) {
    $text = Get-Content -LiteralPath $patchPath -Raw
    if ($text -match [regex]::Escape($markerStart)) {
        $pattern = '(?s)\r?\n?' + [regex]::Escape($markerStart) + '.*?' + [regex]::Escape($markerEnd) + '\r?\n?'
        $updated = [regex]::Replace($text, $pattern, "`n")
        [System.IO.File]::WriteAllText($patchPath, $updated, [System.Text.UTF8Encoding]::new($false))
        Write-Host "已移除挂载行：$patchPath"
    } else {
        Write-Host "没有找到挂载行，跳过：$patchPath"
    }
}

$linkPath = Join-Path (Join-Path $profileDir 'node_modules') $pkgName
if (Test-Path -LiteralPath $linkPath) {
    $item = Get-Item -LiteralPath $linkPath -Force
    $isLink = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    if ($isLink) {
        [System.IO.Directory]::Delete($linkPath)
        Write-Host "已删除目录联接：$linkPath"
    } else {
        Write-Warning "不是目录联接，保持原样：$linkPath"
    }
}

Write-Host ''
Write-Host '重启 DSH 后生效。'
