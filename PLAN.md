# Rencana Kerja — Token Launch Radar (`token-radar-01`)

## Target & Batasan Utama
- Program Node 22 (stdlib saja, deterministik 2x run) membaca `/input/snapshot.json`, menghasilkan `/output/board.json`, `data.js`, salinan `dashboard/` + `screenshots/`, dan `/output/dossier.json` via `vendor/makefun-board.ts`.
- Gate wajib lulus: 100–4000 baris, 100% cakupan 40 `watchlist` + protokol pre-token awal di bawah floor, `implied_value_usd` menurun monoton & tidak seragam, 3–12 `farm_steps` (20–600 karakter), dashboard offline (tanpa URL `http(s)` di atribut/CSS/import), sumber `< 64 KB`, 3 screenshot PNG/JPEG (sisi 800–1440px, ~300–350 KB), dossier `<= 1.5 MiB`.

## Tahapan Kerja (Commit Tiap Milestone)
1. **Inisialisasi Struktur & Data Pipeline**
   - Siapkan `LICENSE` (MIT) dan `vendor/makefun-board.ts` (identik dengan kit).
   - Analisis distribusi `input/snapshot.json` (758 protokol, 40 watchlist, kategori, chain, TVL, `change_7d`, `listed_at`, dan pembanding `mcap_usd/tvl_usd` protokol bertoken).
2. **Model Valuasi Dinamis (`lib/model.ts`)**
   - Pisahkan protokol pre-token vs bertoken secara dinamis (tanpa daftar hardcode); tandai `watchlist`, kandidat awal (pre-token di bawah floor $50M), dan exclude produk wrapped/staked/bridged/CEX.
   - Hitung `implied_value_usd` dari median rasio `mcap/TVL` per kategori di snapshot, disesuaikan dengan pertumbuhan 7 hari (`change_7d`), umur protokol (`listed_at`), skala TVL, dan jangkauan multi-chain; sertakan breakdown faktor valuasi agar transparan di UI.
3. **Generator Rencana Farming Konkret (`lib/farm.ts`)**
   - Bangun 4–6 langkah farming spesifik berdasarkan kategori, chain utama, profil TVL, dan usia protokol; tiap langkah memuat aksi konkret, estimasi biaya/modal & gas, durasi waktu, serta risiko utama (bukan slogan).
4. **Entrypoint CLI (`main.ts`)**
   - Baca argumen `--input` / `MAKEFUN_OUTPUT_DIR`, jalankan model & generator, urutkan rank `1..N`, tulis `board.json`, `dashboard/data.js`, salin aset, dan panggil `buildDossier('/output', { text_max_bytes: 65536 })`.
5. **Dashboard Statis Offline (`dashboard/`)**
   - Desain antarmuka kustom (palet terkurasi, tipografi rapi, tata letak responsif, sumber total `< 64 KB`).
   - Fitur: ringkasan KPI & metodologi model, tabel sortable (rank, implied value, TVL, 7d growth, umur), filter (watchlist/early/all, kategori, chain, pencarian), dan panel detail per protokol lengkap dengan breakdown valuasi & farm plan.
6. **Screenshot, Verifikasi Gate & Determinisme**
   - Jalankan `main.ts` dua kali dan verifikasi output identik byte-per-byte.
   - Buka dashboard di browser lokal, ambil 3 screenshot sesuai batas dimensi/ukuran: board utama, tampilan detail protokol, dan tampilan terfilter.
   - Uji validasi gate penuh (7 cek scorer) dan periksa ukuran `dossier.json` (< 1.5 MiB) serta kelengkapan teks sumber (< 64 KB).

## Daftar Berkas yang Akan Dibuat
- `LICENSE` — Lisensi OSI (MIT) untuk repositori entri.
- `vendor/makefun-board.ts` — Pustaka builder dossier resmi dari kit.
- `main.ts` — Entrypoint Node 22 untuk membangun `board.json`, `data.js`, dan `dossier.json`.
- `lib/model.ts` — Klasifikasi pre-token, kalibrasi kelipatan kategori, dan perhitungan `implied_value_usd`.
- `lib/farm.ts` — Generator langkah farming konkret (aksi, estimasi biaya, durasi, risiko) berbasis atribut protokol.
- `dashboard/index.html` — Kerangka halaman statis offline tanpa referensi jaringan.
- `dashboard/app.css` — Gaya kustom, palet warna, tipografi, dan layout responsif.
- `dashboard/app.js` — Logika interaktif tabel sortable, filter/pencarian, dan panel detail protokol.
- `screenshots/1-board.png` — Tangkapan layar tampilan utama radar (board & KPI).
- `screenshots/2-detail.png` — Tangkapan layar tampilan detail protokol (breakdown valuasi + farm steps).
- `screenshots/3-filtered.png` — Tangkapan layar tampilan board dalam kondisi terfilter.
