# JmaEewParser

React + TypeScript + Vite app for selecting historical JMA Earthquake Early Warning (warning) cases, importing official public-history HTML in the browser, and exporting historical EEW warning reports in a Wolfx JMA EEW-style JSON shape.

## Run locally

```bash
npm install
npm run dev
```

## Data import

1. Try loading the official warning-history page: https://www.data.jma.go.jp/eew/data/nc/pub_hist/index.html
2. If cross-origin access is blocked, save the official index page as HTML and import it in the app.
3. Select a case and load its detail page, or import a saved detail HTML file.
4. Inspect the generated JSON before downloading it. Fields that cannot be verified from the imported HTML remain null, and source text is preserved in OriginalText.

The initial parser is conservative and requires verification against the official page. JMA page structures vary by historical period; this app is for historical study, not real-time emergency use.

## MeteoQuake用の出力(v0.4.0 / JSON 1.2.0)

解析結果のJSONには、従来のフィールドに加えて `normalized` を出力します(既存の `event` / `reports` は変更なし)。
緯度経度・深さ・Mの数値化、発表時刻の絶対時刻化(日付またぎ対応)、予想震度の震度キー化(`5-`=5弱 など)を行い、
抽出できなかった項目は推測せず `normalized.warnings` に出します。保存するファイル名は `YYYYMMDD_震央名M規模.eew.json` です。

- サーバーは不要です(ブラウザだけで動作します)。気象庁のページをブラウザから直接取得できない場合は、保存したHTMLを読み込みます。
- 対象は気象庁が公開している緊急地震速報(警報)の事例のみです。予報だけの事例は含まれません。
- `replay.html` は、このJSONだけでEEWの単体再生ができます(強震モニタのデータは不要)。

```bash
npm test   # 正規化ロジックの単体テスト(Node 22.6+)
```

GitHub Pagesへは `.github/workflows/deploy.yml` で自動公開されます。
