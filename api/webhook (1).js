import { createClient } from '@supabase/supabase-js';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase not configured');
  return createClient(url, key);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-signature, x-webhook-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body || {};
    console.log('Webhook received:', JSON.stringify(payload).slice(0, 400));

    // Extract fields — flexible for qris.pw and similar
    const status   = (payload.status || payload.payment_status || '').toLowerCase();
    const txnId    = payload.invoice_id || payload.id || payload.transaction_id || payload.trx_id || payload.order_id;
    const isPaid   = status === 'paid' || status === 'success' || status === 'settlement' || status === 'completed';

    if (!txnId) return res.status(400).json({ error: 'txn_id missing' });
    if (!isPaid) return res.status(200).json({ ok: true, message: 'Not paid, ignored' });

    const db = getDb();

    // Find order
    const { data: orders, error: oErr } = await db
      .from('orders').select('*').eq('txn_id', txnId).limit(1);
    if (oErr || !orders?.length) {
      console.error('Order not found for txn:', txnId);
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orders[0];

    if (order.status === 'paid') return res.status(200).json({ ok: true, message: 'Already paid' });

    // Claim accounts (duration-specific first, then any)
    const { data: pool, error: pErr } = await db.from('account_pool')
      .select('id, account_data')
      .eq('product_id', order.product_id)
      .eq('used', false)
      .or(`duration.eq.${order.duration},duration.is.null`)
      .order('created_at', { ascending: true })
      .limit(order.quantity);

    if (pErr) { console.error('Pool error:', pErr); return res.status(500).json({ error: pErr.message }); }

    const now = new Date().toISOString();
    const ids = (pool || []).map(a => a.id);

    if (ids.length > 0) {
      await db.from('account_pool').update({ used: true, order_id: order.id, used_at: now }).in('id', ids);
    }

    // Get product rules
    const { data: prodRows } = await db.from('products').select('rules').eq('id', order.product_id).limit(1);
    const rules = prodRows?.[0]?.rules || '';
    const accounts = (pool || []).map(a => ({ ...a.account_data, ...(rules ? { rules } : {}) }));

    // Mark order paid + store accounts snapshot
    await db.from('orders').update({
      status: 'paid',
      paid_at: now,
      accounts_snapshot: JSON.stringify(accounts),
    }).eq('id', order.id);

    console.log(`Order ${txnId} paid — delivered ${accounts.length} accounts`);
    return res.status(200).json({ ok: true, delivered: accounts.length });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
}
