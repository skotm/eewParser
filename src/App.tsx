import { ChangeEvent, useMemo, useState } from "react";
import { buildNormalizedEew, cutAtPageFooter, eewFileName, extractHypocenterFromText, isOriginMinutePrecision, isPlausibleAreaName, parseCoordinate } from "./eewExport";

type Period = "all" | "new" | "old";
type EventItem = {
  id: string; date: string; name: string; magnitude: string;
  intensity: string; detailUrl: string;
};

const INDEX_URL = "https://www.data.jma.go.jp/eew/data/nc/pub_hist/index";

function clean(value: string) { return value.replace(/\s+/g, " ").trim(); }

function inspectIndex(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tables = Array.from(doc.querySelectorAll("table"));
  const rowDetails = tables.map((table, tableIndex) => ({
    table: tableIndex + 1,
    rows: Array.from(table.querySelectorAll("tr")).map((row, rowIndex) => {
      const cells = Array.from(row.querySelectorAll(":scope > th, :scope > td"))
        .map((cell) => clean(cell.textContent || ""));
      const text = clean(row.textContent || "");
      const match = text.match(/(\d{4})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})\s+(\d{1,2}:\d{2})/);
      const links = Array.from(row.querySelectorAll("a[href]")).map((a) => ({
        text: clean(a.textContent || ""),
        href: a.getAttribute("href") || ""
      }));
      if (!match) return null;
      let dateCellIndex = cells.findIndex((cell) => /(\d{4})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})/.test(cell));
      const chosenLink = links.find((link) =>
        /content_out\.html|\/content(?:\/|$)/i.test(link.href) ||
        /\/fc\/(?:index\.html?)?(?:[?#].*)?$/i.test(link.href) ||
        /緊急地震速報の内容|内容|詳細/.test(link.text)
      ) || links.find((link) => !/reach|arrival|time|到達時間|主要動/i.test(link.href + " " + link.text));
      return {
        row: rowIndex + 1,
        year: Number(match[1]),
        cells,
        dateCellIndex,
        links,
        chosenLink: chosenLink || null
      };
    }).filter((row): row is NonNullable<typeof row> => row !== null)
  }));
  const dated = rowDetails.flatMap((table) => table.rows);
  return {
    tables: tables.length,
    datedRows: dated.length,
    linkedRows: dated.filter((row) => row.links.length > 0).length,
    modernRows: dated.filter((row) => row.year >= 2023 && row.links.length > 0).length,
    legacyRows: dated.filter((row) => row.year < 2023 && row.links.length > 0).length,
    rowsWithoutDateCellMatch: dated.filter((row) => row.dateCellIndex < 0).length,
    rowsWithoutChosenLink: dated.filter((row) => !row.chosenLink).length,
    samples: {
      modern: dated.filter((row) => row.year >= 2023).slice(0, 5),
      legacy: dated.filter((row) => row.year < 2023).slice(0, 3),
      modernWithoutDateCellMatch: dated.filter((row) => row.year >= 2023 && row.dateCellIndex < 0).slice(0, 5),
      modernWithoutChosenLink: dated.filter((row) => row.year >= 2023 && !row.chosenLink).slice(0, 5)
    }
  };
}
function formatDate(value: string) {
  const match = value.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return match ? match[1] + "/" + match[2] + "/" + match[3] + " " + match[4] + ":" + match[5] : value;
}
function parseIndex(html: string, baseUrl = INDEX_URL): EventItem[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const result: EventItem[] = [];
  const seen = new Set<string>();

  // JMA splits the history into two separate tables: from 2023-02-01 onward
  // and through 2023-01-31. Parse every table independently so the first
  // table's header/structure cannot affect the older table (or vice versa).
  const tables = Array.from(doc.querySelectorAll("table"));
  for (const table of tables) {
    for (const row of Array.from(table.querySelectorAll("tr"))) {
      const cells = Array.from(row.querySelectorAll("th,td"))
        .map((cell) => clean(cell.textContent || ""));
      // The modern table may split the date and time into separate cells,
      // while the legacy table combines them. Detect both layouts.
      let dateIndex = -1;
      let dateSpan = 1;
      let date: RegExpMatchArray | null = null;
      for (let i = 0; i < cells.length; i++) {
        const oneCell = cells[i].match(/(\d{4})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})\s+(\d{1,2}:\d{2})/);
        if (oneCell) {
          dateIndex = i;
          date = oneCell;
          break;
        }
        if (i + 1 < cells.length) {
          const twoCells = (cells[i] + " " + cells[i + 1]).match(/(\d{4})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})\s+(\d{1,2}:\d{2})/);
          if (twoCells) {
            dateIndex = i;
            dateSpan = 2;
            date = twoCells;
            break;
          }
        }
      }
      if (dateIndex < 0 || !date) continue;

      const links = Array.from(row.querySelectorAll("a[href]"));
      if (!links.length) continue;
      // Newer rows link to content/content_out.html; older rows commonly link
      // to fc/index.html. Prefer the actual EEW content link, not reach-time.
      const detail = links.find((a) => {
        const href = a.getAttribute("href") || "";
        const label = clean(a.textContent || "");
        return /content_out\.html|\/content(?:\/|$)/i.test(href) ||
          /\/fc\/(?:index\.html?)?(?:[?#].*)?$/i.test(href) ||
          /緊急地震速報の内容|内容|詳細/.test(label);
      }) || links.find((a) => {
        // On the modern JMA table, the only link in a row is often the
        // reach-time page. The list does not expose the EEW detail page there,
        // so keep this link as the best available target rather than dropping
        // the entire event. Prefer any non-reach-time link when one exists.
        const href = (a.getAttribute("href") || "").toLowerCase();
        const label = clean(a.textContent || "");
        return !/reachtime|reach.?time|arrival|到達時間|主要動/.test(href + " " + label);
      }) || links[0];
      if (!detail) continue;

      const occurred = date[1] + "-" + date[2] + "-" + date[3] + "T" + date[4] + ":00+09:00";
      // The date may occupy one cell or two adjacent cells. The next cell
      // after the date span is the hypocenter name; do not skip an extra column.
      const name = cells[dateIndex + dateSpan] || "震央地名不明";
      const magnitudeCell = cells[dateIndex + dateSpan + 1] || "";
      const magnitudeMatch = magnitudeCell.match(/[0-9０-９]+(?:\.[0-9０-９]+)?/);
      const magnitude = magnitudeMatch ? magnitudeMatch[0].replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0)) : "";
      const intensityCell = cells[dateIndex + dateSpan + 2] || "";
      const intensity = /^(?:---|[０-７0-7][弱強]?)$/.test(intensityCell)
        ? intensityCell
        : "未掲載";
      let detailUrl = new URL(detail.getAttribute("href") || "", baseUrl).href;
      // Some modern rows expose only the "主要動到達時間" link, even though
      // the same event directory has an EEW-content page. Resolve that sibling
      // page so report-by-report warning data is parsed instead of arrival-time data.
      if (/\/reachtime\/reachtime\.html(?:[?#].*)?$/i.test(detailUrl)) {
        detailUrl = detailUrl.replace(/\/reachtime\/reachtime\.html(?:[?#].*)?$/i, "/content/content_out.html");
      }
      const uniqueKey = occurred + "|" + name + "|" + detailUrl;
      if (seen.has(uniqueKey)) continue;
      seen.add(uniqueKey);

      result.push({
        id: "jma-" + occurred.replace(/[^0-9]/g, "") + "-" + result.length,
        date: occurred,
        name: name.replace(/[()（）]/g, "").trim(),
        magnitude,
        intensity,
        detailUrl
      });
    }
  }

  // Newest first regardless of the source table order.
  result.sort((a, b) => b.date.localeCompare(a.date));
  return result;
}


type ParsedTableRow = {
  tableNumber: number;
  rowNumber: number;
  cells: string[];
  columns: Record<string, string>;
};

function normalizeLabel(value: string) {
  return clean(value).replace(/[：:]/g, "").replace(/\s+/g, "");
}

function intensityFrom(value: string): string | null {
  const text = clean(value)
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, "");
  // JMAの履歴ページで数字が欠落した表記を、震度0を下限として正規化する。
  if (/^震度程度(?:以上)?$/.test(text)) return "0";
  const missingLowerBound = text.match(/^震度から(?:震度)?([0-7](?:弱|強)?)(?:程度以上|以上|程度)?$/);
  if (missingLowerBound) return `from0to${missingLowerBound[1]}`;
  const rangeMatch = text.match(/(?:震度)?([0-7](?:弱|強)?)から(?:震度)?([0-7](?:弱|強)?)(?:程度以上|以上|程度)?/);
  if (rangeMatch) return `from${rangeMatch[1]}to${rangeMatch[2]}`;
  const match = text.match(/(?:震度\s*)?([0-7](?:弱|強)?)(?:程度以上|以上|程度)?/);
  return match?.[1] || null;
}


type ForecastArea = {
  area: string;
  expectedMaximumIntensity: string;
};

type ForecastLongPeriodArea = {
  area: string;
  expectedLongPeriodClass: number;
};

type ForecastBlock = {
  intensity: ForecastArea[];
  longPeriod: ForecastLongPeriodArea[];
};

function parseForecastBlocks(text: string) {
  // フッター(「このページのトップへ」以降)は注記ではないので、地域名の並びに入らないよう切り落とす。
  const normalized = cutAtPageFooter(text)
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0))
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\u00a0]+/g, " ");
  const blocks = new Map<string, ForecastBlock>();
  const markerRegex = /※\s*(\d+)\s*([\s\S]*?)(?=※\s*\d+|$)/g;
  let markerMatch: RegExpExecArray | null;

  const splitAreas = (value: string) => value
    .replace(/長周期地震動階級[0-3]?[\s\S]*$/g, "")
    .split(/[、,，\n]+/)
    .map((name) => clean(name).replace(/^[：:]\s*/, "").trim())
    .filter((name) => Boolean(name) && !/^(?:以上|程度|程度以上)$/.test(name) && isPlausibleAreaName(name));

  while ((markerMatch = markerRegex.exec(normalized)) !== null) {
    const marker = markerMatch[1];
    const blockText = markerMatch[2];
    const intensity: ForecastArea[] = [];
    const longPeriod: ForecastLongPeriodArea[] = [];

    const intensityRegex = /震度\s*((?:[0-7](?:弱|強)?)?(?:から(?:震度)?[0-7](?:弱|強)?)?)(程度以上|程度)?\s*([\s\S]*?)(?=震度|長周期地震動階級|※|$)/g;
    let intensityMatch: RegExpExecArray | null;
    while ((intensityMatch = intensityRegex.exec(blockText)) !== null) {
      const rawIntensity = intensityMatch[1] + (intensityMatch[2] || "");
      const value = intensityFrom(rawIntensity.startsWith("から") ? `震度${rawIntensity}` : rawIntensity || "震度程度") || rawIntensity;
      for (const area of splitAreas(intensityMatch[3])) {
        if (/長周期地震動階級/.test(area)) continue;
        if (!intensity.some((item) => item.area === area && item.expectedMaximumIntensity === value)) {
          intensity.push({ area, expectedMaximumIntensity: value });
        }
      }
    }

    const longPeriodRegex = /長周期地震動階級\s*([0-3])\s*([\s\S]*?)(?=長周期地震動階級|※|$)/g;
    let longPeriodMatch: RegExpExecArray | null;
    while ((longPeriodMatch = longPeriodRegex.exec(blockText)) !== null) {
      const grade = Number(longPeriodMatch[1]);
      const areaText = longPeriodMatch[2]
        .replace(/震度[0-7][\s\S]*$/g, "")
        .trim();
      for (const area of areaText.split(/[、,，\n]+/).map((name) => clean(name)).filter((name) => Boolean(name) && isPlausibleAreaName(name))) {
        if (!longPeriod.some((item) => item.area === area && item.expectedLongPeriodClass === grade)) {
          longPeriod.push({ area, expectedLongPeriodClass: grade });
        }
      }
    }

    // The marker may appear in both the table cell and its expanded footnote.
    // Preserve the populated occurrence instead of replacing it with an empty duplicate.
    if (intensity.length || longPeriod.length || !blocks.has(marker)) {
      blocks.set(marker, { intensity, longPeriod });
    }
  }
  return blocks;
}

// 「最大震度1程度以上」「最大震度５弱程度以上」(全角数字も可)。
const PROVISIONAL_INTENSITY = /最大\s*震度\s*[0-7０-７](?:\s*[弱強])?\s*(?:程度以上|以上|程度)/;

function parseReportGroups(rows: ParsedTableRow[], doc: Document) {
  const forecastBlocks = parseForecastBlocks(doc.body?.innerText || doc.body?.textContent || "");
  const isElapsedCell = (cell?: string) => !!cell && /^\d+(?:\.\d+)?$/.test(cell.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0)));
  const candidates = rows.filter((row) => {
    const rowText = row.cells.join(" | ");
    if (!/\d{1,2}時\d{1,2}分/.test(rowText)) return false;
    if (/※\s*\d+/.test(rowText)) return true;
    // 予報区ごとの予測が無い初期の報は、予測震度の欄が「最大震度1程度以上」のような一文になっている。
    if (PROVISIONAL_INTENSITY.test(rowText) && isElapsedCell(row.cells[2])) return true;
    // 予測震度の注記(※)が無いキャンセル報の行。地震の概要の行などと区別するため、経過時間(秒)の列が数値の行に限る。
    return /キャンセル|取消/.test(rowText) && isElapsedCell(row.cells[2]);
  });

  // A footnote marker alone is not enough to prove which report it belongs to.
  // Do not invent report numbers when the report table could not be identified.
  return candidates.map((row, index) => {
    const rowText = row.cells.join(" | ");
    const marker = rowText.match(/※\s*(\d+)/)?.[1] || "";
    const time = rowText.match(/\d{1,2}時\d{1,2}分(?:\d+(?:\.\d+)?秒)?/)?.[0] || null;
    // 震源要素(北緯・東経・深さ・マグニチュード)は、表の見出しの並び(経過時間→震源要素→予測震度)から、
    // 予測震度のセル(※を含むセル)の直前の4セルとみなす。緯度・経度として読めない時は取り出さない。
    const markerCellIndex = row.cells.findIndex((cell) => /※\s*\d+/.test(cell) || PROVISIONAL_INTENSITY.test(cell));
    const provisional = row.cells.map((cell) => cell.match(PROVISIONAL_INTENSITY)?.[0]).find(Boolean) || null;
    let hypocenter: { latitude: string; longitude: string; depth: string; magnitude: string } | null = null;
    if (markerCellIndex >= 4) {
      const [latitude, longitude, depth, magnitude] = row.cells.slice(markerCellIndex - 4, markerCellIndex);
      if (parseCoordinate(latitude) != null && parseCoordinate(longitude) != null) hypocenter = { latitude, longitude, depth, magnitude };
    }
    const reportNumberCell = row.cells[0]?.match(/^\d+$/)?.[0];
    const elapsedCell = row.cells[2]?.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0));
    const elapsed = elapsedCell?.match(/^\d+(?:\.\d+)?$/)?.[0];

    return {
      reportNumber: reportNumberCell ? Number(reportNumberCell) : index + 1,
      elapsedSeconds: elapsed ? Number(elapsed) : null,
      providedAt: time,
      hypocenter,
      isCancel: /キャンセル|取消/.test(rowText),
      forecastReference: marker ? "※" + marker : null,
      provisionalIntensity: provisional ? provisional.replace(/\s+/g, "") : null,
      forecastIntensityByArea: forecastBlocks.get(marker)?.intensity || [],
      forecastLongPeriodByArea: forecastBlocks.get(marker)?.longPeriod || [],
      sourceTable: row.tableNumber,
      sourceRow: row.rowNumber,
    };
  });
}

const LABEL_ONLY = /^(地震発生日時|発生日時|震央地名|震央|北緯|東経|緯度|経度|深さ|マグニチュード|最大震度)$/;

function parseDetailDocument(doc: Document) {
  const allRows: ParsedTableRow[] = [];
  const eventDetails: Record<string, string> = {};
  const forecastIntensityByArea: Array<{ area: string; expectedMaximumIntensity: string; sourceTable: number; sourceRow: number }> = [];
  const notes: string[] = [];

  const fieldAliases: Array<[RegExp, string]> = [
    [/地震発生日時|発生日時|地震発生時刻|発生時刻/, "occurredAt"],
    [/震央地名|震央|震源地名|震源地/, "hypocenterName"],
    [/北緯|緯度/, "latitude"],
    [/東経|経度/, "longitude"],
    [/深さ|震源の深さ/, "depth"],
    [/マグニチュード|Ｍ|Magnitude/i, "magnitude"],
    [/最大震度|観測最大震度/, "observedMaximumIntensity"],
  ];

  const tables = Array.from(doc.querySelectorAll("table"));
  tables.forEach((table, tableIndex) => {
    const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
      Array.from(row.querySelectorAll(":scope > th, :scope > td")).map((cell) => clean(cell.textContent || ""))
    ).filter((cells) => cells.some((cell) => cell.length > 0));
    if (!rows.length) return;

    const first = rows[0];
    const normalizedHeaders = first.map(normalizeLabel);
    const hasHeader = first.some((cell) => /地震発生|震央|北緯|東経|深さ|マグニチュード|最大震度|細分区域|予想震度|予想最大震度|地域名|区域名/.test(normalizeLabel(cell)));
    const headers = hasHeader ? normalizedHeaders : [];

    // Some JMA pages put all event fields in one header row and all values in the next row.
    for (let rowIndex = 0; rowIndex < rows.length - 1; rowIndex++) {
      const headerCells = rows[rowIndex].map(normalizeLabel);
      const valueCells = rows[rowIndex + 1];
      // 見出し行と値の行の組から、地震諸元を集める。3項目以上そろった組だけを採用し、
      // すでに取れている項目は上書きしない(最初の表=「発生した地震の概要」を優先する)。
      // 後ろの表(報ごとの震源要素の見出しなど)の値で上書きすると、緯度・経度が壊れるため。
      const found: Record<string, string> = {};
      fieldAliases.forEach(([pattern, key]) => {
        const headerIndex = headerCells.findIndex((header) => pattern.test(header));
        if (headerIndex >= 0 && valueCells[headerIndex]) {
          const value = clean(valueCells[headerIndex]);
          // 値が見出しそのもの(別の見出し行)なら採用しない。「北緯36.1度」のように値の中にラベル語を
          // 含むものは、そのまま値として採用する。
          if (value && normalizeLabel(value) !== headerCells[headerIndex] && !LABEL_ONLY.test(normalizeLabel(value))) {
            found[key] = value;
          }
        }
      });
      if (Object.keys(found).length >= 3) {
        for (const [key, value] of Object.entries(found)) if (!(key in eventDetails)) eventDetails[key] = value;
        break;
      }
    }

    rows.forEach((cells, rowIndex) => {
      const columns: Record<string, string> = {};
      if (headers.length && rowIndex > 0) {
        headers.forEach((header, index) => {
          if (header && cells[index]) columns[header] = cells[index];
        });
      }
      allRows.push({
        tableNumber: tableIndex + 1,
        rowNumber: rowIndex + 1,
        cells,
        columns,
      });

      // Detail pages often present earthquake metadata as label/value rows.
      if (cells.length >= 2) {
        const label = normalizeLabel(cells[0]);
        const alias = fieldAliases.find(([pattern]) => pattern.test(label));
        if (alias && cells[1] && !/^(地震発生日時|震央地名|北緯|東経|深さ|マグニチュード|最大震度)$/.test(normalizeLabel(cells[1]))) {
          if (!(alias[1] in eventDetails)) eventDetails[alias[1]] = cells.slice(1).join(" | ");
        }
      }
    });

    if (!hasHeader) return;
    const areaIndex = headers.findIndex((header) => /細分区域|区域名|地域名|予想地域|対象地域|地域$|区域$/.test(header));
    const intensityIndex = headers.findIndex((header) => /予想最大震度|予想震度|予測震度|震度/.test(header));
    if (areaIndex < 0 || intensityIndex < 0 || areaIndex === intensityIndex) return;

    rows.slice(1).forEach((cells, offset) => {
      const area = cells[areaIndex] || "";
      const intensityRaw = cells[intensityIndex] || "";
      const expectedMaximumIntensity = intensityFrom(intensityRaw);
      if (!area || !expectedMaximumIntensity) return;
      if (/細分区域|区域名|地域名|予想地域|対象地域/.test(area)) return;
      if (forecastIntensityByArea.some((item) => item.area === area && item.expectedMaximumIntensity === expectedMaximumIntensity)) return;
      forecastIntensityByArea.push({
        area,
        expectedMaximumIntensity,
        sourceTable: tableIndex + 1,
        sourceRow: offset + 2,
      });
    });
  });

  // Fallback for label/value blocks outside tables, while keeping provenance explicit.
  const text = clean(doc.body?.textContent || "");
  if (!Object.keys(eventDetails).length) {
    for (const [pattern, key] of fieldAliases) {
      const match = text.match(new RegExp(pattern.source + "\\s*[：:]?\\s*([^\\s|]{1,40})", "i"));
      if (match?.[1] && !/地震発生日時|震央地名|北緯|東経|深さ|マグニチュード|最大震度/.test(match[1])) {
        eventDetails[key] = match[1];
      }
    }
    notes.push("地震諸元は表のラベル・値対応から抽出できなかった項目がある可能性があります。");
  }
  // 地震波検知時刻("地震波検知時刻 12時38分10.1秒")。報の「地震波検知からの経過時間」の基準で、
  // MeteoQuakeのリプレイはここから始める。
  {
    const halfWidth = (value: string) => value.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0)).replace(/．/g, ".");
    const detectionRegex = /地震波検知時刻[^\d]{0,6}(\d{1,2}時\d{1,2}分(?:\d+(?:\.\d+)?秒)?)/;
    const fromRows = allRows.map((row) => halfWidth(row.cells.join(" ")).match(detectionRegex)?.[1]).find(Boolean);
    const found = fromRows || halfWidth(clean(doc.body?.textContent || "")).match(detectionRegex)?.[1];
    if (found) eventDetails.detectionTime = found;
  }
  // 緯度・経度が表のラベルと値の対応から取れなかった(または数値にできない)時は、ページ内の
  // 「北緯◯度」「東経◯度」などの表記から探す。再生には震源の位置が必須のため。
  if (parseCoordinate(eventDetails.latitude) == null || parseCoordinate(eventDetails.longitude) == null) {
    const allText = allRows.map((row) => row.cells.join(" ")).join(" ") + " " + (doc.body?.textContent || "");
    const found = extractHypocenterFromText(allText);
    let used = false;
    if (parseCoordinate(eventDetails.latitude) == null && found.latitude != null) { eventDetails.latitude = String(found.latitude); used = true; }
    if (parseCoordinate(eventDetails.longitude) == null && found.longitude != null) { eventDetails.longitude = String(found.longitude); used = true; }
    if (used) notes.push("緯度・経度は表の見出しと対応づけられなかったため、ページ内の「北緯・東経」などの表記から抽出しました。");
  }
  const reportGroups = parseReportGroups(allRows, doc);
  if (!reportGroups.length) {
    notes.push("報ごとの表行を特定できませんでした。注記だけから報番号を推定せず、reportsは空配列にしています。");
  } else if (reportGroups.some((report) => report.forecastIntensityByArea.length === 0 && report.forecastLongPeriodByArea.length === 0)) {
    notes.push("一部の報では参照注記に対応する区域別予想震度を抽出できませんでした。元行と注記を確認してください。");
  }

  return {
    reports: allRows,
    reportGroups,
    eventDetails,
    forecastIntensityByArea,
    notes,
    tableCount: tables.length
  };
}

type ParsedDetail = ReturnType<typeof parseDetailDocument>;

export default function App() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState<Period>("all");
  const [indexUrl, setIndexUrl] = useState(INDEX_URL);
  const [status, setStatus] = useState("気象庁の一覧を読み込むか、保存済みHTMLを選択してください。");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [exportName, setExportName] = useState("");
  const [exportWarnings, setExportWarnings] = useState<string[]>([]);
  const [parsedDetail, setParsedDetail] = useState<{ parsed: ParsedDetail; selectedId: string } | null>(null);
  const [manualLat, setManualLat] = useState("");
  const [manualLon, setManualLon] = useState("");
  const [originSecText, setOriginSecText] = useState("");
  const [indexDiagnostics, setIndexDiagnostics] = useState<Record<string, unknown> | null>(null);

  const visibleEvents = useMemo(() => events.filter((event) => {
    const text = (event.name + " " + event.date + " " + event.magnitude + " " + event.intensity).toLowerCase();
    if (!text.includes(query.trim().toLowerCase())) return false;
    const year = Number(event.date.slice(0, 4));
    if (period === "new" && year < 2023) return false;
    if (period === "old" && year >= 2023) return false;
    return true;
  }), [events, query, period]);
  const selected = events.find((event) => event.id === selectedId);

  async function loadIndex() {
    setBusy(true); setError("");
    try {
      const url = new URL(indexUrl);
      if (url.protocol !== "https:" || !["ds.data.jma.go.jp", "www.data.jma.go.jp"].includes(url.hostname)) {
        throw new Error("https://ds.data.jma.go.jp/ または https://www.data.jma.go.jp/ 配下のURLを指定してください。");
      }
      let response: Response;
      try {
        response = await fetch(url.href);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error("一覧ページへの通信に失敗しました（" + reason + "）。URLをブラウザで開けるか、通信環境を確認してください。");
      }
      if (!response.ok) throw new Error("一覧ページの取得に失敗しました（HTTP " + response.status + "）。");
      const html = await response.text();
      if (!html.trim()) throw new Error("気象庁から空のHTMLが返されました。");
      const diagnostics = inspectIndex(html);
      setIndexDiagnostics(diagnostics);
      const parsed = parseIndex(html, response.url || url.href);
      setEvents(parsed); setSelectedId(parsed[0]?.id || ""); setJsonText("");
      setStatus(parsed.length + "件の事例を抽出しました。");
      if (!parsed.length) setError("事例を抽出できませんでした。保存した一覧HTMLを読み込んでください。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "一覧を取得できませんでした。");
      setStatus("直接取得に失敗した場合は、保存済みHTMLを読み込んでください。");
    } finally { setBusy(false); }
  }

  async function importIndexFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const html = await file.text();
      setIndexDiagnostics(inspectIndex(html));
      const parsed = parseIndex(html);
      setEvents(parsed); setSelectedId(parsed[0]?.id || ""); setJsonText("");
      setStatus(file.name + " から " + parsed.length + "件を抽出しました。");
      setError(parsed.length ? "" : "一覧HTMLから事例を抽出できませんでした。ページ構造を確認してください。");
    } catch { setError("HTMLファイルを解析できませんでした。"); }
    event.target.value = "";
  }

  // 解析結果(parsed)から、保存用のJSON・ファイル名・警告を組み立てる。
  // 緯度・経度が取れなかった場合は、手入力の値(manualLat / manualLon)で補う。
  function buildExport(parsed: ParsedDetail, selected: EventItem, manualLat: string, manualLon: string, originSecText = "") {
    const pickCoord = (parsedValue: string | undefined, manual: string) =>
      parseCoordinate(parsedValue) == null && manual.trim() ? manual.trim() : (parsedValue || null);
      // MeteoQuakeで再生するための正規化済みデータ(数値・絶対時刻・震度キー)。
      // 既存のフィールドは変えず、normalizedとして追加するだけにしている。
      const eventForExport = {
        id: selected.id,
        occurredAt: parsed.eventDetails.occurredAt || selected.date,
        detectionTime: parsed.eventDetails.detectionTime || null,
        hypocenterName: parsed.eventDetails.hypocenterName || selected.name,
        latitude: pickCoord(parsed.eventDetails.latitude, manualLat),
        longitude: pickCoord(parsed.eventDetails.longitude, manualLon),
        depth: parsed.eventDetails.depth || null,
        magnitude: parsed.eventDetails.magnitude || selected.magnitude || null,
        observedMaximumIntensity: parsed.eventDetails.observedMaximumIntensity || selected.intensity || null
      };
      const secNum = originSecText.trim() === "" ? null : Number(originSecText);
      const normalized = buildNormalizedEew(eventForExport, parsed.reportGroups, selected.date, secNum);
      setExportName(eewFileName(normalized.event, selected.id));
      const manualUsed = (manualLat && parseCoordinate(parsed.eventDetails.latitude) == null) || (manualLon && parseCoordinate(parsed.eventDetails.longitude) == null);
      setExportWarnings(manualUsed ? ["震源の緯度・経度は手入力の値です。公式ページと照合してください。", ...normalized.warnings] : normalized.warnings);
      const json = {
        schemaVersion: "1.2.0",
        source: {
          provider: "気象庁",
          indexUrl: INDEX_URL,
          detailUrl: selected.detailUrl,
          retrievedAt: new Date().toISOString(),
          parserVersion: "0.5.0"
        },
        event: eventForExport,
        reports: parsed.reportGroups,
        normalized,
        sourceTables: parsed.reports,
        metadata: {
          conversionMode: "html",
          convertedAt: new Date().toISOString(),
          parsedTableCount: parsed.tableCount,
          notes: [
            "reportsは各報ごとのグループです。forecastIntensityByAreaは予測震度、forecastLongPeriodByAreaは長周期地震動階級を地域ごとに格納します。",
            "sourceTablesには元表の行・セル・列見出しとの対応を保持します。",
            "報と予想震度の対応は、詳細表の注記参照番号（※番号）を使って解析します。",
            ...parsed.notes,
            "出力値は公式ページと照合してから利用してください。"
          ]
        }
      };
      setJsonText(JSON.stringify(json, null, 2));
  }

  async function importDetail(file?: File) {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      let html: string;
      if (file) html = await file.text();
      else {
        const response = await fetch(selected.detailUrl, { mode: "cors" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        html = await response.text();
      }
      const doc = new DOMParser().parseFromString(html, "text/html");
      const parsed = parseDetailDocument(doc);
      setParsedDetail({ parsed, selectedId: selected.id });
      setManualLat(""); setManualLon(""); setOriginSecText("");
      buildExport(parsed, selected, "", "", "");
      setStatus("地震諸元と報ごとの予想震度を解析しました。抽出できない項目は推測せず、元表も保持しています。");
    } catch (cause) {
      setError((cause instanceof Error ? cause.message : "詳細ページを取得できませんでした。") +
        " 詳細HTMLを保存し、下のファイル選択から読み込む方法もあります。");
    } finally { setBusy(false); }
  }

  function downloadJson() {
    if (!jsonText) return;
    const url = URL.createObjectURL(new Blob([jsonText], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = exportName || (selected?.id || "eew-event") + ".eew.json"; anchor.click();
    URL.revokeObjectURL(url);
  }

  const detailReady = !!(jsonText && parsedDetail && selected && parsedDetail.selectedId === selected.id);

  return <div className="page">
    <h1>JmaEewParser</h1>
    <div className="subtitle">
      気象庁の緊急地震速報(警報)の公開履歴から、MeteoQuakeで再生できるEEWファイル(.eew.json)を作ります。
      すべての処理はこのブラウザ内で完結します。対象は警報が発表された事例のみで、予報だけの事例は含まれません。
    </div>

    <div className="card">
      <h2>1. 公開履歴を取り込む</h2>
      <label htmlFor="index-url">一覧ページのURL</label>
      <input type="text" id="index-url" value={indexUrl} onChange={(e) => setIndexUrl(e.target.value)} />
      <div className="row buttons">
        <button disabled={busy} onClick={loadIndex}>{busy ? "処理中…" : "URLから読み込む"}</button>
        <label className="button secondary">一覧のHTMLを選択<input type="file" accept=".html,.htm,text/html" onChange={importIndexFile} /></label>
      </div>
      <div className="small-note">
        ブラウザから直接取得できない場合は、一覧ページ(<a href={INDEX_URL} target="_blank" rel="noreferrer">気象庁の公開履歴</a>)を
        HTMLとして保存して読み込んでください。
      </div>
      <div className="status">{status}</div>
      {error && <div className="error" role="alert">{error}</div>}
      {indexDiagnostics && <details><summary>HTML解析の診断(調査用)</summary><pre>{JSON.stringify(indexDiagnostics, null, 2)}</pre></details>}
    </div>

    <div className="card">
      <h2>2. 事例を選ぶ{events.length > 0 && <span className="count">{visibleEvents.length}件</span>}</h2>
      <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="震央地名・日時・規模で検索" />
      <div className="mode-switch">
        {([{ value: "all", label: "すべて" }, { value: "new", label: "2023年以降" }, { value: "old", label: "2023年より前" }] as const).map((item) =>
          <label key={item.value}><input type="radio" name="period" checked={period === item.value} onChange={() => setPeriod(item.value)} />{item.label}</label>)}
      </div>
      {visibleEvents.length ? <div className="event-list">{visibleEvents.map((item) =>
        <button key={item.id} className={selectedId === item.id ? "event selected" : "event"}
          onClick={() => { setSelectedId(item.id); setJsonText(""); setExportWarnings([]); setParsedDetail(null); }}>
          <span className="event-date">{formatDate(item.date)}</span>
          <span className="event-name">{item.name}</span>
          <span className="event-info">M{item.magnitude || "—"} ・ 最大震度 {item.intensity || "—"}</span>
        </button>)}</div>
        : <div className="small-note">{events.length ? "一致する事例がありません。検索語や期間を変えてください。" : "事例がまだ読み込まれていません。"}</div>}
    </div>

    <div className="card">
      <h2>3. 解析して保存</h2>
      {selected ? <>
        <div className="picked">
          <b>{selected.name}</b>
          <span>{formatDate(selected.date)} ・ M{selected.magnitude || "—"} ・ 最大震度 {selected.intensity || "—"}</span>
        </div>
        <div className="row buttons">
          <button disabled={busy} onClick={() => importDetail()}>{busy ? "処理中…" : "詳細ページを解析"}</button>
          <label className="button secondary">詳細のHTMLを選択<input type="file" accept=".html,.htm,text/html" onChange={(e) => { const file = e.target.files?.[0]; if (file) void importDetail(file); e.target.value = ""; }} /></label>
        </div>
        <div className="small-note">
          <a href={selected.detailUrl} target="_blank" rel="noreferrer">公開ページを開く</a>。
          解析結果は、公式ページと照合してから使ってください。抽出できない項目は推測せず、元の表もJSONに残します。
        </div>
      </> : <div className="small-note">上の一覧から事例を選んでください。</div>}

      {detailReady && (() => {
        const d = parsedDetail!.parsed.eventDetails;
        const missing = parseCoordinate(d.latitude) == null || parseCoordinate(d.longitude) == null;
        const coordRows = parsedDetail!.parsed.reports.filter((row) => row.cells.some((cell) => /緯|経|北|東/.test(cell))).slice(0, 12);
        return <>
          {missing && <div className="warn" role="alert">
            <b>震源の緯度・経度を取得できませんでした</b>
            <div className="small-note">このままではMeteoQuakeで再生できません。公式ページを見て、緯度・経度を数値(度)で入力してください。</div>
            <div className="row">
              <div><input type="text" aria-label="緯度" placeholder="緯度 例: 36.1" value={manualLat} onChange={(e) => setManualLat(e.target.value)} /></div>
              <div><input type="text" aria-label="経度" placeholder="経度 例: 139.9" value={manualLon} onChange={(e) => setManualLon(e.target.value)} /></div>
              <button onClick={() => buildExport(parsedDetail!.parsed, selected!, manualLat, manualLon, originSecText)}>反映</button>
            </div>
          </div>}
          {isOriginMinutePrecision({ occurredAt: d.occurredAt }, selected?.date) && <div className="warn">
            <b>地震発生時刻が分単位です</b>
            <div className="small-note">秒を指定すると、報の絶対時刻などの基準に使います(空欄は0秒)。0以上60未満、小数可。</div>
            <div className="row">
              <div><input type="text" inputMode="decimal" aria-label="地震発生時刻の秒" placeholder="秒 例: 47.5" value={originSecText} onChange={(e) => setOriginSecText(e.target.value)} /></div>
              <button onClick={() => buildExport(parsedDetail!.parsed, selected!, manualLat, manualLon, originSecText)}>反映</button>
            </div>
          </div>}
          <details><summary>諸元の抽出の診断(調査用)</summary>
            <pre>{JSON.stringify({ eventDetails: d, 緯度経度らしいセルを含む行: coordRows.map((row) => ({ table: row.tableNumber, row: row.rowNumber, cells: row.cells })) }, null, 2)}</pre>
          </details>
        </>;
      })()}

      {jsonText && exportWarnings.length > 0 && <div className="warn" role="alert">
        <b>確認が必要な点({exportWarnings.length}件)</b>
        <ul>{exportWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      </div>}

      {jsonText && <>
        <div className="row buttons"><button onClick={downloadJson}>{exportName || ".eew.json"} を保存</button></div>
        <details><summary>変換結果(JSON)を見る</summary><pre>{jsonText}</pre></details>
      </>}
    </div>

    <div className="small-note footer">過去事例の閲覧・分析用です。現在の防災情報には使用しないでください。</div>
  </div>;
}
