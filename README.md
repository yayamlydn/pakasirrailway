# Pakasir Railway Webhook Server v2.0

Mini payment-gateway server yang berjalan di Railway. Tugasnya **hanya** untuk:
1. Menerima request deposit dari bot → memanggil Pakasir API → mengembalikan QRIS string + URL
2. Menerima webhook konfirmasi bayar dari Pakasir → mengkreditkan saldo → notifikasi Telegram

Bot OTP tetap berjalan di VPS Anda. Railway hanya cover payment gateway.

## Alur

```
User klik Deposit (bot VPS)
  → POST /transaction ke Railway
  → Railway panggil app.pakasir.com → dapat QRIS
  → Railway return { payment_number, pay_url } ke bot
  → Bot tampilkan QR image ke user (langsung, tanpa redirect URL)
  → User bayar via QRIS
  → Pakasir kirim webhook ke Railway
  → Railway credit saldo, notif user via Telegram
```

## Endpoints

| Method | Path | Auth | Keterangan |
|--------|------|------|------------|
| GET  | / | — | Health check |
| POST | /transaction | X-Internal-Key | Buat transaksi + generate QRIS |
| POST | /webhook/pakasir | WEBHOOK_SECRET | Terima konfirmasi bayar dari Pakasir |
| GET  | /transaction/:id | X-Internal-Key | Cek status transaksi |
| GET  | /balance/:telegram_id | X-Internal-Key | Cek saldo Railway DB |

## Setup Railway

1. Push folder ini ke GitHub (repo sendiri/folder di monorepo)
2. Buat project Railway → connect repo ini
3. Isi semua env var di Railway dashboard (lihat `.env.example`)
4. Set webhook URL di Pakasir dashboard: `https://nama-app.railway.app/webhook/pakasir`
5. Catat `INTERNAL_SECRET` — harus sama dengan `RAILWAY_INTERNAL_SECRET` di env bot VPS

## Keamanan

- `INTERNAL_SECRET`: Semua endpoint `/transaction` dan `/balance` wajib punya header `X-Internal-Key` yang sesuai
- Double-credit proof: `markSuccess` hanya merubah baris jika `status='pending'` — jika sudah `'success'`, `changes=0` dan fungsi skip
- WAL mode + busy_timeout agar aman saat banyak concurrent request
