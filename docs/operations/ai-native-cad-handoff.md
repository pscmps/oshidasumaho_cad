# AI-native CAD 運用・検証引継ぎ

## 対象と公開状態

- 対象ブランチ: `feat/ai-native-cad-foundation`（pscmps/oshidasumaho_cad）。main・元のスマホCAD・GitHub Pagesは対象外。
- 対象Site: https://oshida-ai-native-lab.pscmps-mechatro.chatgpt.site
- Site project: `appgprj_6abe87fa3e3481919fe3e891c4e6f082`。owner-privateを維持。新しいSiteや複製リポジトリを作らない。
- 夜間の実装修正commit: `91e14a6a77a13d3913f71fa802c6515439011df8`。
- 対応するSitesソースcommit: `b0ec0a01a0ea237a668ae7b8bb0b5800f893f5ec`。
- 公開成功: 2026-10-02 17:22:26 UTC、version 13。deployment `appgdep_6abfe84801a88191bc4912c7e87fb671`。
- このメモ追加はdocsのみ。実装commit以後のdocsだけのcommitにSite再公開は不要。

## 2026-10-02夜間の修正

1. 依頼の閲覧停止と取消を分離。別依頼への切替やタブの終了だけで保存済み依頼を取り消さない。明示取消の失敗は未確認として表示。
2. Webhookの補助的なqueue/配送状態読取り障害が、保存済み回答を隠さない。主ストレージの障害は秘密を含まない503。GETのみ200/400/800msで最大3回再試行し、POSTは自動再送しない。
3. 取消と回答保存の競合は最大3回のCASで処理。新しく届いた回答を捨てずに取消を記録。既取消の再取消は書込みを増やさない。
4. 適用の連打、評価中の取消、別依頼へ移る操作が遅れてモデルを書き換えない。requestIdの適用履歴を文書へ保持し、再読込から同じ提案を二重適用しない。Undoは履歴も元に戻して保存する。
5. 自動保存・適用・Undoが同じWeb Lockと保存前比較を使う。他タブの新しい保存内容、壊れた既存データ、未来版文書を無言で上書きしない。
6. 編集提案も自動で立体画面を開く。現在形状は青、提案は黄と表示。WebhookのURLには該当cadRequestを含める。

仕様と安全境界の詳細は [mcp-events.md](../architecture/mcp-events.md)。新しいLLM API・APIキー・課金サービスは追加していない。

## 検証結果

- Node全体テスト: **163件成功**（154トップレベル、9サブケース）、失敗・skipなし。
- Sites用client/Workerビルド成功。
- 実際の保存依頼データをローカルだけで使い、元スケッチあり／保存なし／編集済み／通常URLから選択、4条件の形状表示を確認。元文書の変更・新規送信なし。
- 質問→明示補足→同じ依頼のrevision 2→未適用プレビュー→再読込の回帰成功。
- Edgeで適用連打→再読込、適用直後取消、Apply→Undo→reload、2タブの上書き防止、編集提案の3D表示、壊れた保存データ保持、6シナリオ成功。ゴースト生成完了を待ってスクリーンショットを確認。
- 再実行可能な6シナリオは `scripts/cad-exchange-browser-smoke.py`。合成fixtureも成功。実ユーザーfixtureや認証情報はリポジトリへ含めない。
- 公開後、認証済みMCPで提案revision 2・commands 1件・取消なしを再確認。購読1件有効。公開範囲はownerのみ、外部閲覧者0。
- mainの比較値: `dec3f78f0c025582368367d6d2699504ab19ce21`（変更なし）。

## ローカル再検証

依存関係が準備された既存checkoutで実行する。ブラウザ検証にはPythonのplaywrightとChromium系ブラウザが必要。Windowsでは既存Edgeを検出し、別の実行ファイルはCAD_BROWSER環境変数で指定できる。

```powershell
npm test
$env:VITE_SITE_CODEX = '1'
$env:VITE_AI_NATIVE_START = '1'
node scripts/build-site.mjs
node scripts/preview-site.mjs 4199
```

別ターミナルで:

```powershell
python scripts/cad-exchange-browser-smoke.py --base-url http://127.0.0.1:4199/
```

ブラウザテストはループバックURLのみ許可。既定では合成依頼を利用する。`--fixture`にはread_cad_requestの本文objectをローカルJSONとして渡せる（今回の環状柱の回帰用）。`--output-dir`で画像保存先を指定でき、省略時は一時フォルダーへ保存する。Site本番にはこのテストを向けない。

## 本番の確認手順

1. 既存Siteのowner-private状態と対象projectを確認する。
2. 専用CADプラグインのget_cad_connection_statusを読む。2026-10-02の確認時点では購読1件、refreshBeforeは2026-10-03 15:36:55 UTC。これは観測値なので後日の確認で更新する。
3. 親dotが既存automationを確認する。成功不明な作成を繰り返さず、重複を作らない。購読前に送った依頼はreplayされない。
4. 新たな実ユーザー依頼の検証を行うなら、購読を確認してからユーザーが明示送信する。Workerの保存201、Webhook/dot実行、同じrequestIdの提案保存、ブラウザの形状表示を別々に確認する。
5. 既存依頼は同Siteの`?ai=1&cadRequest=<requestId>`、または「保存済みの依頼・提案を開く」から確認する。再送で代用しない。元スケッチがない/違う場合も保存時点の提案は表示し、適用はガードする。

## 残る確認と限界

- **ユーザー本人の実画面で、新版の形状が見えるかは未確認。** ローカルの実データ再現と本番保存成功を、本人画面の成功とは扱わない。ログイン操作を代理で行わない。
- ローカルブラウザでの適用だけを試験した。本番のモデル適用、新しい本番依頼送信、追加automation作成、実機印刷は実施していない。
- 今回以前のクライアントで適用した文書には適用receiptがない。その過去の適用を推測で補完しない。
- Web Locks非対応ブラウザでは保存前比較のみ。同等のタブ間原子性は保証しない。タブ間の共同編集やマージは実装していない。
- ブラウザ保存が壊れている場合は上書きを止める。既存データを退避・確認してから人が復旧方法を決める。自動削除や初期化はしない。
- Webhookは最大3回の再送と保存済みoutbox。独立scheduler/queueはなく、途中中断からの復帰は認証済み画面ポーリングに依存する。
- ビルドの大きなWASM/JSチャンク警告は残る。形状カーネル由来で、今回の不具合修正では構成変更しなかった。

## 購読期限と自動更新の確認（2026-10-02）

結論: `2026-10-03T15:36:55.013Z` は現在の購読leaseの失効時刻。サービスの利用契約終了日でも、自動化の総実行期間の上限でもない。翌日以降の継続はChatGPTからの期限前更新を前提とする。現実装は更新に対応しているが、本番で最初の自動更新が成功したことはまだ確認できていない。

### 公式仕様と実装

- [OpenAI MCP Events / Refresh a subscription](https://developers.openai.com/plugins/build/mcp-events#refresh-a-subscription) は、ChatGPTが `refreshBefore` より前に、同じ購読identityと保存済みcursorで `events/subscribe` を再実行すると明記している。具体的な更新時刻、余裕時間、更新障害時の再試行保証は、この公開仕様には記載されていない。
- 同仕様はTTL省略時のサーバー既定値、有限TTLの交渉、`ttlMs: null`への有限期間の応答を許容する。[MCP Events draft / Subscription TTL](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md#subscription-ttl) もクライアントの更新責任を定める。24時間と7日はこのCAD実装の設定であり、プロトコル共通の期間上限ではない。
- `src/cad-events.js` は既定24時間、1回の最大7日、nullも24時間。認証済み `events/subscribe` とcallback検証が成功して初めて `expiresAt = now + duration` を保存し、その値を `refreshBefore` として返す。
- 有効期間内の更新は同じID・1件の購読を維持し、既存の作成時刻とgenerationを保持する。保存済み購読はWorker再起動後もR2から読み出せる。期限を過ぎると新規queueと送信直前の検査で配信を停止する。状態の読取り、画面ポーリング、イベント受信だけでは期間は延長されない。
- 失効後の再購読は新しいgenerationになり、旧outboxを再開しない。`cursor: null`でreplay非対応のため、購読切れの間に発生した依頼は更新だけでは自動通知されない。保存済み依頼自体の読取りは別経路で可能。

### 実証の範囲

- 2026-10-02 17:33 UTCの本番read-only確認: `connected: true`, `subscriptions: 1`, `refreshBefore: 2026-10-03T15:36:55.013Z`。初回の観測値からまだ進んでいない。よって「公式に自動更新する設計」と「この購読の本番更新成功」を区別する。期限前の同値だけで更新失敗とは判定しない。
- 取得できた最近のSiteログは15件（17:22〜17:23 UTC）で、更新成功を示す記録は含まれなかった。これは全期間の更新試行不存在を証明しない。callback URL・secret・認証情報は調査記録へ保存していない。
- 仮想時計のローカル回帰5ケースを追加。TTL既定/上限/null、期限前更新後に旧期限を越えて再起動・配信成功、期限ちょうどで停止、失効後の再購読で旧通知を復活させないこと、更新時のcallback検証失敗で旧期限を延長しないことを検証。イベント関連テストは **16/16成功**。先の全体163件成功とは別の追加確認であり、ChatGPT側schedulerの実証ではない。
- 本番の購読・secret・TTL・automationは変更していない。追加物はテストとこの記録のみ。実装不具合は今回の期限確認では見つからず、Site再公開は不要。

### 朝の報告と次回の観測

ベトナム10月3日10:00は03:00 UTCで、今回の期限（同日22:36:55ベトナム時間）より12時間以上前。朝に期限がまだ同値でも、失敗確定とは報告しない。「更新対応済み、初回本番更新は未観測」と伝える。

親dotは必要時に既存automationの有効状態と `get_cad_connection_status` を読み、期限が先へ進んだことを更新の証拠にする。automationがenabledであることだけでは更新成功の証拠にならない。期限後も未更新なら、自動起動の継続は未成立として既存購読の更新経路を調査する。購読・automationを重複作成したり、secret再発行・TTL延長・無期限化で代用したりしない。観測用の新たなスケジュールは今回作成していない。
