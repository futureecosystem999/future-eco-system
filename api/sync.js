const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const SB_URL = process.env.SB_URL || '';
const SB_SERVICE_KEY = process.env.SB_SERVICE_KEY || '';

function checkTelegramAuth(initData, botToken) {
  if (!initData || !botToken) return { ok: false, reason: 'missing initData or token' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no hash' };
  params.delete('hash');
  const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash) return { ok: false, reason: 'bad signature' };
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (authDate && (Math.floor(Date.now() / 1000) - authDate) > 86400) return { ok: false, reason: 'expired' };
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (e) {}
  return { ok: true, user };
}

function maxAllowedBalance(totalTaps) {
  const taps = Math.max(0, Math.floor(Number(totalTaps) || 0));
  // Tested against real players (all pass with large headroom) and fabricated balances (caught).
  // 100/tap covers level + boosters + VIP comfortably; 50k buffer covers referrals/lottery/bonuses.
  return taps * 100 + 50000;
}

async function sb(path, method, body) {
  const res = await fetch(SB_URL + '/rest/v1/' + path, {
    method,
    headers: {
      'apikey': SB_SERVICE_KEY,
      'Authorization': 'Bearer ' + SB_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  return { status: res.status, data };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const auth = checkTelegramAuth(body.initData, BOT_TOKEN);
  if (!auth.ok) return res.status(401).json({ ok: false, reason: auth.reason });

  const tgId = auth.user ? String(auth.user.id) : null;
  if (!tgId) return res.status(400).json({ ok: false, reason: 'no user id' });

  const p = body.player || {};
  const clientBalance = Math.max(0, Math.floor(Number(p.balance) || 0));
  const totalTaps = Math.max(0, Math.floor(Number(p.total_taps) || 0));
  const level = Math.max(1, Math.min(30, Math.floor(Number(p.level) || 1)));

  const cap = maxAllowedBalance(totalTaps);

  let existing = null;
  try {
    const r = await sb('users?user_id=eq.' + encodeURIComponent(tgId) + '&select=balance,total_taps', 'GET');
    if (r.data && r.data.length) existing = r.data[0];
  } catch (e) {}

  const prevBalance = existing ? Math.floor(Number(existing.balance) || 0) : 0;

  let newBalance = clientBalance;
  if (newBalance > cap) newBalance = cap;
  if (newBalance < prevBalance) newBalance = prevBalance;

  const row = {
    user_id: tgId,
    username: (p.username || (auth.user && (auth.user.username || auth.user.first_name)) || 'Player').toString().slice(0, 64),
    balance: newBalance,
    total_taps: totalTaps,
    level: level,
    referral_code: p.referral_code || null,
    referred_by: p.referred_by || null,
    referral_count: Math.max(0, Math.floor(Number(p.referral_count) || 0)),
    verified_player: !!p.verified_player,
    vip_member: !!p.vip_member,
    updated_at: new Date().toISOString()
  };

  try {
    const r = await sb('users', 'POST', row);
    if (r.status >= 200 && r.status < 300) {
      return res.status(200).json({ ok: true, balance: newBalance, capped: clientBalance > cap });
    }
    return res.status(500).json({ ok: false, reason: 'db error', status: r.status });
  } catch (e) {
    return res.status(500).json({ ok: false, reason: 'exception' });
  }
}
