import { NextRequest, NextResponse } from "next/server";
import { extractVideoId, getTranscript, TranscriptError } from "@/lib/youtube";
import { MIME, safeFilename, toMarkdown, toParagraphs, toSrt, toTxt, toVtt, type ExportFormat } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FORMATS = new Set<ExportFormat>(["txt", "srt", "vtt", "json", "md"]);

/**
 * GET /api/transcript?url=<youtube url or id>[&lang=en][&format=json|txt|srt|vtt|md][&timestamps=1][&paragraphs=1]
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const input = params.get("url") ?? params.get("v") ?? params.get("id") ?? "";
  const lang = params.get("lang")?.trim() || undefined;
  const format = (params.get("format") ?? "json").toLowerCase() as ExportFormat;
  const flag = (name: string) => ["1", "true", "yes"].includes(params.get(name) ?? "");

  if (!FORMATS.has(format)) {
    return NextResponse.json({ error: `Format "${format}" tidak dikenal. Gunakan: ${[...FORMATS].join(", ")}` }, { status: 400 });
  }
  if (lang && !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*(:asr)?$/.test(lang)) {
    return NextResponse.json({ error: "Kode bahasa tidak valid." }, { status: 400 });
  }
  const videoId = extractVideoId(input);
  if (!videoId) {
    return NextResponse.json({ error: "Masukkan URL YouTube atau ID video yang valid." }, { status: 400 });
  }

  try {
    const data = await getTranscript(videoId, lang);
    const cache = { "cache-control": "public, s-maxage=86400, stale-while-revalidate=604800" };

    if (format === "json") {
      return NextResponse.json(data, { headers: cache });
    }

    const segments = flag("paragraphs") ? toParagraphs(data.segments) : data.segments;
    const body =
      format === "srt"
        ? toSrt(segments)
        : format === "vtt"
          ? toVtt(segments)
          : format === "md"
            ? toMarkdown(segments, data)
            : toTxt(segments, flag("timestamps"));
    const filename = `${safeFilename(data.title || videoId)}.${data.language.code}.${format}`;

    return new NextResponse(body, {
      headers: {
        ...cache,
        "content-type": MIME[format],
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (err) {
    if (err instanceof TranscriptError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(err);
    const timeout = err instanceof Error && err.name === "TimeoutError";
    return NextResponse.json(
      { error: timeout ? "YouTube terlalu lama merespons. Silakan coba lagi." : "Terjadi kesalahan saat mengambil transkrip." },
      { status: timeout ? 504 : 500 },
    );
  }
}
