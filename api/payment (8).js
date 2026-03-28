import { createClient } from '@supabase/supabase-js';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY belum dikonfigurasi');
  return createClient(url, key);
}

const DUR = {
  '1d':'1 Hari','3d':'3 Hari','7d':'1 Minggu','10d':'10 Hari',
  '15d':'15 Hari','20d':'20 Hari','1m':'1 Bulan','3m':'3 Bulan',
  '6m':'6 Bulan','1y':'1 Tahun',
};

const validateEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { product_id, duration, quantity, email, whatsapp } = req.body || {};

    if (!product_id || !duration || !quantity || !email || !whatsapp)
      return res.status(400).json({ error: 'Semua field wajib diisi' });
    if (!validateEmail(email))
      return res.status(400).json({ error: 'Format email tidak valid' });
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1 || qty > 20)
      return res.status(400).json({ error: 'Jumlah akun 1–20' });

    const qrisKey = process.env.QRIS_API_KEY;
    const qrisMerchant = process.env.QRIS_MERCHANT_ID;
    if (!qrisKey) return res.status(500).json({ error: 'QRIS_API_KEY belum dikonfigurasi' });

    const db = getDb();

    // Fetch product
    const { data: rows, error: pErr } = await db
      .from('products').select('id,name,category,prices,rules')
      .eq('id', product_id).eq('active', true).limit(1);
    if (pErr || !rows?.length) return res.status(404).json({ error: 'Produk tidak ditemukan' });

    const prod  = rows[0];
    const price = prod.prices?.[duration];
    if (!price) return res.status(400).json({ error: 'Durasi tidak tersedia' });

    // Check stock (duration-specific first, then any)
    const { data: stockRows } = await db.from('account_pool')
      .select('id').eq('product_id', product_id).eq('used', false)
      .or(`duration.eq.${duration},duration.is.null`)
      .limit(qty);
    if (!stockRows || stockRows.length < qty)
      return res.status(400).json({ error: `Stok tidak cukup (tersedia: ${stockRows?.length||0})` });

    // 1% QRIS fee
    const baseTotal = price * qty;
    const fee       = Math.ceil(baseTotal * 0.01);
    const total     = baseTotal + fee;
    const durLabel  = DUR[duration] || duration;
    const desc      = `${prod.name} x${qty} ${durLabel}`.slice(0, 50);

    // App URL for webhook
    const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
    const webhookUrl = `${appUrl}/api/webhook`;

    // === qris.pw API ===
    let txnId, qrImage, expiredAt, payUrl;
    try {
      const body = {
        amount:       total,
        description:  desc,
        customer_email: email,
        customer_phone: whatsapp,
        callback_url:   webhookUrl,
        expired_time:   5, // minutes
        ...(qrisMerchant ? { merchant_id: qrisMerchant } : {}),
      };

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);
      const gwRes = await fetch('https://qris.pw/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${qrisKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(t);

      const raw = await gwRes.text();
      console.log('qris.pw create response:', raw.slice(0, 300));

      let gw;
      try { gw = JSON.parse(raw); } catch(_) {
        return res.status(502).json({ error: 'Gateway mengembalikan respon tidak valid: ' + raw.slice(0,100) });
      }

      if (!gw?.success && !gw?.status) {
        return res.status(502).json({ error: gw?.message || gw?.error || 'Gateway error' });
      }

      const d   = gw.data || gw;
      txnId      = d.invoice_id || d.id || d.transaction_id || d.trx_id;
      qrImage    = d.qr_image   || d.qr_code_image || d.image;
      payUrl     = d.payment_url || d.pay_url || d.url;
      expiredAt  = d.expired_at  || d.expire_time;

      if (!txnId) return res.status(502).json({ error: 'Gateway tidak mengembalikan ID transaksi' });
    } catch (fetchErr) {
      return res.status(502).json({ error: 'Gagal menghubungi gateway: ' + fetchErr.message });
    }

    // Save order
    const { error: oErr } = await db.from('orders').insert({
      txn_id: txnId, product_id: prod.id, product_name: prod.name,
      category: prod.category, email: email.toLowerCase().trim(),
      whatsapp: whatsapp.trim(), duration, duration_label: durLabel,
      quantity: qty, total, status: 'pending',
    });
    if (oErr && !oErr.message?.includes('duplicate'))
      return res.status(500).json({ error: 'Gagal menyimpan pesanan: ' + oErr.message });

    return res.status(200).json({ txn_id: txnId, qr_image: qrImage, pay_url: payUrl, total, expired_at: expiredAt, fee });
  } catch (err) {
    console.error('Payment error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
