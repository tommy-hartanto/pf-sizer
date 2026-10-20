import 'dotenv/config'
import {
  SIGNER_ADDRESS,
  MAKER_ADDRESS,
  IS_KERNEL,
  lookupMarketBySlug,
  fetchAllOpenOrders,
  cancelOrders,
  authenticate
} from './predict-client.js'
import { startWatcher, dropMarketFromFillWatcher } from './fill-watcher.js'
import { startTwapWatcher, isTwapThresholdBreached, getThreshold } from './twap-watcher.js'

function timeStr() {
  return new Date().toISOString().slice(11, 19)
}

// ─── Environment Parsing ─────────────────────────────────────────────────────

export function parseConfiguredTargets(envAssets = process.env.ASSETS) {
  const rawList = (envAssets || 'btc-updown-5m')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)

  const targets = []
  for (const item of rawList) {
    if (item.includes('-updown-')) {
      const [asset, duration] = item.split('-updown-')
      const dur = duration === '15m' ? '15m' : '5m'
      targets.push({ asset, duration: dur, fullPrefix: `${asset}-updown-${dur}` })
    } else if (item.endsWith('-5m') || item.endsWith('-15m')) {
      const lastDash = item.lastIndexOf('-')
      const asset = item.slice(0, lastDash)
      const duration = item.slice(lastDash + 1)
      targets.push({ asset, duration, fullPrefix: `${asset}-updown-${duration}` })
    } else {
      targets.push({ asset: item, duration: '5m', fullPrefix: `${item}-updown-5m` })
    }
  }

  const unique = []
  const seen = new Set()
  for (const t of targets) {
    const key = `${t.asset}:${t.duration}`
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(t)
    }
  }
  return unique
}

const TARGETS = parseConfiguredTargets()
const UNIQUE_ASSETS = [...new Set(TARGETS.map(t => t.asset))]

const DELETE_ALL_ORDERS = process.env.DELETE_ALL_ORDERS === 'true'
const DELETE_ALL_SLUGS = (process.env.DELETE_ALL_SLUGS || '').split(',').map(s => s.trim()).filter(Boolean)
const DELETE_ALL_PRICES = (process.env.DELETE_ALL_PRICES || '').split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => !isNaN(n))
const DELETE_ALL_SIZES = (process.env.DELETE_ALL_SIZES || '').split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => !isNaN(n))
const CANCEL_BEFORE_END_SECONDS = Math.max(0, parseInt(process.env.CANCEL_BEFORE_END_SECONDS || '0', 10) || 0)

// Pre-parse POST_HOURS
const POST_HOURS = {}
for (const { asset, duration } of TARGETS) {
  if (!POST_HOURS[asset]) POST_HOURS[asset] = {}
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

// ─── Active Market Slug Generation ───────────────────────────────────────────

export function generateActiveSlugs() {
  const nowSec = Math.floor(Date.now() / 1000)
  const targets = parseConfiguredTargets()

  const slugs = []
  const timestamps = []

  for (const { asset, duration } of targets) {
    const durationSec = duration === '15m' ? 900 : 300
    const activeTs = Math.floor(nowSec / durationSec) * durationSec
    slugs.push(`${asset}-updown-${duration}-${activeTs}`)
    timestamps.push(activeTs)
  }

  return { slugs, timestamps: [...new Set(timestamps)], targets }
}

// ─── Pre-Expiry Auto Cancellation ────────────────────────────────────────────

const scheduledExpirySlugs = new Set()

function schedulePreExpiryTimers() {
  if (CANCEL_BEFORE_END_SECONDS <= 0) return
  const nowSec = Math.floor(Date.now() / 1000)
  const targets = parseConfiguredTargets()

  for (const { asset, duration } of targets) {
    const durationSec = duration === '15m' ? 900 : 300
    const activeTs = Math.floor(nowSec / durationSec) * durationSec
    const endTime = activeTs + durationSec
    const cancelAtSec = endTime - CANCEL_BEFORE_END_SECONDS

    if (cancelAtSec <= nowSec) continue

    const slug = `${asset}-updown-${duration}-${activeTs}`
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
        console.log(`[${timeStr()}] [PRE-EXPIRY] ${slug} (T-${CANCEL_BEFORE_END_SECONDS}s): Canceled ${ids.length} order(s)`)
      } catch (err) {
        console.error(`[${timeStr()}] [PRE-EXPIRY] Error for ${slug}: ${err.message}`)
      } finally {
        scheduledExpirySlugs.delete(slug)
      }
    }, delayMs)
  }
}

function startPreExpiryWatcher() {
  if (CANCEL_BEFORE_END_SECONDS <= 0) return
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

async function runCleanup(waitMs = 300000) {
  const { slugs } = generateActiveSlugs()
  const foundMarkets = []

  for (const slug of slugs) {
    const result = await lookupMarketBySlug(slug)
    if (result && result.marketId) {
      foundMarkets.push(result)
    }
  }

  if (foundMarkets.length === 0) {
    console.log(`[${timeStr()}] ${slugs.join(', ')}: Market not yet discovered`)
    return
  }

  let allOpenOrders = []
  try {
    allOpenOrders = await fetchAllOpenOrders()
  } catch (err) {
    console.error(`[${timeStr()}] Failed to fetch open orders: ${err.message}`)
    return
  }

  const ordersByMarketId = new Map()
  for (const o of allOpenOrders) {
    const mId = String(o.marketId)
    if (!ordersByMarketId.has(mId)) ordersByMarketId.set(mId, [])
    ordersByMarketId.get(mId).push(o)
  }

  const sizingToCancel = []

  const shouldDeleteAll = (slug) => {
    if (DELETE_ALL_ORDERS) return true
    if (DELETE_ALL_SLUGS.some(pattern => slug.includes(pattern))) return true

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
          const timeStrVal = `${hh}:${mm}`
          if (!allowedSet.has(timeStrVal)) {
            return true
          }
        }
      }
    }
    return false
  }

  let activeOrdersCount = 0

  for (const market of foundMarkets) {
    const marketOrders = ordersByMarketId.get(String(market.marketId)) || []
    activeOrdersCount += marketOrders.length

    if (marketOrders.length === 0) continue

    if (shouldDeleteAll(market.slug)) {
      sizingToCancel.push(...marketOrders.map(o => o.id))
      continue
    }

    if (isTwapThresholdBreached(market.slug)) {
      if (marketOrders.length > 1) {
        sizingToCancel.push(...marketOrders.map(o => o.id))
      }
      continue
    }

    const outcomeGroups = {}
    for (const orderItem of marketOrders) {
      const parsed = parseOrderPriceAndSize(orderItem)
      const tokenKey = parsed.tokenId || 'default'
      if (!outcomeGroups[tokenKey]) outcomeGroups[tokenKey] = []
      outcomeGroups[tokenKey].push({ orderItem, ...parsed })
    }

    for (const [, tokenOrders] of Object.entries(outcomeGroups)) {
      const priceGroups = {}
      for (const item of tokenOrders) {
        const priceKey = item.price.toFixed(4)
        if (!priceGroups[priceKey]) priceGroups[priceKey] = []
        priceGroups[priceKey].push(item)
      }

      for (const [priceKey, groupItems] of Object.entries(priceGroups)) {
        const priceVal = parseFloat(priceKey)

        if (DELETE_ALL_PRICES.length > 0 && DELETE_ALL_PRICES.some(p => Math.abs(p - priceVal) < 0.0001)) {
          sizingToCancel.push(...groupItems.map(i => i.orderItem.id))
          continue
        }

        let validItems = []
        for (const item of groupItems) {
          if (DELETE_ALL_SIZES.length > 0 && DELETE_ALL_SIZES.some(s => Math.abs(s - item.shares) < 0.01)) {
            sizingToCancel.push(item.orderItem.id)
          } else {
            validItems.push(item)
          }
        }

        if (validItems.length <= 1) continue

        validItems.sort((a, b) => {
          const idA = BigInt(a.orderItem.id || '0')
          const idB = BigInt(b.orderItem.id || '0')
          return idA < idB ? -1 : idA > idB ? 1 : 0
        })

        const duplicates = validItems.slice(1)
        sizingToCancel.push(...duplicates.map(d => d.orderItem.id))
      }
    }
  }

  const slugLabel = foundMarkets.map(m => m.slug).join(', ')
  const nextSec = Math.round(waitMs / 1000)
  const nextM = Math.floor(nextSec / 60)
  const nextS = nextSec % 60
  const nextStr = `${nextM}m ${nextS.toString().padStart(2, '0')}s`

  if (sizingToCancel.length > 0) {
    try {
      const res = await cancelOrders(sizingToCancel)
      console.log(`[${timeStr()}] [SIZING] ${slugLabel}: Canceled ${res.removedCount} duplicate/excess order(s). Kept ${activeOrdersCount - sizingToCancel.length} (next cycle in ${nextStr})`)
    } catch (cancelErr) {
      console.error(`[${timeStr()}] [SIZING] Error canceling orders: ${cancelErr.message}`)
    }
  } else {
    console.log(`[${timeStr()}] ${slugLabel}: ${activeOrdersCount} open order(s) OK (next cycle in ${nextStr})`)
  }
}

// ─── Entrypoint & Continuous Loop ────────────────────────────────────────────

async function start() {
  const targetStr = TARGETS.map(t => `${t.asset.toUpperCase()}-${t.duration}`).join(', ')
  const thresStr = UNIQUE_ASSETS.map(a => getThreshold(a) !== null ? `${a.toUpperCase()}: ±${getThreshold(a)}%` : null).filter(Boolean).join(', ') || 'disabled'
  const makerShort = `${MAKER_ADDRESS.slice(0, 6)}...${MAKER_ADDRESS.slice(-4)}`

  console.log(`[START] PF Sizer | Maker: ${makerShort} (${IS_KERNEL ? 'ZeroDev' : 'EOA'}) | Target: ${targetStr} | Pre-expiry: ${CANCEL_BEFORE_END_SECONDS}s | TWAP: ${thresStr}`)

  try {
    await authenticate()
  } catch (err) {
    console.error(`[${timeStr()}] Failed to authenticate on startup: ${err.message}`)
    process.exit(1)
  }

  startPreExpiryWatcher()

  const hasTwapThresholds = UNIQUE_ASSETS.some(a => getThreshold(a) !== null)
  if (hasTwapThresholds) {
    startTwapWatcher({
      lookupMarketBySlug,
      targets: TARGETS,
      onBreach: ({ marketId }) => {
        dropMarketFromFillWatcher(marketId)
      },
    })
  }

  if (process.env.CANCEL_OPPOSITE_ON_FILL === 'true') {
    startWatcher().catch(err => console.error(`[${timeStr()}] Fill Watcher error: ${err.message}`))
  }

  while (true) {
    const now = Date.now()
    const nextBoundaryMs = (Math.floor(now / 300000) + 1) * 300000 + 1000
    const waitMs = Math.max(5000, nextBoundaryMs - now)

    try {
      await runCleanup(waitMs)
    } catch (err) {
      console.error(`[${timeStr()}] Error in runCleanup: ${err.message}`)
    }

    await new Promise(resolve => setTimeout(resolve, waitMs))
  }
}

import { fileURLToPath } from 'url'
export { lookupMarketBySlug }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start()
}
