import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const example = `{
  "schemaVersion": "1.2.0",
  "source": {
    "provider": "気象庁",
    "indexUrl": "https://www.data.jma.go.jp/eew/data/nc/pub_hist/index",
    "detailUrl": "https://www.data.jma.go.jp/eew/data/nc/pub_hist/...",
    "retrievedAt": "2026-10-20T08:00:00.000Z",
    "parserVersion": "0.3.0"
  },
  "event": {
    "id": "jma-202608230200-0",
    "occurredAt": "2026-08-23T02:00:00+09:00",
    "hypocenterName": "茨城県南部",
    "latitude": "36.1",
    "longitude": "139.9",
    "depth": "50 km",
    "magnitude": "5.9",
    "observedMaximumIntensity": "５弱"
  },
  "reports": [
    {
      "reportNumber": 1,
      "elapsedSeconds": 0,
      "providedAt": "02時00分50秒",
      "forecastReference": "※1",
      "forecastIntensityByArea": [
        { "area": "茨城県南部", "expectedMaximumIntensity": "from4to5弱" }
      ],
      "forecastLongPeriodByArea": [
        { "area": "茨城県南部", "expectedLongPeriodClass": 1 }
      ],
      "sourceTable": 2,
      "sourceRow": 3
    }
  ],
  "sourceTables": [],
  "metadata": {
    "conversionMode": "html",
    "convertedAt": "2026-10-20T08:00:00.000Z",
    "parsedTableCount": 3,
    "notes": []
  }
}`;

function SchemaPage() {
  return <div className="docs-layout">
    <aside className="docs-sidebar">
      <a className="docs-brand" href="./"><span className="docs-brand-mark">J</span><span>JmaEewParser<small>DEVELOPER DOCS</small></span></a>
      <div className="docs-nav-label">ドキュメント</div>
      <a className="docs-nav-link" href="./">変換ツール <span>↗</span></a>
      <a className="docs-nav-link active" href="./schema.html"><span className="nav-dot"></span>JSON仕様</a>
      <div className="docs-nav-label docs-nav-spaced">JSONリファレンス</div>
      <a className="docs-sub-link" href="#overview">データ構造</a>
      <a className="docs-sub-link" href="#fields">フィールド一覧</a>
      <a className="docs-sub-link" href="#intensity">予想震度の形式</a>
      <a className="docs-sub-link" href="#example">JSONサンプル</a>
      <a className="docs-sub-link" href="#notes">利用上の注意</a>
      <div className="docs-sidebar-bottom"><span className="docs-status-dot"></span>公開履歴データ用<br/><small>JSON FORMAT · v1.2.0</small></div>
    </aside>
    <main className="schema-main">
      <header className="docs-topbar"><div className="docs-breadcrumb">ドキュメント <span>/</span> JSON仕様</div><a href="./">アプリに戻る <span>↗</span></a></header>
      <div className="schema-content">
    <section className="docs-hero">
      <div className="docs-kicker"><span>DATA FORMAT</span><span className="version-pill">v1.2.0</span></div>
      <h1>JSON仕様</h1>
      <p>JmaEewParserが出力するJSONのデータ構造、各フィールドの型と意味をまとめたリファレンスです。</p>
      <div className="docs-hero-meta"><span><i></i>日本語ドキュメント</span><span>最終更新：2026-10-20</span></div>
    </section>
    <section id="overview" className="panel schema-panel">
      <div className="panel-title"><div><p className="eyebrow">OVERVIEW</p><h3>トップレベル構造</h3></div><span className="tag">JSON</span></div>
      <div className="schema-tree">
        <div><code>schemaVersion</code><span className="type">string</span><p>JSON仕様のバージョン。現在は <code>"1.2.0"</code>。</p></div>
        <div><code>source</code><span className="type">object</span><p>取得元URL、取得日時、変換器のバージョン。</p></div>
        <div><code>event</code><span className="type">object</span><p>地震の基本情報。取得できない値は <code>null</code> になる場合があります。</p></div>
        <div><code>reports</code><span className="type">array</span><p>緊急地震速報の各報。報ごとの予想震度・長周期地震動階級を格納します。</p></div>
        <div><code>normalized</code><span className="type">object</span><p>MeteoQuake用に正規化したデータ(v1.2.0で追加)。<code>event</code>(発生時刻のUTCミリ秒・緯度経度・深さkm・Mを数値化)、<code>reports</code>(報番号<code>serial</code>、発表時刻の絶対時刻<code>issuedAtMs</code>、<code>isFinal</code>、予報区ごとの<code>areas</code>[<code>minIntensityKey</code>/<code>maxIntensityKey</code>は"5-"=5弱、"5+"=5強の形])、<code>warnings</code>(抽出できなかった点)を持ちます。既存のフィールドは変わりません。</p></div>
        <div><code>sourceTables</code><span className="type">array</span><p>詳細ページから抽出した元表の行。セルや列見出しを確認するための情報です。</p></div>
        <div><code>metadata</code><span className="type">object</span><p>変換方法、変換日時、解析した表数、注意事項。</p></div>
      </div>
    </section>
    <section id="fields" className="panel schema-panel">
      <div className="panel-title"><div><p className="eyebrow">FIELD REFERENCE</p><h3>フィールド一覧</h3><p className="section-lead">主要なプロパティと、そのデータ型・用途を確認できます。</p></div></div>
      <h4>source</h4>
      <div className="schema-table-wrap"><table className="schema-table"><thead><tr><th>フィールド</th><th>型</th><th>説明</th></tr></thead><tbody>
        <tr><td><code>provider</code></td><td>string</td><td>情報提供元（気象庁）。</td></tr>
        <tr><td><code>indexUrl</code></td><td>string</td><td>公開履歴の一覧URL。</td></tr>
        <tr><td><code>detailUrl</code></td><td>string</td><td>解析対象とした詳細ページのURL。</td></tr>
        <tr><td><code>retrievedAt</code></td><td>string</td><td>取得日時。ISO 8601形式の日時文字列。</td></tr>
        <tr><td><code>parserVersion</code></td><td>string</td><td>変換器のバージョン。</td></tr>
      </tbody></table></div>
      <h4>event</h4>
      <div className="schema-table-wrap"><table className="schema-table"><thead><tr><th>フィールド</th><th>型</th><th>説明</th></tr></thead><tbody>
        <tr><td><code>id</code></td><td>string</td><td>ツール内で事例を識別するID。</td></tr>
        <tr><td><code>occurredAt</code></td><td>string</td><td>地震発生日時。元データに基づく日時文字列。</td></tr>
        <tr><td><code>hypocenterName</code></td><td>string</td><td>震央地名・震源地名。</td></tr>
        <tr><td><code>latitude</code>, <code>longitude</code></td><td>string | null</td><td>緯度・経度。現在は元ページから抽出した文字列として保持。</td></tr>
        <tr><td><code>depth</code></td><td>string | null</td><td>震源の深さ。元ページの表記を保持。</td></tr>
        <tr><td><code>magnitude</code></td><td>string | null</td><td>マグニチュード。</td></tr>
        <tr><td><code>observedMaximumIntensity</code></td><td>string | null</td><td>公開履歴または詳細ページに記載された観測最大震度。</td></tr>
      </tbody></table></div>
      <h4>reports[]</h4>
      <div className="schema-table-wrap"><table className="schema-table"><thead><tr><th>フィールド</th><th>型</th><th>説明</th></tr></thead><tbody>
        <tr><td><code>reportNumber</code></td><td>number</td><td>報番号。表から確定できない場合は抽出順を使う場合があります。</td></tr>
        <tr><td><code>elapsedSeconds</code></td><td>number | null</td><td>発生からの経過秒数。抽出できない場合は <code>null</code>。</td></tr>
        <tr><td><code>providedAt</code></td><td>string | null</td><td>その報の発表時刻の表記。</td></tr>
        <tr><td><code>forecastReference</code></td><td>string | null</td><td>予想区域の注記参照番号（例：<code>"※1"</code>）。</td></tr>
        <tr><td><code>forecastIntensityByArea</code></td><td>array</td><td>区域ごとの予想最大震度。要素は <code>area</code> と <code>expectedMaximumIntensity</code>。</td></tr>
        <tr><td><code>forecastLongPeriodByArea</code></td><td>array</td><td>区域ごとの長周期地震動階級。要素は <code>area</code> と <code>expectedLongPeriodClass</code>。</td></tr>
        <tr><td><code>sourceTable</code>, <code>sourceRow</code></td><td>number</td><td>詳細HTML内で対応する表番号・行番号。</td></tr>
      </tbody></table></div>
      <div id="intensity" className="docs-subsection"><h4>予想震度の値</h4>
      <p className="schema-copy">各区域の <code>expectedMaximumIntensity</code> は文字列です。単一の震度は震度階級をそのまま格納し、範囲予想は <code>from{ "4" }to{ "5弱" }</code> のような形式で格納します。</p>
      <div className="intensity-examples"><div><span>元の表記</span><b>震度4程度</b><code>"4"</code></div><div><span>元の表記</span><b>震度5弱程度</b><code>"5弱"</code></div><div><span>元の表記</span><b>震度4から5弱程度</b><code>"from4to5弱"</code></div><div><span>元の表記</span><b>震度5弱から5強程度</b><code>"from5弱to5強"</code></div></div>
      <p className="schema-warning">注意：範囲表現は文字列です。震度の大小比較や並べ替えを行う場合は、文字列の辞書順ではなく、震度階級に対応した比較ロジックを実装してください。</p></div>
    </section>
    <section id="example" className="panel schema-panel">
      <div className="panel-title"><div><p className="eyebrow">EXAMPLE</p><h3>JSONサンプル</h3><p className="section-lead">出力されるデータ構造のイメージです。</p></div><button className="primary docs-copy" onClick={() => void navigator.clipboard?.writeText(example)}>コードをコピー <span>↗</span></button></div>
      <pre className="schema-code">{example}</pre>
    </section>
    <section id="notes" className="panel schema-panel">
      <div className="panel-title"><div><p className="eyebrow">NOTES</p><h3>利用上の注意</h3></div></div>
      <ul className="schema-notes">
        <li>HTMLの構造や表記の違いにより、一部フィールドを抽出できない場合があります。</li>
        <li><code>sourceTables</code> は元ページの表情報であり、各報の統合済みデータである <code>reports</code> とは目的が異なります。</li>
        <li>抽出結果は気象庁の公開ページと照合してから利用してください。</li>
        <li>過去事例の閲覧・研究用途を想定しています。現在の防災情報や避難判断には使用しないでください。</li>
      </ul>
    </section>
    <footer className="docs-footer"><span>JmaEewParser <span className="footer-sep">/</span> JSON仕様</span><span>仕様は実装の更新に伴い変更される場合があります。</span></footer>
      </div>
    </main>
    <aside className="docs-toc"><div className="docs-toc-title">このページの内容</div><a href="#overview">データ構造</a><a href="#fields">フィールド一覧</a><a href="#intensity">予想震度の形式</a><a href="#example">JSONサンプル</a><a href="#notes">利用上の注意</a><div className="toc-help">各フィールドの意味や型を、JSONサンプルと照らし合わせて確認できます。</div></aside>
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><SchemaPage /></React.StrictMode>);
