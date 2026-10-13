import 'dotenv/config'
import {
  SIGNER_ADDRESS,
  MAKER_ADDRESS,
  IS_KERNEL,
  lookupMarketBySlug,
  fetchAllOpenOrders,
  cancelOrders,
  getMarketById,
  authenticate
} from './predict-client.js'
import { startWatcher } from './fill-watcher.js'
import { startTwapWatcher, isTwapThresholdBreached, getThreshold } from './twap-watcher.js'

// ─── Environment & Tuning Constants ──────────────────────────────────────────
const SIZING_WINDOW_MS = 301000 // 5 minutes + 1 second

const ASSETS = (process.env.ASSETS || 'eth,btc,sol,xrp,doge,bnb')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean)

const DURATIONS = ['5m', '15m']
const DELETE_ALL_ORDERS = process.env.DELETE_ALL_ORDERS === 'true'
const DELETE_ALL_SLUGS = (process.env.DELETE_ALL_SLUGS || '').split(',').map(s => s.trim()).filter(Boolean)
const DELETE_ALL_PRICES = (process.env.DELETE_ALL_PRICES || '').split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => !isNaN(n))
const DELETE_ALL_SIZES = (process.env.DELETE_ALL_SIZES || '').split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => !isNaN(n))
const CANCEL_BEFORE_END_SECONDS = Math.max(0, parseInt(process.env.CANCEL_BEFORE_END_SECONDS || '0', 10) || 0)

// Pre-parse POST_HOURS into a lookup structure
// POST_HOURS[asset][duration] = Set of allowed 'HH:MM' (or null if all allowed)
const POST_HOURS = {}
for (const asset of ASSETS) {
  POST_HOURS[asset] = {}
  for (const duration of DURATIONS) {
    const envKey = `POST_HOURS_${asset.toUpperCase()}_${duration.toUpperCase()}`
    const raw = process.env[envKey]
    if (raw && raw.trim() !== '') {
      const allowedTimes = raw.split(',').map(s => {
        const [hh, mm] = s.trim().split(':')
        return `${parseInt(hh, 10).toString().padStart(2, '0')}:${parseInt(mm, 10).toString().padStart(2, '0')}`
      }).filter(s => s !== 'NaN:NaN')
      POST_HOURS[asset][duration] = new Set(allowedTimes)
    } else {
      POST_HOURS[asset][duration] = null
    }
  }
}

// ─── Slug Generation ─────────────────────────────────────────────────────────

function generateUpcomingSlugs() {
  const nowSec = Math.floor(Date.now() / 1000)
  const windowEndSec = nowSec + Math.ceil(SIZING_WINDOW_MS / 1000)

  // First 5-minute boundary at or after now
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
  return { slugs, timestamps }
}

// ─── Pre-Expiry Auto Cancellation ────────────────────────────────────────────

const scheduledExpirySlugs = new Set()

function schedulePreExpiryTimers() {
  const nowSec = Math.floor(Date.now() / 1000)

  for (const asset of ASSETS) {
    for (const duration of DURATIONS) {
      const durationSec = duration === '5m' ? 300 : 900
      const intervals = durationSec / 300

      const currentBoundary = Math.floor(nowSec / 300) * 300
      const startFrom = currentBoundary - ((intervals - 1) * 300)
      const startTo = currentBoundary + 1200 // +20 min of future boundaries

      for (let startTs = startFrom; startTs <= startTo; startTs += 300) {
        const endTime = startTs + durationSec
        const cancelAtSec = endTime - CANCEL_BEFORE_END_SECONDS

        if (cancelAtSec <= nowSec) continue

        const slug = `${asset}-updown-${duration}-${startTs}`
        if (scheduledExpirySlugs.has(slug)) continue

        const delayMs = (cancelAtSec * 1000) - Date.now()
        scheduledExpirySlugs.add(slug)

        setTimeout(async () => {
          try {
            const market = await lookupMarketBySlug(slug)
            if (!market || !market.marketId) return

            const allOrders = await fetchAllOpenOrders()
            const marketOrders = allOrders.filter(o => String(o.marketId) === String(market.marketId))
            if (marketOrders.length === 0) return

            const ids = marketOrders.map(o => o.id)
            await cancelOrders(ids)
            console.log(`\n[pre-expiry] ✓ [${slug}] Canceled ${ids.length} order(s) at T-${CANCEL_BEFORE_END_SECONDS}s`)
          } catch (err) {
            console.error(`\n[pre-expiry] Error for ${slug}: ${err.message}`)
          } finally {
            scheduledExpirySlugs.delete(slug)
          }
        }, delayMs)
      }
    }
  }
}

function startPreExpiryWatcher() {
  if (CANCEL_BEFORE_END_SECONDS <= 0) return
  console.log(`[pre-expiry] Watcher active: canceling orders exactly ${CANCEL_BEFORE_END_SECONDS}s before market end`)

  schedulePreExpiryTimers()
  setInterval(schedulePreExpiryTimers, 60_000)
}

// ─── Price & Size Computation Helper ─────────────────────────────────────────

function parseOrderPriceAndSize(orderItem) {
  const order = orderItem.order || {}
  const side = order.side === 0 ? 'BUY' : 'SELL'
  const makerWei = BigInt(order.makerAmount || '0')
  const takerWei = BigInt(order.takerAmount || '0')

  let price = 0
  let shares = 0

  if (side === 'BUY') {
    if (takerWei > 0n) {
      price = Number(makerWei) / Number(takerWei)
    }
    shares = Number(takerWei) / 1e18
  } else {
    if (makerWei > 0n) {
      price = Number(takerWei) / Number(makerWei)
    }
    shares = Number(makerWei) / 1e18
  }

  return { price, shares, side, tokenId: order.tokenId }
}

// ─── Core Cleanup Cycle ──────────────────────────────────────────────────────

async function runCleanup() {
  console.log(`\n════════════════════════════════════════════════════════════════`)
  console.log(`Predict.fun Cleanup cycle at ${new Date().toISOString()}`)
  if (DELETE_ALL_ORDERS) {
    console.log(`⚠️  WARNING: DELETE_ALL_ORDERS is true. ALL open orders for discovered markets will be canceled!`)
  }
  console.log(`════════════════════════════════════════════════════════════════`)

  // Step 1: Generate Upcoming Slugs
  const { slugs, timestamps } = generateUpcomingSlugs()
  const tsLabels = timestamps.map(ts => {
    const d = new Date(ts * 1000)
    return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`
  }).join(', ')

  console.log(`\nAssets: ${ASSETS.join(', ')}`)
  console.log(`Durations: ${DURATIONS.join(', ')}`)
  console.log(`Timestamps: ${tsLabels} UTC (${timestamps.join(', ')})`)
  console.log(`Generated ${slugs.length} slugs to check`)

  // Step 2: Look Up Markets via Predict.fun API
  console.log(`\nLooking up markets...`)
  const foundMarkets = []

  for (const slug of slugs) {
    const result = await lookupMarketBySlug(slug)
    if (result && result.marketId) {
      foundMarkets.push(result)
      console.log(`  ✓ ${slug} → Market ID: ${result.marketId}`)
    }
  }

  if (foundMarkets.length === 0) {
    console.log(`No active Predict.fun markets found for current window. Nothing to size.`)
    return
  }

  console.log(`\nFound ${foundMarkets.length} active market(s)`)

  // Step 3: Fetch Open Orders on Account
  console.log(`Fetching live open orders...`)
  let allOpenOrders = []
  try {
    allOpenOrders = await fetchAllOpenOrders()
  } catch (err) {
    console.error("Failed to fetch open orders:", err.message)
    return
  }

  if (allOpenOrders.length === 0) {
    console.log("0 open orders across entire account. Nothing to size.")
    return
  }

  // Index orders by marketId
  const ordersByMarketId = new Map()
  for (const o of allOpenOrders) {
    const mId = String(o.marketId)
    if (!ordersByMarketId.has(mId)) ordersByMarketId.set(mId, [])
    ordersByMarketId.get(mId).push(o)
  }

  // Step 4: Apply Sizing & Deduplication Rules
  const sizingToCancel = []

  const shouldDeleteAll = (slug) => {
    if (DELETE_ALL_ORDERS) return true
    if (DELETE_ALL_SLUGS.some(pattern => slug.includes(pattern))) return true
    if (isTwapThresholdBreached(slug)) return true

    // Check POST_HOURS restriction
    const parts = slug.split('-')
    if (parts.length >= 4) {
      const asset = parts[0]
      const duration = parts[2]
      const ts = parseInt(parts[parts.length - 1], 10)
      if (!isNaN(ts) && POST_HOURS[asset] && POST_HOURS[asset][duration] !== undefined) {
        const allowedSet = POST_HOURS[asset][duration]
        if (allowedSet !== null) {
          const d = new Date(ts * 1000)
          const hh = d.getUTCHours().toString().padStart(2, '0')
          const mm = d.getUTCMinutes().toString().padStart(2, '0')
          const timeStr = `${hh}:${mm}`
          if (!allowedSet.has(timeStr)) {
            return true
          }
        }
      }
    }
    return false
  }

  if (DELETE_ALL_ORDERS) {
    console.log(`\n--- Sizing: Canceling all open orders for immediate markets ---`)
  } else if (DELETE_ALL_SLUGS.length > 0) {
    console.log(`\n--- Sizing: Delete-all for slugs matching [${DELETE_ALL_SLUGS.join(', ')}]; keep oldest pair per price for the rest ---`)
  } else {
    console.log(`\n--- Sizing: Keep single oldest order per (outcome, price) for all markets ---`)
  }
  if (DELETE_ALL_PRICES.length > 0) {
    console.log(`    Also deleting ALL orders at price(s): ${DELETE_ALL_PRICES.join(', ')}`)
  }
  if (DELETE_ALL_SIZES.length > 0) {
    console.log(`    Also deleting ALL orders at size(s): ${DELETE_ALL_SIZES.join(', ')}`)
  }

  for (const market of foundMarkets) {
    const marketOrders = ordersByMarketId.get(String(market.marketId)) || []

    if (marketOrders.length === 0) {
      console.log(`  [${market.slug}] 0 open orders`)
      continue
    }

    // Delete all if conditions met
    if (shouldDeleteAll(market.slug)) {
      const toCancel = marketOrders.map(o => o.id)
      sizingToCancel.push(...toCancel)
      console.log(`  [${market.slug}] ${marketOrders.length} orders scheduled for cancellation (delete-all condition).`)
      continue
    }

    // Group orders by tokenId (Up vs Down outcome)
    const outcomeGroups = {}
    for (const orderItem of marketOrders) {
      const parsed = parseOrderPriceAndSize(orderItem)
      const tokenKey = parsed.tokenId || 'default'
      if (!outcomeGroups[tokenKey]) outcomeGroups[tokenKey] = []
      outcomeGroups[tokenKey].push({ orderItem, ...parsed })
    }

    console.log(`\n  [${market.slug}] ${marketOrders.length} orders across ${Object.keys(outcomeGroups).length} outcome(s)`)

    for (const [tokenId, tokenOrders] of Object.entries(outcomeGroups)) {
      // Sub-group by price
      const priceGroups = {}
      for (const item of tokenOrders) {
        const priceKey = item.price.toFixed(4)
        if (!priceGroups[priceKey]) priceGroups[priceKey] = []
        priceGroups[priceKey].push(item)
      }

      for (const [priceKey, groupItems] of Object.entries(priceGroups)) {
        const priceVal = parseFloat(priceKey)

        // 1. DELETE_ALL_PRICES filter
        if (DELETE_ALL_PRICES.length > 0 && DELETE_ALL_PRICES.some(p => Math.abs(p - priceVal) < 0.0001)) {
          const toCancel = groupItems.map(i => i.orderItem.id)
          sizingToCancel.push(...toCancel)
          console.log(`    └─ Token ${tokenId.slice(0, 10)}... @ price=${priceKey}: deleting ALL ${toCancel.length} orders (DELETE_ALL_PRICES)`)
          continue
        }

        // 2. DELETE_ALL_SIZES filter
        let validItems = []
        for (const item of groupItems) {
          if (DELETE_ALL_SIZES.length > 0 && DELETE_ALL_SIZES.some(s => Math.abs(s - item.shares) < 0.01)) {
            sizingToCancel.push(item.orderItem.id)
            console.log(`    └─ Token ${tokenId.slice(0, 10)}... @ price=${priceKey}: deleting order id=${item.orderItem.id} (size=${item.shares.toFixed(2)}) (DELETE_ALL_SIZES)`)
          } else {
            validItems.push(item)
          }
        }

        if (validItems.length <= 1) {
          if (validItems.length === 1) {
            console.log(`    └─ Token ${tokenId.slice(0, 10)}... @ price=${priceKey}: only 1 order (size=${validItems[0].shares.toFixed(2)}), keeping as-is`)
          } else {
            console.log(`    └─ Token ${tokenId.slice(0, 10)}... @ price=${priceKey}: no valid orders remaining`)
          }
          continue
        }

        // Sort ascending by BigInt(id): oldest order has lowest sequential ID
        validItems.sort((a, b) => {
          const idA = BigInt(a.orderItem.id || '0')
          const idB = BigInt(b.orderItem.id || '0')
          return idA < idB ? -1 : idA > idB ? 1 : 0
        })

        // Keep the oldest, cancel all newer duplicates
        const kept = validItems[0]
        const duplicates = validItems.slice(1)
        const toCancel = duplicates.map(d => d.orderItem.id)
        sizingToCancel.push(...toCancel)

        console.log(`    └─ Token ${tokenId.slice(0, 10)}... @ price=${priceKey}: keeping oldest (ID=${kept.orderItem.id}, size=${kept.shares.toFixed(2)}), canceling ${toCancel.length} duplicate(s)`)
      }
    }
  }

  // Step 5: Execute Cancellations
  if (sizingToCancel.length > 0) {
    console.log(`\nCanceling ${sizingToCancel.length} excess order(s) on Predict.fun...`)
    try {
      const res = await cancelOrders(sizingToCancel)
      console.log(`✓ Cancellation complete: ${res.removedCount} order(s) removed from orderbook.`)
    } catch (cancelErr) {
      console.error("Cancellation error:", cancelErr.message)
    }
  } else {
    console.log("\nNo sizing adjustments needed.")
  }

  console.log(`Cleanup finished at ${new Date().toISOString()}`)
}

// ─── Entrypoint & Continuous Loop ────────────────────────────────────────────

async function start() {
  console.log("PF Sizer — Predict.fun Proactive Sizing & Order Management")
  console.log(`Signer:        ${SIGNER_ADDRESS}`)
  console.log(`Account/Maker: ${MAKER_ADDRESS}`)
  console.log(`Smart Account: ${IS_KERNEL ? 'ZeroDev Kernel (Privy Export)' : 'EOA'}`)
  console.log(`Assets:        ${ASSETS.join(', ')}`)
  console.log(`Durations:     ${DURATIONS.join(', ')}`)
  console.log(`Delete All:    ${DELETE_ALL_ORDERS}`)
  console.log(`Delete Slugs:  ${DELETE_ALL_SLUGS.length > 0 ? DELETE_ALL_SLUGS.join(', ') : '(none)'}`)
  console.log(`Delete Prices: ${DELETE_ALL_PRICES.length > 0 ? DELETE_ALL_PRICES.join(', ') : '(none)'}`)
  console.log(`Delete Sizes:  ${DELETE_ALL_SIZES.length > 0 ? DELETE_ALL_SIZES.join(', ') : '(none)'}`)
  console.log(`Pre-Expiry:    ${CANCEL_BEFORE_END_SECONDS > 0 ? CANCEL_BEFORE_END_SECONDS + 's' : 'disabled'}`)

  const configuredThres = ASSETS.map(a => {
    const t = getThreshold(a)
    return t !== null ? `${a.toUpperCase()}: ±${t}%` : null
  }).filter(Boolean)
  console.log(`TWAP Limits:   ${configuredThres.length > 0 ? configuredThres.join(', ') : 'disabled'}`)

  try {
    await authenticate()
    console.log("✓ Authenticated with Predict.fun successfully.\n")
  } catch (err) {
    console.error("Failed to authenticate on startup:", err.message)
    process.exit(1)
  }

  startPreExpiryWatcher()

  const hasTwapThresholds = ASSETS.some(a => getThreshold(a) !== null)
  if (hasTwapThresholds) {
    startTwapWatcher({
      lookupMarketBySlug,
      assets: ASSETS,
      durations: DURATIONS,
    })
  }

  if (process.env.CANCEL_OPPOSITE_ON_FILL === 'true') {
    startWatcher().catch(err => console.error("Fill Watcher error:", err))
  }

  while (true) {
    const startTime = Date.now()
    try {
      await runCleanup()
    } catch (err) {
      console.error("Unhandled error in runCleanup:", err)
    }
    const executionTime = Date.now() - startTime
    const waitMs = Math.max(0, 300000 - executionTime) // 5 minutes minus execution time
    console.log(`\nNext cycle in ${Math.floor(waitMs / 1000 / 60)}m ${Math.floor((waitMs / 1000) % 60)}s...\n`)
    await new Promise(resolve => setTimeout(resolve, waitMs))
  }
}

export { lookupMarketBySlug }
start()
