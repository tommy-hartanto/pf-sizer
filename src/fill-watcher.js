import 'dotenv/config'
import WebSocket from 'ws'
import {
  WS_URL,
  API_KEY,
  getJwtToken,
  fetchAllOpenOrders,
  cancelOrders,
  getMarketById
} from './predict-client.js'

function timeStr() {
  return new Date().toISOString().slice(11, 19)
}

const knownOrders = new Map()
const marketCache = new Map()
const POLL_SYNC_INTERVAL_MS = 30_000

let ws = null
let reconnectTimeout = null
let isShuttingDown = false

// ─── Order State Sync & Opposite Order Cancellation ──────────────────────────

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

      if (prev && BigInt(orderData.amountFilled) > BigInt(prev.amountFilled)) {
        cancelOppositeOrders(orderData.marketId, orderData.tokenId).catch(() => {})
      }

      knownOrders.set(id, orderData)
    }

    for (const [id] of knownOrders.entries()) {
      if (!currentIds.has(id)) {
        knownOrders.delete(id)
      }
    }
  } catch {}
}

export async function cancelOppositeOrders(marketId, filledTokenId) {
  if (!marketId || !filledTokenId) return

  let allOrders = []
  try {
    allOrders = await fetchAllOpenOrders()
  } catch {
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

  try {
    await cancelOrders(toCancelIds)
    console.log(`[${timeStr()}] [FILL] ${label}: Canceled ${toCancelIds.length} opposite order(s) on fill`)
  } catch (err) {
    console.error(`[${timeStr()}] [FILL] Error canceling opposite orders for ${label}: ${err.message}`)
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
  } catch {
    reconnectTimeout = setTimeout(connectWs, 5000)
    return
  }

  const url = WS_URL + (API_KEY ? `?apiKey=${API_KEY}` : '')

  ws = new WebSocket(url, {
    headers: {
      ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      'User-Agent': 'pf-sizer/2.0',
    },
  })

  ws.on('open', () => {
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
      const payload = msg.data || msg
      const eventType = payload.type || payload.event_type || payload.event || ''

      if (
        eventType === 'OrderTransactionSuccess' ||
        eventType === 'OrderTransactionSubmitted' ||
        eventType === 'OrderMatched' ||
        eventType === 'Trade' ||
        eventType === 'Fill'
      ) {
        const orderId = String(payload.order_id || payload.orderId || payload.id || '')
        const orderHash = payload.order_hash || payload.orderHash || ''

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

        if (!targetOrder) {
          await syncOpenOrders()
          if (orderId && knownOrders.has(orderId)) {
            targetOrder = knownOrders.get(orderId)
          }
        }

        if (targetOrder) {
          await cancelOppositeOrders(targetOrder.marketId, targetOrder.tokenId)
        } else {
          await syncOpenOrders()
        }
      }
    } catch {}
  })

  ws.on('close', () => {
    if (!isShuttingDown) {
      reconnectTimeout = setTimeout(connectWs, 5000)
    }
  })
}

// ─── Main Watcher Lifecycle ──────────────────────────────────────────────────

export async function startWatcher() {
  await syncOpenOrders()
  await connectWs()
  setInterval(syncOpenOrders, POLL_SYNC_INTERVAL_MS)
}

function setupShutdown() {
  const shutdown = () => {
    isShuttingDown = true
    if (reconnectTimeout) clearTimeout(reconnectTimeout)
    if (ws) ws.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

import { fileURLToPath } from 'url'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setupShutdown()
  startWatcher().catch(() => process.exit(1))
}
