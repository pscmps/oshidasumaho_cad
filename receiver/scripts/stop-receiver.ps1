param(
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'OshidaSmartphoneCadReceiver\receiver.json')
)

$ErrorActionPreference = 'Stop'
$pidPath = Join-Path (Split-Path -Parent $ConfigPath) 'receiver.pid'
if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Output 'Receiver is not running (PID file not found).'
    exit 0
}

$receiverPid = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
$children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$receiverPid" -ErrorAction SilentlyContinue
foreach ($child in $children) {
    Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
}
Stop-Process -Id $receiverPid -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
Write-Output "Receiver stopped (PID $receiverPid)."
