import { createClient } from '@supabase/supabase-js';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase not configured');
  return createClient(url, key);
}

const adminCheck = req => (req.headers['x-admin-key'] || '') === process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!adminCheck(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const db = getDb();

    if (req.method === 'GET') {
      const { product_id, duration } = req.query;
      if (!product_id) return res.status(400).json({ error: 'product_id diperlukan' });
      let q = db.from('account_pool').select('id, account_data, duration, used, created_at')
        .eq('product_id', product_id).eq('used', false).order('created_at', { ascending: false });
      if (duration) q = q.eq('duration', duration);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ items: data || [], count: (data||[]).length });
    }

    if (req.method === 'POST') {
      const { product_id, account_data, duration } = req.body || {};
      if (!product_id || !account_data || typeof account_data !== 'object')
        return res.status(400).json({ error: 'product_id dan account_data diperlukan' });
      const { data, error } = await db.from('account_pool').insert({
        product_id, account_data, duration: duration || null, used: false,
      }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json(data);
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id diperlukan' });
      const { error } = await db.from('account_pool').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Stock error:', err);
    return res.status(500).json({ error: err.message });
  }
}
