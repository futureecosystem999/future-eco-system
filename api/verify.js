// api/verify.js
// Patikrina, ar užklausa tikrai ateina iš Telegram (initData parašo tikrinimas).
// Tai SAUGUS, atskiras endpoint — nieko esamo nelaužia. Tai pamatas būsimai balanso apsaugai.
//
// Kaip veikia: Telegram, atidarant Mini App, duoda pasirašytą "initData" eilutę.
// Parašą galima patikrinti tik su bot tokenu (kurį žino tik serveris).
// Jei parašas teisingas -> tai tikras Telegram vartotojas, ne botas/sukčius.

const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN || '';

// Telegram initData parašo tikrinimo algoritmas (oficialus).
function checkTelegramAuth(initData, botToken) {
  if (!initData || !botToken) return { ok: false, reason: 'missing initData or token' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no hash' };

  // Surenkam visus laukus (be hash), surūšiuojam, sujungiam į "key=value\n" formatą.
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  // secret = HMAC_SHA256(bot_token) su raktu "WebAppData"
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  // tikrinam: HMAC_SHA256(dataCheckString) su tuo secret
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return { ok: false, reason: 'bad signature' };

  // Patikrinam, kad duomenys nesenesni nei 24h (apsauga nuo pakartojimo).
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (authDate && ageSeconds > 86400) return { ok: false, reason: 'expired' };

  // Ištraukiam vartotoją.
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (e) {}

  return { ok: true, user, authDate };
}

export default async function handler(req, res) {
  // Leidžiam CORS, kad žaidimas (kitas domenas) galėtų kviesti.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const initData = body && body.initData;

  const result = checkTelegramAuth(initData, BOT_TOKEN);

  if (!result.ok) {
    return res.status(401).json({ ok: false, reason: result.reason });
  }

  // Parašas teisingas. Grąžinam patvirtintą vartotoją.
  // (Kol kas tik patvirtinam tapatybę. Balanso logiką pridėsim kitame žingsnyje.)
  return res.status(200).json({
    ok: true,
    verified: true,
    user_id: result.user ? String(result.user.id) : null,
    username: result.user ? (result.user.username || result.user.first_name || 'Player') : null
  });
}
