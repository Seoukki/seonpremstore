import { createClient } from '@supabase/supabase-js';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY belum dikonfigurasi');
  return createClient(url, key);
}

const adminCheck = req => (req.headers['x-admin-key'] || '') === process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!adminCheck(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);

    const { data: orders, error } = await db
      .from('orders')
      .select('id, txn_id, product_name, email, total, status, created_at, paid_at, quantity, duration_label')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });

    const paid = (orders || []).filter(o => o.status === 'paid');
    const totalRevenue = paid.reduce((s, o) => s + (o.total || 0), 0);

    return res.status(200).json({
      orders: orders || [],
      stats: {
        total_orders:   (orders || []).length,
        paid_orders:    paid.length,
        pending_orders: (orders || []).filter(o => o.status === 'pending').length,
        total_revenue:  totalRevenue,
      },
    });
  } catch (err) {
    console.error('Orders error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
