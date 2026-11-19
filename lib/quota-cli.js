// CLI: `cgr quota [source|provider ...] [--json] [--account <name|email>] [--status-only]`
// Runs on demand in this process (no daemon needed). Relay providers keep forced-proxy semantics.

import { RelayManager, isRelayProvider } from './relay.js'
import { QuotaService, formatQuotaReport } from './quota/index.js'

export function createCliQuotaService(getConfig) {
  const relay = new RelayManager()
  return new QuotaService({
    getConfig,
    fetchFor: (providerId, provider) => (provider && isRelayProvider(provider)
      ? relay.createFetch(providerId, provider, globalThis.fetch)
      : globalThis.fetch),
  })
}

export async function handleQuotaCommand({ command, values, positionals, config }) {
  if (command !== 'quota') return false
  const ids = positionals.slice(1)
  const service = createCliQuotaService(() => config)
  const result = await service.query({
    ids,
    force: true,
    live: !values['status-only'],
    account: values.account || '',
  })
  if (values.json) console.log(JSON.stringify(result, null, 2))
  else console.log(formatQuotaReport(result))
  if (result.sources.some(s => s.error && !s.stale)) process.exitCode = 2
  return true
}
