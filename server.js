'use strict';

/**
 * PAKASIR RAILWAY WEBHOOK SERVER — Production Edition
 * ─────────────────────────────────────────────────────
 * Tugas:
 *   1. Terima POST /transaction dari bot → simpan ke DB, panggil Pakasir API → buat QRIS
 *   2. Terima POST /webhook/pakasir (dari Pakasir) → credit saldo Railway DB → notif bot
 *   3. Endpoint utilitas: GET /transaction/:id, GET /balance/:telegram_id
 *
 * Keamanan:
 *   - WEBHOOK_SECRET: Pakasir mengirim header X-Pakasir-Signature atau query ?secret=
 *   - INTERNAL_SECRET: Bot harus kirim header X-Internal-Key agar endpoint internal tidak publik
 *   - Idempotent webhook: double-credit mustahil karena SELECT+UPDATE dalam satu DB transaction
 *   - WAL mode + busy_timeout agar aman concurrent write
 *   - Graceful shutdown: tutup DB + HTTP server dengan bersih
 */

const express  = require('express');
const axios    = require('axios');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const PORT              = parseInt(process.env.PORT) || 3000;
const PAKASIR_API_KEY   = process.env.PAKASIR_API_KEY   || '';
const PAKASIR_PROJECT   = process.env.PAKASIR_PROJECT   || '';
const PAKASIR_SLUG      = process.env.PAKASIR_SLUG      || 'kirimkode';   // slug halaman pay
const BOT_TOKENS        = {
  BOTA: process.env.BOT_TOKEN_A || '',
  BOTB: process.env.BOT_TOKEN_B || '',
};
const INTERNAL_SECRET   = process.env.INTERNAL_SECRET   || '';   // bot wajib kirim ini
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET    || '';   // Pakasir webhook secret (opsional)

const PAKASIR_CREATE_URL = 'https://app.pakasir.com/api/transactioncreate/qris';

// ─── DATABASE ───────────────────────────────────────────────────────────────
const DB_PATH = path.resolve(process.env.DB_PATH || './data/pakasir.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous   = NORMAL');
db.pragma('foreign_keys  = ON');
db.pragma('busy_timeout  = 10000');
db.pragma('cache_size    = -16000');  // 16 MB page cache

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id       TEXT    UNIQUE NOT NULL,
    user_id        TEXT    NOT NULL,
    amount         REAL    NOT NULL,
    status         TEXT    DEFAULT 'pending',
    bot_prefix     TEXT,
    payment_number TEXT,
    pay_url        TEXT,
    expired_at     TEXT,
    credited_at    TEXT,
    created_at     TEXT    DEFAULT (datetime('now')),
    updated_at     TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT    UNIQUE NOT NULL,
    balance     REAL    DEFAULT 0,
    updated_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tx_user   ON transactions(user_id);
  CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
`);

// ─── STATEMENTS (prepared once, reused) ────────────────────────────────────
const stmts = {
  insertTx: db.prepare(`
    INSERT OR IGNORE INTO transactions
      (order_id, user_id, amount, bot_prefix, payment_number, pay_url, expired_at)
    VALUES (@order_id, @user_id, @amount, @bot_prefix, @payment_number, @pay_url, @expired_at)
  `),
  getTx:      db.prepare(`SELECT * FROM transactions WHERE order_id=?`),
  markSuccess: db.prepare(`
    UPDATE transactions
    SET status='success', credited_at=datetime('now'), updated_at=datetime('now')
    WHERE order_id=? AND status='pending'
  `),
  markExpired: db.prepare(`
    UPDATE transactions SET status='expired', updated_at=datetime('now') WHERE order_id=?
  `),
  upsertBalance: db.prepare(`
    INSERT INTO users (telegram_id, balance) VALUES (?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      balance    = balance + excluded.balance,
      updated_at = datetime('now')
  `),
  getBalance: db.prepare(`SELECT balance FROM users WHERE telegram_id=?`),
};

// Credit saldo dalam satu atomic DB transaction (idempotent)
const creditBalance = db.transaction((order_id, user_id, amount) => {
  const changed = stmts.markSuccess.run(order_id).changes;
  if (changed === 0) return false;   // sudah diproses sebelumnya → skip
  stmts.upsertBalance.run(user_id, amount);
  return true;
});

// ─── HELPERS ────────────────────────────────────────────────────────────────
function getBotToken(orderId) {
  if (!orderId) return null;
  for (const [prefix, token] of Object.entries(BOT_TOKENS)) {
    if (orderId.startsWith(prefix) && token) return token;
  }
  return null;
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

async function createQrisFromPakasir(orderId, amount, userId) {
  if (!PAKASIR_API_KEY) throw new Error('PAKASIR_API_KEY belum diset di env Railway.');
  if (!PAKASIR_PROJECT) throw new Error('PAKASIR_PROJECT belum diset di env Railway.');

  const res = await axios.post(
    PAKASIR_CREATE_URL,
    {
      api_key:  PAKASIR_API_KEY,
      project:  PAKASIR_PROJECT,
      order_id: orderId,
      amount:   amount,
      user_id:  String(userId),
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
  );

  const data = res.data?.data ?? res.data ?? {};

  // Ambil payment_number (string QRIS) dari beberapa kemungkinan field
  const paymentNumber = data.payment_number ?? data.qris_number ?? data.qr_string ?? null;
  const expiredAt     = data.expired_at ?? data.expiry ?? null;

  if (!paymentNumber) {
    throw new Error(`Pakasir tidak mengembalikan QRIS. Response: ${JSON.stringify(res.data)}`);
  }

  // URL pembayaran dengan qris_only=1 agar user langsung lihat QR
  const payUrl = `https://app.pakasir.com/pay/${PAKASIR_SLUG}/${orderId}?qris_only=1`;

  return { paymentNumber, payUrl, expiredAt };
}

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '256kb' }));
app.disable('x-powered-by');

// Validasi internal key (untuk endpoint yang dipanggil bot)
function requireInternal(req, res, next) {
  if (!INTERNAL_SECRET) return next();  // dev mode: tanpa secret
  const key = req.headers['x-internal-key'] || req.query.key;
  if (key !== INTERNAL_SECRET) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Health check
app.get('/', (_, res) => res.json({ status: 'ok', service: 'pakasir-railway', ts: new Date().toISOString() }));

/**
 * POST /transaction
 * Dipanggil bot setiap kali user minta deposit.
 * 1. Simpan ke DB Railway (INSERT OR IGNORE — idempotent)
 * 2. Panggil Pakasir API untuk buat QRIS
 * 3. Kembalikan { payment_number, pay_url, expired_at } ke bot
 *
 * Body: { order_id, user_id, amount, bot_prefix, expired_at? }
 */
app.post('/transaction', requireInternal, async (req, res) => {
  const { order_id, user_id, amount, bot_prefix, expired_at } = req.body ?? {};

  if (!order_id || !user_id || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'order_id, user_id, dan amount (>0) wajib diisi.' });
  }

  try {
    // Cek apakah order_id ini sudah ada (retry idempotency)
    let tx = stmts.getTx.get(order_id);

    if (!tx) {
      // Panggil Pakasir untuk buat QRIS
      let qris;
      try {
        qris = await createQrisFromPakasir(order_id, amount, user_id);
      } catch (e) {
        console.error(`[createQris] ${e.message}`);
        return res.status(502).json({ error: `Gagal buat QRIS dari Pakasir: ${e.message}` });
      }

      const expAt = qris.expiredAt ?? expired_at ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();

      stmts.insertTx.run({
        order_id,
        user_id:        String(user_id),
        amount,
        bot_prefix:     bot_prefix ?? null,
        payment_number: qris.paymentNumber,
        pay_url:        qris.payUrl,
        expired_at:     expAt,
      });

      tx = stmts.getTx.get(order_id);
    }

    return res.json({
      ok:             true,
      order_id:       tx.order_id,
      payment_number: tx.payment_number,
      pay_url:        tx.pay_url,
      expired_at:     tx.expired_at,
      status:         tx.status,
    });
  } catch (e) {
    console.error(`[POST /transaction] ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

/**
 * POST /webhook/pakasir
 * Diterima dari Pakasir setelah user selesai bayar.
 * Pakasir kirim: { order_id, status, amount, ... }
 * Kita harus balas 200 secepat mungkin, baru proses async.
 */
app.post('/webhook/pakasir', (req, res) => {
  // Balas Pakasir dulu — maksimum 3 detik
  res.status(200).json({ received: 'ok' });

  // Validasi webhook secret (opsional tapi dianjurkan)
  if (WEBHOOK_SECRET) {
    const sig = req.headers['x-pakasir-signature'] ?? req.query.secret ?? '';
    if (sig !== WEBHOOK_SECRET) {
      console.warn(`[Webhook] Invalid signature: ${sig}`);
      return;
    }
  }

  setImmediate(async () => {
    try {
      const { order_id, status, amount } = req.body ?? {};
      if (!order_id) return;

      // Hanya proses jika status completed/paid
      if (!['completed', 'paid', 'settlement', 'success'].includes(String(status).toLowerCase())) return;

      const tx = stmts.getTx.get(order_id);
      if (!tx) { console.warn(`[Webhook] order_id ${order_id} tidak ditemukan.`); return; }

      // Cek expired
      if (tx.expired_at) {
        const exp = new Date(tx.expired_at);
        if (!isNaN(exp.getTime()) && new Date() > exp) {
          stmts.markExpired.run(order_id);
          console.warn(`[Webhook] ${order_id} expired.`);
          return;
        }
      }

      // Credit saldo (atomic + idempotent)
      const credited = creditBalance(order_id, tx.user_id, tx.amount);
      if (!credited) {
        console.info(`[Webhook] ${order_id} sudah diproses sebelumnya, skip.`);
        return;
      }

      console.info(`[Webhook] Deposit OK: order=${order_id} user=${tx.user_id} amount=${tx.amount}`);

      // Notif ke user via Telegram
      const token = getBotToken(order_id);
      if (token) {
        const text =
          `✅ *Deposit Berhasil!*\n\n` +
          `💵 Jumlah : *Rp ${Number(tx.amount).toLocaleString('id-ID')}*\n` +
          `🆔 Order  : \`${order_id.slice(0, 12)}...\`\n\n` +
          `Saldo sudah masuk ke akun Anda.\n_Silakan order OTP sekarang!_`;
        await sendTelegram(token, tx.user_id, text);
      }
    } catch (e) {
      console.error(`[Webhook async] ${e.message}`);
    }
  });
});

/**
 * GET /transaction/:order_id
 * Bot polling untuk cek apakah sudah dibayar.
 */
app.get('/transaction/:order_id', requireInternal, (req, res) => {
  const tx = stmts.getTx.get(req.params.order_id);
  if (!tx) return res.status(404).json({ error: 'Tidak ditemukan.' });
  return res.json({ ok: true, transaction: tx });
});

/**
 * GET /balance/:telegram_id
 * Saldo user di Railway DB (bukan saldo bot lokal).
 */
app.get('/balance/:telegram_id', requireInternal, (req, res) => {
  const row = stmts.getBalance.get(req.params.telegram_id);
  return res.json({ telegram_id: req.params.telegram_id, balance: row?.balance ?? 0 });
});

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Pakasir Railway server berjalan di port ${PORT}`);
});

function shutdown(signal) {
  console.log(`[${signal}] Menutup server...`);
  server.close(() => {
    db.close();
    console.log('DB ditutup. Exit.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (e) => console.error(`[uncaughtException] ${e.message}`, e.stack));
process.on('unhandledRejection', (e) => console.error(`[unhandledRejection] ${e}`));
