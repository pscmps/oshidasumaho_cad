param(
  [ValidateRange(1, 65535)]
  [int]$ReceiverPort = 8787
)

$ErrorActionPreference = 'Stop'
$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'

if (-not (Test-Path -LiteralPath $tailscale)) {
  throw "Tailscale CLI was not found at $tailscale"
}

& $tailscale serve --bg --yes "http://127.0.0.1:$ReceiverPort"
if ($LASTEXITCODE -ne 0) {
  throw "tailscale serve failed with exit code $LASTEXITCODE"
}

& $tailscale serve status
