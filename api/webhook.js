const BOT_TOKEN = '8636085648:AAFWT6DVWwqqaXNJO3mZoviyUeNX4VcSQMs';
const SB_URL = 'https://sbfkpwunsqwjplkdhsyq.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNiZmtwd3Vuc3F3anBsa2Roc3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0ODczNzUsImV4cCI6MjA5NTA2MzM3NX0.L1ucNe91Lv9hu86HSkWeoq-cCR7DBE-nXPT_UUIHXc0';

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

async function getStats() {
  const res = await fetch(`${SB_URL}/rest/v1/users?select=user_id,balance,total_taps`, {
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
  });
  const data = await res.json();
  if (!data || !data.length) return null;
  return {
    players: data.length,
    totalTaps: data.reduce((s, u) => s + (u.total_taps || 0), 0),
    totalTokens: data.reduce((s, u) => s + (u.balance || 0), 0)
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const update = req.body;
  const msg = update.message;
  if (!msg) return res.status(200).json({ ok: true });

  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = msg.text || '';

  if (text === '/start') {
    await sendMessage(chatId,
      `🐝 <b>Welcome to FUTURE-eco-system!</b>\n\nTap the Crystal Bee, earn FUTURE tokens and be part of the next TON blockchain launch!\n\n<b>Commands:</b>\n/balance — Your token balance\n/stats — Community stats\n/help — Help`,
      [[{ text: '🎮 Play Game', web_app: { url: 'https://futureecosystem999.github.io/future-eco-system/' } }]]
    );
  } else if (text === '/balance') {
    const user = await getUser(userId);
    if (user) {
      await sendMessage(chatId,
        `💰 <b>Your Balance</b>\n\n🐝 <b>${user.balance?.toLocaleString() || 0} FUTURE</b>\n📊 Level: ${user.level || 1}\n👆 Total taps: ${user.total_taps?.toLocaleString() || 0}\n\n🎯 Token launch at 50,000 players!`,
        [[{ text: '🎮 Play & Earn More', web_app: { url: 'https://futureecosystem999.github.io/future-eco-system/' } }]]
      );
    } else {
      await sendMessage(chatId,
        `❌ You haven't played yet!\n\nStart the game to earn FUTURE tokens 🐝`,
        [[{ text: '🎮 Play Now', web_app: { url: 'https://futureecosystem999.github.io/future-eco-system/' } }]]
      );
    }
  } else if (text === '/stats') {
    const stats = await getStats();
    if (stats) {
      const pct = ((stats.players / 50000) * 100).toFixed(2);
      await sendMessage(chatId,
        `📊 <b>Community Stats</b>\n\n👥 Players: <b>${stats.players.toLocaleString()}</b>\n👆 Total taps: <b>${stats.totalTaps.toLocaleString()}</b>\n💰 Total earned: <b>${stats.totalTokens.toLocaleString()} FUTURE</b>\n\n🎯 TGE Progress: <b>${pct}%</b> (${stats.players.toLocaleString()} / 50,000)\n\n🚀 Token launches at 50,000 players!`,
        [[{ text: '🌐 Live Stats', url: 'https://futureecosystem999.github.io/future-eco-system/stats.html' }]]
      );
    }
  } else if (text === '/help') {
    await sendMessage(chatId,
      `🐝 <b>FUTURE-eco-system Help</b>\n\n<b>Commands:</b>\n/start — Start the bot\n/balance — Check your FUTURE balance\n/stats — Community statistics\n/help — This message\n\n<b>How to earn:</b>\n🎮 Tap the Crystal Bee\n✅ Complete daily missions\n👥 Invite friends (+500 FUTURE each)\n🎰 Daily spin wheel\n🐝 Bee Catcher mini game\n\n<b>Token launch at 50,000 players!</b>\n📧 Support: futureecosystem999@gmail.com`,
      [[{ text: '🎮 Play Game', web_app: { url: 'https://futureecosystem999.github.io/future-eco-system/' } }]]
    );
  } else {
    await sendMessage(chatId,
      `🐝 Use /help to see all commands!`,
      [[{ text: '🎮 Play Game', web_app: { url: 'https://futureecosystem999.github.io/future-eco-system/' } }]]
    );
  }

  return res.status(200).json({ ok: true });
}

