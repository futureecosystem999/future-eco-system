// Authenticated balance sync. The browser NEVER writes balances directly.
// Every write here requires a valid Telegram initData signature, and the
// server is the single source of truth for balance (anti-cheat capped).
const { checkTelegramAuth } = require('./_auth.js');
const { sb } = require('./_db.js');

const BOT_TOKEN = process.env.BOT_TOKEN || '';

// Anti-cheat: balance may grow at most this fast since the last sync.
// taps*100 covers legit per-tap value + boosters/VIP; time cap stops a client
// from claiming an impossible jump even if it also inflates total_taps.
const MAX_PER_TAP = 100;
const BASE_BUFFER = 50000;            // referrals / lottery / one-off bonuses
const MAX_GROWTH_PER_SEC = 200;       // hard ceiling on balance increase rate
const WELCOME_BONUS = 500;            // new referred player
const REFERRER_BONUS = 500;           // person who referred them

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

  const tgId = String(auth.user.id);
  const p = body.player || {};

  const clientBalance = Math.max(0, Math.floor(Number(p.balance) || 0));
  const totalTaps = Math.max(0, Math.floor(Number(p.total_taps) || 0));
  const level = Math.max(1, Math.min(30, Math.floor(Number(p.level) || 1)));

  // Load existing row (trusted server state)
  let existing = null;
  try {
    const r = await sb(
      'users?user_id=eq.' + encodeURIComponent(tgId) +
      '&select=balance,total_taps,referred_by,referral_bonus_paid,updated_at',
      'GET'
    );
    if (r.data && r.data.length) existing = r.data[0];
  } catch (e) {}

  const prevBalance = existing ? Math.floor(Number(existing.balance) || 0) : 0;
  const prevUpdated = existing && existing.updated_at ? Date.parse(existing.updated_at) : 0;
  const isNew = !existing;

  // ---- Anti-cheat caps ----
  const tapCap = totalTaps * MAX_PER_TAP + BASE_BUFFER;
  const elapsedSec = prevUpdated ? Math.max(1, (Date.now() - prevUpdated) / 1000) : 86400;
  const growthCap = prevBalance + Math.ceil(elapsedSec * MAX_GROWTH_PER_SEC) + BASE_BUFFER;
  const cap = Math.min(tapCap, growthCap);

  let newBalance = clientBalance;
  // Anti-cheat: cap how FAST the balance may GROW (stops auto-tap bots / edits).
  if (newBalance > cap) newBalance = cap;
  // Decreases are always allowed: spending tokens (skins, boosts, lottery, gifts,
  // withdrawals) is legitimate and must persist across refreshes. Only growth is capped.

  // ---- Server-side referral handling (paid exactly once) ----
  let bonusApplied = false;
  const referredBy = existing ? existing.referred_by : (p.referred_by || null);
  const alreadyPaid = existing ? !!existing.referral_bonus_paid : false;

  if (isNew && p.referred_by) {
    const refCode = String(p.referred_by).toUpperCase().slice(0, 16);
    // Award only if the referrer exists and it isn't a self-referral.
    if (refCode) {
      try {
        const r = await sb(
          'users?referral_code=eq.' + encodeURIComponent(refCode) +
          '&select=user_id,balance,referral_count&limit=1',
          'GET'
        );
        if (r.data && r.data[0] && String(r.data[0].user_id) !== tgId) {
          const refUser = r.data[0];
          await sb('users?user_id=eq.' + encodeURIComponent(refUser.user_id), 'PATCH', {
            balance: Math.floor(Number(refUser.balance) || 0) + REFERRER_BONUS,
            referral_count: Math.floor(Number(refUser.referral_count) || 0) + 1
          });
          newBalance += WELCOME_BONUS;
          bonusApplied = true;
        }
      } catch (e) {}
    }
  }

  const row = {
    user_id: tgId,
    username: (p.username || auth.user.username || auth.user.first_name || 'Player')
      .toString().slice(0, 64),
    balance: newBalance,
    total_taps: totalTaps,
    level: level,
    referral_code: (p.referral_code || ('F' + tgId.slice(-5))).toString().toUpperCase().slice(0, 16),
    referred_by: referredBy ? String(referredBy).toUpperCase().slice(0, 16) : null,
    referral_count: Math.max(0, Math.floor(Number(p.referral_count) || 0)),
    verified_player: !!p.verified_player,
    vip_member: !!p.vip_member,
    referral_bonus_paid: alreadyPaid || bonusApplied,
    updated_at: new Date().toISOString()
  };

  try {
    const r = await sb('users', 'POST', row, 'resolution=merge-duplicates,return=representation');
    if (r.status >= 200 && r.status < 300) {
      return res.status(200).json({
        ok: true,
        balance: newBalance,
        capped: clientBalance > cap,
        bonus: bonusApplied ? WELCOME_BONUS : 0
      });
    }
    return res.status(500).json({ ok: false, reason: 'db error', status: r.status });
  } catch (e) {
    return res.status(500).json({ ok: false, reason: 'exception' });
  }
}
