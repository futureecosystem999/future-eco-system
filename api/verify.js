// Verifies a Telegram WebApp initData signature. Returns the authenticated user.
const { checkTelegramAuth } = require('./_auth.js');

const BOT_TOKEN = process.env.BOT_TOKEN || '';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const result = checkTelegramAuth(body && body.initData, BOT_TOKEN);

  if (!result.ok) return res.status(401).json({ ok: false, reason: result.reason });

  return res.status(200).json({
    ok: true,
    verified: true,
    user_id: String(result.user.id),
    username: result.user.username || result.user.first_name || 'Player'
  });
}
