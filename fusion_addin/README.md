# Fusion Add-in

`OshidaSmartphoneCadImporter` は、オシダスマホキャドのJSONをFusionで読み込み、Fusion側のソリッドとして再構築するためのPython Add-inです。

F3Dを直接書き出すのではなく、FusionのPython APIでJSONから形状を作ります。ユーザーはFusion上で通常どおり保存すれば、Fusionのネイティブデータとして扱えます。

## インストール

このフォルダをFusionのAdd-insフォルダへコピーします。

コピー元:

```text
fusion_addin/OshidaSmartphoneCadImporter
```

コピー先の例:

```text
Windows: %appdata%\Autodesk\Autodesk Fusion\API\AddIns\OshidaSmartphoneCadImporter
macOS: ~/Library/Application Support/Autodesk/Autodesk Fusion/API/AddIns/OshidaSmartphoneCadImporter
```

Fusionを再起動し、`Utilities > Scripts and Add-Ins > Add-Ins` から `OshidaSmartphoneCadImporter` を実行します。

## 使い方

1. オシダスマホキャドでJSONを出力します。
2. Fusionで `Import Oshida CAD JSON` を実行します。
3. JSONファイルを選択します。
4. 上面・正面・右側面の3面情報から、Fusion内にソリッドが作成されます。

## 形状生成の考え方

単純に上面図だけを押し出すのではなく、3面それぞれから押し出しボディを作ります。

- 上面: 幅 x 奥行きを高さ方向へ押し出す
- 正面: 幅 x 高さを奥行き方向へ押し出す
- 右側面: 奥行き x 高さを幅方向へ押し出す

各面ではJSONの図形順に `add` / `cut` をFusionのブーリアンで反映します。その後、3つの面由来ボディを `Intersect` して、3面すべてに合う形だけを残します。

この方式は、オシダスマホキャド本体の3DプレビューやSTEP生成と同じ発想です。

## 現時点の制限

- 対応図形は `rect` と `circle` のみです。
- 上面・正面・右側面の3面に、寸法を決められる `add` 図形が必要です。
- 複雑な接線、ゼロ厚み、完全に重なる面ではFusion側のブーリアンが失敗する可能性があります。
- 初期版ではFusion上の履歴をきれいな編集履歴として整理するところまでは行っていません。
- Add-inはFusion上での動作確認が必要です。リポジトリ側ではPython構文チェックまで行います。

## ライセンス上の考え方

F3Dの独自生成は行いません。Fusionの公開Python APIを使い、ユーザー環境のFusion上でモデルを構築します。
