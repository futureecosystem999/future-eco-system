// Authenticated game actions. Every call requires a valid Telegram signature,
// and every balance change is validated against the trusted DB value server-side.
const { checkTelegramAuth } = require('./_auth.js');
const { sb } = require('./_db.js');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const LOTTERY_TICKET_TON = 0.1;
const MAX_TICKETS_PER_CALL = 100;
const OWNER_WALLET = 'UQCcc-bk_qaS30QXZgpMmpY3rTEJL7YmMLcYNYwJhEhRpiZE'; // Projekto piniginė — turi sutapti su index.html mokėjimo adresu

const TONCENTER_KEY = '4301f696f9e1ff6dcb3ce9e75daa33b297d4750ef094585cda451c2552190acc';

// Verify a TON payment by scanning the OWNER_WALLET's recent INCOMING transactions
// for one that matches the expected amount within a short time window.
// This does not rely on the client-supplied "boc" (which is NOT a usable message
// hash). On success we return the on-chain transaction hash, which is later stored
// so the same payment can never be used to claim tickets twice (replay protection).
async function verifyTonPayment(ticketCount) {
  const expectedNano = ticketCount * LOTTERY_TICKET_TON * 1e9;
  const minNano = BigInt(Math.floor(expectedNano * 0.9));   // tolerate forward fees
  const maxNano = BigInt(Math.floor(expectedNano * 1.1));   // small overpay tolerance
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
        seen.push({ val: String(inMsg.value || '0'), ageSec, src: inMsg.source || '' });
        if (val >= minNano && val <= maxNano && fresh) {
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
      // by scanning the owner wallet's recent incoming transactions for a matching amount.
      let onchainHash = '';
      try {
        const verified = await verifyTonPayment(count);
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

    return res.status(400).json({ ok: false, reason: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, reason: 'exception' });
  }
}
