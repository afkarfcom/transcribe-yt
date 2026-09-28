import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

export type Segment = {
  /** start time in seconds */
  start: number;
  /** duration in seconds */
  dur: number;
  text: string;
};

export type Language = {
  code: string;
  name: string;
  /** true when the track is auto-generated (ASR) */
  auto: boolean;
  /** true when the language is produced via YouTube auto-translate */
  translated?: boolean;
};

export type TranscriptResult = {
  videoId: string;
  title: string;
  author: string;
  lengthSeconds: number;
  thumbnail: string;
  language: Language;
  languages: Language[];
  translationLanguages: { code: string; name: string }[];
  segments: Segment[];
};

export class TranscriptError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type Text = { simpleText?: string; runs?: { text: string }[] };

type CaptionTrack = {
  baseUrl: string;
  languageCode: string;
  name?: Text;
  kind?: string;
  isTranslatable?: boolean;
};

type PlayerResponse = {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    lengthSeconds?: string;
    thumbnail?: { thumbnails?: { url: string; width?: number }[] };
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
      translationLanguages?: { languageCode: string; languageName?: Text }[];
    };
  };
};

type WatchPage = {
  apiKey?: string;
  clientVersion?: string;
  visitorData?: string;
  transcriptParams?: string;
  player?: PlayerResponse;
  blocked?: boolean;
};

type Found = Pick<TranscriptResult, "language" | "languages" | "translationLanguages" | "segments">;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// Innertube player clients tried in order. The embedded/TV clients are
// usually exempt from the "confirm you're not a bot" check YouTube applies
// to datacenter IPs (e.g. Vercel); mobile clients return caption URLs that
// work without a PO token.
const CLIENTS: { context: Record<string, unknown>; userAgent?: string; embed?: boolean }[] = [
  { context: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0" }, embed: true },
  { context: { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "1.20250910.01.00" }, embed: true },
  {
    context: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, osName: "Android", osVersion: "14" },
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
  },
  {
    context: { clientName: "IOS", clientVersion: "20.10.4", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82" },
    userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
  },
  {
    context: { clientName: "TVHTML5", clientVersion: "7.20250910.13.00" },
    userAgent: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
  },
  {
    context: { clientName: "MWEB", clientVersion: "2.20250910.01.00" },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
  },
];

let dispatcher: Dispatcher | undefined;
function getDispatcher(): Dispatcher | undefined {
  const proxy = process.env.TRANSCRIPT_PROXY_URL?.trim();
  if (!proxy) return undefined;
  dispatcher ??= new ProxyAgent(proxy);
  return dispatcher;
}

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

async function ytFetch(url: string, init: FetchInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    "accept-language": "en-US,en;q=0.9",
    ...init.headers,
  };
  // SOCS/CONSENT skip the EU cookie consent page. YOUTUBE_COOKIE (optional)
  // makes requests run as a logged-in session, which avoids most bot checks.
  const extra = process.env.YOUTUBE_COOKIE?.trim();
  headers.cookie = ["CONSENT=YES+cb; SOCS=CAI", extra].filter(Boolean).join("; ");

  const options = { ...init, headers, signal: AbortSignal.timeout(12_000) };
  const d = getDispatcher();
  if (d) return (await undiciFetch(url, { ...options, dispatcher: d })) as unknown as Response;
  return fetch(url, { ...options, cache: "no-store" });
}

/** Extracts an 11-character YouTube video id from a URL or raw id. */
export function extractVideoId(input: string): string | null {
  const value = input.trim();
  if (/^[\w-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    const host = url.hostname.replace(/^(www\.|m\.|music\.)/, "");
    if (host === "youtu.be") {
      const id = url.pathname.slice(1, 12);
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const v = url.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const match = url.pathname.match(/^\/(?:shorts|embed|live|v|e)\/([\w-]{11})/);
      if (match) return match[1];
    }
  } catch {
    // not a URL
  }
  return null;
}

function textOf(value?: Text): string {
  if (!value) return "";
  return value.simpleText ?? value.runs?.map((r) => r.text).join("") ?? "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function cleanText(raw: string): string {
  // Captions can be double-encoded, and may contain inline tags like <font>.
  return decodeEntities(decodeEntities(raw).replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Parses both the classic (`<text start dur>`) and srv3 (`<p t d>`) caption formats. */
export function parseCaptionXml(xml: string): Segment[] {
  const segments: Segment[] = [];
  const classic = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  const srv3 = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  const attr = (attrs: string, name: string) => {
    const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? Number(m[1]) : NaN;
  };

  let m: RegExpExecArray | null;
  while ((m = classic.exec(xml))) {
    const text = cleanText(m[2]);
    if (!text) continue;
    segments.push({ start: attr(m[1], "start") || 0, dur: attr(m[1], "dur") || 0, text });
  }
  if (segments.length) return segments;

  while ((m = srv3.exec(xml))) {
    const text = cleanText(m[2]);
    if (!text) continue;
    segments.push({ start: (attr(m[1], "t") || 0) / 1000, dur: (attr(m[1], "d") || 0) / 1000, text });
  }
  return segments;
}

/* ---------------------------- languages ---------------------------- */

let nameToCode: Map<string, string> | undefined;
/** "English (auto-generated)" -> "en" */
export function codeFromName(name: string): string | undefined {
  if (!nameToCode) {
    nameToCode = new Map();
    const dn = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
    const codes = ["zh-Hans", "zh-Hant", "pt-BR", "pt-PT", "es-419", "fil", "haw", "ceb", "hmn"];
    for (let a = 97; a <= 122; a++) for (let b = 97; b <= 122; b++) codes.push(String.fromCharCode(a, b));
    for (const code of codes) {
      const n = dn.of(code)?.toLowerCase();
      if (n && !nameToCode.has(n)) nameToCode.set(n, code);
    }
  }
  const clean = name.replace(/\(.*?\)/g, "").trim().toLowerCase();
  return nameToCode.get(clean) ?? nameToCode.get(clean.split(/[\s,]/)[0]);
}

function nameFromCode(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function parseLang(lang?: string): { code?: string; asr: boolean } {
  if (!lang) return { asr: false };
  return { code: lang.replace(/:asr$/, "").toLowerCase(), asr: lang.endsWith(":asr") };
}

/* ------------------- strategy 1: player caption tracks ------------------- */

async function fetchWatchPage(videoId: string): Promise<WatchPage> {
  const res = await ytFetch(`https://www.youtube.com/watch?v=${videoId}&hl=en&bpctr=9999999999&has_verified=1`);
  if (!res.ok) return { blocked: res.status === 429 };
  const html = await res.text();
  const page: WatchPage = {
    apiKey: html.match(/"INNERTUBE_API_KEY":\s*"([\w-]+)"/)?.[1],
    clientVersion: html.match(/"INNERTUBE_CLIENT_VERSION":\s*"([\d.]+)"/)?.[1],
    visitorData: html.match(/"VISITOR_DATA":\s*"([^"]+)"/)?.[1],
    transcriptParams: html.match(/"getTranscriptEndpoint":\s*\{\s*"params":\s*"([^"]+)"/)?.[1],
    blocked: html.includes('class="g-recaptcha"'),
  };
  const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s+meta|<\/script|\n)/);
  if (playerMatch) {
    try {
      page.player = JSON.parse(playerMatch[1]);
    } catch {
      // ignore
    }
  }
  return page;
}

async function fetchPlayer(videoId: string, client: (typeof CLIENTS)[number], page: WatchPage) {
  const url = `https://www.youtube.com/youtubei/v1/player?prettyPrint=false${page.apiKey ? `&key=${page.apiKey}` : ""}`;
  const body = {
    context: {
      client: { ...client.context, hl: "en", gl: "US", visitorData: page.visitorData },
      ...(client.embed ? { thirdParty: { embedUrl: `https://www.youtube.com/embed/${videoId}` } } : {}),
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: "https://www.youtube.com",
    "x-youtube-client-version": String(client.context.clientVersion),
  };
  if (client.userAgent) headers["user-agent"] = client.userAgent;
  if (page.visitorData) headers["x-goog-visitor-id"] = page.visitorData;
  try {
    const res = await ytFetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    return res.ok ? ((await res.json()) as PlayerResponse) : undefined;
  } catch {
    return undefined;
  }
}

function pickTrack(tracks: CaptionTrack[], lang?: string): { track: CaptionTrack; tlang?: string } | null {
  const want = parseLang(lang);
  if (!want.code) return { track: tracks.find((t) => t.kind !== "asr") ?? tracks[0] };

  const same = (t: CaptionTrack) => t.languageCode.toLowerCase() === want.code;
  const exact = tracks.find((t) => same(t) && (t.kind === "asr") === want.asr) ?? tracks.find(same);
  if (exact) return { track: exact };
  const base = want.code.split("-")[0];
  const loose = tracks.find((t) => t.languageCode.toLowerCase().split("-")[0] === base);
  if (loose) return { track: loose };
  // Fall back to YouTube auto-translate.
  const translatable = tracks.find((t) => t.isTranslatable && t.kind !== "asr") ?? tracks.find((t) => t.isTranslatable);
  return translatable ? { track: translatable, tlang: want.code } : null;
}

async function downloadTrack(baseUrl: string, tlang?: string): Promise<Segment[]> {
  try {
    const url = new URL(baseUrl.replace(/&fmt=[^&]*/, ""), "https://www.youtube.com");
    if (tlang) url.searchParams.set("tlang", tlang);
    const res = await ytFetch(url.toString());
    return res.ok ? parseCaptionXml(await res.text()) : [];
  } catch {
    return [];
  }
}

const toLanguage = (t: CaptionTrack): Language => ({
  code: t.languageCode,
  name: textOf(t.name) || nameFromCode(t.languageCode),
  auto: t.kind === "asr",
});

async function viaPlayer(player: PlayerResponse, lang?: string): Promise<Found | null> {
  const renderer = player.captions?.playerCaptionsTracklistRenderer;
  const tracks = renderer?.captionTracks ?? [];
  if (!tracks.length) return null;
  const translationLanguages = (renderer?.translationLanguages ?? []).map((l) => ({
    code: l.languageCode,
    name: textOf(l.languageName) || l.languageCode,
  }));

  const picked = pickTrack(tracks, lang);
  if (!picked) throw new TranscriptError(`Transkrip untuk bahasa "${parseLang(lang).code}" tidak ditemukan.`, 404);

  const segments = await downloadTrack(picked.track.baseUrl, picked.tlang);
  if (!segments.length) return null;

  const language: Language = picked.tlang
    ? {
        code: picked.tlang,
        name: translationLanguages.find((l) => l.code === picked.tlang)?.name ?? nameFromCode(picked.tlang),
        auto: true,
        translated: true,
      }
    : toLanguage(picked.track);
  return { language, languages: tracks.map(toLanguage), translationLanguages, segments };
}

/* --------------- strategy 2: "Show transcript" panel endpoint --------------- */

function varint(n: number): Buffer {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 127) | 128);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}
const pbStr = (field: number, s: string) => {
  const b = Buffer.from(s);
  return Buffer.concat([varint((field << 3) | 2), varint(b.length), b]);
};
const pbInt = (field: number, v: number) => Buffer.concat([varint(field << 3), varint(v)]);

/** Builds get_transcript params when the watch page did not provide them. */
function buildTranscriptParams(videoId: string, lang?: string): string {
  const want = parseLang(lang);
  const inner = Buffer.concat([pbStr(1, want.asr ? "asr" : ""), pbStr(2, want.code ?? "en"), pbStr(3, "")]).toString(
    "base64",
  );
  return Buffer.concat([
    pbStr(1, videoId),
    pbStr(2, inner),
    pbInt(3, 1),
    pbStr(5, "engagement-panel-searchable-transcript-search-panel"),
    pbInt(6, 1),
    pbInt(7, 1),
    pbInt(8, 1),
  ]).toString("base64");
}

/** Depth-first search for every value stored under `key`. */
function findAll(obj: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(obj)) for (const v of obj) findAll(v, key, out);
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (k === key) out.push(v);
      findAll(v, key, out);
    }
  }
  return out;
}

async function callGetTranscript(params: string, page: WatchPage): Promise<unknown> {
  const clientVersion = page.clientVersion ?? "2.20250910.01.00";
  try {
    const res = await ytFetch(
      `https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false${page.apiKey ? `&key=${page.apiKey}` : ""}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://www.youtube.com",
          "x-youtube-client-name": "1",
          "x-youtube-client-version": clientVersion,
          ...(page.visitorData ? { "x-goog-visitor-id": page.visitorData } : {}),
        },
        body: JSON.stringify({
          context: { client: { clientName: "WEB", clientVersion, hl: "en", gl: "US", visitorData: page.visitorData } },
          params,
        }),
      },
    );
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

type MenuItem = { title?: string; selected?: boolean; continuation?: { reloadContinuationData?: { continuation?: string } } };

export function panelLanguages(data: unknown) {
  const items = (findAll(data, "subMenuItems")[0] as MenuItem[] | undefined) ?? [];
  return items.map((item) => {
    const title = item.title ?? "";
    const lang: Language = {
      code: codeFromName(title) ?? title,
      name: title.replace(/\s*\(auto-generated\)/i, ""),
      auto: /auto-generated/i.test(title),
    };
    return { lang, selected: !!item.selected, params: item.continuation?.reloadContinuationData?.continuation };
  });
}

export function panelSegments(data: unknown): Segment[] {
  type Seg = { startMs?: string; endMs?: string; snippet?: Text };
  return (findAll(data, "transcriptSegmentRenderer") as Seg[])
    .map((s) => {
      const start = Number(s.startMs ?? 0) / 1000;
      return { start, dur: Math.max(0, Number(s.endMs ?? 0) / 1000 - start), text: cleanText(textOf(s.snippet)) };
    })
    .filter((s) => s.text);
}

async function viaTranscriptPanel(videoId: string, page: WatchPage, lang?: string): Promise<Found | null> {
  const want = parseLang(lang);
  let data = page.transcriptParams ? await callGetTranscript(page.transcriptParams, page) : undefined;
  if (!panelSegments(data).length) data = await callGetTranscript(buildTranscriptParams(videoId, lang), page);
  if (!data) return null;

  let langs = panelLanguages(data);
  if (want.code && langs.length) {
    const base = want.code.split("-")[0];
    const match =
      langs.find((l) => l.lang.code.toLowerCase() === want.code && l.lang.auto === want.asr) ??
      langs.find((l) => l.lang.code.toLowerCase() === want.code) ??
      langs.find((l) => l.lang.code.toLowerCase().split("-")[0] === base);
    if (!match) throw new TranscriptError(`Transkrip untuk bahasa "${want.code}" tidak ditemukan.`, 404);
    if (!match.selected && match.params) {
      const next = await callGetTranscript(match.params, page);
      if (panelSegments(next).length) {
        data = next;
        langs = langs.map((l) => ({ ...l, selected: l === match }));
      }
    }
  }

  const segments = panelSegments(data);
  if (!segments.length) return null;
  const fallback: Language = { code: want.code ?? "en", name: nameFromCode(want.code ?? "en"), auto: false };
  const current = langs.find((l) => l.selected)?.lang ?? langs[0]?.lang ?? fallback;
  return {
    language: current,
    languages: langs.length ? langs.map((l) => l.lang) : [current],
    translationLanguages: [],
    segments,
  };
}

/* ------------------------------ metadata ------------------------------ */

type OEmbed = { title?: string; author_name?: string; thumbnail_url?: string };

async function fetchOEmbed(videoId: string): Promise<OEmbed | undefined> {
  try {
    const res = await ytFetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`);
    return res.ok ? ((await res.json()) as OEmbed) : undefined;
  } catch {
    return undefined;
  }
}

/* ----------------------------- entry point ----------------------------- */

export async function getTranscript(videoId: string, lang?: string): Promise<TranscriptResult> {
  const [page, oembed] = await Promise.all([
    fetchWatchPage(videoId).catch((): WatchPage => ({})),
    fetchOEmbed(videoId),
  ]);

  const players: PlayerResponse[] = [];
  let found: Found | null = null;

  // 1. Watch-page player response, then each Innertube client in turn.
  //    A bot check on one client does not stop us from trying the others.
  const candidates: (() => Promise<PlayerResponse | undefined>)[] = [
    async () => page.player,
    ...CLIENTS.map((client) => () => fetchPlayer(videoId, client, page)),
  ];
  for (const next of candidates) {
    const player = await next();
    if (!player) continue;
    players.push(player);
    found = await viaPlayer(player, lang);
    if (found) break;
  }

  // 2. The transcript panel endpoint.
  if (!found) found = await viaTranscriptPanel(videoId, page, lang);

  if (!found) {
    const statuses = players.map((p) => p.playabilityStatus ?? {});
    const hasCaptionList = players.some((p) => p.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length);
    const playable = statuses.some((s) => s.status === "OK");
    const botBlocked = page.blocked || statuses.some((s) => /not a bot|sign in to confirm|unusual traffic/i.test(s.reason ?? ""));
    const unavailable = statuses.find((s) => s.status === "ERROR" || s.status === "UNPLAYABLE");

    if (hasCaptionList) {
      throw new TranscriptError(
        "Daftar subtitle ditemukan tapi gagal diunduh (dibatasi YouTube). Coba lagi, atau set TRANSCRIPT_PROXY_URL / YOUTUBE_COOKIE — lihat README.",
        502,
      );
    }
    if (playable) throw new TranscriptError("Video ini tidak memiliki subtitle/transkrip.", 404);
    if (!oembed && unavailable) {
      throw new TranscriptError(`Video tidak tersedia: ${unavailable.reason ?? "tidak ditemukan"}`, 404);
    }
    if (botBlocked || !players.length) {
      throw new TranscriptError(
        "YouTube memblokir request dari server ini (\"confirm you're not a bot\"). Tambahkan TRANSCRIPT_PROXY_URL atau YOUTUBE_COOKIE di Environment Variables Vercel — lihat README.",
        429,
      );
    }
    throw new TranscriptError("Video ini tidak memiliki subtitle/transkrip.", 404);
  }

  const result: Found = found;
  const details = players.find((p) => p.videoDetails?.title)?.videoDetails ?? {};
  const thumbs = details.thumbnail?.thumbnails ?? [];
  const last = result.segments[result.segments.length - 1];
  return {
    videoId,
    title: details.title ?? oembed?.title ?? "",
    author: details.author ?? oembed?.author_name ?? "",
    lengthSeconds: Number(details.lengthSeconds ?? 0) || Math.ceil(last.start + last.dur),
    thumbnail: thumbs[thumbs.length - 1]?.url ?? oembed?.thumbnail_url ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    ...result,
  };
}
