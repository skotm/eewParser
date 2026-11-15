/**
 * eewExport.ts
 * ------------------------------------------------------------
 * 気象庁の公開履歴HTMLから取り出した「文字列のままの値」を、MeteoQuakeが
 * そのまま使える形(数値・絶対時刻・震度キー)に正規化する純粋関数群。
 * DOMに依存しないので、Node単体でテストできる(tests/eewExport.test.mjs)。
 *
 * 出力は JSON の `normalized` に入れる。従来のフィールド(event / reports /
 * sourceTables)は変えず追加するだけなので、既存のEEW再生ページ(replay.html)や
 * 古いJSONとの互換性は保たれる。
 *
 * 震度キーはMeteoQuakeの内部表記に合わせる: "0"〜"4", "5-"(5弱), "5+"(5強),
 * "6-"(6弱), "6+"(6強), "7"。
 */

export type IntensityKey = "0" | "1" | "2" | "3" | "4" | "5-" | "5+" | "6-" | "6+" | "7";

export const NORMALIZED_FORMAT_VERSION = 1;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 全角数字・記号を半角にし、空白を詰める。 */
export function toHalfWidth(value: string): string {
  return value
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, ".")
    .replace(/[－−―ー]/g, "-")
    .replace(/[\s ]+/g, "");
}

/** "北緯36.1度" "東経139度54.0分" "南緯10.0度" "36.1" などを度(数値)にする。 */
export function parseCoordinate(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = toHalfWidth(value);
  if (!text) return null;
  const negative = /南緯|西経/.test(text) || /^[-]/.test(text);
  // "36度06.0分" のほか、気象庁の表の "51°59.1′" (度°分′)も扱う。
  const dms = text.match(/(\d+(?:\.\d+)?)[度°](\d+(?:\.\d+)?)[分′'’]/);
  let result: number | null = null;
  if (dms) {
    result = Number(dms[1]) + Number(dms[2]) / 60;
  } else {
    const plain = text.match(/(\d+(?:\.\d+)?)/);
    result = plain ? Number(plain[1]) : null;
  }
  if (result == null || !Number.isFinite(result)) return null;
  return negative ? -result : result;
}

/**
 * ページの文章から震源の緯度・経度を探す(表のラベルと値の対応から取れなかった時の予備)。
 *   "北緯36.1度" "北緯36度06.0分" "緯度 36.1" "36.1°N" "N36.1" など。経度も同様(東経/西経/E/W)。
 * 文章全体を探すので、範囲外(緯度0〜90・経度0〜180以外)の値は採用しない。
 * 北緯・東経の表記が見つからなければnull(推測しない)。
 */
export function extractHypocenterFromText(text: string): { latitude: number | null; longitude: number | null } {
  // 空白は詰めず1つにまとめる("N36.1 E139.9" のように、緯度と経度の境目を空白で見分けるため)。
  const t = (text || "")
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, ".")
    .replace(/[\s\u00a0]+/g, " ");
  const pick = (
    kanji: RegExp, // (北緯|南緯)(度)(分)
    labelOnly: RegExp, // 緯度 36.1
    letterA: RegExp, // 36.1°N
    letterB: RegExp, // N36.1
    negativeKanji: string, negativeLetter: string, max: number,
  ): number | null => {
    const ok = (v: number) => Number.isFinite(v) && v >= 0 && v <= max;
    let m = t.match(kanji);
    if (m) {
      const v = Number(m[2]) + (m[3] ? Number(m[3]) / 60 : 0);
      if (ok(v)) return m[1] === negativeKanji ? -v : v;
    }
    m = t.match(labelOnly);
    if (m && ok(Number(m[1]))) return Number(m[1]);
    m = t.match(letterA);
    if (m && ok(Number(m[1]))) return m[2] === negativeLetter ? -Number(m[1]) : Number(m[1]);
    m = t.match(letterB);
    if (m && ok(Number(m[2]))) return m[1] === negativeLetter ? -Number(m[2]) : Number(m[2]);
    return null;
  };
  const latitude = pick(
    /(北緯|南緯)\s*(\d+(?:\.\d+)?)\s*度\s*(?:(\d+(?:\.\d+)?)\s*分)?/,
    /緯度[^\d]{0,6}(\d+(?:\.\d+)?)/,
    /(?<![\d.])(\d+(?:\.\d+)?)°?([NS])(?![A-Za-z])/,
    /(?<![A-Za-z])([NS])(\d+(?:\.\d+)?)(?![A-Za-z\d.])/,
    "南緯", "S", 90,
  );
  const longitude = pick(
    /(東経|西経)\s*(\d+(?:\.\d+)?)\s*度\s*(?:(\d+(?:\.\d+)?)\s*分)?/,
    /経度[^\d]{0,6}(\d+(?:\.\d+)?)/,
    /(?<![\d.])(\d+(?:\.\d+)?)°?([EW])(?![A-Za-z])/,
    /(?<![A-Za-z])([EW])(\d+(?:\.\d+)?)(?![A-Za-z\d.])/,
    "西経", "W", 180,
  );
  return { latitude, longitude };
}

/** "50 km" "約10km" "ごく浅い" を km(数値)にする。 */
export function parseDepthKm(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = toHalfWidth(value);
  if (!text) return null;
  if (/ごく浅い/.test(text)) return 0;
  const m = text.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/** "5.9" "M5.9" "Ｍ５．９" をマグニチュードにする。 */
export function parseMagnitude(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const m = toHalfWidth(value).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

const KEY_BY_LABEL: Record<string, IntensityKey> = {
  "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
  "5弱": "5-", "5強": "5+", "6弱": "6-", "6強": "6+", "7": "7",
  "5-": "5-", "5+": "5+", "6-": "6-", "6+": "6+",
};

export const INTENSITY_ORDER: IntensityKey[] = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];

/** "5弱" "震度5強" "４" を震度キーにする。変換できなければnull。 */
export function intensityToKey(value: unknown): IntensityKey | null {
  if (typeof value !== "string") return null;
  const text = toHalfWidth(value).replace(/震度/g, "").replace(/程度以上|以上|程度/g, "");
  return KEY_BY_LABEL[text] ?? null;
}

export type IntensityRange = {
  minKey: IntensityKey | null;
  maxKey: IntensityKey | null;
  /** "震度5弱程度以上" のように上限が決まっていない場合 true。maxKeyはminKeyと同じ値にしてある。 */
  openEnded: boolean;
};

/**
 * パーサが出す予想震度表記を、下限・上限の震度キーにする。
 *   "from4to5弱" → 4〜5-    "from0to4" → 0〜4
 *   "5弱"        → 5-〜5-   "0"        → 0〜0
 *   "震度5弱程度以上" → 5-〜5-(openEnded)
 */
export function parseIntensityRange(value: unknown): IntensityRange {
  const empty: IntensityRange = { minKey: null, maxKey: null, openEnded: false };
  if (typeof value !== "string") return empty;
  const text = toHalfWidth(value);
  if (!text) return empty;
  const openEnded = /以上/.test(text);

  const range = text.match(/^from(.+?)to(.+)$/) || text.match(/^(?:震度)?(.+?)から(?:震度)?(.+?)(?:程度以上|以上|程度)?$/);
  if (range) {
    const min = intensityToKey(range[1]);
    const max = intensityToKey(range[2]);
    return { minKey: min ?? max, maxKey: max ?? min, openEnded };
  }
  const single = intensityToKey(text);
  return { minKey: single, maxKey: single, openEnded: openEnded && single != null };
}

export function maxIntensityKey(keys: Array<IntensityKey | null | undefined>): IntensityKey | null {
  let best = -1;
  for (const key of keys) {
    if (!key) continue;
    const rank = INTENSITY_ORDER.indexOf(key);
    if (rank > best) best = rank;
  }
  return best >= 0 ? INTENSITY_ORDER[best] : null;
}

export type OriginTime = { ms: number; precision: "second" | "minute" };

/**
 * 地震発生時刻の文字列(JST想定)をUTCミリ秒にする。
 *   "2026-08-23T02:00:00+09:00" / "2026/08/23 02:00" / "2026年8月23日2時0分47.5秒"
 * オフセットが付いていればそれを優先し、無ければJSTとして扱う。
 */
export function parseOriginTime(value: unknown): OriginTime | null {
  if (typeof value !== "string") return null;
  // 日付と時刻の区切り(空白・T)を残したまま解釈する(空白を詰めると「23 02:00」が「2302:00」になり曖昧になる)。
  let text = value
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, ".")
    .trim();
  // 和暦("令和 8年10月16日12時38分")は西暦に直してから解釈する。
  text = text.replace(/(令和|平成|昭和)\s*(元|\d+)\s*年/, (_all, era: string, y: string) => {
    const base = era === "令和" ? 2018 : era === "平成" ? 1988 : 1925;
    return `${base + (y === "元" ? 1 : Number(y))}年`;
  });
  const m = text.match(/(\d{4})\s*[年\/-]\s*(\d{1,2})\s*[月\/-]\s*(\d{1,2})\s*日?[\sT]*(\d{1,2})\s*[時:]\s*(\d{1,2})(?:\s*[分:]\s*(\d{1,2}(?:\.\d+)?)?)?\s*秒?\s*(Z|[+-]\d{2}:?\d{2})?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  let offsetMs = JST_OFFSET_MS;
  if (tz === "Z") offsetMs = 0;
  else if (tz) {
    const sign = tz[0] === "-" ? -1 : 1;
    const digits = tz.slice(1).replace(":", "");
    offsetMs = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60 * 1000;
  }
  const seconds = s != null ? Number(s) : 0;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0) + Math.round(seconds * 1000) - offsetMs;
  if (!Number.isFinite(ms)) return null;
  return { ms, precision: s != null ? "second" : "minute" };
}

/** "02時00分50秒" "2時0分50.5秒" を、その日の0時(JST)からの経過ミリ秒にする。秒が無ければ0秒。 */
export function parseClockOfDay(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = toHalfWidth(value).match(/(\d{1,2})時(\d{1,2})分(?:(\d+(?:\.\d+)?)秒)?/);
  if (!m) return null;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + (m[3] ? Number(m[3]) : 0)) * 1000;
}

/**
 * 発表時刻(日付なしの時分秒)を、発生時刻を基準にした絶対時刻(UTCミリ秒)にする。
 * 発生日(JST)の日付を使い、発生時刻より1分以上前に見える場合は日付をまたいだものとして翌日にする。
 */
export function resolveIssuedAtMs(clockOfDayMs: number, originMs: number): number {
  const originJstDayStart = Math.floor((originMs + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
  let candidate = originJstDayStart + clockOfDayMs;
  // 発生時刻が分単位(秒が切り捨て)でも、報は発生より後なので、1分を超えて前なら日付またぎ。
  if (candidate < originMs - 60 * 1000) candidate += DAY_MS;
  return candidate;
}

export function toJstIso(ms: number): string {
  const d = new Date(ms + JST_OFFSET_MS);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const frac = d.getUTCMilliseconds() ? "." + p(d.getUTCMilliseconds(), 3) : "";
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${frac}+09:00`;
}

/* ───────── 入力(JmaEewParserが組み立てる既存JSONの該当部分) ───────── */

export type RawHypocenter = {
  latitude?: string | number | null;
  longitude?: string | number | null;
  depth?: string | number | null;
  magnitude?: string | number | null;
};

export type RawReport = {
  reportNumber?: number | null;
  /** その報の震源要素(北緯・東経・深さ・M)。表から取れた時だけ入る。 */
  hypocenter?: RawHypocenter | null;
  /** キャンセル報(取消)の行か。 */
  isCancel?: boolean;
  elapsedSeconds?: number | null;
  providedAt?: string | null;
  forecastIntensityByArea?: Array<{ area?: string; expectedMaximumIntensity?: string }>;
  forecastLongPeriodByArea?: Array<{ area?: string; expectedLongPeriodClass?: number }>;
};

export type RawEvent = {
  id?: string;
  occurredAt?: string | null;
  /** 地震波検知時刻("12時38分10.1秒")。報の「地震波検知からの経過時間」の基準になる。 */
  detectionTime?: string | null;
  hypocenterName?: string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  depth?: string | number | null;
  magnitude?: string | number | null;
  observedMaximumIntensity?: string | null;
};

export type NormalizedReport = {
  serial: number;
  issuedAtMs: number | null;
  issuedAtIso: string | null;
  /**
   * どの値から発表時刻を決めたか。
   * detection+elapsed=地震波検知時刻+経過秒(0.1秒単位で最も正確)、providedAt=表の発表時刻(秒単位)、
   * origin+elapsed=発生時刻+経過秒。
   */
  issuedAtSource: "detection+elapsed" | "providedAt" | "origin+elapsed" | null;
  elapsedSeconds: number | null;
  /** 最後の報を最終報として扱う(公開履歴には「最終」の明示が無いため)。 */
  isFinal: boolean;
  maxIntensityKey: IntensityKey | null;
  /** その報の震源(数値)。無ければnull(その場合はevent側の震源を使う)。 */
  hypocenter: { latitude: number | null; longitude: number | null; depthKm: number | null; magnitude: number | null } | null;
  /** キャンセル報(取消)か。 */
  isCancel: boolean;
  areas: Array<{ name: string; minIntensityKey: IntensityKey | null; maxIntensityKey: IntensityKey | null; openEnded: boolean }>;
  longPeriod: Array<{ name: string; grade: number }>;
};

export type NormalizedEew = {
  formatVersion: number;
  event: {
    eventId: string;
    originTimeMs: number | null;
    originTimeIso: string | null;
    originTimePrecision: "second" | "minute" | null;
    /** 地震波検知時刻(UTCミリ秒)。リプレイの開始位置に使う。取れなければnull。 */
    detectionTimeMs: number | null;
    detectionTimeIso: string | null;
    hypocenterName: string | null;
    latitude: number | null;
    longitude: number | null;
    depthKm: number | null;
    magnitude: number | null;
    observedMaxIntensityKey: IntensityKey | null;
    /** 事例全体が「キャンセル報」として公開されているか(震央地名の「(キャンセル報)」から判定)。 */
    isCancelEvent: boolean;
  };
  reports: NormalizedReport[];
  warnings: string[];
};

export function buildNormalizedEew(event: RawEvent, reports: RawReport[], fallbackOriginText?: string | null): NormalizedEew {
  const warnings: string[] = [];

  const origin = parseOriginTime(event.occurredAt) || parseOriginTime(fallbackOriginText);
  if (!origin) warnings.push("地震発生時刻を解釈できませんでした。報の絶対時刻は出力されません。");
  else if (origin.precision === "minute") warnings.push("地震発生時刻が分単位のため、秒以下は0として扱っています。");

  // 地震波検知時刻。発生時刻と同じ日(JST)の時刻として絶対時刻にする。
  const detectionClock = parseClockOfDay(event.detectionTime);
  const detectionMs = origin && detectionClock != null ? Math.round(resolveIssuedAtMs(detectionClock, origin.ms)) : null;
  if (event.detectionTime && detectionMs == null) warnings.push("地震波検知時刻を解釈できませんでした。");
  if (!event.detectionTime) warnings.push("地震波検知時刻を取り出せませんでした。リプレイは第1報の少し前から始まります。");

  const latitude = parseCoordinate(event.latitude);
  const longitude = parseCoordinate(event.longitude);
  const rawName = typeof event.hypocenterName === "string" ? event.hypocenterName : "";
  const isCancelEvent = /キャンセル報|取消/.test(rawName);
  const cleanName = rawName.replace(/[(（]\s*(?:キャンセル報|取消[^)）]*)\s*[)）]/g, "").trim();
  const reportsHaveHypocenter = reports.some((r) => r.hypocenter && parseCoordinate(r.hypocenter.latitude) != null && parseCoordinate(r.hypocenter.longitude) != null);
  if ((latitude == null || longitude == null) && !reportsHaveHypocenter) warnings.push("震源の緯度・経度を数値にできませんでした。");

  const sorted = [...reports].sort((a, b) => (a.reportNumber ?? 0) - (b.reportNumber ?? 0));
  const out: NormalizedReport[] = sorted.map((report, index) => {
    const clock = parseClockOfDay(report.providedAt);
    const elapsed = typeof report.elapsedSeconds === "number" && Number.isFinite(report.elapsedSeconds) ? report.elapsedSeconds : null;
    let issuedAtMs: number | null = null;
    let source: NormalizedReport["issuedAtSource"] = null;
    const fromTable = origin && clock != null ? resolveIssuedAtMs(clock, origin.ms) : null;
    // 「地震波検知からの経過時間」は0.1秒単位なので、地震波検知時刻+経過秒を優先する。表の発表時刻(秒単位)と
    // 2秒を超えて食い違う時は、どちらかの読み違いを疑って、表の発表時刻を使い警告を出す。
    const fromDetection = detectionMs != null && elapsed != null ? detectionMs + Math.round(elapsed * 1000) : null;
    if (fromDetection != null && (fromTable == null || Math.abs(fromDetection - fromTable) <= 2000)) {
      issuedAtMs = fromDetection;
      source = "detection+elapsed";
    } else if (fromTable != null) {
      issuedAtMs = fromTable;
      source = "providedAt";
      if (fromDetection != null) warnings.push(`第${report.reportNumber ?? index + 1}報: 地震波検知時刻+経過時間と表の発表時刻が2秒より大きくずれています。表の発表時刻を使いました。`);
    } else if (origin && elapsed != null) {
      issuedAtMs = origin.ms + elapsed * 1000;
      source = "origin+elapsed";
    }

    const areas = (report.forecastIntensityByArea || [])
      .filter((a) => a.area)
      .map((a) => {
        const range = parseIntensityRange(a.expectedMaximumIntensity);
        return { name: String(a.area), minIntensityKey: range.minKey, maxIntensityKey: range.maxKey, openEnded: range.openEnded };
      });
    const longPeriod = (report.forecastLongPeriodByArea || [])
      .filter((a) => a.area && typeof a.expectedLongPeriodClass === "number")
      .map((a) => ({ name: String(a.area), grade: Number(a.expectedLongPeriodClass) }));

    const serial = report.reportNumber ?? index + 1;
    if (!areas.length) warnings.push(`第${serial}報: 予報区ごとの予想震度を取り出せませんでした。`);
    if (issuedAtMs == null) warnings.push(`第${serial}報: 発表時刻を決められませんでした。`);

    const h = report.hypocenter;
    const hypocenter = h
      ? { latitude: parseCoordinate(h.latitude), longitude: parseCoordinate(h.longitude), depthKm: parseDepthKm(h.depth), magnitude: parseMagnitude(h.magnitude) }
      : null;
    const usableHypocenter = hypocenter && hypocenter.latitude != null && hypocenter.longitude != null ? hypocenter : null;

    return {
      serial,
      hypocenter: usableHypocenter,
      isCancel: !!report.isCancel,
      issuedAtMs,
      issuedAtIso: issuedAtMs != null ? toJstIso(issuedAtMs) : null,
      issuedAtSource: source,
      elapsedSeconds: elapsed,
      isFinal: index === sorted.length - 1,
      maxIntensityKey: maxIntensityKey(areas.map((a) => a.maxIntensityKey)),
      areas,
      longPeriod,
    };
  });

  // 発表時刻が報番号順に並んでいるか・発生より前になっていないかを確認する。
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1].issuedAtMs;
    const cur = out[i].issuedAtMs;
    if (prev != null && cur != null && cur < prev) warnings.push(`第${out[i].serial}報の発表時刻が前の報より前になっています。`);
  }
  if (origin) {
    for (const r of out) {
      if (r.issuedAtMs != null && r.issuedAtMs < origin.ms - 60 * 1000) warnings.push(`第${r.serial}報の発表時刻が地震発生より前になっています。`);
    }
  }
  if (!out.length) warnings.push("報が1件も取り出せませんでした。");

  return {
    formatVersion: NORMALIZED_FORMAT_VERSION,
    event: {
      eventId: event.id || "",
      originTimeMs: origin ? origin.ms : null,
      originTimeIso: origin ? toJstIso(origin.ms) : null,
      originTimePrecision: origin ? origin.precision : null,
      detectionTimeMs: detectionMs,
      detectionTimeIso: detectionMs != null ? toJstIso(detectionMs) : null,
      hypocenterName: cleanName || null,
      latitude,
      longitude,
      depthKm: parseDepthKm(event.depth),
      magnitude: parseMagnitude(event.magnitude),
      observedMaxIntensityKey: intensityToKey(event.observedMaximumIntensity ?? undefined),
      isCancelEvent,
    },
    reports: out,
    warnings,
  };
}

/** ダウンロード用のファイル名(例: 20260823_茨城県南部M5.9.eew.json)。 */
export function eewFileName(event: NormalizedEew["event"], fallbackId: string): string {
  const base = event.originTimeMs != null
    ? toJstIso(event.originTimeMs).slice(0, 10).replace(/-/g, "")
    : fallbackId;
  const name = (event.hypocenterName || "").replace(/[\\/:*?"<>|]/g, "");
  const mag = event.magnitude != null ? `M${event.magnitude}` : "";
  return `${base}${name ? "_" + name : ""}${mag}.eew.json`;
}
