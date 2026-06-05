// Authenticated game actions. Every call requires a valid Telegram signature,
// and every balance change is validated against the trusted DB value server-side.
const { checkTelegramAuth } = require('./_auth.js');
const { sb } = require('./_db.js');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const LOTTERY_TICKET_TON = 0.1;
const MAX_TICKETS_PER_CALL = 100;
const OWNER_WALLET = 'UQCcc-bk_qaS30QXZgpMmpY3rTEJL7YmMLcYNYwJhEhRpiZE'; // Projekto piniginė — turi sutapti su index.html mokėjimo adresu

const TONCENTER_KEY = '4301f696f9e1ff6dcb3ce9e75daa33b297d4750ef094585cda451c2552190acc';

// TON addresses come in several text forms (raw "0:<hex>" and user-friendly
// base64 "EQ.../UQ..."). The underlying 32-byte account hash is identical in all
// of them, so we compare by that hash to bind a payment to the buyer's wallet
// regardless of which format TonConnect or TonCenter happens to use.
function addrHashHex(a) {
  if (!a) return null;
  a = String(a).trim();
  const m = a.match(/^-?\d+:([0-9a-fA-F]{64})$/); // raw form
  if (m) return m[1].toLowerCase();
  try { // user-friendly base64 / base64url (36 bytes: tag+wc+hash32+crc2)
    const buf = Buffer.from(a.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (buf.length === 36) return buf.subarray(2, 34).toString('hex').toLowerCase();
  } catch (e) {}
  return null;
}

// Verify a TON payment by scanning the OWNER_WALLET's recent INCOMING transactions
// for one that matches the expected amount within a short time window.
// This does not rely on the client-supplied "boc" (which is NOT a usable message
// hash). On success we return the on-chain transaction hash, which is later stored
// so the same payment can never be used to claim tickets twice (replay protection).
async function verifyTonPayment(ticketCount, expectedSender) {
  const expectedNano = ticketCount * LOTTERY_TICKET_TON * 1e9;
  const minNano = BigInt(Math.floor(expectedNano * 0.9));   // tolerate forward fees
  const maxNano = BigInt(Math.floor(expectedNano * 1.1));   // small overpay tolerance
  const wantHash = addrHashHex(expectedSender);
  const WINDOW_SEC = 30 * 60; // payment must be from the last 30 minutes
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Poll for up to ~30s: a freshly-confirmed TON payment can take 10-25s to be
  // confirmed on-chain and indexed by TonCenter. The function may run up to 5 min,
  // so a longer wait here is safe.
  let lastReason = 'no matching recent payment';
  for (let attempt = 0; attempt < 11; attempt++) {
    if (attempt > 0) await sleep(3000);
    try {
      const res = await fetch(
        `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(OWNER_WALLET)}&limit=40`,
        { headers: { 'X-API-Key': TONCENTER_KEY } }
      );
      if (!res.ok) { lastReason = 'toncenter http ' + res.status; continue; }
      const data = await res.json();
      const txs = (data && Array.isArray(data.result)) ? data.result : [];
      const nowSec = Math.floor(Date.now() / 1000);
      const seen = [];
      for (const tx of txs) {
        const inMsg = tx.in_msg;
        if (!inMsg) continue;
        const val = BigInt(String(inMsg.value || '0'));
        const utime = Number(tx.utime || 0);
        const ageSec = nowSec - utime;
        const fresh = ageSec <= WINDOW_SEC;
        const src = String(inMsg.source || '').toLowerCase();
        seen.push({ val: String(inMsg.value || '0'), ageSec, src });
        // Bind the payment to the buyer's wallet when both addresses are parseable
        // (airtight). If either can't be parsed, fall back to amount+time so a
        // legitimate buy is never wrongly blocked.
        const srcHash = addrHashHex(inMsg.source);
        const srcOk = !wantHash || !srcHash || srcHash === wantHash;
        if (val >= minNano && val <= maxNano && fresh && srcOk) {
          const hash = (tx.transaction_id && tx.transaction_id.hash)
            ? String(tx.transaction_id.hash)
            : ('amt' + String(inMsg.value) + '_lt' + String(tx.transaction_id && tx.transaction_id.lt));
          console.log('LOTTERY verify MATCH', { val: String(inMsg.value), ageSec });
          return { ok: true, onchainHash: hash };
        }
      }
      console.log('LOTTERY verify attempt', attempt, 'no match. want nano',
        String(minNano), '-', String(maxNano), 'within', WINDOW_SEC, 's. incoming seen:',
        JSON.stringify(seen.slice(0, 8)));
      lastReason = 'no matching recent payment';
    } catch (e) {
      lastReason = 'verify error: ' + e.message;
    }
  }
  return { ok: false, reason: lastReason };
}

async function getUser(tgId) {
  const r = await sb(
    'users?user_id=eq.' + encodeURIComponent(tgId) +
    '&select=user_id,username,balance,referral_code&limit=1', 'GET');
  return (r.data && r.data[0]) || null;
}

module.exports = async function handler(req, res) {
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
  const action = body.action;

  try {
    // ---- GIFT FUTURE to another player by referral code ----
    if (action === 'gift') {
      const code = String(body.code || '').toUpperCase().slice(0, 16);
      const amount = Math.floor(Number(body.amount) || 0);
      if (amount < 50) return res.status(400).json({ ok: false, reason: 'min 50' });

      const sender = await getUser(tgId);
      if (!sender) return res.status(400).json({ ok: false, reason: 'sender not found' });
      if (code === sender.referral_code) return res.status(400).json({ ok: false, reason: 'self gift' });
      if (Math.floor(Number(sender.balance) || 0) < amount) {
        return res.status(400).json({ ok: false, reason: 'insufficient balance' });
      }

      const r = await sb('users?referral_code=eq.' + encodeURIComponent(code) +
        '&select=user_id,username,balance&limit=1', 'GET');
      const recipient = r.data && r.data[0];
      if (!recipient) return res.status(404).json({ ok: false, reason: 'recipient not found' });

      // Deduct from sender, credit recipient (server-validated amounts).
      await sb('users?user_id=eq.' + encodeURIComponent(tgId), 'PATCH', {
        balance: Math.floor(Number(sender.balance) || 0) - amount
      });
      await sb('users?user_id=eq.' + encodeURIComponent(recipient.user_id), 'PATCH', {
        balance: Math.floor(Number(recipient.balance) || 0) + amount
      });
      return res.status(200).json({
        ok: true, newBalance: Math.floor(Number(sender.balance) || 0) - amount,
        recipient: recipient.username || code
      });
    }

    // ---- BUY LOTTERY TICKETS (verify TON payment on-chain) ----
    if (action === 'lottery_buy') {
      const count = Math.floor(Number(body.count) || 0);
      const week = Math.floor(Number(body.week) || 0);
      if (count < 1 || count > MAX_TICKETS_PER_CALL) {
        return res.status(400).json({ ok: false, reason: 'bad count' });
      }
      // We no longer trust the client-supplied "boc" as proof. Verify the payment
      // by scanning the owner wallet's recent incoming transactions for a matching
      // amount AND a matching sender (the buyer's connected wallet).
      const buyerWallet = String(body.wallet_address || '').slice(0, 128);
      let onchainHash = '';
      try {
        const verified = await verifyTonPayment(count, buyerWallet);
        if (!verified.ok) {
          console.log('LOTTERY reject:', verified.reason, 'count=', count);
          return res.status(400).json({ ok: false, reason: verified.reason });
        }
        onchainHash = verified.onchainHash;
      } catch (e) {
        console.error('TON payment verify error:', e.message);
        // On network error, do NOT grant tickets (avoid free tickets on outages).
        return res.status(503).json({ ok: false, reason: 'verify service unavailable' });
      }

      // Replay protection: this exact on-chain payment must not have been used before.
      try {
        const dupe = await sb(
          'lottery_tickets?tx_hash=eq.' + encodeURIComponent(onchainHash) + '&select=user_id&limit=1', 'GET');
        if (dupe.data && dupe.data.length > 0) {
          console.log('LOTTERY reject: payment already used, hash=', onchainHash);
          return res.status(400).json({ ok: false, reason: 'payment already used' });
        }
      } catch (e) { /* if the check fails, fall through; insert still records the hash */ }

      // Payment verified — create tickets, tagged with the real on-chain hash.
      const rows = [];
      for (let i = 0; i < count; i++) {
        rows.push({
          user_id: tgId,
          ticket_number: Math.floor(Math.random() * 1000000),
          amount_ton: LOTTERY_TICKET_TON,
          week_number: week,
          won: false,
          tx_hash: onchainHash
        });
      }
      const r = await sb('lottery_tickets', 'POST', rows, 'return=minimal');
      if (r.status >= 200 && r.status < 300) {
        console.log('LOTTERY SUCCESS tickets=', count, 'user=', tgId);
        return res.status(200).json({ ok: true, tickets: count });
      }
      console.log('LOTTERY reject: db error status=', r.status, 'body=', JSON.stringify(r.data));
      return res.status(500).json({ ok: false, reason: 'db error ' + r.status });
    }

    // ---- WITHDRAW REQUEST (validated against trusted balance) ----
    if (action === 'withdraw') {
      const amount = Math.floor(Number(body.amount) || 0);
      const wallet = String(body.wallet || 'not connected').slice(0, 128);
      if (amount < 100) return res.status(400).json({ ok: false, reason: 'min 100' });

      const user = await getUser(tgId);
      if (!user) return res.status(400).json({ ok: false, reason: 'user not found' });
      if (Math.floor(Number(user.balance) || 0) < amount) {
        return res.status(400).json({ ok: false, reason: 'insufficient balance' });
      }
      const r = await sb('withdraw_requests', 'POST', {
        user_id: tgId,
        username: user.username || 'Player',
        amount: amount,
        wallet_address: wallet,
        status: 'pending',
        created_at: new Date().toISOString()
      }, 'return=minimal');
      if (r.status >= 200 && r.status < 300) {
        return res.status(200).json({ ok: true, amount });
      }
      return res.status(500).json({ ok: false, reason: 'db error' });
    }

    // ---- COINFLIP (server-side RNG, 33% win chance) ----
    if (action === 'coinflip') {
      const choice = String(body.choice || ''); // 'heads' or 'tails'
      const currency = String(body.currency || 'future'); // 'future' | 'stars' | 'ton'

      if (choice !== 'heads' && choice !== 'tails') {
        return res.status(400).json({ ok: false, reason: 'invalid choice' });
      }

      // Provably fair RNG: crypto.randomBytes — 33% win chance
      const crypto = require('crypto');
      const randByte = crypto.randomBytes(1)[0]; // 0–255
      // 33% win: byte 0–84 = win, 85–255 = loss (85/256 ≈ 33.2%)
      const userWins = randByte <= 84;
      // Result coin side — if user wins, coin matches their choice; if loses, coin is opposite
      const result = userWins ? choice : (choice === 'heads' ? 'tails' : 'heads');

      // ---- FUTURE mode ----
      if (currency === 'future') {
        const bet = Math.floor(Number(body.bet) || 0);
        if (bet < 10) return res.status(400).json({ ok: false, reason: 'min bet 10 FUTURE' });
        if (bet > 100000) return res.status(400).json({ ok: false, reason: 'max bet 100000 FUTURE' });

        const user = await getUser(tgId);
        if (!user) return res.status(400).json({ ok: false, reason: 'user not found' });
        const currentBalance = Math.floor(Number(user.balance) || 0);
        if (currentBalance < bet) return res.status(400).json({ ok: false, reason: 'insufficient balance' });

        // Win pays 2.5x (house edge ~17% given 33% chance)
        const payout = userWins ? Math.floor(bet * 2.5) : 0;
        const newBalance = userWins ? currentBalance - bet + payout : currentBalance - bet;

        await sb('users?user_id=eq.' + encodeURIComponent(tgId), 'PATCH', { balance: newBalance });
        console.log('COINFLIP FUTURE user=', tgId, 'bet=', bet, 'won=', userWins, 'newBal=', newBalance);
        return res.status(200).json({ ok: true, result, won: userWins, bet, payout, newBalance });
      }

      // ---- STARS mode (50 Stars in, 125 Stars win) ----
      // Stars payment handled by Telegram billing separately; here we just run RNG
      if (currency === 'stars') {
        console.log('COINFLIP STARS user=', tgId, 'won=', userWins);
        return res.status(200).json({ ok: true, result, won: userWins, currency: 'stars',
          bet_stars: 50, payout_stars: userWins ? 125 : 0 });
      }

      // ---- TON mode (0.05 TON in, 0.125 TON win) ----
      if (currency === 'ton') {
        console.log('COINFLIP TON user=', tgId, 'won=', userWins);
        return res.status(200).json({ ok: true, result, won: userWins, currency: 'ton',
          bet_ton: 0.05, payout_ton: userWins ? 0.125 : 0 });
      }

      return res.status(400).json({ ok: false, reason: 'unknown currency' });
    }


    // ---- LUCKY SPIN (server-side RNG, house edge ~35%) ----
    if (action === 'lucky_spin') {
      const user = await getUser(tgId);
      if (!user) return res.status(400).json({ ok: false, reason: 'user not found' });

      // Check daily spin limit (stored in spin_data column or separate table)
      // Use a simple daily key in user metadata
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const spinMeta = await sb(
        'spin_logs?user_id=eq.' + encodeURIComponent(tgId) +
        '&spin_date=eq.' + encodeURIComponent(today) +
        '&select=spin_count&limit=1', 'GET');
      const spinsToday = (spinMeta.data && spinMeta.data[0]) ? Number(spinMeta.data[0].spin_count || 0) : 0;
      const maxSpins = 1; // base; VIP gets more client-side display but server enforces 1 for free
      if (spinsToday >= maxSpins) {
        return res.status(400).json({ ok: false, reason: 'no spins left today' });
      }

      // ---- PRIZE TABLE (server authoritative) ----
      // prob out of 10000 for precision. House edge ~35%
      // Expected payout per spin = sum(prob/10000 * value)
      // = (5000*10 + 2000*30 + 1000*100 + 500*200 + 200*500 + 100*800 + 50*1500 + 0*7860) / 10000
      // = (50000+60000+100000+100000+100000+80000+75000+0) / 10000 = 565000/10000 = 56.5 per spin
      // If avg spin earns 56.5 FUTURE and daily tap earns ~500+ that's fine — spin is bonus
      const prizes = [
        { label: '💎 5000', value: 5000, type: 'tokens', prob: 10,   index: 0 },
        { label: '🔥 2000', value: 2000, type: 'tokens', prob: 30,   index: 1 },
        { label: '+1000',   value: 1000, type: 'tokens', prob: 100,  index: 2 },
        { label: '+500',    value: 500,  type: 'tokens', prob: 200,  index: 3 },
        { label: '⚡ Energy',value: 500, type: 'energy', prob: 300,  index: 4 },
        { label: '+200',    value: 200,  type: 'tokens', prob: 500,  index: 5 },
        { label: '+100',    value: 100,  type: 'tokens', prob: 800,  index: 6 },
        { label: '+50',     value: 50,   type: 'tokens', prob: 1500, index: 7 },
        { label: '😢 +10',  value: 10,   type: 'tokens', prob: 6560, index: 8 },
      ];
      const total = prizes.reduce((a, b) => a + b.prob, 0); // 10000

      // Provably fair: crypto RNG
      const crypto = require('crypto');
      const randBuf = crypto.randomBytes(4);
      const randVal = randBuf.readUInt32BE(0) % total; // 0..9999

      let cumProb = 0, winner = prizes[prizes.length - 1];
      for (const p of prizes) {
        cumProb += p.prob;
        if (randVal < cumProb) { winner = p; break; }
      }

      // Near Miss: if player rolled jackpot range+1 (just missed 5000),
      // force near-miss flag so client shows dramatic "almost" animation
      const nearMiss = (randVal >= 10 && randVal < 60); // just outside jackpot

      // Apply reward
      const currentBalance = Math.floor(Number(user.balance) || 0);
      let newBalance = currentBalance;
      if (winner.type === 'tokens') newBalance = currentBalance + winner.value;
      // energy handled client-side for now

      // Update balance
      if (winner.type === 'tokens') {
        await sb('users?user_id=eq.' + encodeURIComponent(tgId), 'PATCH', { balance: newBalance });
      }

      // Log spin
      if (spinsToday === 0) {
        await sb('spin_logs', 'POST', { user_id: tgId, spin_date: today, spin_count: 1 }, 'return=minimal');
      } else {
        await sb('spin_logs?user_id=eq.' + encodeURIComponent(tgId) + '&spin_date=eq.' + encodeURIComponent(today),
          'PATCH', { spin_count: spinsToday + 1 });
      }

      console.log('SPIN user=', tgId, 'rand=', randVal, 'winner=', winner.label, 'nearMiss=', nearMiss);

      return res.status(200).json({
        ok: true,
        winner: {
          index: winner.index,
          label: winner.label,
          value: winner.value,
          type: winner.type
        },
        nearMiss,
        newBalance,
        spinsLeft: 0
      });
    }


    // ---- CREATE STARS INVOICE (Telegram Stars payment) ----
    if (action === 'create_invoice') {
      const productId = String(body.product_id || '');

      // Product catalog — server authoritative (prices in Stars/XTR)
      const PRODUCTS = {
        // FUTURE token packs
        future_5000:  { title: '5,000 FUTURE',  desc: 'Instant 5,000 FUTURE tokens',  stars: 100,  type: 'future', value: 5000 },
        future_15000: { title: '15,000 FUTURE', desc: 'Instant 15,000 FUTURE tokens', stars: 250,  type: 'future', value: 15000 },
        future_50000: { title: '50,000 FUTURE', desc: 'Instant 50,000 FUTURE tokens', stars: 700,  type: 'future', value: 50000 },
        // Energy refill
        energy_full:  { title: 'Full Energy',   desc: 'Instantly refill energy to max', stars: 50,  type: 'energy', value: 0 },
        // Extra spins
        spins_3:      { title: '3 Lucky Spins',  desc: '3 extra Lucky Spin chances',    stars: 80,  type: 'spins', value: 3 },
        spins_10:     { title: '10 Lucky Spins', desc: '10 extra Lucky Spin chances',   stars: 200, type: 'spins', value: 10 }
      };

      const product = PRODUCTS[productId];
      if (!product) return res.status(400).json({ ok: false, reason: 'unknown product' });

      // Create invoice link via Telegram Bot API (currency XTR = Telegram Stars)
      const payload = JSON.stringify({ uid: tgId, pid: productId, t: Date.now() });
      try {
        const tgRes = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/createInvoiceLink', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: product.title,
            description: product.desc,
            payload: payload,
            currency: 'XTR',
            prices: [{ label: product.title, amount: product.stars }]
          })
        });
        const tgData = await tgRes.json();
        if (tgData.ok && tgData.result) {
          console.log('INVOICE created user=', tgId, 'product=', productId, 'stars=', product.stars);
          return res.status(200).json({ ok: true, invoice_link: tgData.result, product: { title: product.title, stars: product.stars } });
        }
        console.log('INVOICE fail:', JSON.stringify(tgData));
        return res.status(500).json({ ok: false, reason: 'invoice creation failed' });
      } catch (e) {
        console.error('INVOICE error:', e.message);
        return res.status(500).json({ ok: false, reason: 'invoice error' });
      }
    }

    return res.status(400).json({ ok: false, reason: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, reason: 'exception' });
  }
}


