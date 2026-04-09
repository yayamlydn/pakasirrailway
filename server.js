'use strict';

/**
 * PAKASIR RAILWAY WEBHOOK SERVER — v3.1
 * ──────────────────────────────────────
 * Perubahan dari v3.0:
 *   - Setelah webhook Pakasir masuk + verified paid,
 *     Railway forward ke bot VPS via POST BOT_NOTIFY_URL/notify-paid
 *   - Tidak ada DB, tidak ada polling — pure event-driven
 *
 * Env vars:
 *   PORT                 (auto Railway)
 *   PAKASIR_API_KEY
 *   PAKASIR_PROJECT
 *   PAKASIR_SLUG         (default: kirimkode)
 *   BOT_TOKEN_A          Token bot (untuk fallback notif langsung jika BOT_NOTIFY_URL kosong)
 *   BOT_TOKEN_B
 *   INTERNAL_SECRET      Secret untuk /transaction (bot → Railway)
 *   WEBHOOK_SECRET       Secret dari Pakasir (opsional, dianjurkan)
 *   BOT_NOTIFY_URL       URL bot VPS, contoh: http://kahfi.myserver.com:4000
 *                        Kosongkan jika bot VPS tidak expose port public
 */

const express = require('express');
const axios   = require('axios');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT            = parseInt(process.env.PORT) || 3000;
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY || '';
const PAKASIR_PROJECT = process.env.PAKASIR_PROJECT || '';
const PAKASIR_SLUG    = process.env.PAKASIR_SLUG    || 'kirimkode';
const BOT_TOKENS      = {
  BOTA: process.env.BOT_TOKEN_A || '',
  BOTB: process.env.BOT_TOKEN_B || '',
};
const INTERNAL_SECRET  = process.env.INTERNAL_SECRET  || '';
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET   || '';
const BOT_NOTIFY_URL   = (process.env.BOT_NOTIFY_URL  || '').replace(/\/$/, '');

const PAKASIR_CREATE_URL = 'https://app.pakasir.com/api/transactioncreate/qris';

// ─── IN-MEMORY IDEMPOTENCY CACHE (mencegah double-credit jika Pakasir retry) ─
// Max 1000 entries, auto-expire 1 jam
const paidCache = new Map();
function markPaid(orderId) {
  if (paidCache.has(orderId)) return false; // sudah diproses
  paidCache.set(orderId, Date.now());
  if (paidCache.size > 1000) {
    // Hapus entry terlama
    const oldest = [...paidCache.entries()].sort((a, b) => a[1] - b[1])[0];
    paidCache.delete(oldest[0]);
  }
  return true;
}
// Bersihkan cache tiap jam
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of paidCache.entries()) {
    if (now - ts > 3600_000) paidCache.delete(k);
  }
}, 3600_000);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getBotToken(orderId) {
  if (!orderId) return null;
  for (const [prefix, token] of Object.entries(BOT_TOKENS)) {
    if (orderId.startsWith(prefix) && token) return token;
  }
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

// Forward ke bot VPS untuk credit saldo
async function notifyBotVps(payload) {
  if (!BOT_NOTIFY_URL) return false;
  try {
    await axios.post(
      `${BOT_NOTIFY_URL}/notify-paid`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': INTERNAL_SECRET,
        },
        timeout: 10000,
      }
    );
    console.log(`[Webhook] ✅ Forwarded ke bot VPS: order=${payload.tx_id}`);
    return true;
  } catch (e) {
    console.error(`[Webhook] ❌ Gagal forward ke bot VPS: ${e.message}`);
    return false;
  }
}

async function createQrisFromPakasir(orderId, amount) {
  if (!PAKASIR_API_KEY) throw new Error('PAKASIR_API_KEY belum diset.');
  if (!PAKASIR_PROJECT) throw new Error('PAKASIR_PROJECT belum diset.');

  const res = await axios.post(
    PAKASIR_CREATE_URL,
    { api_key: PAKASIR_API_KEY, project: PAKASIR_PROJECT, order_id: orderId, amount },
    { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
  );

  const data          = res.data?.payment ?? res.data?.data ?? res.data ?? {};
  const paymentNumber = data.payment_number ?? data.qris_number ?? data.qr_string ?? null;
  const expiredAt     = data.expired_at ?? data.expiry ?? null;

  if (!paymentNumber) {
    throw new Error(`Pakasir tidak mengembalikan QRIS. Response: ${JSON.stringify(res.data)}`);
  }

  return {
    paymentNumber,
    payUrl:    `https://app.pakasir.com/pay/${PAKASIR_SLUG}/${orderId}?qris_only=1`,
    expiredAt,
  };
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '256kb' }));
app.disable('x-powered-by');

function requireInternal(req, res, next) {
  if (!INTERNAL_SECRET) return next();
  const key = req.headers['x-internal-key'] || req.query.key;
  if (key !== INTERNAL_SECRET) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/',       (_, res) => res.json({ status: 'ok', service: 'pakasir-railway', version: '3.1.0', ts: new Date().toISOString() }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));

/**
 * POST /transaction
 * Bot VPS → Railway → Pakasir API → QRIS
 * Body: { order_id, user_id, chat_id, amount }
 * Response: { ok, order_id, payment_number, pay_url, expired_at }
 */
app.post('/transaction', requireInternal, async (req, res) => {
  const { order_id, user_id, chat_id, amount } = req.body ?? {};

  if (!order_id || !user_id || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'order_id, user_id, chat_id, dan amount (>0) wajib diisi.' });
  }

  try {
    const qris = await createQrisFromPakasir(order_id, amount);
    console.log(`[/transaction] OK: order=${order_id} user=${user_id} amount=${amount}`);

    return res.json({
      ok:             true,
      order_id,
      payment_number: qris.paymentNumber,
      pay_url:        qris.payUrl,
      expired_at:     qris.expiredAt ?? new Date(Date.now() + 3600_000).toISOString(),
    });
  } catch (e) {
    console.error(`[/transaction] ERROR: ${e.message}`);
    return res.status(502).json({ error: `Gagal buat QRIS: ${e.message}` });
  }
});

/**
 * POST /webhook/pakasir
 * Pakasir → Railway → (forward ke bot VPS ATAU kirim Telegram langsung)
 *
 * Pakasir kirim: { order_id, status, amount, user_id, ... }
 * PENTING: order_id di Pakasir = tx_id di bot VPS
 *          user_id di Pakasir = telegram_id user (jika bot kirim user_id ke Pakasir saat buat transaksi)
 */
app.post('/webhook/pakasir', (req, res) => {
  // Balas Pakasir segera — jangan timeout
  res.status(200).json({ received: 'ok' });

  // Validasi secret
  if (WEBHOOK_SECRET) {
    const sig = req.headers['x-pakasir-signature'] ?? req.headers['x-webhook-secret'] ?? req.query.secret ?? '';
    if (sig !== WEBHOOK_SECRET) {
      console.warn(`[Webhook] Signature invalid: "${sig}"`);
      return;
    }
  }

  setImmediate(async () => {
    try {
      const body = req.body ?? {};
      const { order_id, status, amount, user_id } = body;

      if (!order_id) return;

      const isPaid = ['completed', 'paid', 'settlement', 'success']
        .includes(String(status).toLowerCase());

      console.log(`[Webhook] order=${order_id} status=${status} paid=${isPaid}`);

      if (!isPaid) return;

      // Idempotency — jangan proses ulang jika Pakasir retry
      if (!markPaid(order_id)) {
        console.log(`[Webhook] order=${order_id} sudah diproses sebelumnya — skip`);
        return;
      }

      const numAmount = Number(amount) || 0;
      const token     = getBotToken(order_id);
      const chatId    = user_id || null;

      // ── Coba forward ke bot VPS (cara terbaik — bot yang kredit saldo) ──
      const forwarded = await notifyBotVps({
        tx_id:   order_id,
        user_id: chatId,
        chat_id: chatId,
        amount:  numAmount,
      });

      // ── Fallback: jika bot VPS tidak bisa dihubungi, kirim Telegram manual ──
      // (saldo tidak otomatis kredit — admin perlu topup manual atau bot punya fallback lain)
      if (!forwarded && token && chatId) {
        console.warn(`[Webhook] BOT_NOTIFY_URL gagal/kosong — kirim notif Telegram saja`);
        const text =
          `✅ *Pembayaran Diterima*\n\n` +
          `💵 Jumlah : *Rp ${numAmount.toLocaleString('id-ID')}*\n` +
          `🆔 Order  : \`${order_id}\`\n\n` +
          `⏳ _Saldo sedang diproses, mohon tunggu sebentar atau hubungi admin jika belum masuk._`;
        await sendTelegram(token, chatId, text);
      }
    } catch (e) {
      console.error(`[Webhook async] ${e.message}`);
    }
  });
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Pakasir Railway server v3.1 berjalan di port ${PORT}`);
  if (BOT_NOTIFY_URL) console.log(`🔗 Bot VPS URL: ${BOT_NOTIFY_URL}`);
  else console.warn(`⚠️  BOT_NOTIFY_URL kosong — kredit saldo tidak akan otomatis!`);
});

function shutdown(signal) {
  console.log(`[${signal}] Menutup server...`);
  server.close(() => { console.log('Server ditutup.'); process.exit(0); });
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (e) => console.error(`[uncaughtException] ${e.message}`, e.stack));
process.on('unhandledRejection', (e) => console.error(`[unhandledRejection] ${e}`));
    
