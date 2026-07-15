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

WebアプリのGitHub Pages版へAdd-inを組み込む方式ではありません。Web版で保存したJSONファイルを、Fusionが動いているPCで選択して使用します。

## 形状生成の考え方

単純に上面図だけを押し出すのではなく、3面それぞれから押し出しボディを作ります。

- 上面: 幅 x 奥行きを高さ方向へ押し出す
- 正面: 幅 x 高さを奥行き方向へ押し出す
- 右側面: 奥行き x 高さを幅方向へ押し出す

各面ではJSONの図形順に `add` / `cut` をFusionのブーリアンで反映します。その後、3つの面由来ボディを `Intersect` して、3面すべてに合う形だけを残します。

この方式は、オシダスマホキャド本体の3DプレビューやSTEP生成と同じ発想です。

平歯車、ラックギヤ、内歯車はWeb版と同じ20度圧力角の輪郭計算をPythonへ移植しています。Fusion上では外形を押し出し、平歯車の中央穴や内歯車の内側輪郭を別の切削フィーチャーとして作成します。

## 対応図形

- `rect`: 四角形
- `circle`: 円
- `gear`: 平歯車と中央穴
- `rack`: 0/90/180/270度のラックギヤ
- `internalGear`: 内歯車

未対応の図形種別や新しすぎる `schemaVersion` は、形状を黙って欠落させずエラーとして表示します。

## 開発時の確認

JSON検証、寸法計算、歯形輪郭はFusion APIから分離しているため、通常のPythonでテストできます。

```bash
python3 -m unittest discover -s fusion_addin/tests -v
python3 -m py_compile \
  fusion_addin/OshidaSmartphoneCadImporter/OshidaSmartphoneCadImporter.py \
  fusion_addin/OshidaSmartphoneCadImporter/oshida_model.py
```

リポジトリの `examples/` にある四角・円、平歯車、ラックギヤ、内歯車のJSONをテスト対象にしています。

## 現時点の制限

- 上面・正面・右側面の3面に、寸法を決められる `add` 図形が必要です。
- 複雑な接線、ゼロ厚み、完全に重なる面ではFusion側のブーリアンが失敗する可能性があります。
- スケッチ、押し出し、切削、結合、交差は履歴に残りますが、各寸法はまだFusionのユーザーパラメータと連動していません。
- ギヤ系の歯形は編集可能な直線分割スケッチです。モジュールや歯数をFusion上で変更して自動再生成する機能は未対応です。
- Add-inはFusion上での動作確認が必要です。リポジトリ側ではPython構文チェックまで行います。

## ライセンス上の考え方

F3Dの独自生成やファイル形式の解析は行いません。Fusionの公開Python APIを使い、ユーザー環境のFusion上でモデルを構築します。
