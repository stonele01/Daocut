param(
  [ValidateSet('Start','Stop','Open')][string]$Action = 'Start',
  [string]$Configuration = (Join-Path $PSScriptRoot 'service-launch.json')
)
$ErrorActionPreference = 'Stop'
try {
  $launch = Get-Content -LiteralPath $Configuration -Raw -Encoding UTF8 | ConvertFrom-Json
  $nodeExecutable = [IO.Path]::GetFullPath($launch.nodePath)
  $serviceEntry = [IO.Path]::GetFullPath($launch.entryPath)
  $companyData = [IO.Path]::GetFullPath($launch.dataDir)
  $healthScript = Join-Path $PSScriptRoot 'health-check.mjs'
  $pidPath = Join-Path $companyData 'service-process.json'
  $serverConfig = Get-Content -LiteralPath (Join-Path $companyData 'server-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not (Test-Path -LiteralPath $nodeExecutable) -or -not (Test-Path -LiteralPath $serviceEntry)) { throw 'Node or company service source was not found. Reinstall the launchers after moving the source.' }
  function Get-CompanyHealth {
    $healthOutput = & $nodeExecutable $healthScript $companyData
    if ($LASTEXITCODE -eq 0 -and $healthOutput) { return ($healthOutput | ConvertFrom-Json) }
    return $null
  }
  function Get-VerifiedServiceProcess {
    if (-not (Test-Path -LiteralPath $pidPath)) { return $null }
    $saved = Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $processInfo = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$saved.processId)
    if (-not $processInfo) { return $null }
    $entryPattern = '(?i)(?:^|\s)"?' + [regex]::Escape($serviceEntry) + '"?(?:\s|$)'
    if ($processInfo.ExecutablePath -ne $nodeExecutable -or $processInfo.CommandLine -notmatch $entryPattern -or $processInfo.CommandLine -cne $saved.commandLine -or $processInfo.CreationDate.ToUniversalTime().Ticks.ToString() -ne [string]$saved.creationTicks) {
      throw 'The saved PID belongs to a different process. No process was stopped. Check service-process.json before retrying.'
    }
    return $processInfo
  }
  $actionMutex = New-Object System.Threading.Mutex($false, 'Local\DaocutCompanyServiceControl')
  if (-not $actionMutex.WaitOne(0)) { Write-Host 'Another company service action is already in progress.'; exit 0 }
  try {
    if ($Action -eq 'Open') {
      if (-not (Get-CompanyHealth)) { throw 'Company service is not running. Double-click Start Company Service first.' }
      Start-Process ('https://localhost:' + $serverConfig.port + '/admin')
      Write-Host 'Opened the local administration page.'
      exit 0
    }
    if ($Action -eq 'Stop') {
      $serviceProcessInfo = Get-VerifiedServiceProcess
      if (-not $serviceProcessInfo) { Write-Host 'No launcher-owned company service process is running. Other Node processes were left unchanged.'; exit 0 }
      Stop-Process -Id $serviceProcessInfo.ProcessId
      Wait-Process -Id $serviceProcessInfo.ProcessId -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $pidPath -Force
      Write-Host 'Daocut company service stopped. Employee sign-in is unavailable until the service starts again.'
      exit 0
    }
    if (Get-CompanyHealth) { Write-Host ('Company service is already running: ' + $serverConfig.baseURL); exit 0 }
    $serviceProcessInfo = Get-VerifiedServiceProcess
    if (-not $serviceProcessInfo) {
      $logDirectory = Join-Path $companyData 'logs'
      New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
      $launchStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
      $stdoutLog = Join-Path $logDirectory ('company-' + $launchStamp + '-out.log')
      $stderrLog = Join-Path $logDirectory ('company-' + $launchStamp + '-error.log')
      $previousDataEnvironment = $env:DAOCUT_COMPANY_DATA
      try {
        $env:DAOCUT_COMPANY_DATA = $companyData
        $started = Start-Process -FilePath $nodeExecutable -ArgumentList ('"' + $serviceEntry + '"') -WorkingDirectory (Split-Path (Split-Path $serviceEntry -Parent) -Parent) -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
      } finally { $env:DAOCUT_COMPANY_DATA = $previousDataEnvironment }
      $serviceProcessInfo = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $started.Id)
      if (-not $serviceProcessInfo) { throw ('Service exited during startup. Check ' + $stderrLog) }
      @{ processId = $started.Id; creationTicks = $serviceProcessInfo.CreationDate.ToUniversalTime().Ticks.ToString(); commandLine = $serviceProcessInfo.CommandLine; entryPath = $serviceEntry; nodePath = $nodeExecutable; stdoutLog = $stdoutLog; stderrLog = $stderrLog } | ConvertTo-Json | Set-Content -LiteralPath $pidPath -Encoding UTF8
    }
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      $health = Get-CompanyHealth
      if ($health) {
        Write-Host ('Company service started: ' + $serverConfig.baseURL)
        Write-Host ('Local administration: https://localhost:' + $serverConfig.port + '/admin')
        Write-Host ('Logs: ' + (Join-Path $companyData 'logs'))
        if ($health.setupRequired) { Write-Host 'Create the first administrator in the local administration page. No default password has been set.' }
        exit 0
      }
      if (-not (Get-Process -Id $serviceProcessInfo.ProcessId -ErrorAction SilentlyContinue)) { throw ('Service exited during startup. Check logs in ' + (Join-Path $companyData 'logs')) }
      Start-Sleep -Milliseconds 300
    }
    throw ('Service process started but its HTTPS health check did not succeed. Check logs in ' + (Join-Path $companyData 'logs'))
  } finally { $actionMutex.ReleaseMutex(); $actionMutex.Dispose() }
} catch {
  Write-Host ('Error: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
