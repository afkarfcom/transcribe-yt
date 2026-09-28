import type { Segment } from "./youtube";

export type ExportFormat = "txt" | "srt" | "vtt" | "json" | "md";

/** 75.5 -> "1:15", 3725 -> "1:02:05" */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

function clock(seconds: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(rest, 3)}`;
}

/** End time of a segment, clamped so it never overlaps the next one. */
function endOf(segments: Segment[], i: number): number {
  const seg = segments[i];
  const end = seg.start + (seg.dur || 2);
  const next = segments[i + 1];
  return next ? Math.min(end, next.start) || end : end;
}

/** Groups short caption lines into readable paragraphs. */
export function toParagraphs(segments: Segment[], maxChars = 400): Segment[] {
  const out: Segment[] = [];
  let cur: Segment | null = null;
  for (const seg of segments) {
    if (!cur) {
      cur = { ...seg };
      continue;
    }
    const gap = seg.start - (cur.start + cur.dur);
    const endsSentence = /[.!?…]["')\]]?$/.test(cur.text);
    if (cur.text.length >= maxChars || (endsSentence && cur.text.length > maxChars / 2) || gap > 4) {
      out.push(cur);
      cur = { ...seg };
    } else {
      cur.text += ` ${seg.text}`;
      cur.dur = seg.start + seg.dur - cur.start;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function toTxt(segments: Segment[], withTimestamps = false): string {
  return segments
    .map((s) => (withTimestamps ? `[${formatTimestamp(s.start)}] ${s.text}` : s.text))
    .join(withTimestamps ? "\n" : "\n\n");
}

export function toSrt(segments: Segment[]): string {
  return segments
    .map((s, i) => `${i + 1}\n${clock(s.start, ",")} --> ${clock(endOf(segments, i), ",")}\n${s.text}\n`)
    .join("\n");
}

export function toVtt(segments: Segment[]): string {
  return `WEBVTT\n\n${segments
    .map((s, i) => `${clock(s.start, ".")} --> ${clock(endOf(segments, i), ".")}\n${s.text}\n`)
    .join("\n")}`;
}

export function toMarkdown(
  segments: Segment[],
  meta: { title: string; author: string; videoId: string },
): string {
  const lines = segments.map(
    (s) =>
      `[${formatTimestamp(s.start)}](https://www.youtube.com/watch?v=${meta.videoId}&t=${Math.floor(s.start)}s) ${s.text}`,
  );
  return `# ${meta.title}\n\n_${meta.author}_ · https://www.youtube.com/watch?v=${meta.videoId}\n\n${lines.join("\n\n")}\n`;
}

export const MIME: Record<ExportFormat, string> = {
  txt: "text/plain; charset=utf-8",
  srt: "application/x-subrip; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
};

export function countWords(segments: Segment[]): number {
  return segments.reduce((n, s) => n + (s.text.match(/\S+/g)?.length ?? 0), 0);
}

export function safeFilename(name: string): string {
  return (name || "transcript").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || "transcript";
}
