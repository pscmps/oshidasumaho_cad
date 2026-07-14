# オシダスマホキャド ローカルSTL受信機

**日本語（正本）** | [English](README.en.md)

これは上級者向けの任意のローカルサーバー機能です。通常のオシダスマホキャド利用には必要ありません。GitHub Pages版は、この受信機がなくても静的Webアプリとして動作します。

受信機はGitHub Pages上では動作しません。ローカルのWindows PCで起動した場合だけ動作し、公開中のPagesアプリには受信機ボタンも依存関係も追加されません。

受信機をインターネットへ直接公開しないでください。非公開のTailscaleアクセス専用です。

## 目的

スマートフォンで生成したSTLファイルを受け取り、Windows PCへ保存します。今後印刷処理を拡張する場合は、アップロード処理へ直接追加せず、`src/print-pipeline.js`より後段へ実装します。

現在の対応範囲：

- `POST /upload`
- STL本体の直接アップロード
- `Content-Type: model/stl`または`application/octet-stream`
- 任意の`X-Receiver-Token`
- ローカルへのSTL保存
- Bambu Studio CLIによるスライス
- G-code出力
- `result.json`の確認
- コンソールログ
- 任意のLANモードG-code転送と印刷開始

自動印刷開始は初期状態で無効です。対象プリンター、材料、ビルドプレート、モデルを確認してから有効にしてください。

受信機はアップロードを直列処理し、転送前にプリンター状態を確認し、条件に合うAMSトレイを選択して、実際に`RUNNING`へ移行したことを確認します。別のアップロードを処理中は2件目を拒否し、プリンターが`RUNNING`や`PAUSE`などの使用中状態を返した場合は新しい印刷を送りません。

## 管理された起動と停止

非公開設定は`%LOCALAPPDATA%\OshidaSmartphoneCadReceiver\receiver.json`へ保存します。`config.example.json`をひな形としてコピーし、トークンとプリンター情報を書き換えてください。この非公開ファイルはコミットしないでください。

`RECEIVER_TOKEN`は任意です。空文字列にするとTailscaleのアクセス制御だけを使用し、ローカル印刷ダイアログではトークン入力欄を非表示にします。HTTPS URLには同じTailnetへ参加している他の端末やユーザーもアクセスできるため、Tailnetの参加者を制限し、Funnelは有効にしないでください。

次のコマンドは絶対パスを使うため、SSH接続中を含む任意のカレントディレクトリから実行できます。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\projects\oshidasumaho_cad\receiver\scripts\start-receiver.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\projects\oshidasumaho_cad\receiver\scripts\status-receiver.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\projects\oshidasumaho_cad\receiver\scripts\stop-receiver.ps1"
```

管理スクリプトは`RECEIVER_HOST`を常に`127.0.0.1`へ上書きします。実行時ファイルの`receiver.pid`、`receiver.log`、非公開の`receiver.json`は`%LOCALAPPDATA%\OshidaSmartphoneCadReceiver`へ保存されます。

## Tailnet HTTPS

Node受信機は`127.0.0.1`へバインドしたままにし、Tailscale ServeでHTTPSを終端します。これにより受信機はTailnet内だけへ公開され、GitHub Pagesアプリを変更する必要もありません。

初回利用前にTailscale管理画面のDNSページを開き、必要に応じてMagicDNSを有効化し、**HTTPS Certificates**を有効にしてください。`tailscale serve`が証明書を発行するには、このTailnet単位の同意が一度必要です。同意画面には、端末名とTailnet DNS名が公開Certificate Transparencyログへ記録されることが記載されています。

受信機を起動し、HTTPSプロキシを一度有効にします。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\projects\oshidasumaho_cad\receiver\scripts\start-receiver.ps1"

# 2つ目のPowerShellウィンドウで実行します。
.\scripts\enable-tailscale-https.ps1
```

`tailscale serve status`でTailnet HTTPS URLを確認し、そのURLへ`/upload`を付けて使用します。`tailscale funnel`はインターネットへ公開するため使用しないでください。プロキシ設定を削除する場合は`tailscale serve reset`を実行します。

アップロードURLの形式：

```text
https://<端末名>.<Tailnet名>.ts.net/upload
```

## ローカルCADと印刷UI

Tailnet内の端末から`https://<端末名>.<Tailnet名>.ts.net/`を開きます。受信機はローカルでホストしたオシダスマホキャド画面へリダイレクトします。右上のメニューには**ローカル3Dプリント**が追加され、現在のCADモデルまたは選択したSTLファイルを`/upload`へ送信できます。

管理された起動コマンドは、受信機を起動する前にViteの本番ビルドを実行します。受信機はアップロードAPIと同じHTTPSオリジンの`/oshidasumaho_cad/`からビルド結果を配信するため、ブラウザでHTTPとHTTPSを混在させる必要はありません。

同一オリジンの`/health`がオシダスマホキャド受信機として応答した場合だけ、このメニュー項目が表示されます。ローカル印刷を利用できない公開GitHub Pages版では非表示です。ダイアログからの送信は、設定済みのスライスと印刷処理を実際に開始します。プレビューではありません。

設定済みの0.4 mmノズル用プロファイルに対して、ジョブごとに`0.08`、`0.12`、`0.16`、`0.20`、`0.24`、`0.28` mmのレイヤー高さと、自動サポート生成のオン・オフを選択できます。APIクライアントは`X-Layer-Height`と`X-Enable-Support`ヘッダーで同じ値を指定できます。初期値は`0.20` mm、サポートなしです。

アップロードされたファイルは初期状態で`receiver/uploads/`へ保存されます。変更する場合：

```powershell
$env:RECEIVER_UPLOAD_DIR = "D:\oshidasumaho_uploads"
```

スライス結果は初期状態で`receiver/outputs/<upload-id>/`へ保存されます。各ジョブのディレクトリには、次のようなBambu Studio出力が生成されます。

- `plate_1.gcode`
- `result.json`

出力先のルートを変更する場合：

```powershell
$env:RECEIVER_OUTPUT_DIR = "D:\oshidasumaho_outputs"
```

Bambu Studioの実行ファイルは`BAMBU_STUDIO_PATH`から読み込みます。未設定の場合：

```text
D:\bambu\Bambu Studio\bambu-studio.exe
```

## Tailscaleの設定手順

1. Windows PCとスマートフォンへTailscaleをインストールします。
2. 両方を同じTailnetへ参加させます。
3. 前述の手順でWindows PCのTailscale Serveを有効にします。

```powershell
tailscale ip -4
```

4. Windows PCで受信機を起動します。
5. Tailnet HTTPS URLへアップロードします。

URLの例：

```text
https://<端末名>.<Tailnet名>.ts.net/upload
```

アップロード例：

```powershell
curl.exe -X POST "https://<端末名>.<Tailnet名>.ts.net/upload" `
  -H "Content-Type: model/stl" `
  -H "X-Receiver-Token: change-this-token" `
  --data-binary "@part.stl"
```

レスポンスにはアップロード情報とスライス結果が含まれます。正常にスライスできた場合の例：

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

## 任意のBambu LAN印刷開始

信頼できる自宅LAN、またはTailscale経由で自宅へ接続する場合だけ使用する上級者向け機能です。受信機をインターネットへ直接公開しないでください。

この環境のBambu Studio CLIでは、印刷開始に使えることを確認できたオプションがありませんでした。そのため、受信機ではスライスと印刷データ転送を分けて処理します。

1. Bambu Studio CLIでSTLを`receiver/outputs/<upload-id>/plate_1.gcode`へスライスします。
2. 動作確認済みのテンプレートを使い、G-codeを`.gcode.3mf`へパッケージします。
3. `BAMBU_AUTO_PRINT=1`の場合、`.gcode.3mf`をFTPSでプリンターへアップロードします。
4. LAN MQTTの`project_file`コマンドを対象プリンターへ送り、印刷を開始します。

必要な環境変数：

```powershell
$env:BAMBU_AUTO_PRINT = "1"
$env:BAMBU_PRINTER_HOST = "192.168.x.y"
$env:BAMBU_PRINTER_SERIAL = "your-printer-serial"
$env:BAMBU_PRINTER_NAME = "Bambu Lab X1 Carbon"
$env:BAMBU_ACCESS_CODE = "your-lan-access-code"
$env:BAMBU_GCODE_3MF_TEMPLATE = "C:\path\to\known-good-template.gcode.3mf"
```

初期値：

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

AMS自動選択を有効にすると、受信機は現在のAMS情報を読み、条件に合う`PLA Basic`トレイを優先します。特定のスロットへ固定する場合は、`BAMBU_AMS_SLOT`にグローバルトレイ番号（`ams_id * 4 + slot_id`）を設定します。Bambuエラー`03008004`（10進数`50364420`、フィラメント利用不可）で印刷が一時停止した場合は、条件に合う別のAMSトレイを一度だけ試して同じジョブを再開します。2件目の印刷ジョブは送信しません。

アップロードレスポンスが`print_started`になるのは、プリンターが`RUNNING`を返したことを確認した後だけです。`print_paused`、`print_unconfirmed`、`print_skipped`は、実行中の印刷を確認できなかったことを示します。プリンターが使用中の場合は、現在の状態とともに`print_skipped`を返します。

現在の`project_file`方式では`BAMBU_GCODE_3MF_TEMPLATE`が必要です。動作確認では、プリンターのSDカードに保存されていた`.gcode.3mf`を取得してテンプレートに使用しました。受信機はアップロード前に`Metadata/plate_1.gcode`とそのMD5ファイルを置き換えます。

X1 Carbonでの確認では、Bambu Studio CLIに機種プロファイルとプロセスプロファイルの両方が必要でした。

```text
BAMBU_MACHINE_PROFILE=Bambu Lab X1 Carbon 0.4 nozzle
BAMBU_PROCESS_PROFILE=0.20mm Standard @BBL X1C
BAMBU_FILAMENT_PROFILE=Bambu PLA Basic @BBL X1C
```

この環境ではCLIがフィラメントプロファイルを安定して適用しなかったため、現在の受信機は生成されたG-codeのPLA用メタデータを後処理し、パッケージ前にノズル温度を220 Cへ設定します。

X1 Carbonでは、スライス前にBambu機種プロファイルのincludeを解決し、ジョブ専用の一時機種プロファイルを作ります。ノズル清掃、ベッドレベリング、パージライン、流量校正など、Bambu標準の開始・終了G-codeを含めるために必要です。生成したG-codeにこれらの安全用マーカーがない場合、自動印刷開始を中止します。

BambuプリンターのFTPSサーバーは、データ接続でTLSセッションを再利用する必要があります。Windowsの`curl.exe`とNode標準TLSクライアントでは、この要件を満たせませんでした。そのため受信機はFTPSアップロードに`src/ftps-upload.py`を使います。この補助スクリプトはPython標準ライブラリだけを使い、ファイル転送時に制御接続のTLSセッションを再利用します。

`BAMBU_PRINT_TEST_ONLY=1`は初期状態の安全制限です。有効な間は、`20mm-test-cube.stl`などテスト用に見えるファイル名の場合だけ自動印刷開始を試みます。この実験的な経路を使用するプリンターで動作確認してから、`BAMBU_PRINT_TEST_ONLY=0`へ変更してください。

20 mmテストキューブのアップロード例：

```powershell
curl.exe -X POST "http://127.0.0.1:8787/upload" `
  -H "Content-Type: model/stl" `
  -H "X-Receiver-Token: change-this-token" `
  -H "X-Filename: 20mm-test-cube.stl" `
  --data-binary "@receiver\examples\20mm-test-cube.stl"
```

ログには対象プリンター名、ホスト、シリアル番号、アップロード先のG-codeパス、印刷開始コマンドを送信したかどうかが記録されます。

## Bambu Studio CLIの確認結果

この環境で使用したBambu Studioの場所：

```text
D:\bambu\Bambu Studio\bambu-studio.exe
```

Bambu Studio `02.07.01.57`で確認した結果：

- `--help`と`-h`は終了コード0でしたが、コンソールへヘルプを表示しませんでした。
- パスに空白がない場合、`--slice=0 --outputdir <dir> <stl>`で`plate_1.gcode`と`result.json`を生成できました。受信機は初期状態で、アップロードSTLと出力先を空白のないパスへ保存します。
- ハイフン区切りの`--load-settings <json>`は動作しました。
- アンダースコア区切りの`--load_settings <json>`は終了コード`-2`で失敗しました。
- 確認した形式の`--export_3mf=output.3mf`は終了コード`-2`で失敗しました。
- 印刷開始に使えるBambu Studio CLIオプションは確認できませんでした。Bambu Studio公式ソースでは、GUIからの印刷開始に`PrintJob`とネットワークプラグイン（`start_local_print`、`start_local_print_with_record`、`start_send_gcode_to_sdcard`）を使用しており、公開CLIコマンドは使用していません。
