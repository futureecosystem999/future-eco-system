// Secrets come ONLY from Vercel Environment Variables. No hardcoded fallbacks.
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const SB_URL = process.env.SB_URL || '';
// Server-side reads use the SERVICE key (kept secret on the server, never shipped to a browser).
const SB_KEY = process.env.SB_SERVICE_KEY || '';

const LANDING = 'https://futureecosystem999.github.io/future-eco-system/landing.html';
const STATS = 'https://futureecosystem999.github.io/future-eco-system/stats.html';
const GAME = 'https://futureecosystem999.github.io/future-eco-system/';
const TWITTER = 'https://x.com/Futuresystem999';
const INSTAGRAM = 'https://instagram.com/futureecosystem999';
const FACEBOOK = 'https://www.facebook.com/share/1C26VneLKJ/';
const CHANNEL = 'https://t.me/futureecosystem999';

async function sendMessage(chatId, text, keyboard) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function getUser(userId) {
  const res = await fetch(`${SB_URL}/rest/v1/users?user_id=eq.${userId}&limit=1`, {
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
  });
  const data = await res.json();
  return data && data[0] ? data[0] : null;
}

async function getAllUsers() {
  const res = await fetch(`${SB_URL}/rest/v1/users?select=user_id,username,balance,total_taps,level,referral_code,referral_count&order=balance.desc`, {
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
  });
  return await res.json();
}


// Answer pre-checkout query (must respond within 10s or payment fails)
async function answerPreCheckout(queryId, ok, errorMessage) {
  const body = { pre_checkout_query_id: queryId, ok: ok };
  if (!ok && errorMessage) body.error_message = errorMessage;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

// Product catalog (must match action.js create_invoice)
const STAR_PRODUCTS = {
  vip_hivelord: { type: 'vip', value: 30 },
  future_5000:  { type: 'future', value: 5000 },
  future_15000: { type: 'future', value: 15000 },
  future_50000: { type: 'future', value: 50000 },
  energy_full:  { type: 'energy', value: 0 },
  spins_3:      { type: 'spins', value: 3 },
  spins_10:     { type: 'spins', value: 10 }
};

// Credit a purchase to the user in DB (server-side, trusted)
async function creditPurchase(userId, productId, starsAmount, chargeId) {
  const product = STAR_PRODUCTS[productId];
  if (!product) return false;

  // Replay protection: skip if this telegram_charge_id already recorded
  try {
    const dupeRes = await fetch(`${SB_URL}/rest/v1/star_purchases?telegram_charge_id=eq.${encodeURIComponent(chargeId)}&select=id&limit=1`, {
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
    });
    const dupe = await dupeRes.json();
    if (dupe && dupe.length > 0) { console.log('PURCHASE already processed:', chargeId); return true; }
  } catch (e) {}

  // Record purchase
  await fetch(`${SB_URL}/rest/v1/star_purchases`, {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ user_id: userId, product_id: productId, stars_amount: starsAmount, telegram_charge_id: chargeId })
  });

  // Apply reward to user balance for FUTURE packs
  if (product.type === 'future') {
    const user = await getUser(userId);
    const newBalance = (user ? Math.floor(Number(user.balance) || 0) : 0) + product.value;
    await fetch(`${SB_URL}/rest/v1/users?user_id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ balance: newBalance })
    });
  }

  // Activate VIP (Hive Lord) — set vip_member + vip_until 30 days from now.
  // If user already has active VIP, extend from current expiry (stacking).
  if (product.type === 'vip') {
    const user = await getUser(userId);
    const now = Date.now();
    let base = now;
    if (user && user.vip_until && Date.parse(user.vip_until) > now) {
      base = Date.parse(user.vip_until); // extend existing VIP
    }
    const vipUntil = new Date(base + product.value * 24 * 60 * 60 * 1000).toISOString();
    await fetch(`${SB_URL}/rest/v1/users?user_id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ vip_member: true, vip_until: vipUntil })
    });
  }
  // energy & spins are applied client-side (read from star_purchases on next sync)
  console.log('PURCHASE credited user=', userId, 'product=', productId);
  return true;
}


module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const update = req.body;

  // ---- STARS PAYMENT: pre-checkout (must answer within 10s) ----
  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;
    // Approve all valid checkouts (product validity already enforced at invoice creation)
    await answerPreCheckout(q.id, true);
    return res.status(200).json({ ok: true });
  }

  // ---- STARS PAYMENT: successful payment ----
  if (update.message && update.message.successful_payment) {
    const sp = update.message.successful_payment;
    const payerId = String(update.message.from.id);
    let pid = '';
    try { pid = JSON.parse(sp.invoice_payload || '{}').pid || ''; } catch (e) {}
    const chargeId = sp.telegram_payment_charge_id || '';
    const starsAmount = Number(sp.total_amount) || 0;
    try {
      await creditPurchase(payerId, pid, starsAmount, chargeId);
      await sendMessage(update.message.chat.id,
        `✅ <b>Payment successful!</b>\n\nYour purchase has been credited. Open the game to see it! 🐝`,
        [[{ text: '🎮 Open Game', web_app: { url: GAME } }]]
      );
    } catch (e) { console.error('payment credit error:', e.message); }
    return res.status(200).json({ ok: true });
  }

  const msg = update.message;
  if (!msg) return res.status(200).json({ ok: true });

  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = msg.text || '';

  if (text.startsWith('/start')) {
    await sendMessage(chatId,
      `🐝 <b>Welcome to FUTURE-eco-system!</b>\n\nTap the Crystal Bee, earn FUTURE tokens and be part of the next TON blockchain launch!\n\n🎯 Token launches at <b>50,000 players!</b>\n\n<b>Commands:</b>\n/balance — Your token balance\n/stats — Community stats\n/top — Top 10 players\n/referral — Your referral link\n/progress — Token launch progress\n/help — Help`,
      [
        [{ text: '🎮 Play Game', web_app: { url: GAME } }],
        [{ text: '🌐 Website', url: LANDING }, { text: '📊 Live Stats', url: STATS }],
        [{ text: '𝕏 Twitter', url: TWITTER }, { text: '📸 Instagram', url: INSTAGRAM }],
        [{ text: '📢 Telegram Channel', url: CHANNEL }]
      ]
    );

  } else if (text === '/balance') {
    const user = await getUser(userId);
    if (user) {
      await sendMessage(chatId,
        `💰 <b>Your Balance</b>\n\n🐝 <b>${(user.balance||0).toLocaleString()} FUTURE</b>\n📊 Level: ${user.level || 1}\n👆 Total taps: ${(user.total_taps||0).toLocaleString()}\n\n🎯 Token launch at 50,000 players!`,
        [
          [{ text: '🎮 Play & Earn More', web_app: { url: GAME } }],
          [{ text: '📊 Community Stats', url: STATS }]
        ]
      );
    } else {
      await sendMessage(chatId,
        `❌ You haven't played yet!\n\nStart the game to earn FUTURE tokens 🐝`,
        [[{ text: '🎮 Play Now', web_app: { url: GAME } }]]
      );
    }

  } else if (text === '/stats') {
    const users = await getAllUsers();
    if (users && users.length) {
      const totalTaps = users.reduce((s, u) => s + (u.total_taps || 0), 0);
      const totalTokens = users.reduce((s, u) => s + (u.balance || 0), 0);
      const pct = ((users.length / 50000) * 100).toFixed(2);
      await sendMessage(chatId,
        `📊 <b>Community Stats</b>\n\n👥 Players: <b>${users.length.toLocaleString()}</b>\n👆 Total taps: <b>${totalTaps.toLocaleString()}</b>\n💰 Total earned: <b>${totalTokens.toLocaleString()} FUTURE</b>\n\n🎯 TGE Progress: <b>${pct}%</b> (${users.length} / 50,000)\n\n🚀 Token launches at 50,000 players!`,
        [
          [{ text: '🌐 Live Stats Page', url: STATS }],
          [{ text: '🎮 Play Game', web_app: { url: GAME } }]
        ]
      );
    }

  } else if (text === '/top') {
    const users = await getAllUsers();
    if (users && users.length) {
      const medals = ['🥇','🥈','🥉'];
      const top10 = users.slice(0, 10);
      const rows = top10.map((u, i) => {
        const rank = medals[i] || `${i+1}.`;
        return `${rank} <b>${u.username || 'Player'}</b> — ${(u.balance||0).toLocaleString()} FUTURE`;
      }).join('\n');
      await sendMessage(chatId,
        `🏆 <b>Top 10 Players</b>\n\n${rows}\n\n🎮 Keep tapping to climb the ranks!`,
        [
          [{ text: '🌐 Full Leaderboard', url: STATS }],
          [{ text: '🎮 Play Game', web_app: { url: GAME } }]
        ]
      );
    }

  } else if (text === '/referral') {
    const user = await getUser(userId);
    const code = user?.referral_code || 'F' + userId.slice(-5).toUpperCase();
    await sendMessage(chatId,
      `👥 <b>Your Referral Link</b>\n\nShare and earn <b>+500 FUTURE</b> for every friend!\n\n🔗 <code>https://t.me/FutureEcoSystemBot?start=${code}</code>\n\n💰 Your referrals: <b>${user?.referral_count || 0}</b>`,
      [
        [{ text: '📤 Share Now', url: `https://t.me/share/url?url=https://t.me/FutureEcoSystemBot&text=🐝 Join FUTURE-eco-system! Use my code: ${code} and get 500 FREE tokens!` }],
        [{ text: '🌐 Website', url: LANDING }]
      ]
    );

  } else if (text === '/progress') {
    const users = await getAllUsers();
    const count = users ? users.length : 0;
    const pct = ((count / 50000) * 100).toFixed(2);
    const remaining = Math.max(50000 - count, 0);
    const filled = Math.floor(parseFloat(pct) / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    await sendMessage(chatId,
      `🎯 <b>Token Launch Progress</b>\n\n${bar}\n<b>${pct}%</b> — ${count.toLocaleString()} / 50,000 players\n\n⏳ <b>${remaining.toLocaleString()} players remaining</b> until FUTURE token launches on TON mainnet!\n\n🚀 Invite friends to speed it up!`,
      [
        [{ text: '📤 Invite Friends', url: `https://t.me/share/url?url=https://t.me/FutureEcoSystemBot&text=🐝 Join FUTURE-eco-system and earn crypto!` }],
        [{ text: '🌐 Website', url: LANDING }, { text: '📊 Live Stats', url: STATS }]
      ]
    );

  } else if (text === '/help') {
    await sendMessage(chatId,
      `🐝 <b>FUTURE-eco-system Help</b>\n\n<b>Commands:</b>\n/start — Start the bot\n/balance — Your FUTURE balance\n/stats — Community statistics\n/top — Top 10 players\n/referral — Your referral link\n/progress — Token launch progress\n/help — This message\n\n<b>How to earn:</b>\n🎮 Tap the Crystal Bee\n✅ Complete daily missions\n👥 Invite friends (+500 FUTURE each)\n🎰 Daily spin wheel\n🐝 Bee Catcher mini game\n\n<b>Token launch at 50,000 players!</b>`,
      [
        [{ text: '🎮 Play Game', web_app: { url: GAME } }],
        [{ text: '🌐 Website', url: LANDING }, { text: '📊 Stats', url: STATS }],
        [{ text: '📸 Instagram', url: INSTAGRAM }, { text: '👍 Facebook', url: FACEBOOK }],
        [{ text: '📢 Telegram Channel', url: CHANNEL }]
      ]
    );

  } else {
    await sendMessage(chatId,
      `🐝 Use /help to see all commands!`,
      [
        [{ text: '🎮 Play Game', web_app: { url: GAME } }],
        [{ text: '🌐 Website', url: LANDING }]
      ]
    );
  }

  return res.status(200).json({ ok: true });
}

