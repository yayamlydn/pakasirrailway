'use strict';

/**
 * PAKASIR RAILWAY WEBHOOK SERVER — Stateless Edition (v3)
 * ─────────────────────────────────────────────────────────
 * Tidak pakai SQLite — cocok untuk Railway Trial (no Volume).
 *
 * Tugas:
 *   1. POST /transaction  → proxy ke Pakasir API → buat QRIS → balik ke bot
 *   2. POST /webhook/pakasir → terima notif dari Pakasir → forward ke bot via Telegram
 *   3. GET  /health       → health check
 *
 * State (balance, idempotency) dikelola sepenuhnya di DB bot (Pterodactyl).
 *
 * Env vars yang dibutuhkan:
 *   PORT                 (auto-set oleh Railway)
 *   PAKASIR_API_KEY      API key dari app.pakasir.com
 *   PAKASIR_PROJECT      Project ID di Pakasir
 *   PAKASIR_SLUG         Slug halaman pay (default: kirimkode)
 *   BOT_TOKEN_A          Token bot Telegram
 *   INTERNAL_SECRET      Secret untuk autentikasi request dari bot
 *   WEBHOOK_SECRET       Secret dari Pakasir (opsional tapi dianjurkan)
 */

const express = require('express');
const axios   = require('axios');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT            = parseInt(process.env.PORT) || 3000;
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY   || '';
const PAKASIR_PROJECT = process.env.PAKASIR_PROJECT   || '';
const PAKASIR_SLUG    = process.env.PAKASIR_SLUG      || 'kirimkode';
const BOT_TOKENS      = {
  BOTA: process.env.BOT_TOKEN_A || '',
  BOTB: process.env.BOT_TOKEN_B || '',
};
const INTERNAL_SECRET = process.env.INTERNAL_SECRET   || '';
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET    || '';

const PAKASIR_CREATE_URL = 'https://app.pakasir.com/api/transactioncreate/qris';

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getBotToken(orderId) {
  if (!orderId) return null;
  for (const [prefix, token] of Object.entries(BOT_TOKENS)) {
    if (orderId.startsWith(prefix) && token) return token;
  }
  // Fallback ke token pertama yang ada
  return Object.values(BOT_TOKENS).find(t => t) || null;
}

async function sendTelegram(token, chatId, text) {
  if (!token || !chatId) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'Markdown' },
      { timeout: 10000 }
    );
  } catch (e) {
    console.error(`[Telegram] chatId=${chatId}: ${e.message}`);
  }
}

async function createQrisFromPakasir(orderId, amount) {
  if (!PAKASIR_API_KEY) throw new Error('PAKASIR_API_KEY belum diset di env Railway.');
  if (!PAKASIR_PROJECT) throw new Error('PAKASIR_PROJECT belum diset di env Railway.');

  const res = await axios.post(
    PAKASIR_CREATE_URL,
    {
      api_key:  PAKASIR_API_KEY,
      project:  PAKASIR_PROJECT,
      order_id: orderId,
      amount:   amount,
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
  );

  // Docs Pakasir: response ada di res.data.payment (bukan .data)
  const data          = res.data?.payment ?? res.data?.data ?? res.data ?? {};
  const paymentNumber = data.payment_number ?? data.qris_number ?? data.qr_string ?? null;
  const expiredAt     = data.expired_at ?? data.expiry ?? null;

  if (!paymentNumber) {
    throw new Error(`Pakasir tidak mengembalikan QRIS. Response: ${JSON.stringify(res.data)}`);
  }

  const payUrl = `https://app.pakasir.com/pay/${PAKASIR_SLUG}/${orderId}?qris_only=1`;

  return { paymentNumber, payUrl, expiredAt };
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '256kb' }));
app.disable('x-powered-by');

function requireInternal(req, res, next) {
  if (!INTERNAL_SECRET) return next(); // dev mode
  const key = req.headers['x-internal-key'] || req.query.key;
  if (key !== INTERNAL_SECRET) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Health check
app.get('/', (_, res) => res.json({
  status:  'ok',
  service: 'pakasir-railway',
  version: '3.0.0',
  ts:      new Date().toISOString(),
}));

app.get('/health', (_, res) => res.json({ status: 'ok' }));

/**
 * POST /transaction
 * Dipanggil bot → Railway proxy ke Pakasir API → balik QRIS ke bot.
 * Bot yang menyimpan transaksi ke DB-nya sendiri (Pterodactyl).
 *
 * Body: { order_id, user_id, amount, bot_prefix }
 * Response: { ok, order_id, payment_number, pay_url, expired_at }
 */
app.post('/transaction', requireInternal, async (req, res) => {
  const { order_id, user_id, amount, bot_prefix } = req.body ?? {};

  if (!order_id || !user_id || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'order_id, user_id, dan amount (>0) wajib diisi.' });
  }

  try {
    const qris = await createQrisFromPakasir(order_id, amount);

    const expiredAt = qris.expiredAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();

    console.log(`[/transaction] OK: order=${order_id} user=${user_id} amount=${amount}`);

    return res.json({
      ok:             true,
      order_id,
      payment_number: qris.paymentNumber,
      pay_url:        qris.payUrl,
      expired_at:     expiredAt,
    });
  } catch (e) {
    console.error(`[/transaction] ERROR: ${e.message}`);
    return res.status(502).json({ error: `Gagal buat QRIS: ${e.message}` });
  }
});

/**
 * POST /webhook/pakasir
 * Diterima dari Pakasir setelah user bayar.
 * Railway tidak punya DB — kita hanya forward notif ke bot via Telegram.
 * Bot yang update saldo di DB-nya.
 *
 * Pakasir kirim: { order_id, status, amount, user_id, ... }
 */
app.post('/webhook/pakasir', (req, res) => {
  // Balas Pakasir dulu — harus cepat
  res.status(200).json({ received: 'ok' });

  // Validasi signature (opsional)
  if (WEBHOOK_SECRET) {
    const sig = req.headers['x-pakasir-signature'] ?? req.query.secret ?? '';
    if (sig !== WEBHOOK_SECRET) {
      console.warn(`[Webhook] Signature tidak valid: ${sig}`);
      return;
    }
  }

  setImmediate(async () => {
    try {
      const { order_id, status, amount, user_id } = req.body ?? {};

      if (!order_id) return;

      console.log(`[Webhook] order=${order_id} status=${status} amount=${amount}`);

      const isPaid = ['completed', 'paid', 'settlement', 'success']
        .includes(String(status).toLowerCase());

      if (!isPaid) return;

      // Forward ke bot via Telegram — bot yang handle credit saldo
      // Format pesan khusus agar bot bisa parse
      const token = getBotToken(order_id);
      if (!token) {
        console.warn(`[Webhook] Tidak ada token untuk order ${order_id}`);
        return;
      }

      // Kirim ke user (jika user_id tersedia dari Pakasir)
      const chatId = user_id || null;
      if (chatId) {
        const text =
          `✅ *Deposit Berhasil!*\n\n` +
          `💵 Jumlah : *Rp ${Number(amount).toLocaleString('id-ID')}*\n` +
          `🆔 Order  : \`${order_id.slice(0, 16)}...\`\n\n` +
          `Saldo sudah masuk ke akun Anda.\n_Silakan order OTP sekarang!_`;

        await sendTelegram(token, chatId, text);
      }

      console.log(`[Webhook] Notif dikirim: order=${order_id} chatId=${chatId}`);
    } catch (e) {
      console.error(`[Webhook async] ${e.message}`);
    }
  });
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Pakasir Railway server berjalan di port ${PORT}`);
});

function shutdown(signal) {
  console.log(`[${signal}] Menutup server...`);
  server.close(() => {
    console.log('Server ditutup. Exit.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (e) => console.error(`[uncaughtException] ${e.message}`, e.stack));
process.on('unhandledRejection', (e) => console.error(`[unhandledRejection] ${e}`));
