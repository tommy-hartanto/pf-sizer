import 'dotenv/config'
import { ClobClient } from '@polymarket/clob-client'
import { Wallet } from 'ethers'
import { request } from 'undici'
import WebSocket from 'ws'


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

// Asset & duration configuration (same as cleanup.js)
const ASSETS = (process.env.ASSETS || 'eth,btc,sol,xrp,doge,bnb,hype').split(',').map(s => s.trim()).filter(Boolean)
const DURATIONS = ['5m', '15m']
const SIZING_WINDOW_MS = 301000  // 5 minutes + 1 second

// How often to refresh the market list (ms)
const MARKET_REFRESH_INTERVAL_MS = 4 * 60 * 1000  // 4 minutes

// Polymarket User WebSocket endpoint
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user'

// --- Shared CLOB Client (initialized once, reused) ---
let clobClient = null
let apiCreds = null

// Map: conditionId -> { slug, tokens: [tokenId0, tokenId1] }
let marketMap = {}

// Set of conditionIds we are currently subscribed to
let subscribedMarkets = new Set()


// ─── CLOB Client Initialization ───────────────────────────────────────────────

async function initClobClient() {
  const SIGNATURE_TYPE = FUNDER_ADDRESS && SIGNER_ADDRESS.toLowerCase() !== FUNDER_ADDRESS.toLowerCase() ? 1 : 0

  let creds = null
  if (process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_API_PASSPHRASE) {
    creds = {
      key: process.env.POLY_API_KEY,
      secret: process.env.POLY_API_SECRET,
      passphrase: process.env.POLY_API_PASSPHRASE,
    }
  }

  let client = new ClobClient(
    "https://clob.polymarket.com", 137, wallet,
    creds || undefined, SIGNATURE_TYPE, FUNDER_ADDRESS || undefined
  )

  if (!creds) {
    console.log("[init] No CLOB API keys found. Deriving credentials via wallet...")
    creds = await client.createOrDeriveApiKey()
    client = new ClobClient(
      "https://clob.polymarket.com", 137, wallet,
      creds, SIGNATURE_TYPE, FUNDER_ADDRESS || undefined
    )
  }

  const keysResp = await client.getApiKeys().catch(e => e)
  if (keysResp && (keysResp.error || keysResp instanceof Error)) {
    console.log("[init] API key error, deriving new credentials...")
    creds = await client.createOrDeriveApiKey()
    client = new ClobClient(
      "https://clob.polymarket.com", 137, wallet,
      creds, SIGNATURE_TYPE, FUNDER_ADDRESS || undefined
    )
  }

  clobClient = client
  apiCreds = creds
  console.log("[init] CLOB client initialized.")
}


// ─── Market Discovery (same slug logic as cleanup.js) ─────────────────────────

function generateUpcomingSlugs() {
  const nowSec = Math.floor(Date.now() / 1000)
  const windowEndSec = nowSec + Math.ceil(SIZING_WINDOW_MS / 1000)
  const firstBoundary = Math.ceil(nowSec / 300) * 300

  const timestamps = []
  for (let ts = firstBoundary; ts <= windowEndSec; ts += 300) {
    timestamps.push(ts)
  }

  const slugs = []
  for (const asset of ASSETS) {
    for (const duration of DURATIONS) {
      for (const ts of timestamps) {
        slugs.push(`${asset}-updown-${duration}-${ts}`)
      }
    }
  }
  return slugs
}

async function lookupMarketBySlug(slug) {
  let retries = 3
  while (retries > 0) {
    try {
      const res = await request(`https://gamma-api.polymarket.com/markets?slug=${slug}`, {
        headersTimeout: 10000,
        bodyTimeout: 10000,
      })
      if (res.statusCode === 200) {
        const data = await res.body.json()
        const market = Array.isArray(data) ? data[0] : data
        if (!market || !market.conditionId) return null
        let tokens = []
        if (Array.isArray(market.clobTokenIds)) {
          tokens = market.clobTokenIds
        } else if (typeof market.clobTokenIds === 'string') {
          try { tokens = JSON.parse(market.clobTokenIds) } catch { }
        }
        return {
          conditionId: market.conditionId,
          tokens,
          slug: market.slug || slug,
        }
      }
      await res.body.text()
      if (res.statusCode === 429) {
        await new Promise(r => setTimeout(r, 1500))
        retries--
      } else {
        return null
      }
    } catch {
      retries--
      if (retries > 0) await new Promise(r => setTimeout(r, 1000))
    }
  }
  return null
}

// Refreshes marketMap and returns the list of conditionIds found
async function refreshMarkets() {
  console.log(`\n[markets] Refreshing market list at ${new Date().toISOString()}`)
  const slugs = generateUpcomingSlugs()
  const newMarketMap = {}

  for (const slug of slugs) {
    const result = await lookupMarketBySlug(slug)
    if (result && result.tokens.length >= 2) {
      newMarketMap[result.conditionId] = {
        slug: result.slug,
        tokens: result.tokens,
      }
    }
  }

  const count = Object.keys(newMarketMap).length
  console.log(`[markets] Found ${count} active market(s)`)

  marketMap = newMarketMap
  return Object.keys(newMarketMap)
}


// ─── Cancel Opposite Orders ────────────────────────────────────────────────────

// Given a filled asset_id and conditionId, cancel all open orders for the OTHER asset_id.
// Does NOT rely on marketMap — derives the opposite token directly from live orders.
async function cancelOppositeOrders(conditionId, filledAssetId) {
  // Fetch all open orders for this market
  let orders = []
  try {
    const ordersRaw = await clobClient.getOpenOrders({ market: conditionId }).catch(e => e)
    if (ordersRaw && (ordersRaw.error || ordersRaw instanceof Error)) {
      console.error(`[cancel] Error fetching orders: ${ordersRaw.error || ordersRaw.message}`)
      return
    }
    orders = Array.isArray(ordersRaw) ? ordersRaw : (ordersRaw.data || [])
  } catch (e) {
    console.error(`[cancel] Exception fetching orders: ${e.message}`)
    return
  }

  // Cancel all orders that belong to a DIFFERENT asset_id than the one that was filled
  const toCancel = orders
    .filter(o => o.asset_id !== filledAssetId)
    .map(o => o.id)

  if (toCancel.length === 0) return

  const slug = marketMap[conditionId]?.slug || conditionId.slice(0, 12) + '...'

  try {
    for (let i = 0; i < toCancel.length; i += 2000) {
      const batch = toCancel.slice(i, i + 2000)
      await clobClient.cancelOrders(batch)
    }
    console.log(`[cancel] ✓ [${slug}] Canceled ${toCancel.length} opposite-outcome order(s)`)
  } catch (err) {
    console.error(`[cancel] Error canceling orders: ${err.message}`)
  }
}


// ─── WebSocket Connection ──────────────────────────────────────────────────────

let ws = null
let pingInterval = null
let reconnectTimeout = null
let isShuttingDown = false

function buildSubscriptionMessage() {
  // Omit 'markets' entirely → server sends events for ALL of the user's markets
  return JSON.stringify({
    auth: {
      apiKey: apiCreds.key,
      secret: apiCreds.secret,
      passphrase: apiCreds.passphrase,
    },
    type: 'user',
  })
}

const filledSizes = new Map()

function handleMessage(rawData) {
  let messages
  try {
    const parsed = JSON.parse(rawData)
    // The server may send a single object or an array
    messages = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    // PONG or other non-JSON text
    if (rawData === 'PONG') return
    return
  }

  for (const msg of messages) {
    if (msg.event_type === 'order') {
      // We ONLY look at 'order' events, because 'trade' events can have the TAKER's asset_id at the top level.
      // An 'order' event always belongs to OUR order, so its asset_id is unambiguously ours.
      const sizeMatched = parseFloat(msg.size_matched || '0')
      
      if (sizeMatched > 0) {
        // Track the size matched to prevent triggering cancel over and over for the same fill level
        const lastSize = filledSizes.get(msg.id) || 0
        if (sizeMatched > lastSize) {
          filledSizes.set(msg.id, sizeMatched)
          
          const conditionId = msg.market
          const filledAssetId = msg.asset_id
          if (!conditionId || !filledAssetId) continue
          
          const slug = marketMap[conditionId]?.slug || conditionId.slice(0, 12) + '...'
          console.log(`\n[ws] 🔔 ORDER FILL [${slug}] asset=${filledAssetId.slice(0,12)}... matched=${msg.size_matched}/${msg.original_size} price=${msg.price}`)
          
          cancelOppositeOrders(conditionId, filledAssetId).catch(err => {
            console.error(`[ws] cancelOppositeOrders error: ${err.message}`)
          })
        }
      }
    }
  }
}

function connect() {
  if (isShuttingDown) return

  if (ws) {
    ws.removeAllListeners()
    ws.terminate()
    ws = null
  }
  if (pingInterval) {
    clearInterval(pingInterval)
    pingInterval = null
  }

  console.log(`\n[ws] Connecting to ${WS_URL}...`)
  ws = new WebSocket(WS_URL)

  ws.on('open', () => {
    console.log('[ws] Connected. Subscribed to all user events.')
    ws.send(buildSubscriptionMessage())

    // Send PING every 10 seconds to keep connection alive
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send('PING')
      }
    }, 10000)
  })

  ws.on('message', (data) => {
    handleMessage(data.toString())
  })

  ws.on('error', (err) => {
    console.error(`[ws] Error: ${err.message}`)
  })

  ws.on('close', (code, reason) => {
    console.log(`[ws] Disconnected (code=${code}, reason=${reason}). Reconnecting in 5s...`)
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
    if (!isShuttingDown) {
      reconnectTimeout = setTimeout(() => connect(), 5000)
    }
  })
}

// ─── Main Loop ─────────────────────────────────────────────────────────────────

export async function startWatcher() {
  console.log("PM Fill Watcher — Cancel Opposite on Fill")
  console.log(`Signer: ${SIGNER_ADDRESS}`)
  console.log(`Assets: ${ASSETS.join(', ')}`)
  console.log(`Durations: ${DURATIONS.join(', ')}`)

  // Initialize CLOB client
  try {
    await initClobClient()
  } catch (err) {
    console.error("[start] Failed to initialize CLOB client:", err.message)
    process.exit(1)
  }

  // Initial market discovery (populates marketMap for logs)
  await refreshMarkets()

  // Start WebSocket (subscribes to ALL user events globally)
  connect()

  // Periodically refresh market list so logs have the right slugs
  setInterval(async () => {
    try {
      await refreshMarkets()
    } catch (err) {
      console.error("[refresh] Error refreshing markets:", err.message)
    }
  }, MARKET_REFRESH_INTERVAL_MS)
}

// Graceful shutdown
function setupShutdown() {
  process.on('SIGINT', () => {
    console.log("\n[shutdown] SIGINT received. Closing...")
    isShuttingDown = true
    if (pingInterval) clearInterval(pingInterval)
    if (reconnectTimeout) clearTimeout(reconnectTimeout)
    if (ws) ws.close()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    console.log("\n[shutdown] SIGTERM received. Closing...")
    isShuttingDown = true
    if (pingInterval) clearInterval(pingInterval)
    if (reconnectTimeout) clearTimeout(reconnectTimeout)
    if (ws) ws.close()
    process.exit(0)
  })
}

// If run directly
import { fileURLToPath } from 'url'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setupShutdown()
  startWatcher().catch(err => {
    console.error("[fatal]", err)
    process.exit(1)
  })
}
