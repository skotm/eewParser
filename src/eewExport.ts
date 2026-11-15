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
  const dms = text.match(/(\d+(?:\.\d+)?)度(\d+(?:\.\d+)?)分/);
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
  const text = value
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, ".")
    .trim();
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

export type RawReport = {
  reportNumber?: number | null;
  elapsedSeconds?: number | null;
  providedAt?: string | null;
  forecastIntensityByArea?: Array<{ area?: string; expectedMaximumIntensity?: string }>;
  forecastLongPeriodByArea?: Array<{ area?: string; expectedLongPeriodClass?: number }>;
};

export type RawEvent = {
  id?: string;
  occurredAt?: string | null;
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
  /** どの値から発表時刻を決めたか。providedAt=表の発表時刻、origin+elapsed=発生時刻+経過秒。 */
  issuedAtSource: "providedAt" | "origin+elapsed" | null;
  elapsedSeconds: number | null;
  /** 最後の報を最終報として扱う(公開履歴には「最終」の明示が無いため)。 */
  isFinal: boolean;
  maxIntensityKey: IntensityKey | null;
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
    hypocenterName: string | null;
    latitude: number | null;
    longitude: number | null;
    depthKm: number | null;
    magnitude: number | null;
    observedMaxIntensityKey: IntensityKey | null;
  };
  reports: NormalizedReport[];
  warnings: string[];
};

export function buildNormalizedEew(event: RawEvent, reports: RawReport[], fallbackOriginText?: string | null): NormalizedEew {
  const warnings: string[] = [];

  const origin = parseOriginTime(event.occurredAt) || parseOriginTime(fallbackOriginText);
  if (!origin) warnings.push("地震発生時刻を解釈できませんでした。報の絶対時刻は出力されません。");
  else if (origin.precision === "minute") warnings.push("地震発生時刻が分単位のため、秒以下は0として扱っています。");

  const latitude = parseCoordinate(event.latitude);
  const longitude = parseCoordinate(event.longitude);
  if (latitude == null || longitude == null) warnings.push("震源の緯度・経度を数値にできませんでした。");

  const sorted = [...reports].sort((a, b) => (a.reportNumber ?? 0) - (b.reportNumber ?? 0));
  const out: NormalizedReport[] = sorted.map((report, index) => {
    const clock = parseClockOfDay(report.providedAt);
    const elapsed = typeof report.elapsedSeconds === "number" && Number.isFinite(report.elapsedSeconds) ? report.elapsedSeconds : null;
    let issuedAtMs: number | null = null;
    let source: NormalizedReport["issuedAtSource"] = null;
    if (origin && clock != null) {
      issuedAtMs = resolveIssuedAtMs(clock, origin.ms);
      source = "providedAt";
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

    return {
      serial,
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
      hypocenterName: event.hypocenterName || null,
      latitude,
      longitude,
      depthKm: parseDepthKm(event.depth),
      magnitude: parseMagnitude(event.magnitude),
      observedMaxIntensityKey: intensityToKey(event.observedMaximumIntensity ?? undefined),
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
