import { createClient } from '@supabase/supabase-js';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY belum dikonfigurasi');
  return createClient(url, key);
}

function maskEmail(email) {
  const [local = '', domain = ''] = (email || '').split('@');
  const masked = local.length <= 2 ? local + '***' : local.slice(0, 2) + '***' + local.slice(-1);
  return domain ? `${masked}@${domain}` : masked + '***';
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db = getDb();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const { data, error } = await db
      .from('orders')
      .select('email, total, product_name')
      .eq('status', 'paid')
      .gte('created_at', monthStart);

    if (error) return res.status(500).json({ error: error.message });

    const map = {};
    for (const o of data || []) {
      if (!map[o.email]) map[o.email] = { email: maskEmail(o.email), total: 0, count: 0 };
      map[o.email].total += o.total || 0;
      map[o.email].count += 1;
    }

    const leaderboard = Object.values(map).sort((a, b) => b.total - a.total).slice(0, 10);
    const month = now.toLocaleString('id-ID', { month: 'long', year: 'numeric' });

    return res.status(200).json({ leaderboard, total_customers: Object.keys(map).length, month });
  } catch (err) {
    console.error('Leaderboard error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
