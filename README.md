# TranscribeYT 🎬📝

Aplikasi web **transkrip video YouTube** yang simpel tapi powerful, siap deploy ke **Vercel** dalam 1 klik.
Dibangun dengan **Next.js (App Router) + TypeScript**, tanpa database dan tanpa API key.

## ✨ Fitur

- 🔗 Mendukung semua format link: `watch?v=`, `youtu.be/`, `shorts/`, `embed/`, `live/`, atau ID video langsung
- 📜 Transkrip **lengkap** dengan timestamp
- ▶️ Player YouTube terintegrasi — klik timestamp untuk lompat ke detik tersebut
- 🎯 Mode **"Ikuti video"**: baris yang sedang diputar otomatis di-highlight & di-scroll
- 🔍 Pencarian di dalam transkrip dengan highlight
- 🧾 Mode **Paragraf**: gabungkan potongan caption menjadi paragraf yang enak dibaca
- 🌐 Pilih bahasa subtitle (manual / otomatis) + **terjemahan otomatis** ke bahasa lain (mis. Indonesia)
- 📋 Salin sekali klik
- ⬇️ Unduh sebagai **TXT, SRT, VTT, Markdown, JSON**
- 📊 Info durasi, jumlah kata, estimasi waktu baca
- 🔗 Link bisa dibagikan: `https://domain-kamu.vercel.app/?v=VIDEO_ID&lang=id`
- 🌗 Dark mode otomatis & responsif di HP
- 🧩 **REST API** publik untuk integrasi

## 🚀 Deploy ke Vercel

1. Push repositori ini ke GitHub.
2. Buka [vercel.com/new](https://vercel.com/new), pilih repositori ini.
3. Framework otomatis terdeteksi sebagai **Next.js**. Klik **Deploy**. Selesai ✅

Atau lewat CLI:

```bash
npm i -g vercel
vercel --prod
```

## 💻 Jalankan di lokal

```bash
npm install
npm run dev
# buka http://localhost:3000
```

Butuh Node.js 20.9 atau lebih baru.

## 🧩 API

```
GET /api/transcript?url=<link atau id>&lang=<kode>&format=<format>
```

| Parameter    | Keterangan                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------- |
| `url`        | Link YouTube atau ID video (wajib). Alias: `v`, `id`                                         |
| `lang`       | Kode bahasa, mis. `en`, `id`. Tambahkan `:asr` untuk subtitle otomatis (`en:asr`). Jika bahasa tidak ada, dipakai terjemahan otomatis YouTube |
| `format`     | `json` (default), `txt`, `srt`, `vtt`, `md`                                                  |
| `timestamps` | `1` untuk menambahkan `[mm:ss]` di format `txt`                                              |
| `paragraphs` | `1` untuk menggabungkan caption menjadi paragraf (format selain `json`)                      |

Contoh:

```bash
curl "https://domain-kamu.vercel.app/api/transcript?url=https://youtu.be/jNQXAC9IVRw"
curl "https://domain-kamu.vercel.app/api/transcript?url=jNQXAC9IVRw&lang=id&format=srt"
curl "https://domain-kamu.vercel.app/api/transcript?url=jNQXAC9IVRw&format=txt&paragraphs=1"
```

Contoh respons JSON:

```json
{
  "videoId": "jNQXAC9IVRw",
  "title": "Me at the zoo",
  "author": "jawed",
  "lengthSeconds": 19,
  "thumbnail": "https://i.ytimg.com/...",
  "language": { "code": "en", "name": "English", "auto": false },
  "languages": [{ "code": "en", "name": "English", "auto": false }],
  "translationLanguages": [{ "code": "id", "name": "Indonesian" }],
  "segments": [{ "start": 1.2, "dur": 2.16, "text": "All right, so here we are..." }]
}
```

Respons di-cache di edge Vercel selama 24 jam (`s-maxage=86400`), jadi video yang sama tidak di-fetch berulang kali.

## ⚠️ Catatan: YouTube memblokir IP server

YouTube kadang memblokir request dari IP cloud/datacenter (termasuk Vercel). Tandanya muncul error seperti
_"YouTube memblokir request dari server ini"_ atau _"confirm you're not a bot"_.

Solusinya: pakai proxy (sebaiknya **residential proxy**). Di Vercel → **Project → Settings → Environment Variables**, tambahkan:

```
TRANSCRIPT_PROXY_URL=http://user:pass@host:port
```

lalu redeploy. Semua request ke YouTube akan lewat proxy tersebut. Lihat `.env.example`.

## 🗂️ Struktur

```
app/
  page.tsx                  # UI (client component)
  layout.tsx                # metadata & layout
  globals.css               # styling (light/dark)
  api/transcript/route.ts   # REST API
lib/
  youtube.ts                # ambil & parsing transkrip dari YouTube (Innertube API)
  format.ts                 # export TXT / SRT / VTT / MD / JSON, paragraf, timestamp
public/icon.svg
```

## ⚙️ Cara kerja

1. Ambil halaman video untuk mendapatkan metadata & API key Innertube.
2. Panggil endpoint `youtubei/v1/player` (klien Android/iOS) untuk daftar caption; jika gagal, pakai data dari halaman.
3. Unduh caption XML, parsing (format klasik & srv3), bersihkan HTML entities.
4. Format ulang sesuai permintaan (JSON/TXT/SRT/VTT/MD).

Hanya video yang memiliki subtitle (manual atau otomatis) yang bisa ditranskrip.

## 📄 Lisensi

MIT
