// Shared Telegram WebApp initData verification (server-side only).
// Files prefixed with "_" are NOT treated as routes by Vercel.
const crypto = require('crypto');

function checkTelegramAuth(initData, botToken) {
  if (!initData || !botToken) return { ok: false, reason: 'missing initData or token' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no hash' };
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  // constant-time compare to avoid timing leaks
  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad signature' };
  }
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (authDate && ageSeconds > 86400) return { ok: false, reason: 'expired' };
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (e) {}
  if (!user || !user.id) return { ok: false, reason: 'no user' };
  return { ok: true, user, authDate };
}

module.exports = { checkTelegramAuth };
