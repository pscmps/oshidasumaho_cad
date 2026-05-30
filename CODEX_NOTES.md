# Codex作業メモ: オシダスマホキャド

## 現状

このリポジトリは、スマホ向け軽量CAD「オシダスマホキャド」のGitHub Pages / React試作用です。

ChatGPT上のGitHub連携から以下を追加済みです。

- `index.html`
  - 旧Hello Worldページのまま残っている可能性が高いです。
  - React/Vite入口用に差し替える必要があります。
- `package.json`
  - React + Vite用の最小設定を追加済み。
- `src/main.jsx`
  - Reactの初期Appを追加済み。
- `src/style.css`
  - スマホ画面を意識した上下2分割風の初期スタイルを追加済み。

GitHub Pagesはpublic repo化して有効化済みの想定です。

## 注意

ChatGPTのGitHub連携から複数ファイルをまとめて更新するのは手間が大きく、既存ファイル更新が安全チェックで止まることがありました。
そのため、以降はCodexでまとめて整える方針がよいです。

## まずやること

1. リポジトリをcloneまたはCodexで開く。
2. `npm install` を実行。
3. `index.html` をVite標準の入口に差し替える。
4. `vite.config.js` を追加して、GitHub Pagesのサブパス `/oshidasumaho_cad/` に対応させる。
5. GitHub Actions workflowを追加して、`main` push時にVite buildしてPagesへdeployする。
6. `npm run build` が通ることを確認する。

## index.html 差し替え案

```html
<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>オシダスマホキャド</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

## vite.config.js 案

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/oshidasumaho_cad/',
});
```

## GitHub Actions案

`.github/workflows/deploy.yml` を追加。

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm install

      - name: Build
        run: npm run build

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

GitHub Pages設定は、Actionsからdeployする場合、Settings → Pages → Build and deployment の Source を `GitHub Actions` にする。

## 当面の開発方針

最初からReact + Viteで進める。
素のHTML/JSプロトは後で捨てることになりそうなので、ここからはReact前提で作る。

第一段階は、CAD本体というよりUI/データ構造の確認を優先する。

- 上半分: ビューア領域
- 下半分: 編集UI
- 図形はまず四角と円のみ
- 図形は直接ドラッグしない
- 下UIで座標、サイズ、add/cut、順序を編集
- 上ビューアでは選択と表示確認のみ
- 内部データはJSONで保持
- 保存はまずlocalStorageでよい

## 仕様の重要ポイント

オシダスマホキャドは一般的なスケッチCADではない。
線を引かず、図形を配置して、ブール演算と押し出しで形を作る。
スマホ操作向けに、直接ドラッグ編集や拘束ベースのスケッチは避ける。

最初のゴールは、GitHub Pages上で動くReactアプリとして、四角と円を数値入力で追加・編集できる状態にすること。
