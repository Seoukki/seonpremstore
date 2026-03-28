/**
 * admin.js — merged: auth + admin management + activity logs
 * GET  ?action=logs          → activity logs
 * GET  ?action=list          → list admins (superadmin)
 * POST {action:'login'}      → login
 * POST {action:'logout'}     → logout
 * POST {action:'verify'}     → verify token
 * POST {action:'add_admin'}  → add new admin (superadmin)
 * PUT                        → update admin (superadmin)
 */
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

function getDb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');
  return createClient(url, key);
}
const hashPw   = pw => crypto.createHash('sha256').update(pw + (process.env.SALT || 'sp2025')).digest('hex');
const genToken = () => crypto.randomBytes(32).toString('hex');
const limiter  = new Map();

function rateOk(ip) {
  const now = Date.now(), r = limiter.get(ip) || { n: 0, t: now };
  if (now - r.t > 60000) { r.n = 0; r.t = now; }
  r.n++; limiter.set(ip, r); return r.n <= 10;
}

async function getAdmin(req, db) {
  const token = req.headers['x-admin-token'] || '';
  if (!token) return null;
  const { data } = await db.from('admins').select('id,username,role,login_at')
    .eq('session_token', token).eq('active', true).single();
  return data || null;
}

async function logAction(db, adminId, adminName, action, detail) {
  await db.from('admin_logs').insert({ admin_id: adminId, admin_name: adminName, action, detail }).catch(() => {});
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();

  try {
    const db = getDb();

    // ─── GET ─────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const admin = await getAdmin(req, db);
      if (!admin) return res.status(401).json({ error: 'Unauthorized' });

      if (req.query.action === 'logs') {
        const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
        let q = db.from('admin_logs').select('id,admin_id,admin_name,action,detail,created_at')
          .order('created_at', { ascending: false }).limit(limit);
        if (admin.role !== 'superadmin') q = q.eq('admin_id', admin.id);
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data || []);
      }

      if (req.query.action === 'list') {
        if (admin.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin required' });
        const { data, error } = await db.from('admins')
          .select('id,username,email,role,active,created_at,last_login').order('created_at');
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data || []);
      }

      return res.status(400).json({ error: 'Gunakan ?action=logs atau ?action=list' });
    }

    // ─── PUT: update admin ──────────────────────────────────────────
    if (req.method === 'PUT') {
      const admin = await getAdmin(req, db);
      if (!admin || admin.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin required' });
      const { id, active, role, password } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id diperlukan' });
      const upd = {};
      if (active !== undefined) upd.active = active;
      if (role)     upd.role = role;
      if (password) upd.password_hash = hashPw(password);
      await db.from('admins').update(upd).eq('id', id);
      await logAction(db, admin.id, admin.username, 'UPDATE_ADMIN', `Update ID ${id}: ${JSON.stringify(upd)}`);
      return res.status(200).json({ success: true });
    }

    // ─── POST ────────────────────────────────────────────────────────
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};
    const { action } = body;

    // LOGOUT
    if (action === 'logout') {
      const token = body.token || req.headers['x-admin-token'] || '';
      if (token) {
        const { data: adm } = await db.from('admins')
          .select('id,username,login_at').eq('session_token', token).single();
        if (adm) {
          const dur = adm.login_at ? Math.round((Date.now() - new Date(adm.login_at).getTime()) / 60000) : 0;
          await db.from('admins').update({ session_token: null }).eq('id', adm.id);
          await logAction(db, adm.id, adm.username, 'LOGOUT', `Logout setelah ${dur} menit`);
        }
      }
      return res.status(200).json({ ok: true });
    }

    // VERIFY
    if (action === 'verify') {
      const token = body.token || req.headers['x-admin-token'] || '';
      if (!token) return res.status(401).json({ error: 'Token diperlukan' });
      const { data: adm } = await db.from('admins')
        .select('id,username,email,role,login_at').eq('session_token', token).eq('active', true).single();
      if (!adm) return res.status(401).json({ error: 'Token tidak valid' });
      return res.status(200).json({ ok: true, admin: adm });
    }

    // ADD ADMIN (superadmin only)
    if (action === 'add_admin') {
      const admin = await getAdmin(req, db);
      if (!admin || admin.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin required' });
      const { username, email, password, role = 'admin' } = body;
      if (!username || !email || !password)
        return res.status(400).json({ error: 'username, email, password wajib diisi' });
      const { data, error } = await db.from('admins').insert({
        username: username.trim(), email: email.toLowerCase().trim(),
        password_hash: hashPw(password), role, active: true,
      }).select('id,username,email,role').single();
      if (error) return res.status(500).json({ error: error.message });
      await logAction(db, admin.id, admin.username, 'ADD_ADMIN', `Tambah admin: ${username} (${role})`);
      return res.status(201).json(data);
    }

    // LOGIN (default action)
    if (!rateOk(ip)) return res.status(429).json({ error: 'Terlalu banyak percobaan, tunggu 1 menit' });
    const { username, password } = body;
    if (!username || !password) return res.status(400).json({ error: 'username dan password wajib diisi' });

    // Master env admin
    const masterUser = process.env.SUPER_ADMIN_USER || 'superadmin';
    const masterPass = process.env.ADMIN_PASSWORD || '';
    let adminRecord;

    if (masterPass && username === masterUser && password === masterPass) {
      const { data: ex } = await db.from('admins').select('*').eq('username', masterUser).limit(1);
      adminRecord = ex?.[0];
      if (!adminRecord) {
        const { data: cr } = await db.from('admins').insert({
          username: masterUser, email: process.env.SUPER_ADMIN_EMAIL || 'admin@seonsstore.com',
          password_hash: hashPw(masterPass), role: 'superadmin', active: true,
        }).select().single();
        adminRecord = cr;
      }
    } else {
      const { data: rows } = await db.from('admins').select('*').eq('active', true)
        .or(`username.eq.${username},email.eq.${username}`).limit(1);
      const found = rows?.[0];
      if (!found || found.password_hash !== hashPw(password))
        return res.status(401).json({ error: 'Username atau password salah' });
      adminRecord = found;
    }

    if (!adminRecord) return res.status(401).json({ error: 'Login gagal' });

    const token = genToken();
    const now   = new Date().toISOString();
    await db.from('admins').update({ session_token: token, last_login: now, login_at: now }).eq('id', adminRecord.id);
    await logAction(db, adminRecord.id, adminRecord.username, 'LOGIN', `IP: ${ip}`);

    return res.status(200).json({
      ok: true, token,
      admin: { id: adminRecord.id, username: adminRecord.username, email: adminRecord.email, role: adminRecord.role },
    });

  } catch (err) {
    console.error('Admin error:', err);
    return res.status(500).json({ error: err.message });
  }
}
