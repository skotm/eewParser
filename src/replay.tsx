import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import maplibregl, { Map as MapLibreMap, GeoJSONSource } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import "./replay.css";

type Forecast = { area?: string; expectedMaximumIntensity?: string };
type ReplayReport = {
  reportNumber?: number;
  elapsedSeconds?: number | null;
  providedAt?: string | null;
  forecastIntensityByArea?: Forecast[];
  forecastLongPeriodByArea?: { area?: string; expectedLongPeriodClass?: number }[];
};
type EewData = {
  schemaVersion?: string;
  event?: {
    id?: string; occurredAt?: string; hypocenterName?: string;
    latitude?: string | number | null; longitude?: string | number | null;
    depth?: string | number | null; magnitude?: string | number | null;
    observedMaximumIntensity?: string | null;
  };
  reports?: ReplayReport[];
  source?: { provider?: string; detailUrl?: string };
};

const numberValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[度°東経北緯km]/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
// 気象庁の履歴JSONに混入する震度表記の欠落を補正する。
const normalizeIntensityText = (value: string) => {
  const normalized = value.replace(/\s/g, "").trim();
  if (normalized === "震度程度") return "震度0程度";
  // 「震度から震度4程度」「震度から震度5弱程度」など、範囲の下限が欠落した表記を補正。
  const missingLowerBound = normalized.match(/^震度から震度(.+程度)$/);
  if (missingLowerBound) return `震度0から震度${missingLowerBound[1]}`;
  return normalized;
};

const intensityRank = (value: string) => {
  const normalized = normalizeIntensityText(value).replace(/震度/g, "").replace(/\s/g, "").trim();
  const map: Record<string, number> = { "0":0, "1":1, "2":2, "3":3, "4":4, "5弱":5, "5強":6, "6弱":7, "6強":8, "7":9 };
  // EEWの「from5弱to6弱」等は、範囲の最大側（to側）で塗り分ける。
  const rangeEnd = normalized.match(/(?:to|〜|～|-)(震度)?(5弱|5強|6弱|6強|7|[0-4])$/);
  if (rangeEnd) return map[rangeEnd[2]] ?? 0;
  const plain = normalized.match(/(5弱|5強|6弱|6強|7|[0-4])$/);
  return plain ? (map[plain[1]] ?? 0) : 0;
};
const intensityColor: Record<number, string> = {
  0: "#dce8f2",
  1: "#f2f2f2",
  2: "#00a0e9",
  3: "#0041ff",
  4: "#f2e700",
  5: "#f39800",
  6: "#e60012",
  7: "#a50021",
  8: "#7f0060",
  9: "#b40068"
};
const formatClock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
};

export default function ReplayApp() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<EewData | null>(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [elapsed, setElapsed] = useState(0);
  const lastTick = useRef<number | null>(null);
  const event = data?.event;
  const reports = useMemo(() => (data?.reports || []).map((report, index) => ({
    ...report,
    reportNumber: report.reportNumber ?? index + 1,
    elapsedSeconds: typeof report.elapsedSeconds === "number" && Number.isFinite(report.elapsedSeconds) ? report.elapsedSeconds : index * 5,
  })).sort((a, b) => a.elapsedSeconds - b.elapsedSeconds), [data]);
  const duration = reports.length ? Math.max(1, reports[reports.length - 1].elapsedSeconds) : 0;
  const activeIndex = reports.reduce((found, report, index) => report.elapsedSeconds <= elapsed ? index : found, -1);
  const activeReport = activeIndex >= 0 ? reports[activeIndex] : null;
  const lat = numberValue(event?.latitude);
  const lon = numberValue(event?.longitude);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      center: [139.7, 35.7],
      zoom: 4.2,
      style: {
        version: 8,
        sources: {},
        layers: [{ id: "water-background", type: "background", paint: { "background-color": "#bfe8f5" } }]
      }
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    mapRef.current = map;
    map.on("load", async () => {
      map.resize();
      try {
        const [worldResponse, subdivisionResponse] = await Promise.all([
          fetch("./data/world.json"),
          fetch("./data/%E7%B4%B0%E5%88%86%E5%8C%BA%E5%9F%9F.json")
        ]);
        if (!subdivisionResponse.ok) {
          throw new Error("細分区域.json を読み込めません。public/data/細分区域.json を確認してください。");
        }
        const subdivisions = await subdivisionResponse.json();
        // world.json が配置されている場合は陸地を描画。未配置でも海と細分区域は表示する。
        if (worldResponse.ok) {
          const worldRaw = await worldResponse.json();
          const worldFeatures = Array.isArray(worldRaw.features)
            ? worldRaw.features
            : (worldRaw.geometries || []).map((geometry: GeoJSON.Geometry) => ({
                type: "Feature", properties: {}, geometry
              }));
          map.addSource("world-land", {
            type: "geojson", data: { type: "FeatureCollection", features: worldFeatures }
          });
          map.addLayer({
            id: "world-land-fill", type: "fill", source: "world-land",
            paint: { "fill-color": "#f2f3ef", "fill-opacity": 1 }
          });
        }
        map.addSource("jma-subdivisions", { type: "geojson", data: subdivisions });
        map.addLayer({
          id: "jma-subdivision-fill", type: "fill", source: "jma-subdivisions",
          paint: {
            "fill-color": ["match", ["get", "intensityRank"],
              1, "#f2f2f2", 2, "#00a0e9", 3, "#0041ff", 4, "#f2e700",
              5, "#f39800", 6, "#e60012", 7, "#a50021", 8, "#7f0060",
              9, "#b40068", "#f2f3ef"],
            // 予想震度がない区域は陸地色で不透明に描画し、海色が透けないようにする。
            "fill-opacity": ["case", [">", ["get", "intensityRank"], 0], 0.82, 1]
          }
        });
        map.addLayer({
          id: "jma-subdivision-outline", type: "line", source: "jma-subdivisions",
          paint: { "line-color": "#647f96", "line-width": 0.7, "line-opacity": 0.85 }
        });
        subdivisionDataRef.current = subdivisions;
        updateIntensityFill(activeReport?.forecastIntensityByArea || []);
      } catch (cause) {
        console.error("Map data loading failed", cause);
        setError(cause instanceof Error ? cause.message : "地図データの読み込みに失敗しました。");
      }
    });
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(mapContainer.current);
    return () => { resizeObserver.disconnect(); map.remove(); mapRef.current = null; };
  }, [data]);

  const subdivisionDataRef = useRef<any>(null);
  const updateIntensityFill = (forecasts: Forecast[]) => {
    const map = mapRef.current;
    const raw = subdivisionDataRef.current;
    if (!map || !raw || !map.getSource("jma-subdivisions")) return;
    const byArea = new Map<string, number>();
    forecasts.forEach(item => {
      const rank = intensityRank(item.expectedMaximumIntensity || "");
      if (item.area && rank > 0) byArea.set(item.area.trim(), rank);
    });
    const features = (raw.features || []).map((feature: any) => {
      const name = String(feature.properties?.name || "").trim();
      return { ...feature, properties: { ...feature.properties, intensityRank: byArea.get(name) || 0 } };
    });
    (map.getSource("jma-subdivisions") as GeoJSONSource).setData({ type: "FeatureCollection", features });
  };

  useEffect(() => {
    updateIntensityFill(activeReport?.forecastIntensityByArea || []);
  }, [activeReport]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const valid = lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    const point = valid ? { type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: [lon!, lat!] } } : { type: "FeatureCollection" as const, features: [] };
    const elapsedRadiusKm = Math.max(0, elapsed) * 3.5;
    const circleCoords: number[][] = [];
    if (valid && elapsedRadiusKm > 0) {
      for (let i = 0; i <= 96; i++) {
        const angle = (i / 96) * Math.PI * 2;
        const dLat = (elapsedRadiusKm / 111.32) * Math.cos(angle);
        const dLon = (elapsedRadiusKm / (111.32 * Math.max(0.15, Math.cos((lat! * Math.PI) / 180)))) * Math.sin(angle);
        circleCoords.push([lon! + dLon, lat! + dLat]);
      }
    }
    const wave = valid && circleCoords.length ? { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [circleCoords] } } : { type: "FeatureCollection" as const, features: [] };
    const update = () => {
      if (!map.getSource("hypocenter")) {
        map.addSource("hypocenter", { type: "geojson", data: point as Feature | FeatureCollection });
        map.addLayer({ id: "hypocenter-halo", type: "circle", source: "hypocenter", paint: { "circle-radius": 12, "circle-color": "#e44b45", "circle-opacity": 0.18 } });
        map.addLayer({ id: "hypocenter-dot", type: "circle", source: "hypocenter", paint: { "circle-radius": 5, "circle-color": "#d93636", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
        map.addSource("wavefront", { type: "geojson", data: wave as Feature | FeatureCollection });
        map.addLayer({ id: "wavefront-fill", type: "fill", source: "wavefront", paint: { "fill-color": "#e44b45", "fill-opacity": 0.08 } });
        map.addLayer({ id: "wavefront-line", type: "line", source: "wavefront", paint: { "line-color": "#e44b45", "line-width": 2, "line-dasharray": [2, 2] } });
      } else {
        (map.getSource("hypocenter") as GeoJSONSource).setData(point as Feature | FeatureCollection);
        (map.getSource("wavefront") as maplibregl.GeoJSONSource).setData(wave as Feature | FeatureCollection);
      }
    };
    if (map.isStyleLoaded()) update(); else map.once("load", update);
  }, [lat, lon, elapsed]);

  useEffect(() => {
    if (!playing) { lastTick.current = null; return; }
    let frame = 0;
    const tick = (now: number) => {
      if (lastTick.current === null) lastTick.current = now;
      const delta = (now - lastTick.current) / 1000;
      lastTick.current = now;
      setElapsed(current => {
        const next = current + delta * speed;
        if (next >= duration) { setPlaying(false); return duration; }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, duration]);

  useEffect(() => { setElapsed(0); setPlaying(false); }, [data]);

  async function loadFile(file?: File) {
    if (!file) return;
    setError("");
    try {
      const parsed = JSON.parse(await file.text()) as EewData;
      if (!parsed || typeof parsed !== "object" || !parsed.event || !Array.isArray(parsed.reports)) {
        throw new Error("event と reports を含む JmaEewParser のJSONを選択してください。");
      }
      setData(parsed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "JSONを読み込めませんでした。");
    }
  }
  function seek(value: number) {
    setElapsed(Math.max(0, Math.min(duration, value)));
  }
  function togglePlayback() {
    if (!reports.length) return;
    if (playing) { setPlaying(false); return; }
    if (elapsed >= duration) setElapsed(0);
    setPlaying(true);
  }

  return <div className="replay-app">
    <header className="replay-header">
      <a className="replay-brand" href="./index.html"><span className="replay-logo">JMA</span><span><b>JmaEewParser</b><small>EARTHQUAKE EARLY WARNING REPLAY</small></span></a>
      <div className="replay-header-right"><span className="live-indicator"><i /> HISTORY MODE</span><a href="./index.html">← 解析ページ</a></div>
    </header>
    <main className="replay-main">
      <section className="replay-heading"><div><p className="replay-eyebrow">HISTORICAL SIMULATION</p><h1>緊急地震速報 Replay</h1><p>過去の解析JSONを読み込み、報ごとの変化を時間軸に沿って再生します。</p></div>
        <button className="replay-load-button" onClick={() => fileRef.current?.click()}>＋ JSONを読み込む</button><input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={e => { void loadFile(e.target.files?.[0]); e.currentTarget.value = ""; }} />
      </section>
      {error && <div className="replay-error" role="alert">{error}</div>}
      {!data ? <section className="replay-empty"><div className="replay-empty-icon">↗</div><h2>再生する地震データを読み込む</h2><p>解析ページで作成したJSONファイルを選択してください。</p><button className="replay-primary" onClick={() => fileRef.current?.click()}>JSONファイルを選択</button><small>対応形式：JmaEewParser schemaVersion 1.x / event + reports</small></section> :
      <>
        <section className="replay-eventbar">
          <div className="replay-event-title"><span className="replay-tag">過去事例</span><h2>{event?.hypocenterName || "震源情報なし"}</h2><p>{event?.occurredAt || "発生時刻不明"} <span>·</span> Event ID {event?.id || "—"}</p></div>
          <div className="replay-stat"><small>マグニチュード</small><strong>{event?.magnitude ? `M ${event.magnitude}` : "—"}</strong></div>
          <div className="replay-stat"><small>深さ</small><strong>{event?.depth ? `${event.depth} km` : "—"}</strong></div>
          <div className="replay-stat"><small>観測最大震度</small><strong>{event?.observedMaximumIntensity || "—"}</strong></div>
        </section>
        <section className="replay-workspace">
          <div className="replay-map-panel"><div className="replay-map-title"><div><p className="replay-eyebrow">MAP VIEW</p><h3>震源・波面の参考表示</h3></div><span className="map-legend"><i />震源</span></div><div className="replay-map" ref={mapContainer} />
            <div className="replay-map-note">波面は経過時間を示すための概念表示（仮定速度 3.5 km/s）です。実際の地震波到達・震度分布の予測ではありません。背景の水色は海域、区域の色は速報データに含まれる予想震度です。色が付かない区域は予想震度データがありません。</div>
          </div>
          <aside className="replay-side">
            <div className="replay-side-title"><div><p className="replay-eyebrow">CURRENT REPORT</p><h3>速報内容</h3></div><span className="replay-report-badge">{activeReport ? `第${activeReport.reportNumber}報` : "開始前"}</span></div>
            {activeReport ? <div className="replay-report-content">
              <div className="replay-report-time"><small>発表時刻（原表記）</small><strong>{activeReport.providedAt || "記録なし"}</strong></div>
              <div className="replay-report-time"><small>発生からの経過</small><strong>{formatClock(activeReport.elapsedSeconds)}</strong></div>
              <h4>予想震度</h4>
              {activeReport.forecastIntensityByArea?.length ? <div className="replay-intensity-list">{[...activeReport.forecastIntensityByArea].sort((a,b)=>intensityRank(b.expectedMaximumIntensity || "")-intensityRank(a.expectedMaximumIntensity || "")).map((item,i)=><div className="replay-intensity-row" key={(item.area || "地域不明") + i}><span>{item.area || "地域不明"}</span><b className={`intensity-rank rank-${intensityRank(item.expectedMaximumIntensity || "")}`}>{item.expectedMaximumIntensity ? normalizeIntensityText(item.expectedMaximumIntensity).replace(/^from/, "").replace(/^(.+)to(.+)$/, "$1〜$2") : "—"}</b></div>)}</div> : <p className="replay-muted">この報に対応する予想震度データはありません。</p>}
              {activeReport.forecastLongPeriodByArea?.length ? <><h4>長周期地震動階級</h4><div className="replay-intensity-list">{activeReport.forecastLongPeriodByArea.map((item,i)=><div className="replay-intensity-row" key={(item.area || "地域不明") + i}><span>{item.area || "地域不明"}</span><b>階級 {item.expectedLongPeriodClass ?? "—"}</b></div>)}</div></> : null}
            </div> : <div className="replay-before">再生を開始すると、該当する報の内容がここに表示されます。</div>}
            <div className="replay-report-count"><span>読み込んだ報</span><b>{reports.length} 報</b></div>
          </aside>
        </section>
        <section className="replay-player">
          <div className="replay-player-top"><div><p className="replay-eyebrow">TIMELINE PLAYER</p><h3>速報の時間変化</h3></div><div className="replay-speed"><label htmlFor="replay-speed">再生速度</label><select id="replay-speed" value={speed} onChange={e=>setSpeed(Number(e.target.value))}><option value={0.25}>0.25×</option><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option><option value={8}>8×</option></select></div></div>
          <div className="replay-range-row"><span>{formatClock(elapsed)}</span><input aria-label="再生位置" type="range" min={0} max={Math.max(1,duration)} step={0.1} value={Math.min(elapsed,Math.max(1,duration))} onChange={e=>{setPlaying(false);seek(Number(e.target.value));}}/><span>{formatClock(duration)}</span></div>
          <div className="replay-report-ticks">{reports.map((report,index)=><button key={`${report.reportNumber}-${index}`} className={index===activeIndex?"active":""} style={{left:`${duration ? report.elapsedSeconds/duration*100 : 0}%`}} title={`第${report.reportNumber}報 · ${formatClock(report.elapsedSeconds)}`} onClick={()=>{setPlaying(false);seek(report.elapsedSeconds);}}><i /><span>第{report.reportNumber}報</span></button>)}</div>
          <div className="replay-controls"><div className="replay-transport"><button aria-label="最初へ" title="最初へ" onClick={()=>{setPlaying(false);seek(0);}}>↤</button><button aria-label="前の報" title="前の報" onClick={()=>{setPlaying(false);seek(activeIndex>0?reports[activeIndex-1].elapsedSeconds:0);}}>‹</button><button className="replay-play" onClick={togglePlayback} disabled={!reports.length}>{playing ? "Ⅱ 一時停止" : "▶ 再生"}</button><button aria-label="次の報" title="次の報" onClick={()=>{setPlaying(false);seek(activeIndex<reports.length-1?reports[activeIndex+1].elapsedSeconds:duration);}}>›</button><button aria-label="最後へ" title="最後へ" onClick={()=>{setPlaying(false);seek(duration);}}>↦</button></div><button className="replay-reset" onClick={()=>{setPlaying(false);seek(0);}}>最初から</button></div>
          <p className="replay-timing-note">経過時間が記録された報はその秒数に合わせて再生します。経過時間がない報は表示順に5秒間隔で仮配置されます。</p>
        </section>
      </>}
      <footer className="replay-footer">JmaEewParser · Historical replay only <span>現在の緊急地震速報・防災判断には使用しないでください。</span></footer>
    </main>
  </div>;
}


const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<ReplayApp />);
