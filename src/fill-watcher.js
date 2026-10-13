import 'dotenv/config'
import WebSocket from 'ws'
import {
  SIGNER_ADDRESS,
  MAKER_ADDRESS,
  IS_KERNEL,
  WS_URL,
  API_KEY,
  getJwtToken,
  fetchAllOpenOrders,
  cancelOrders,
  getMarketById
} from './predict-client.js'

// In-memory cache of orders: id -> { marketId, tokenId, side, amount, amountFilled, hash }
const knownOrders = new Map()

// Map of marketId -> market info
const marketCache = new Map()

// How often to poll REST as a fallback/sync layer (ms)
const POLL_SYNC_INTERVAL_MS = 30_000

let ws = null
let heartbeatCheckInterval = null
let reconnectTimeout = null
let isShuttingDown = false

// ─── Order State Sync & Opposite Order Cancellation ──────────────────────────

/**
 * Syncs currently resting orders from REST API into in-memory map.
 */
async function syncOpenOrders() {
  try {
    const orders = await fetchAllOpenOrders()
    const currentIds = new Set()

    for (const item of orders) {
      const id = String(item.id)
      currentIds.add(id)
      const order = item.order || {}
      const prev = knownOrders.get(id)

      const orderData = {
        id,
        marketId: String(item.marketId),
        tokenId: order.tokenId,
        side: order.side,
        amount: item.amount,
        amountFilled: item.amountFilled || '0',
        hash: order.hash,
      }

      // Check if order was filled or partially filled since last sync
      if (prev && BigInt(orderData.amountFilled) > BigInt(prev.amountFilled)) {
        console.log(`\n[fill-watcher] 🔔 Fill detected via REST sync for Order ${id} (Market: ${orderData.marketId}, Token: ${orderData.tokenId.slice(0, 10)}...)`)
        cancelOppositeOrders(orderData.marketId, orderData.tokenId).catch(err => {
          console.error(`[fill-watcher] Error in cancelOppositeOrders: ${err.message}`)
        })
      }

      knownOrders.set(id, orderData)
    }

    // Clean up orders that are no longer open
    for (const [id, data] of knownOrders.entries()) {
      if (!currentIds.has(id)) {
        // If an order disappeared from open list and had not been marked cancelled, it might have filled
        knownOrders.delete(id)
      }
    }
  } catch (err) {
    console.warn(`[fill-watcher] Order sync warning: ${err.message}`)
  }
}

/**
 * Given a filled marketId and tokenId, cancel all remaining open orders for ANY OTHER tokenId in that market.
 */
export async function cancelOppositeOrders(marketId, filledTokenId) {
  if (!marketId || !filledTokenId) return

  let allOrders = []
  try {
    allOrders = await fetchAllOpenOrders()
  } catch (err) {
    console.error(`[fill-watcher] Error fetching orders during opposite cancel: ${err.message}`)
    return
  }

  const marketOrders = allOrders.filter(o => String(o.marketId) === String(marketId))
  const oppositeOrders = marketOrders.filter(o => o.order && o.order.tokenId && o.order.tokenId !== filledTokenId)

  if (oppositeOrders.length === 0) return

  const toCancelIds = oppositeOrders.map(o => o.id)
  let marketInfo = marketCache.get(String(marketId))
  if (!marketInfo) {
    marketInfo = await getMarketById(marketId).catch(() => null)
    if (marketInfo) marketCache.set(String(marketId), marketInfo)
  }

  const label = marketInfo?.slug || `Market ${marketId}`
  console.log(`\n[fill-watcher] ⚡ [${label}] CANCELLATION TRIGGERED: ${toCancelIds.length} opposite-outcome order(s)`)

  try {
    await cancelOrders(toCancelIds)
    console.log(`[fill-watcher] ✓ [${label}] Successfully canceled ${toCancelIds.length} opposite order(s)!`)
  } catch (err) {
    console.error(`[fill-watcher] Failed to cancel opposite orders: ${err.message}`)
  }
}

// ─── WebSocket Connection & Protocol ─────────────────────────────────────────

async function connectWs() {
  if (isShuttingDown) return

  if (ws) {
    ws.removeAllListeners()
    ws.terminate()
    ws = null
  }

  let jwt = null
  try {
    jwt = await getJwtToken()
  } catch (err) {
    console.error(`[fill-watcher] Failed to get JWT token: ${err.message}. Retrying in 5s...`)
    reconnectTimeout = setTimeout(connectWs, 5000)
    return
  }

  const url = WS_URL + (API_KEY ? `?apiKey=${API_KEY}` : '')
  console.log(`[fill-watcher] Connecting to Predict.fun WebSocket (${WS_URL})...`)

  ws = new WebSocket(url, {
    headers: {
      ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      'User-Agent': 'pf-sizer/2.0',
    },
  })

  ws.on('open', () => {
    console.log('[fill-watcher] WebSocket connected. Subscribing to predictWalletEvents...')
    const topic = `predictWalletEvents/${jwt}`
    const subMsg = JSON.stringify({
      requestId: Date.now(),
      method: 'subscribe',
      params: [topic]
    })
    ws.send(subMsg)
  })

  ws.on('message', async (data) => {
    const raw = data.toString()
    if (!raw) return

    // Heartbeat check / echo
    if (raw.includes('"heartbeat"')) {
      try {
        const parsed = JSON.parse(raw)
        const ts = parsed.data || Date.now()
        ws.send(JSON.stringify({ method: 'heartbeat', data: ts }))
      } catch {}
      return
    }

    if (raw === 'PONG' || raw === 'pong') return

    try {
      const msg = JSON.parse(raw)

      // Handle subscription acknowledgement
      if (msg.type === 'R' && msg.success) {
        console.log('[fill-watcher] ✓ Subscribed to user wallet events successfully.')
        return
      }

      // Check for wallet events
      const payload = msg.data || msg
      const eventType = payload.type || payload.event_type || payload.event || ''

      // Order fill events
      if (
        eventType === 'OrderTransactionSuccess' ||
        eventType === 'OrderTransactionSubmitted' ||
        eventType === 'OrderMatched' ||
        eventType === 'Trade' ||
        eventType === 'Fill'
      ) {
        const orderId = String(payload.order_id || payload.orderId || payload.id || '')
        const orderHash = payload.order_hash || payload.orderHash || ''
        console.log(`\n[fill-watcher] 🔔 EVENT RECEIVED: [${eventType}] Order ID: ${orderId || 'N/A'}, Hash: ${orderHash || 'N/A'}`)

        // Identify which order filled
        let targetOrder = null
        if (orderId && knownOrders.has(orderId)) {
          targetOrder = knownOrders.get(orderId)
        } else if (orderHash) {
          for (const ord of knownOrders.values()) {
            if (ord.hash === orderHash) {
              targetOrder = ord
              break
            }
          }
        }

        // If not found in memory, refresh orders and search
        if (!targetOrder) {
          await syncOpenOrders()
          if (orderId && knownOrders.has(orderId)) {
            targetOrder = knownOrders.get(orderId)
          }
        }

        if (targetOrder) {
          await cancelOppositeOrders(targetOrder.marketId, targetOrder.tokenId)
        } else {
          // If we couldn't match the specific order ID, trigger a general orderbook audit
          console.log('[fill-watcher] Order not in local cache; triggering sync to check for fills...')
          await syncOpenOrders()
        }
      }
    } catch {}
  })

  ws.on('error', (err) => {
    console.warn(`[fill-watcher] WebSocket error: ${err.message}`)
  })

  ws.on('close', (code, reason) => {
    console.log(`[fill-watcher] WebSocket disconnected (code=${code}). Reconnecting in 5s...`)
    if (!isShuttingDown) {
      reconnectTimeout = setTimeout(connectWs, 5000)
    }
  })
}

// ─── Main Watcher Lifecycle ──────────────────────────────────────────────────

export async function startWatcher() {
  console.log("Predict.fun Fill Watcher — Cancel Opposite on Fill")
  console.log(`Signer:        ${SIGNER_ADDRESS}`)
  console.log(`Account/Maker: ${MAKER_ADDRESS}`)
  console.log(`Smart Account: ${IS_KERNEL ? 'ZeroDev Kernel' : 'EOA'}`)

  // Initial orders snapshot
  await syncOpenOrders()
  console.log(`[fill-watcher] Initialized order cache with ${knownOrders.size} open order(s).`)

  // Connect WebSocket
  await connectWs()

  // Periodic fallback REST sync
  setInterval(syncOpenOrders, POLL_SYNC_INTERVAL_MS)
}

function setupShutdown() {
  const shutdown = () => {
    console.log("\n[fill-watcher] Shutting down...")
    isShuttingDown = true
    if (reconnectTimeout) clearTimeout(reconnectTimeout)
    if (heartbeatCheckInterval) clearInterval(heartbeatCheckInterval)
    if (ws) ws.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// Standalone execution
import { fileURLToPath } from 'url'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setupShutdown()
  startWatcher().catch(err => {
    console.error("[fill-watcher] Fatal error:", err)
    process.exit(1)
  })
}
