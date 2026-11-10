param(
  [string]$Destination = 'D:\Daocut\CompanyService',
  [string]$DataDirectory = 'D:\Daocut\CompanyData'
)
$ErrorActionPreference = 'Stop'
$serviceEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src\start-lan.mjs'))
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = (& $nodeExecutable --version).TrimStart('v').Split('.')
if ([int]$nodeVersion[0] -lt 24 -or ([int]$nodeVersion[0] -eq 24 -and [int]$nodeVersion[1] -lt 15)) { throw 'Node.js 24.15 or newer is required.' }
$destinationPath = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
foreach ($filename in @('Company-Service.ps1','health-check.mjs','启动公司服务.cmd','停止公司服务.cmd','打开管理台.cmd')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $filename) -Destination (Join-Path $destinationPath $filename) -Force
}
@{ nodePath = $nodeExecutable; entryPath = $serviceEntry; dataDir = [IO.Path]::GetFullPath($DataDirectory) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destinationPath 'service-launch.json') -Encoding UTF8
Write-Host ('Launchers installed in ' + $destinationPath)
