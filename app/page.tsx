"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptResult } from "@/lib/youtube";
import {
  countWords,
  formatTimestamp,
  MIME,
  safeFilename,
  toMarkdown,
  toParagraphs,
  toSrt,
  toTxt,
  toVtt,
  type ExportFormat,
} from "@/lib/format";

const EXAMPLE = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

export default function Home() {
  const [input, setInput] = useState("");
  const [data, setData] = useState<TranscriptResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [showTime, setShowTime] = useState(true);
  const [paragraphs, setParagraphs] = useState(false);
  const [follow, setFollow] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [toast, setToast] = useState("");

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (value: string, lang?: string) => {
    if (!value.trim()) return;
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams({ url: value.trim() });
      if (lang) qs.set("lang", lang);
      const res = await fetch(`/api/transcript?${qs}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Gagal mengambil transkrip.");
      const result = json as TranscriptResult;
      setData(result);
      setCurrentTime(0);
      const url = new URL(window.location.href);
      url.search = "";
      url.searchParams.set("v", result.videoId);
      if (lang) url.searchParams.set("lang", lang);
      window.history.replaceState(null, "", url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Deep links: /?v=VIDEO_ID&lang=en
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get("v") ?? params.get("url");
    if (v) {
      setInput(v.length === 11 ? `https://youtu.be/${v}` : v);
      load(v, params.get("lang") ?? undefined);
    }
  }, [load]);

  // Receive current playback time from the embedded player.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      try {
        if (!/youtube(-nocookie)?\.com$/.test(new URL(e.origin).hostname)) return;
        const msg = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        const t = msg?.info?.currentTime;
        if (typeof t === "number") setCurrentTime(t);
      } catch {
        // ignore
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const segments = useMemo(
    () => (data ? (paragraphs ? toParagraphs(data.segments) : data.segments) : []),
    [data, paragraphs],
  );

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => segments.map((s, i) => ({ ...s, i })).filter((s) => !q || s.text.toLowerCase().includes(q)),
    [segments, q],
  );

  const activeIndex = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].start <= currentTime + 0.25) idx = i;
      else break;
    }
    return idx;
  }, [segments, currentTime]);

  useEffect(() => {
    if (!follow || q || activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-i="${activeIndex}"]`);
    if (!el) return;
    const box = listRef.current;
    box.scrollTo({ top: el.offsetTop - box.offsetTop - box.clientHeight / 3, behavior: "smooth" });
  }, [activeIndex, follow, q]);

  const stats = useMemo(() => {
    if (!data) return null;
    const words = countWords(data.segments);
    return { words, minutes: Math.max(1, Math.round(words / 230)) };
  }, [data]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 1800);
  };

  const postToPlayer = (func: string, args: unknown[] = []) =>
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");

  const seek = (t: number) => {
    postToPlayer("seekTo", [t, true]);
    postToPlayer("playVideo");
    setCurrentTime(t);
  };

  const onPlayerLoad = () => {
    // Ask the player to stream state updates (currentTime) via postMessage.
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), "*");
  };

  const render = (format: ExportFormat) => {
    if (!data) return "";
    switch (format) {
      case "srt":
        return toSrt(segments);
      case "vtt":
        return toVtt(segments);
      case "md":
        return toMarkdown(segments, data);
      case "json":
        return JSON.stringify({ ...data, segments }, null, 2);
      default:
        return toTxt(segments, showTime);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(render("txt"));
      flash("Transkrip disalin ✓");
    } catch {
      flash("Gagal menyalin");
    }
  };

  const download = (format: ExportFormat) => {
    if (!data) return;
    const blob = new Blob([render(format)], { type: MIME[format] });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${safeFilename(data.title || data.videoId)}.${data.language.code}.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setQuery("");
    load(input);
  };

  const langValue = data ? data.language.code + (data.language.translated ? "" : data.language.auto ? ":asr" : "") : "";

  const onLangChange = (value: string) => {
    if (!data) return;
    load(data.videoId, value);
  };

  return (
    <main className="wrap">
      <header className="hero">
        <div className="brand">
          <svg viewBox="0 0 64 64" aria-hidden>
            <rect width="64" height="64" rx="14" fill="currentColor" />
            <path d="M25 20v24l19-12z" fill="#fff" />
          </svg>
          <span>TranscribeYT</span>
        </div>
        <h1>Transkrip video YouTube, lengkap &amp; instan.</h1>
        <p className="muted">
          Tempel link video → dapatkan transkrip penuh dengan timestamp. Cari, terjemahkan, salin, atau unduh sebagai TXT,
          SRT, VTT, Markdown, dan JSON.
        </p>

        <form className="search" onSubmit={onSubmit}>
          <input
            type="text"
            inputMode="url"
            autoFocus
            placeholder="https://www.youtube.com/watch?v=..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label="URL video YouTube"
          />
          <button type="submit" className="primary" disabled={loading || !input.trim()}>
            {loading ? <span className="spinner" /> : "Transkrip"}
          </button>
        </form>
        {!data && !loading && (
          <button
            className="link"
            onClick={() => {
              setInput(EXAMPLE);
              load(EXAMPLE);
            }}
          >
            Coba contoh video
          </button>
        )}
        {error && <div className="error">⚠️ {error}</div>}
      </header>

      {data && (
        <section className="result">
          <aside className="side">
            <div className="player">
              <iframe
                ref={iframeRef}
                key={data.videoId}
                src={`https://www.youtube-nocookie.com/embed/${data.videoId}?enablejsapi=1&rel=0`}
                title={data.title}
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                onLoad={onPlayerLoad}
              />
            </div>
            <h2 className="title">{data.title}</h2>
            <p className="muted small">{data.author}</p>
            <div className="chips">
              {data.lengthSeconds > 0 && <span className="chip">⏱ {formatTimestamp(data.lengthSeconds)}</span>}
              <span className="chip">📝 {stats?.words.toLocaleString("id-ID")} kata</span>
              <span className="chip">📖 ~{stats?.minutes} mnt baca</span>
              <span className="chip">
                🌐 {data.language.name}
                {data.language.translated ? " (terjemahan)" : data.language.auto ? " (otomatis)" : ""}
              </span>
            </div>

            <label className="field">
              <span>Bahasa</span>
              <select value={langValue} onChange={(e) => onLangChange(e.target.value)} disabled={loading}>
                <optgroup label="Tersedia">
                  {data.languages.map((l) => (
                    <option key={l.code + l.auto} value={l.code + (l.auto ? ":asr" : "")}>
                      {l.name}
                      {l.auto && !/auto/i.test(l.name) ? " (otomatis)" : ""}
                    </option>
                  ))}
                </optgroup>
                {data.translationLanguages.length > 0 && (
                  <optgroup label="Terjemahan otomatis">
                    {data.translationLanguages.map((l) => (
                      <option key={`t-${l.code}`} value={l.code}>
                        {l.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>

            <div className="actions">
              <button className="primary block" onClick={copy}>
                📋 Salin transkrip
              </button>
              <div className="grid">
                {(["txt", "srt", "vtt", "md", "json"] as ExportFormat[]).map((f) => (
                  <button key={f} onClick={() => download(f)}>
                    ⬇ {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </aside>

          <div className="panel">
            <div className="toolbar">
              <input
                type="search"
                placeholder="Cari di transkrip…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {q && <span className="muted small nowrap">{visible.length} hasil</span>}
              <div className="toggles">
                <Toggle label="Timestamp" checked={showTime} onChange={setShowTime} />
                <Toggle label="Paragraf" checked={paragraphs} onChange={setParagraphs} />
                <Toggle label="Ikuti video" checked={follow} onChange={setFollow} />
              </div>
            </div>

            <div className={`lines${loading ? " dim" : ""}`} ref={listRef}>
              {visible.length === 0 && <p className="muted center">Tidak ada hasil untuk “{query}”.</p>}
              {visible.map((s) => (
                <div key={s.i} data-i={s.i} className={`line${s.i === activeIndex ? " active" : ""}`}>
                  {showTime && (
                    <button className="ts" onClick={() => seek(s.start)} title="Putar dari sini">
                      {formatTimestamp(s.start)}
                    </button>
                  )}
                  <p onDoubleClick={() => seek(s.start)}>
                    <Highlight text={s.text} query={q} />
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <footer className="foot muted small">
        API: <code>/api/transcript?url=…&amp;lang=id&amp;format=txt|srt|vtt|md|json</code>
      </footer>

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return (
    <>
      {parts.map((p, i) => (p.toLowerCase() === query ? <mark key={i}>{p}</mark> : p))}
    </>
  );
}
