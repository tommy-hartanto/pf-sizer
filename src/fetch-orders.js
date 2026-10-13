import 'dotenv/config'
import { ClobClient, createL2Headers } from '@polymarket/clob-client'
import { Wallet } from 'ethers'
import { request } from 'undici'


// --- Environment Setup ---
const PRIVATE_KEY = process.env.PRIVATE_KEY
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS || ''

if (!PRIVATE_KEY) {
  console.error("Missing PRIVATE_KEY")
  process.exit(1)
}

// Derive addresses
const wallet = new Wallet(PRIVATE_KEY)
const SIGNER_ADDRESS = wallet.address
const SIGNATURE_TYPE = FUNDER_ADDRESS && SIGNER_ADDRESS.toLowerCase() !== FUNDER_ADDRESS.toLowerCase() ? 1 : 0

let sharedClobClient = null
let sharedCreds = null

async function initSharedClobClient() {
  if (sharedClobClient && sharedCreds && sharedCreds.key && sharedCreds.secret && sharedCreds.passphrase) return

  let creds = null
  if (process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_API_PASSPHRASE) {
    creds = {
      key: process.env.POLY_API_KEY,
      secret: process.env.POLY_API_SECRET,
      passphrase: process.env.POLY_API_PASSPHRASE,
    }
  }

  let client = new ClobClient("https://clob.polymarket.com", 137, wallet, creds || undefined, SIGNATURE_TYPE, FUNDER_ADDRESS || undefined)

  if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
    console.log("No valid CLOB API keys found. Deriving credentials via wallet...")
    const derived = await client.createOrDeriveApiKey().catch(e => e)
    if (derived && derived.key && derived.secret && derived.passphrase) {
      creds = derived
      client = new ClobClient("https://clob.polymarket.com", 137, wallet, creds, SIGNATURE_TYPE, FUNDER_ADDRESS || undefined)
    } else {
      throw new Error(`Failed to derive API keys: ${derived?.message || derived?.error || 'Unknown error'}`)
    }
  }

  sharedCreds = creds
  sharedClobClient = client
}

const marketInfoCache = new Map()

async function getMarketByConditionId(conditionId) {
  if (marketInfoCache.has(conditionId)) {
    return marketInfoCache.get(conditionId)
  }

  let retries = 3
  while (retries > 0) {
    try {
      const res = await request(`https://clob.polymarket.com/markets/${conditionId}`, {
        headersTimeout: 10000,
        bodyTimeout: 10000,
      })
      if (res.statusCode === 200) {
        const data = await res.body.json()
        const info = {
          conditionId,
          slug: data.market_slug || conditionId,
          question: data.question || '',
        }
        marketInfoCache.set(conditionId, info)
        return info
      }
      await res.body.text()
      if (res.statusCode === 429) {
        await new Promise(r => setTimeout(r, 1500))
        retries--
      } else {
        break
      }
    } catch {
      retries--
      if (retries > 0) await new Promise(r => setTimeout(r, 1000))
    }
  }

  // Fallback: try Gamma API
  try {
    const gRes = await request(`https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`, {
      headersTimeout: 10000,
      bodyTimeout: 10000,
    })
    if (gRes.statusCode === 200) {
      const data = await gRes.body.json()
      const m = Array.isArray(data) ? data[0] : data
      if (m && m.slug) {
        const info = { conditionId, slug: m.slug, question: m.question || '' }
        marketInfoCache.set(conditionId, info)
        return info
      }
    }
    await gRes.body.text()
  } catch { }

  const fallbackInfo = { conditionId, slug: conditionId, question: '' }
  marketInfoCache.set(conditionId, fallbackInfo)
  return fallbackInfo
}

async function fetchAllOpenOrders() {
  let attempts = 3
  while (attempts > 0) {
    try {
      if (!sharedCreds || !sharedCreds.key || !sharedCreds.secret || !sharedCreds.passphrase) {
        await initSharedClobClient()
      }

      const l2HeaderArgs = {
        method: 'GET',
        requestPath: '/data/orders',
      }
      const headers = await createL2Headers(wallet, sharedCreds, l2HeaderArgs)
      const res = await request('https://clob.polymarket.com/data/orders', {
        method: 'GET',
        headers,
        headersTimeout: 10000,
        bodyTimeout: 10000,
      })

      if (res.statusCode === 200) {
        const json = await res.body.json()
        if (Array.isArray(json)) return json
        if (json && Array.isArray(json.data)) return json.data
        return []
      }

      const errBody = await res.body.text()

      if (res.statusCode === 401) {
        console.warn("[CLOB] 401 Unauthorized on getOpenOrders. Re-deriving credentials...")
        const derived = await sharedClobClient.createOrDeriveApiKey().catch(e => e)
        if (derived && derived.key && derived.secret && derived.passphrase) {
          sharedCreds = derived
          sharedClobClient = new ClobClient("https://clob.polymarket.com", 137, wallet, sharedCreds, SIGNATURE_TYPE, FUNDER_ADDRESS || undefined)
        }
      } else if (res.statusCode === 429) {
        console.warn("[CLOB] 429 Rate Limit on getOpenOrders. Backing off 2s...")
        await new Promise(r => setTimeout(r, 2000))
      } else if (res.statusCode >= 500) {
        console.warn(`[CLOB] ${res.statusCode} Server Error on getOpenOrders: ${errBody}. Retrying...`)
        await new Promise(r => setTimeout(r, 1500))
      }
    } catch (err) {
      console.warn(`[CLOB] Fetch open orders error: ${err.message}`)
      await new Promise(r => setTimeout(r, 1000))
    }

    attempts--
  }

  return []
}

async function runFetch() {
  console.log(`\n════════════════════════════════════════`)
  console.log(`Fetching Open Orders at ${new Date().toISOString()}`)
  console.log(`Signer: ${SIGNER_ADDRESS}`)
  console.log(`Funder: ${FUNDER_ADDRESS}`)
  console.log(`════════════════════════════════════════`)

  try {
    await initSharedClobClient()
  } catch (error) {
    console.error("Failed to initialize CLOB client:", error.message)
    return
  }

  console.log("Fetching live open orders from CLOB API...")
  const orders = await fetchAllOpenOrders()

  if (orders.length === 0) {
    console.log("0 open orders detected on account.")
    return
  }

  // Group by market
  const marketOrdersMap = {}
  for (const order of orders) {
    if (!marketOrdersMap[order.market]) marketOrdersMap[order.market] = []
    marketOrdersMap[order.market].push(order)
  }

  console.log(`\nTotal open orders: ${orders.length} across ${Object.keys(marketOrdersMap).length} market(s)\n`)

  for (const [conditionId, mOrders] of Object.entries(marketOrdersMap)) {
    const market = await getMarketByConditionId(conditionId)
    console.log(`\n  [${market.slug}]: ${mOrders.length} open orders (Market: ${conditionId.slice(0, 12)}...)`)
    for (const order of mOrders) {
      const size = order.original_size || order.size
      console.log(`    └─ Order ${order.id.slice(0, 12)}...: Outcome=${order.outcome}, Side=${order.side}, Price=${order.price}, Size=${size}, AssetID=${order.asset_id.slice(0, 8)}...`)
    }
  }

  console.log("\nFinished successfully.")
}

runFetch().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); })
