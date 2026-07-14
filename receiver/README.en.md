# Oshida Smartphone CAD Receiver

[日本語（正本）](README.md) | **English**

This is an advanced optional local-server bonus feature. It is not required for normal Oshida Smartphone CAD use. The GitHub Pages app works as a static web app without this receiver.

The receiver cannot run on GitHub Pages. It runs only on a local Windows PC, and no receiver button or receiver dependency is added to the public Pages app.

Do not expose this receiver directly to the internet. It is intended for private Tailscale access only.

## Purpose

The receiver accepts STL files generated on a phone and saves them on a Windows PC. Future print automation should be added behind `src/print-pipeline.js`, not in the upload handler.

Current scope:

- `POST /upload`
- raw STL body upload
- `Content-Type: model/stl` or `application/octet-stream`
- optional `X-Receiver-Token`
- local STL save
- Bambu Studio CLI slicing
- G-code output
- `result.json` check
- console logs
- optional LAN-mode G-code upload and print start

Automatic print start is disabled by default. Enable it only after confirming the target printer, material, bed, and model.

The receiver serializes uploads, checks the printer state before transfer, selects a matching AMS tray, and confirms that the printer actually reached `RUNNING`. A second request is rejected while another upload is being processed, and a new print is not sent while the printer reports a busy state such as `RUNNING` or `PAUSE`.

## Managed Start And Stop

Keep private settings in `%LOCALAPPDATA%\OshidaSmartphoneCadReceiver\receiver.json`. Copy `config.example.json` there as a starting point, replace the token and printer values, and do not commit that private file.

`RECEIVER_TOKEN` is optional. Set it to an empty string to rely only on Tailscale access control; the local print dialog then hides the token field. This PC uses that mode. The HTTPS URL is still reachable by other devices and users admitted to the same Tailnet, so keep Tailnet membership restricted and never enable Funnel.

These commands use absolute paths, so they work over SSH and from any current directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\projects\oshidasumaho_cad\receiver\scripts\start-receiver.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\projects\oshidasumaho_cad\receiver\scripts\status-receiver.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\projects\oshidasumaho_cad\receiver\scripts\stop-receiver.ps1"
```

The managed launcher always overrides `RECEIVER_HOST` to `127.0.0.1`. Runtime files are stored under `%LOCALAPPDATA%\OshidaSmartphoneCadReceiver`: `receiver.pid`, `receiver.log`, and the private `receiver.json`.

## Tailnet HTTPS

Keep the Node receiver bound to `127.0.0.1` and let Tailscale Serve terminate HTTPS. This exposes the receiver only inside the Tailnet and does not require changes to the GitHub Pages application.

Before the first use, open the Tailscale admin console DNS page, enable MagicDNS if needed, and enable **HTTPS Certificates**. Tailscale requires this one-time Tailnet consent before `tailscale serve` can provision a certificate. The consent notes that machine and Tailnet DNS names are recorded in the public certificate transparency ledger.

Start the receiver, then enable the HTTPS proxy once:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\projects\oshidasumaho_cad\receiver\scripts\start-receiver.ps1"

# Run in a second PowerShell window.
.\scripts\enable-tailscale-https.ps1
```

`tailscale serve status` prints the Tailnet HTTPS URL. Use that URL with `/upload`. Do not use `tailscale funnel`; Funnel publishes to the internet. To remove the proxy configuration, run `tailscale serve reset`.

The upload URL has this form: `https://<machine-name>.<tailnet-name>.ts.net/upload`.

## Local CAD And Print UI

Open `https://<machine-name>.<tailnet-name>.ts.net/` from a Tailnet device. The receiver redirects to the locally hosted Oshida Smartphone CAD screen. Its top-right menu includes **ローカル3Dプリント**, which can send either the current CAD model or a selected STL file to `/upload`.

The managed start command runs the Vite production build before launching the receiver. The receiver serves that build from `/oshidasumaho_cad/` on the same HTTPS origin as the upload API, so the browser does not need mixed HTTP/HTTPS access.

This menu item appears only when the same origin answers `/health` as an Oshida receiver. It is hidden on the public GitHub Pages site, where local printing is unavailable. Sending from the dialog starts the configured slicing and print pipeline; it is a real print command, not a preview.

The dialog supports job-specific layer heights of `0.08`, `0.12`, `0.16`, `0.20`, `0.24`, and `0.28` mm for the configured 0.4 mm nozzle profile, plus automatic support generation on/off. API clients can pass the same values with `X-Layer-Height` and `X-Enable-Support` headers. Defaults are `0.20` mm and support off.

Uploads are saved to `receiver/uploads/` by default. Override with:

```powershell
$env:RECEIVER_UPLOAD_DIR = "D:\oshidasumaho_uploads"
```

Sliced output is saved to `receiver/outputs/<upload-id>/` by default. Each job directory should contain Bambu Studio outputs such as:

- `plate_1.gcode`
- `result.json`

Override the output root with:

```powershell
$env:RECEIVER_OUTPUT_DIR = "D:\oshidasumaho_outputs"
```

The Bambu Studio executable path is read from `BAMBU_STUDIO_PATH`. If unset, the receiver uses:

```text
D:\bambu\Bambu Studio\bambu-studio.exe
```

## Tailscale

1. Install Tailscale on the Windows PC and the phone.
2. Sign in to the same Tailnet.
3. On the Windows PC, enable Tailscale Serve as described above.

```powershell
tailscale ip -4
```

4. Start this receiver on the Windows PC.
5. Send uploads to the Tailnet HTTPS URL.

Example URL:

```text
https://<machine-name>.<tailnet-name>.ts.net/upload
```

Example upload:

```powershell
curl.exe -X POST "https://<machine-name>.<tailnet-name>.ts.net/upload" `
  -H "Content-Type: model/stl" `
  -H "X-Receiver-Token: change-this-token" `
  --data-binary "@part.stl"
```

The response includes the upload metadata and slicing result. A successful pipeline has:

```json
{
  "pipeline": {
    "status": "sliced",
    "gcodeFiles": ["...plate_1.gcode"],
    "resultJson": {
      "returnCode": 0,
      "errorString": "Success."
    }
  }
}
```

## Optional Bambu LAN Print Start

This is an advanced option for a trusted home LAN or Tailscale-to-home workflow. Do not expose the receiver directly to the internet.

Bambu Studio CLI did not expose a confirmed print-start option on this PC. The receiver therefore keeps slicing and print delivery separate:

1. Bambu Studio CLI slices STL to `receiver/outputs/<upload-id>/plate_1.gcode`.
2. The receiver packages that G-code into a `.gcode.3mf` file using a known-good template.
3. If `BAMBU_AUTO_PRINT=1`, the receiver uploads the `.gcode.3mf` file to the printer over FTPS.
4. The receiver sends a LAN MQTT `project_file` print-start command to the target printer.

Required environment variables:

```powershell
$env:BAMBU_AUTO_PRINT = "1"
$env:BAMBU_PRINTER_HOST = "192.168.x.y"
$env:BAMBU_PRINTER_SERIAL = "your-printer-serial"
$env:BAMBU_PRINTER_NAME = "Bambu Lab X1 Carbon"
$env:BAMBU_ACCESS_CODE = "your-lan-access-code"
$env:BAMBU_GCODE_3MF_TEMPLATE = "C:\path\to\known-good-template.gcode.3mf"
```

Defaults:

```text
BAMBU_FTP_USER=bblp
BAMBU_FTP_PORT=990
BAMBU_MQTT_PORT=8883
BAMBU_STORAGE_ROOT=/sdcard
BAMBU_FTP_STORAGE_ROOT=
BAMBU_PYTHON_PATH=python
BAMBU_PRINT_COMMAND=project_file
BAMBU_PRINT_TEST_ONLY=1
BAMBU_BED_LEVELING=1
BAMBU_FLOW_CALI=0
BAMBU_VIBRATION_CALI=0
BAMBU_LAYER_INSPECT=0
BAMBU_USE_AMS=1
BAMBU_AMS_AUTO_SELECT=1
BAMBU_AMS_FILAMENT_TYPE=PLA
BAMBU_AMS_SLOT=
BAMBU_PRINT_CONFIRM_TIMEOUT_MS=45000
BAMBU_STATUS_POLL_MS=3000
```

With automatic AMS selection enabled, the receiver reads the live AMS report and prefers a matching `PLA Basic` tray. Set `BAMBU_AMS_SLOT` to a global tray number (`ams_id * 4 + slot_id`) to pin a specific slot. If a print pauses with Bambu error `03008004` (decimal `50364420`, filament unavailable), the receiver tries one different matching AMS tray and resumes the same job; it does not submit a second print job.

The upload response reports `print_started` only after the printer confirms `RUNNING`. `print_paused`, `print_unconfirmed`, or `print_skipped` indicate that no confirmed running print was observed. A busy printer returns `print_skipped` and its current status.

`BAMBU_GCODE_3MF_TEMPLATE` is required for the current `project_file` path. During testing, a `.gcode.3mf` file already present on the printer SD card was downloaded and used as the template; the receiver replaces `Metadata/plate_1.gcode` and its MD5 file before upload.

For X1 Carbon testing, Bambu Studio CLI required both the machine and process profiles:

```text
BAMBU_MACHINE_PROFILE=Bambu Lab X1 Carbon 0.4 nozzle
BAMBU_PROCESS_PROFILE=0.20mm Standard @BBL X1C
BAMBU_FILAMENT_PROFILE=Bambu PLA Basic @BBL X1C
```

The CLI did not reliably apply the filament profile in this environment, so the receiver currently post-processes generated G-code metadata for PLA and sets nozzle temperature to 220 C before packaging.

For X1 Carbon, the receiver resolves the Bambu machine profile includes into a temporary job-local machine profile before slicing. This is required so Bambu's standard start and end G-code are present, including nozzle wipe, bed leveling hooks, purge line, and flow calibration hooks. Automatic print start is skipped if those safety markers are missing from the generated G-code.

The Bambu printer's FTPS server requires TLS session reuse on the data connection. Windows `curl.exe` and Node's standard TLS client failed this requirement during testing, so the receiver uses `src/ftps-upload.py` for the FTPS upload step. The helper uses Python's standard library and reuses the control TLS session for file upload.

`BAMBU_PRINT_TEST_ONLY=1` is the default safety guard. With this guard enabled, the receiver only attempts automatic print start when the upload filename looks like a test file, such as `20mm-test-cube.stl`. Set `BAMBU_PRINT_TEST_ONLY=0` only after this experimental path is proven with your printer.

20mm test cube upload:

```powershell
curl.exe -X POST "http://127.0.0.1:8787/upload" `
  -H "Content-Type: model/stl" `
  -H "X-Receiver-Token: change-this-token" `
  -H "X-Filename: 20mm-test-cube.stl" `
  --data-binary "@receiver\examples\20mm-test-cube.stl"
```

The logs print the target printer name, host, serial, uploaded remote G-code path, and whether the print-start command was sent.

## Bambu Studio CLI Check

This PC has Bambu Studio installed at:

```text
D:\bambu\Bambu Studio\bambu-studio.exe
```

Observed on Bambu Studio `02.07.01.57`:

- `--help` and `-h` returned exit code 0 but printed no console help.
- `--slice=0 --outputdir <dir> <stl>` worked when paths did not contain spaces, producing `plate_1.gcode` and `result.json`. The receiver stores uploaded STL files and output directories under paths without spaces by default.
- `--load-settings <json>` worked with hyphenated option spelling.
- `--load_settings <json>` failed with exit code `-2`.
- `--export_3mf=output.3mf` failed with exit code `-2` in the tested form.
- No Bambu Studio CLI option was confirmed for print start. Official Bambu Studio source shows GUI print start going through `PrintJob` and the networking plugin (`start_local_print`, `start_local_print_with_record`, `start_send_gcode_to_sdcard`), not a public CLI print command.
