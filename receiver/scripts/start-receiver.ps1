param(
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'OshidaSmartphoneCadReceiver\receiver.json')
)

$ErrorActionPreference = 'Stop'
$runtimeRoot = Split-Path -Parent $ConfigPath
$pidPath = Join-Path $runtimeRoot 'receiver.pid'
$runnerPath = Join-Path $PSScriptRoot 'run-receiver.ps1'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

if (Test-Path -LiteralPath $pidPath) {
    $existingPid = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
    if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
        Write-Output "Receiver is already running (PID $existingPid)."
        exit 0
    }
    Remove-Item -LiteralPath $pidPath -Force
}

Push-Location -LiteralPath $repositoryRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "CAD frontend build failed with code $LASTEXITCODE" }
}
finally {
    Pop-Location
}

$arguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $runnerPath),
    '-ConfigPath', ('"{0}"' -f $ConfigPath)
) -join ' '
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru

$deadline = (Get-Date).AddSeconds(15)
do {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { throw "Receiver failed to start (exit code $($process.ExitCode))." }
    $listener = Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -ne 0 }
} until ($listener -or (Get-Date) -ge $deadline)

if (-not $listener) { throw 'Receiver did not listen on port 8787 within 15 seconds.' }
if ($listener.LocalAddress -contains '0.0.0.0' -or $listener.LocalAddress -contains '::') {
    throw 'Unsafe receiver listener detected. Expected 127.0.0.1 only.'
}

Write-Output "Receiver started (PID $($process.Id)) on http://127.0.0.1:8787."
