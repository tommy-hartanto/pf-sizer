import 'dotenv/config'
import dns from 'dns'
import https from 'https'
import WebSocket from 'ws'
import { cancelOrders, fetchAllOpenOrders } from './predict-client.js'

// ─── DoH (DNS over HTTPS) Helper ─────────────────────────────────────────────
const dnsCache = new Map()

export async function resolveDoH(hostname) {
  if (dnsCache.has(hostname)) return dnsCache.get(hostname)

  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
    return hostname
  }

  return new Promise((resolve) => {
    https.get(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { accept: 'application/dns-json' }, timeout: 4000 },
      (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            const answer = json.Answer?.find(a => a.type === 1)
            if (answer?.data) {
              dnsCache.set(hostname, answer.data)
              return resolve(answer.data)
            }
          } catch {}
          resolve(null)
        })
      }
    ).on('error', () => resolve(null))
  })
}

export function customDohLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback
  const opts = typeof options === 'object' ? options : {}

  resolveDoH(hostname)
    .then((ip) => {
      if (ip) {
        if (opts.all) cb(null, [{ address: ip, family: 4 }])
        else cb(null, ip, 4)
      } else {
        dns.lookup(hostname, options, cb)
      }
    })
    .catch(() => dns.lookup(hostname, options, cb))
}

// ─── Constants & Configuration ───────────────────────────────────────────────
const BINANCE_WS_HOST = 'data-stream.binance.vision'
const DEFAULT_ASSETS = ['eth', 'btc', 'sol', 'xrp', 'doge', 'bnb']
const DEFAULT_DURATIONS = ['5m', '15m']

// In-memory price state
// latestPrices[asset] = { spot, twap30s, twap60s, lastUpdateMs }
const latestPrices = new Map()

// priceHistory[asset] = array of { ts: epochSeconds, price }
const priceHistory = new Map()

// marketOpenPrices: slug -> openPrice (float)
const marketOpenPrices = new Map()

// triggeredSlugs: Set of slugs whose orders were already canceled this window
const triggeredSlugs = new Set()

/**
 * Reads configured percentage threshold for an asset (e.g. CANCEL_THRES_BTC=0.3).
 * Falls back to CANCEL_THRES_DEFAULT or CANCEL_THRES_PERCENT if set.
 * Returns threshold as a positive number (e.g. 0.3 for 0.3%), or null if not set.
 */
export function getThreshold(asset) {
  const assetKey = asset.toUpperCase()
  const raw = process.env[`CANCEL_THRES_${assetKey}`]
  if (raw !== undefined && raw.trim() !== '') {
    const val = parseFloat(raw)
    if (!isNaN(val) && val > 0) return val
  }

  const fallback = process.env.CANCEL_THRES_DEFAULT || process.env.CANCEL_THRES_PERCENT
  if (fallback !== undefined && fallback.trim() !== '') {
    const val = parseFloat(fallback)
    if (!isNaN(val) && val > 0) return val
  }

  return null
}

/**
 * Checks if a market slug has breached its TWAP percentage threshold.
 */
export function isTwapThresholdBreached(slug) {
  return triggeredSlugs.has(slug)
}

/**
 * Returns latest tracked TWAP information for debugging / logging.
 */
export function getTwapStatus() {
  const status = {}
  for (const [asset, data] of latestPrices.entries()) {
    status[asset] = { ...data, threshold: getThreshold(asset) }
  }
  return status
}

/**
 * Calculates TWAP over a window in seconds from historical price ticks.
 */
function calculateTwap(asset, windowSec, nowSec) {
  const sym = asset.toLowerCase()
  const list = priceHistory.get(sym)
  if (!list || list.length === 0) return null

  const cutoff = nowSec - windowSec
  let sum = 0
  let count = 0

  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]
    if (item.ts < cutoff) break
    sum += item.price
    count++
  }

  return count > 0 ? sum / count : null
}

/**
 * Returns effective TWAP or spot price for an asset given market duration.
 * 5m markets resolve on 30s TWAP (or spot fallback).
 * 15m markets resolve on 60s TWAP (or 30s / spot fallback).
 */
export function getEffectiveTwap(asset, duration) {
  const sym = asset.toLowerCase()
  const data = latestPrices.get(sym)
  if (!data) return null

  const nowSec = Math.floor(Date.now() / 1000)
  if (duration === '5m') {
    return calculateTwap(sym, 30, nowSec) ?? data.spot ?? null
  } else {
    return calculateTwap(sym, 60, nowSec) ?? calculateTwap(sym, 30, nowSec) ?? data.spot ?? null
  }
}

/**
 * Records a price tick into latest state and historical ring buffer.
 */
function recordPriceTick(asset, price, tsMs) {
  const sym = asset.toLowerCase()
  const tsSec = Math.floor(tsMs / 1000)

  if (!latestPrices.has(sym)) {
    latestPrices.set(sym, { spot: price, twap30s: null, twap60s: null, lastUpdateMs: tsMs })
  }
  const current = latestPrices.get(sym)
  current.spot = price
  current.lastUpdateMs = tsMs

  if (!priceHistory.has(sym)) priceHistory.set(sym, [])
  const list = priceHistory.get(sym)
  list.push({ ts: tsSec, price })

  // Prune history older than 35 minutes (2100s)
  const cutoff = tsSec - 2100
  while (list.length > 0 && list[0].ts < cutoff) {
    list.shift()
  }

  current.twap30s = calculateTwap(sym, 30, tsSec)
  current.twap60s = calculateTwap(sym, 60, tsSec)
}

/**
 * Finds historical price at or closest to a specific timestamp.
 */
function findHistoricalPrice(asset, targetTsSec) {
  const sym = asset.toLowerCase()
  const list = priceHistory.get(sym)
  if (!list || list.length === 0) return null

  let best = null
  let minDiff = Infinity

  for (const item of list) {
    const diff = Math.abs(item.ts - targetTsSec)
    if (diff < minDiff && diff <= 45) { // within 45s tolerance
      minDiff = diff
      best = item.price
    }
  }

  return best
}

/**
 * Evaluates active markets and cancels orders if TWAP delta exceeds threshold.
 */
async function checkThresholdsForActiveMarkets({
  lookupMarketBySlug,
  assets,
  durations,
}) {
  const nowSec = Math.floor(Date.now() / 1000)

  for (const asset of assets) {
    const threshold = getThreshold(asset)
    if (threshold === null) continue

    for (const duration of durations) {
      const durationSec = duration === '5m' ? 300 : 900

      // Active window check
      const currentBoundary = Math.floor(nowSec / 300) * 300
      const startFrom = currentBoundary - durationSec + 300

      for (let startTs = startFrom; startTs <= currentBoundary; startTs += 300) {
        const endTime = startTs + durationSec
        if (nowSec < startTs || nowSec >= endTime) continue

        const slug = `${asset}-updown-${duration}-${startTs}`
        if (triggeredSlugs.has(slug)) continue

        // 1. Determine open price for this market
        let openPrice = marketOpenPrices.get(slug)
        if (!openPrice) {
          openPrice = findHistoricalPrice(asset, startTs)
          if (!openPrice) {
            openPrice = getEffectiveTwap(asset, duration)
          }

          if (openPrice && openPrice > 0) {
            marketOpenPrices.set(slug, openPrice)
            console.log(`[twap-threshold] 📌 [${slug}] Registered Open Price: $${openPrice.toFixed(4)} (Threshold: ±${threshold}%)`)
          }
        }

        if (!openPrice || openPrice <= 0) continue

        // 2. Get current live price / TWAP
        const currentTwap = getEffectiveTwap(asset, duration)
        if (!currentTwap || currentTwap <= 0) continue

        // 3. Compute percentage delta
        const deltaPercent = Math.abs((currentTwap - openPrice) / openPrice) * 100

        // 4. Check if breached
        if (deltaPercent >= threshold) {
          triggeredSlugs.add(slug)

          console.log(`\n═══════════════════════════════════════════════════════════════════`)
          console.log(`[twap-threshold] 🚨 BREACH DETECTED for [${slug}]!`)
          console.log(`  Current TWAP/Spot: $${currentTwap.toFixed(4)}`)
          console.log(`  Open Price:        $${openPrice.toFixed(4)}`)
          console.log(`  Delta:             ${deltaPercent.toFixed(4)}% >= Threshold: ${threshold}%`)
          console.log(`  Action:            Canceling ALL open orders for market on Predict.fun...`)
          console.log(`═══════════════════════════════════════════════════════════════════`)

          try {
            const market = await lookupMarketBySlug(slug)
            if (!market || !market.marketId) {
              console.warn(`[twap-threshold] Could not resolve market ID for ${slug}`)
              continue
            }

            const allOrders = await fetchAllOpenOrders()
            const marketOrders = allOrders.filter(o => String(o.marketId) === String(market.marketId))

            if (marketOrders.length === 0) {
              console.log(`[twap-threshold] [${slug}] 0 open orders found.`)
              continue
            }

            const ids = marketOrders.map(o => o.id)
            const result = await cancelOrders(ids)
            console.log(`[twap-threshold] ✓ [${slug}] Successfully canceled all ${ids.length} open order(s)!`)
          } catch (cancelErr) {
            console.error(`[twap-threshold] Error canceling orders for ${slug}: ${cancelErr.message}`)
          }
        }
      }
    }
  }

  // Periodic cleanup of expired market state
  for (const [slug] of marketOpenPrices.entries()) {
    const parts = slug.split('-')
    const startTs = parseInt(parts[parts.length - 1], 10)
    const duration = parts[2]
    const durationSec = duration === '5m' ? 300 : 900
    if (!isNaN(startTs) && nowSec >= startTs + durationSec + 60) {
      marketOpenPrices.delete(slug)
      triggeredSlugs.delete(slug)
    }
  }
}

// ─── WebSocket Client for Binance Spot Price Stream ──────────────────────────
let binanceWs = null
let pingInterval = null
let reconnectTimeout = null
let checkInterval = null
let isShuttingDown = false

export function startTwapWatcher({
  lookupMarketBySlug,
  assets = DEFAULT_ASSETS,
  durations = DEFAULT_DURATIONS,
}) {
  const configuredAssets = assets.filter(a => getThreshold(a) !== null)
  if (configuredAssets.length === 0) {
    console.log("[twap-threshold] No CANCEL_THRES_* variables configured. Watcher inactive.")
    return { stop: () => {} }
  }

  console.log(`[twap-threshold] 🚀 Initializing TWAP Threshold Watcher via Binance Spot Stream...`)
  for (const a of configuredAssets) {
    console.log(`  └─ ${a.toUpperCase()}: threshold = ${getThreshold(a)}%`)
  }

  const streams = assets.map(a => `${a.toLowerCase()}usdt@ticker`).join('/')
  const streamUrl = `wss://${BINANCE_WS_HOST}:9443/stream?streams=${streams}`

  function connect() {
    if (isShuttingDown) return

    if (binanceWs) {
      binanceWs.removeAllListeners()
      binanceWs.terminate()
      binanceWs = null
    }
    if (pingInterval) clearInterval(pingInterval)

    binanceWs = new WebSocket(streamUrl, {
      lookup: customDohLookup,
      headers: {
        'User-Agent': 'pf-sizer/2.0',
      },
    })

    binanceWs.on('open', () => {
      console.log(`[twap-threshold] Connected to Binance Spot WS stream (tracking: ${assets.join(', ')}).`)
    })

    binanceWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        const payload = msg.data || msg
        const rawSymbol = payload.s || ''
        if (!rawSymbol.endsWith('USDT')) return

        const sym = rawSymbol.slice(0, -4).toLowerCase()
        const priceStr = payload.c
        if (!priceStr) return

        const price = parseFloat(priceStr)
        if (isNaN(price)) return

        const tsMs = payload.E || Date.now()
        recordPriceTick(sym, price, tsMs)
      } catch {}
    })

    binanceWs.on('error', (err) => {
      if (!isShuttingDown) console.warn(`[twap-threshold] Binance WS error: ${err.message}`)
    })

    binanceWs.on('close', (code) => {
      if (!isShuttingDown) {
        console.log(`[twap-threshold] Binance WS disconnected (${code}). Reconnecting in 3s...`)
        reconnectTimeout = setTimeout(connect, 3000)
      }
    })
  }

  connect()

  // Evaluate every 1 second
  checkInterval = setInterval(() => {
    checkThresholdsForActiveMarkets({
      lookupMarketBySlug,
      assets,
      durations,
    }).catch(err => console.error(`[twap-threshold] Check loop error: ${err.message}`))
  }, 1000)

  return {
    stop: () => {
      isShuttingDown = true
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
      if (checkInterval) clearInterval(checkInterval)
      if (binanceWs) binanceWs.close()
    },
  }
}

// ─── Standalone CLI Runner ───────────────────────────────────────────────────
import { fileURLToPath } from 'url'
import { lookupMarketBySlug as lookupMarket } from './predict-client.js'

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ASSETS = (process.env.ASSETS || 'eth,btc,sol,xrp,doge,bnb').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const DURATIONS = ['5m', '15m']

  const watcher = startTwapWatcher({
    lookupMarketBySlug: lookupMarket,
    assets: ASSETS,
    durations: DURATIONS,
  })

  const shutdown = () => {
    console.log("\n[twap-threshold] Shutting down...")
    if (watcher) watcher.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
