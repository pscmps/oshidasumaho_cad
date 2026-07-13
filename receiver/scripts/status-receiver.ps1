param(
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'OshidaSmartphoneCadReceiver\receiver.json')
)

$pidPath = Join-Path (Split-Path -Parent $ConfigPath) 'receiver.pid'
if (Test-Path -LiteralPath $pidPath) {
    $receiverPid = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
    $process = Get-Process -Id $receiverPid -ErrorAction SilentlyContinue
    if ($process) { Write-Output "Receiver process: running (PID $receiverPid)" }
    else { Write-Output "Receiver process: stale PID file ($receiverPid)" }
} else {
    Write-Output 'Receiver process: stopped'
}

$listeners = Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue
if ($listeners) {
    $listeners | ForEach-Object { Write-Output "Listener: $($_.LocalAddress):$($_.LocalPort) (PID $($_.OwningProcess))" }
} else {
    Write-Output 'Listener: none on port 8787'
}

$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (Test-Path -LiteralPath $tailscale) {
    Write-Output 'Tailscale Serve:'
    & $tailscale serve status
}
