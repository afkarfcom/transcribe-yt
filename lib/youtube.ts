import { ProxyAgent, type Dispatcher } from "undici";

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

type CaptionTrack = {
  baseUrl: string;
  languageCode: string;
  name?: { simpleText?: string; runs?: { text: string }[] };
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
      translationLanguages?: {
        languageCode: string;
        languageName?: { simpleText?: string; runs?: { text: string }[] };
      }[];
    };
  };
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// Innertube clients tried in order. Mobile clients usually return caption
// URLs that work without a PO token.
const CLIENTS = [
  {
    context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, hl: "en" } },
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
  },
  {
    context: { client: { clientName: "IOS", clientVersion: "20.10.4", deviceModel: "iPhone16,2", hl: "en" } },
    userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)",
  },
];

let dispatcher: Dispatcher | undefined;
function getDispatcher(): Dispatcher | undefined {
  const proxy = process.env.TRANSCRIPT_PROXY_URL;
  if (!proxy) return undefined;
  dispatcher ??= new ProxyAgent(proxy);
  return dispatcher;
}

async function ytFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
  headers.set("accept-language", "en-US,en;q=0.9");
  // Skip the EU cookie consent interstitial.
  headers.set("cookie", "CONSENT=YES+cb; SOCS=CAI");
  return fetch(url, {
    ...init,
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    // @ts-expect-error `dispatcher` is a Node (undici) fetch extension
    dispatcher: getDispatcher(),
  });
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

function textOf(value?: { simpleText?: string; runs?: { text: string }[] }): string {
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

async function fetchWatchPage(videoId: string) {
  const res = await ytFetch(`https://www.youtube.com/watch?v=${videoId}&hl=en&bpctr=9999999999&has_verified=1`);
  if (!res.ok) throw new TranscriptError(`YouTube merespons dengan HTTP ${res.status}.`, 502);
  const html = await res.text();

  if (html.includes('action="https://consent.youtube.com/s"')) {
    throw new TranscriptError("YouTube meminta persetujuan cookie dari region server ini. Coba set TRANSCRIPT_PROXY_URL.", 502);
  }
  if (html.includes('class="g-recaptcha"')) {
    throw new TranscriptError(
      "YouTube memblokir request dari server ini (captcha). Set TRANSCRIPT_PROXY_URL — lihat README.",
      429,
    );
  }

  const apiKey = html.match(/"INNERTUBE_API_KEY":\s*"([\w-]+)"/)?.[1];
  let player: PlayerResponse | undefined;
  const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s+meta|<\/script|\n)/);
  if (playerMatch) {
    try {
      player = JSON.parse(playerMatch[1]);
    } catch {
      player = undefined;
    }
  }
  return { apiKey, player };
}

async function fetchInnertubePlayer(videoId: string, apiKey: string | undefined): Promise<PlayerResponse | undefined> {
  const url = `https://www.youtube.com/youtubei/v1/player?prettyPrint=false${apiKey ? `&key=${apiKey}` : ""}`;
  for (const client of CLIENTS) {
    try {
      const res = await ytFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": client.userAgent },
        body: JSON.stringify({ context: client.context, videoId, contentCheckOk: true, racyCheckOk: true }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as PlayerResponse;
      if (data.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length) return data;
    } catch {
      // try next client
    }
  }
  return undefined;
}

function toLanguage(track: CaptionTrack): Language {
  return {
    code: track.languageCode,
    name: textOf(track.name) || track.languageCode,
    auto: track.kind === "asr",
  };
}

function pickTrack(tracks: CaptionTrack[], lang?: string): { track: CaptionTrack; tlang?: string } | null {
  if (lang) {
    // "en:asr" explicitly asks for the auto-generated track.
    const wantAsr = lang.endsWith(":asr");
    const want = lang.replace(/:asr$/, "").toLowerCase();
    lang = want;
    const exact =
      tracks.find((t) => t.languageCode.toLowerCase() === want && (t.kind === "asr") === wantAsr) ??
      tracks.find((t) => t.languageCode.toLowerCase() === want);
    if (exact) return { track: exact };
    const base = want.split("-")[0];
    const loose = tracks.find((t) => t.languageCode.toLowerCase().split("-")[0] === base);
    if (loose) return { track: loose };
    // Fall back to YouTube auto-translate.
    const translatable = tracks.find((t) => t.isTranslatable && t.kind !== "asr") ?? tracks.find((t) => t.isTranslatable);
    if (translatable) return { track: translatable, tlang: lang };
    return null;
  }
  const manual = tracks.find((t) => t.kind !== "asr");
  return { track: manual ?? tracks[0] };
}

async function downloadTrack(baseUrl: string, tlang?: string): Promise<Segment[]> {
  const url = new URL(baseUrl.replace(/&fmt=[^&]*/, ""));
  if (tlang) url.searchParams.set("tlang", tlang);
  const res = await ytFetch(url.toString());
  if (!res.ok) return [];
  return parseCaptionXml(await res.text());
}

export async function getTranscript(videoId: string, lang?: string): Promise<TranscriptResult> {
  const page = await fetchWatchPage(videoId);
  const status = page.player?.playabilityStatus;

  if (status?.status && status.status !== "OK") {
    const reason = status.reason ?? status.status;
    if (/not a bot|sign in to confirm/i.test(reason)) {
      throw new TranscriptError(
        "YouTube memblokir request dari server ini (\"confirm you're not a bot\"). Set TRANSCRIPT_PROXY_URL — lihat README.",
        429,
      );
    }
    if (status.status === "ERROR") throw new TranscriptError(`Video tidak tersedia: ${reason}`, 404);
    if (status.status === "LOGIN_REQUIRED") throw new TranscriptError(`Video memerlukan login: ${reason}`, 403);
  }

  // Innertube mobile clients first, then the watch-page player response.
  const candidates = [await fetchInnertubePlayer(videoId, page.apiKey), page.player].filter(
    (p): p is PlayerResponse => !!p?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length,
  );
  if (!candidates.length) {
    throw new TranscriptError("Video ini tidak memiliki subtitle/transkrip.", 404);
  }

  const details = page.player?.videoDetails ?? candidates[0].videoDetails ?? {};
  const renderer = candidates[0].captions!.playerCaptionsTracklistRenderer!;
  const tracks = renderer.captionTracks!;
  const translationLanguages = (renderer.translationLanguages ?? []).map((l) => ({
    code: l.languageCode,
    name: textOf(l.languageName) || l.languageCode,
  }));

  const picked = pickTrack(tracks, lang);
  if (!picked) {
    throw new TranscriptError(`Transkrip untuk bahasa "${lang}" tidak ditemukan.`, 404);
  }

  let segments: Segment[] = [];
  for (const candidate of candidates) {
    const cTracks = candidate.captions!.playerCaptionsTracklistRenderer!.captionTracks!;
    const match =
      cTracks.find((t) => t.languageCode === picked.track.languageCode && t.kind === picked.track.kind) ??
      picked.track;
    segments = await downloadTrack(match.baseUrl, picked.tlang);
    if (segments.length) break;
  }
  if (!segments.length) {
    throw new TranscriptError(
      "Gagal mengunduh transkrip. YouTube mungkin membatasi server ini — coba lagi atau set TRANSCRIPT_PROXY_URL.",
      502,
    );
  }

  const language: Language = picked.tlang
    ? {
        code: picked.tlang,
        name: translationLanguages.find((l) => l.code === picked.tlang)?.name ?? picked.tlang,
        auto: true,
        translated: true,
      }
    : toLanguage(picked.track);

  const thumbs = details.thumbnail?.thumbnails ?? [];
  return {
    videoId,
    title: details.title ?? "",
    author: details.author ?? "",
    lengthSeconds: Number(details.lengthSeconds ?? 0),
    thumbnail: thumbs[thumbs.length - 1]?.url ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    language,
    languages: tracks.map(toLanguage),
    translationLanguages,
    segments,
  };
}
