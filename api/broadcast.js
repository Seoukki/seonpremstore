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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db = getDb();
    const isAdmin = adminCheck(req);

    // ── GET ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (isAdmin) {
        // Admin: full history (50 latest)
        const { data, error } = await db
          .from('broadcasts')
          .select('id, message, active, created_at')
          .order('created_at', { ascending: false })
          .limit(50);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ history: data || [] });
      }

      // Public: latest broadcast (active = true)
      const { data, error } = await db
        .from('broadcasts')
        .select('id, message, created_at')
        .eq('active', true)
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) return res.status(500).json({ error: error.message });
      if (!data || data.length === 0) return res.status(204).end();
      return res.status(200).json(data[0]);
    }

    // Admin-only below ──────────────────────────────────────────────
    if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });

    // ── POST — create new broadcast ───────────────────────────────────
    if (req.method === 'POST') {
      const { message } = req.body || {};
      if (!message?.trim()) return res.status(400).json({ error: 'Pesan tidak boleh kosong' });

      // Deactivate all existing
      await db.from('broadcasts').update({ active: false }).neq('id', '00000000-0000-0000-0000-000000000000');

      const { data, error } = await db.from('broadcasts')
        .insert({ message: message.trim(), active: true })
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json(data);
    }

    // ── DELETE ────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id diperlukan' });
      const { error } = await db.from('broadcasts').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Broadcast error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
