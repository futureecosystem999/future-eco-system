// PUBLIC read-only endpoint. No secrets exposed to the browser.
// All DB access happens here with the service key; only safe columns are returned.
const { sb } = require('./_db.js');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function clampLimit(v, def, max) {
  const n = Math.floor(Number(v) || def);
  return Math.max(1, Math.min(max, n));
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, reason: 'GET only' });

  const q = (req.query && req.query.q) || '';

  try {
    if (q === 'count') {
      // HEAD with count header avoids pulling the whole table.
      const r = await sb('users?select=user_id', 'GET', null, 'count=exact');
      const count = Array.isArray(r.data) ? r.data.length : 0;
      return res.status(200).json({ ok: true, count });
    }

    if (q === 'leaderboard') {
      const limit = clampLimit(req.query.limit, 50, 100);
      const r = await sb(
        'users?select=username,balance,total_taps,level,verified_player,vip_member&order=balance.desc&limit=' + limit,
        'GET'
      );
      return res.status(200).json({ ok: true, players: r.data || [] });
    }

    if (q === 'friends') {
      const code = String(req.query.code || '').slice(0, 16);
      if (!code) return res.status(400).json({ ok: false, reason: 'no code' });
      const r = await sb(
        'users?referred_by=eq.' + encodeURIComponent(code) + '&select=username,balance&limit=50',
        'GET'
      );
      return res.status(200).json({ ok: true, friends: r.data || [] });
    }

    if (q === 'refcount') {
      const code = String(req.query.code || '').slice(0, 16);
      if (!code) return res.status(400).json({ ok: false, reason: 'no code' });
      const r = await sb(
        'users?referred_by=eq.' + encodeURIComponent(code) + '&select=user_id',
        'GET'
      );
      return res.status(200).json({ ok: true, count: Array.isArray(r.data) ? r.data.length : 0 });
    }

    if (q === 'lottery') {
      const week = Math.floor(Number(req.query.week) || 0);
      const winners = await sb(
        'lottery_winners?week_number=eq.' + (week - 1) + '&select=prize_ton&order=claimed_at.desc&limit=5',
        'GET'
      );
      const tickets = await sb(
        'lottery_tickets?week_number=eq.' + week + '&select=amount_ton',
        'GET'
      );
      const sold = Array.isArray(tickets.data) ? tickets.data.length : 0;
      const pool = Array.isArray(tickets.data)
        ? tickets.data.reduce((s, t) => s + (Number(t.amount_ton) || 0), 0)
        : 0;
      return res.status(200).json({
        ok: true,
        winners: winners.data || [],
        sold,
        pool
      });
    }

    return res.status(400).json({ ok: false, reason: 'unknown q' });
  } catch (e) {
    return res.status(500).json({ ok: false, reason: 'exception' });
  }
}
