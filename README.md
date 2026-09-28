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

## ⚠️ Kalau YouTube memblokir server (error "confirm you're not a bot")

YouTube sering memblokir request dari IP cloud/datacenter (termasuk Vercel). Aplikasi ini sudah otomatis mencoba
beberapa cara secara berurutan (halaman video → klien *embedded*/TV/Android/iOS/mobile → endpoint panel transkrip).
Kalau semuanya tetap diblokir, pilih salah satu (atau keduanya) di **Vercel → Project → Settings → Environment Variables**, lalu **Redeploy**:

### Opsi A — Proxy (paling andal)

```
TRANSCRIPT_PROXY_URL=http://user:pass@host:port
```

Semua request ke YouTube akan lewat proxy ini. Sebaiknya pakai **residential proxy** (misalnya Webshare, IPRoyal, Smartproxy, dan sejenisnya), karena proxy datacenter biasanya juga diblokir.

### Opsi B — Cookie akun YouTube (gratis)

```
YOUTUBE_COOKIE=SID=...; HSID=...; SSID=...; APISID=...; SAPISID=...; __Secure-3PSID=...
```

Cara ambil:
1. Login ke youtube.com di browser (**sebaiknya akun cadangan**, bukan akun utama).
2. Buka DevTools (F12) → tab **Network** → refresh halaman → klik request `www.youtube.com`.
3. Di **Request Headers**, salin seluruh isi header `cookie`, lalu tempel sebagai nilai `YOUTUBE_COOKIE`.

Cookie bisa kedaluwarsa. Kalau error muncul lagi, ulangi langkah di atas.

### Tips tambahan

- Ganti region function Vercel (**Settings → Functions → Function Region**), misalnya ke `sin1` (Singapura). Region tertentu kadang lebih jarang diblokir.
- Saat dijalankan di komputer sendiri (`npm run dev`), aplikasi biasanya langsung jalan tanpa proxy karena memakai IP rumah.

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
2. Coba daftar caption dari halaman video, lalu dari endpoint `youtubei/v1/player` dengan beberapa klien (embedded, TV, Android, iOS, mobile web).
3. Jika semuanya gagal, pakai endpoint panel "Show transcript" (`youtubei/v1/get_transcript`).
4. Unduh caption XML, parsing (format klasik & srv3), bersihkan HTML entities.
5. Format ulang sesuai permintaan (JSON/TXT/SRT/VTT/MD).

Hanya video yang memiliki subtitle (manual atau otomatis) yang bisa ditranskrip.

## 📄 Lisensi

MIT
