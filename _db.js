// Server-side Supabase access using the SERVICE key. NEVER expose this client-side.
const SB_URL = process.env.SB_URL || '';
const SB_SERVICE_KEY = process.env.SB_SERVICE_KEY || '';

async function sb(path, method, body, extraPrefer) {
  if (!SB_URL || !SB_SERVICE_KEY) {
    return { status: 500, data: null, error: 'server not configured (SB_URL / SB_SERVICE_KEY)' };
  }
  const headers = {
    'apikey': SB_SERVICE_KEY,
    'Authorization': 'Bearer ' + SB_SERVICE_KEY,
    'Content-Type': 'application/json'
  };
  if (extraPrefer) headers['Prefer'] = extraPrefer;
  const res = await fetch(SB_URL + '/rest/v1/' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  return { status: res.status, data };
}

module.exports = { sb, SB_URL, SB_SERVICE_KEY };
