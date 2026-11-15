import assert from "node:assert/strict";
import {
  parseCoordinate, parseDepthKm, parseMagnitude, intensityToKey, parseIntensityRange,
  parseOriginTime, parseClockOfDay, extractHypocenterFromText, resolveIssuedAtMs, toJstIso, buildNormalizedEew, eewFileName,
} from "../src/eewExport.ts";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("緯度経度", () => {
  assert.equal(parseCoordinate("北緯36.1度"), 36.1);
  assert.equal(parseCoordinate("東経139.9度"), 139.9);
  assert.equal(parseCoordinate("南緯10.0度"), -10);
  assert.equal(parseCoordinate("西経120.5度"), -120.5);
  assert.ok(Math.abs(parseCoordinate("北緯36度06.0分") - 36.1) < 1e-9);
  assert.equal(parseCoordinate("３６．１"), 36.1);
  assert.equal(parseCoordinate(""), null);
  assert.equal(parseCoordinate(null), null);
});
t("深さ・M", () => {
  assert.equal(parseDepthKm("50 km"), 50);
  assert.equal(parseDepthKm("約１０km"), 10);
  assert.equal(parseDepthKm("ごく浅い"), 0);
  assert.equal(parseDepthKm("---"), null);
  assert.equal(parseMagnitude("Ｍ５．９"), 5.9);
  assert.equal(parseMagnitude("5.9"), 5.9);
  assert.equal(parseMagnitude("—"), null);
});
t("震度キー", () => {
  assert.equal(intensityToKey("５弱"), "5-");
  assert.equal(intensityToKey("震度5強"), "5+");
  assert.equal(intensityToKey("6弱"), "6-");
  assert.equal(intensityToKey("7"), "7");
  assert.equal(intensityToKey("---"), null);
});
t("震度範囲", () => {
  assert.deepEqual(parseIntensityRange("from4to5弱"), { minKey: "4", maxKey: "5-", openEnded: false });
  assert.deepEqual(parseIntensityRange("from0to4"), { minKey: "0", maxKey: "4", openEnded: false });
  assert.deepEqual(parseIntensityRange("5弱"), { minKey: "5-", maxKey: "5-", openEnded: false });
  assert.deepEqual(parseIntensityRange("震度4から5弱"), { minKey: "4", maxKey: "5-", openEnded: false });
  assert.deepEqual(parseIntensityRange("震度5弱程度以上"), { minKey: "5-", maxKey: "5-", openEnded: true });
  assert.deepEqual(parseIntensityRange("from5強to6弱"), { minKey: "5+", maxKey: "6-", openEnded: false });
  assert.deepEqual(parseIntensityRange(""), { minKey: null, maxKey: null, openEnded: false });
});
t("発生時刻", () => {
  const a = parseOriginTime("2026-08-23T02:00:00+09:00");
  assert.equal(a.ms, Date.UTC(2026, 7, 22, 17, 0, 0));
  assert.equal(a.precision, "second");
  const b = parseOriginTime("2026/08/23 02:00");
  assert.equal(b.ms, a.ms);
  assert.equal(b.precision, "minute");
  const c = parseOriginTime("2026年8月3日 2時0分47.5秒");
  assert.equal(c.ms, Date.UTC(2026, 7, 2, 17, 0, 47, 500));
  assert.equal(parseOriginTime("2026/08/3 02:00").ms, Date.UTC(2026, 7, 2, 17, 0, 0));
  assert.equal(parseOriginTime("不明"), null);
});
t("発表時刻の絶対化と日付またぎ", () => {
  const origin = parseOriginTime("2026-08-23T02:00:00+09:00").ms;
  const clock = parseClockOfDay("02時00分50秒");
  assert.equal(resolveIssuedAtMs(clock, origin), origin + 50_000);
  // 23:59:30発生 → 00:00:10発表 は翌日
  const o2 = parseOriginTime("2026-08-23T23:59:30+09:00").ms;
  const c2 = parseClockOfDay("0時0分10秒");
  assert.equal(resolveIssuedAtMs(c2, o2), o2 + 40_000);
  // 分単位切り捨て(02:00)の発生で、02:00:05発表でも前日扱いにならない
  assert.equal(resolveIssuedAtMs(parseClockOfDay("2時0分5秒"), origin), origin + 5000);
  assert.equal(toJstIso(origin + 50_000), "2026-08-23T02:00:50+09:00");
});
t("全体の組み立て(スキーマ例どおりの入力)", () => {
  const out = buildNormalizedEew(
    { id: "jma-202608230200-0", occurredAt: "2026-08-23T02:00:00+09:00", hypocenterName: "茨城県南部",
      latitude: "36.1", longitude: "139.9", depth: "50 km", magnitude: "5.9", observedMaximumIntensity: "５弱" },
    [
      { reportNumber: 2, elapsedSeconds: 6, providedAt: "02時00分56秒",
        forecastIntensityByArea: [{ area: "茨城県南部", expectedMaximumIntensity: "from5弱to5強" }, { area: "千葉県北西部", expectedMaximumIntensity: "from4to5弱" }],
        forecastLongPeriodByArea: [] },
      { reportNumber: 1, elapsedSeconds: 0, providedAt: "02時00分50秒",
        forecastIntensityByArea: [{ area: "茨城県南部", expectedMaximumIntensity: "from4to5弱" }],
        forecastLongPeriodByArea: [{ area: "茨城県南部", expectedLongPeriodClass: 1 }] },
    ],
  );
  assert.equal(out.event.latitude, 36.1);
  assert.equal(out.event.depthKm, 50);
  assert.equal(out.event.magnitude, 5.9);
  assert.equal(out.event.observedMaxIntensityKey, "5-");
  assert.deepEqual(out.reports.map((r) => r.serial), [1, 2]);
  assert.equal(out.reports[0].issuedAtIso, "2026-08-23T02:00:50+09:00");
  assert.equal(out.reports[0].isFinal, false);
  assert.equal(out.reports[1].isFinal, true);
  assert.equal(out.reports[1].maxIntensityKey, "5+");
  assert.deepEqual(out.reports[0].longPeriod, [{ name: "茨城県南部", grade: 1 }]);
  assert.deepEqual(out.warnings, ["地震発生時刻が分単位のため、秒以下は0として扱っています。"].slice(1));
  assert.equal(eewFileName(out.event, "x"), "20260823_茨城県南部M5.9.eew.json");
});
t("欠落時は推測せず警告", () => {
  const out = buildNormalizedEew({ id: "e", occurredAt: "???" }, [{ reportNumber: 1, forecastIntensityByArea: [] }]);
  assert.equal(out.reports[0].issuedAtMs, null);
  assert.ok(out.warnings.some((w) => w.includes("発生時刻")));
  assert.ok(out.warnings.some((w) => w.includes("予想震度")));
  const empty = buildNormalizedEew({ id: "e", occurredAt: "2026-01-01T00:00:00+09:00" }, []);
  assert.ok(empty.warnings.some((w) => w.includes("1件も")));
});
t("elapsedのみの報は発生時刻+経過秒", () => {
  const out = buildNormalizedEew({ id: "e", occurredAt: "2026-08-23T02:00:00+09:00" }, [{ reportNumber: 1, elapsedSeconds: 12.5, forecastIntensityByArea: [{ area: "A", expectedMaximumIntensity: "3" }] }]);
  assert.equal(out.reports[0].issuedAtSource, "origin+elapsed");
  assert.equal(out.reports[0].issuedAtIso, "2026-08-23T02:00:12.500+09:00");
});
t("文章から震源の緯度経度を探す", () => {
  assert.deepEqual(extractHypocenterFromText("震央地名 茨城県南部 北緯36.1度 東経139.9度 深さ50km"), { latitude: 36.1, longitude: 139.9 });
  assert.deepEqual(extractHypocenterFromText("北緯 36度06.0分 東経 139度54.0分"), { latitude: 36.1, longitude: 139.9 });
  assert.deepEqual(extractHypocenterFromText("緯度:36.1 経度:139.9"), { latitude: 36.1, longitude: 139.9 });
  assert.deepEqual(extractHypocenterFromText("36.1°N 139.9°E"), { latitude: 36.1, longitude: 139.9 });
  assert.deepEqual(extractHypocenterFromText("N36.1 E139.9"), { latitude: 36.1, longitude: 139.9 });
  assert.deepEqual(extractHypocenterFromText("南緯10.0度 西経120.5度"), { latitude: -10, longitude: -120.5 });
  assert.deepEqual(extractHypocenterFromText("北緯９９度 東経139.9度"), { latitude: null, longitude: 139.9 });
  assert.deepEqual(extractHypocenterFromText("NHK DOCTYPE html 2026"), { latitude: null, longitude: null });
  assert.deepEqual(extractHypocenterFromText(""), { latitude: null, longitude: null });
});
t("気象庁の表の表記: 度°分′・和暦・キャンセル報", () => {
  assert.ok(Math.abs(parseCoordinate("51°59.1′") - (51 + 59.1 / 60)) < 1e-9);
  assert.ok(Math.abs(parseCoordinate("157°16.2′") - (157 + 16.2 / 60)) < 1e-9);
  assert.equal(parseDepthKm("135km"), 135);
  const o = parseOriginTime("令和 8年10月16日12時38分");
  assert.equal(o.ms, Date.UTC(2026, 9, 16, 3, 38, 0));
  assert.equal(parseOriginTime("令和元年5月1日0時0分").ms, Date.UTC(2019, 3, 30, 15, 0, 0));
  assert.equal(parseOriginTime("平成23年3月11日14時46分").ms, Date.UTC(2011, 2, 11, 5, 46, 0));
  const out = buildNormalizedEew(
    { id: "e", occurredAt: "令和 8年10月16日12時38分", hypocenterName: "カムチャツカ半島付近(キャンセル報)", latitude: "51°59.1′", longitude: "157°16.2′", depth: "135km", magnitude: "6.9", observedMaximumIntensity: "１" },
    [{ reportNumber: 1, providedAt: "12時38分20秒", hypocenter: { latitude: "51°59.1′", longitude: "157°16.2′", depth: "--", magnitude: "6.9" },
       forecastIntensityByArea: [{ area: "根室地方北部", expectedMaximumIntensity: "from5弱to7" }] },
     { reportNumber: 2, providedAt: "12時38分40秒", isCancel: true, forecastIntensityByArea: [] }]);
  assert.equal(out.event.hypocenterName, "カムチャツカ半島付近");
  assert.equal(out.event.isCancelEvent, true);
  assert.ok(Math.abs(out.event.latitude - 51.985) < 0.001);
  assert.equal(out.event.depthKm, 135);
  assert.equal(out.event.originTimeIso, "2026-10-16T12:38:00+09:00");
  assert.equal(out.reports[0].hypocenter.magnitude, 6.9);
  assert.equal(out.reports[0].hypocenter.depthKm, null);
  assert.equal(out.reports[1].isCancel, true);
  assert.equal(out.reports[0].issuedAtIso, "2026-10-16T12:38:20+09:00");
  assert.equal(out.reports[0].maxIntensityKey, "7");
});
console.log(`${n} tests passed`);
