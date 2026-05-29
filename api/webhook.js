const BOT_TOKEN = '8636085648:AAFWT6DVWwqqaXNJO3mZoviyUeNX4VcSQMs';
const SB_URL = 'https://sbfkpwunsqwjplkdhsyq.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNiZmtwd3Vuc3F3anBsa2Roc3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0ODczNzUsImV4cCI6MjA5NTA2MzM3NX0.L1ucNe91Lv9hu86HSkWeoq-cCR7DBE-nXPT_UUIHXc0';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const update = req.body;
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
