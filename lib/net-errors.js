// Node's global fetch (undici) reports every network failure as TypeError("fetch failed"); the
// real reason (DNS, TCP connect, TLS, proxy) is nested in err.cause. Walk the chain so UI and
// logs show "fetch failed: connect ETIMEDOUT 142.250.196.42:443" instead of just "fetch failed".
export function describeNetworkError(err) {
  const parts = []
  for (let e = err; e && parts.length < 4; e = e.cause) {
    const msg = String(e?.message ?? e?.reason ?? e).trim()
    if (msg && !parts.includes(msg)) parts.push(msg)
  }
  return parts.join(': ')
}
