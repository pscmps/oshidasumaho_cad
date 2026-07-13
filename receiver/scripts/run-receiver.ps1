param(
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'OshidaSmartphoneCadReceiver\receiver.json')
)

$ErrorActionPreference = 'Stop'
$receiverRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Split-Path -Parent $ConfigPath
$pidPath = Join-Path $runtimeRoot 'receiver.pid'
$logPath = Join-Path $runtimeRoot 'receiver.log'

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Receiver config not found: $ConfigPath"
}

$settings = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
foreach ($property in $settings.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
}

# Tailscale Serve owns network exposure. The Node process stays loopback-only.
$env:RECEIVER_HOST = '127.0.0.1'

if ($env:BAMBU_AUTO_PRINT -in @('1', 'true', 'yes', 'on') -and
    [string]::IsNullOrWhiteSpace($env:BAMBU_ACCESS_CODE) -and
    -not [string]::IsNullOrWhiteSpace($env:BAMBU_PRINTER_SERIAL)) {
    $studioConfigPath = Join-Path $env:APPDATA 'BambuStudio\BambuStudio.conf'
    if (Test-Path -LiteralPath $studioConfigPath) {
        $studioConfigText = Get-Content -LiteralPath $studioConfigPath -Raw
        $studioConfigText = $studioConfigText -replace '(?ms)\r?\n\s*#?\s*MD5 checksum[^\r\n]*\s*$', ''
        $studioConfig = $studioConfigText | ConvertFrom-Json
        $accessCodeProperty = $studioConfig.access_code.PSObject.Properties[$env:BAMBU_PRINTER_SERIAL]
        if ($accessCodeProperty) {
            $env:BAMBU_ACCESS_CODE = [string]$accessCodeProperty.Value
        }
    }
}

Set-Content -LiteralPath $pidPath -Value $PID -Encoding ascii
Set-Location -LiteralPath $receiverRoot
try {
    & node.exe 'src/server.js' *>> $logPath
    if ($LASTEXITCODE -ne 0) { throw "Receiver exited with code $LASTEXITCODE" }
}
finally {
    if (Test-Path -LiteralPath $pidPath) {
        $recordedPid = (Get-Content -LiteralPath $pidPath -Raw).Trim()
        if ($recordedPid -eq [string]$PID) { Remove-Item -LiteralPath $pidPath -Force }
    }
}
