import 'dotenv/config'
import dns from 'dns'
import https from 'https'
import WebSocket from 'ws'
import { cancelOrders, fetchAllOpenOrders } from './predict-client.js'
import { parseConfiguredTargets } from './cleanup.js'

function timeStr() {
  return new Date().toISOString().slice(11, 19)
}

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

// ─── Constants & State ───────────────────────────────────────────────────────
const BINANCE_WS_HOST = 'data-stream.binance.vision'

const latestPrices = new Map()
const priceHistory = new Map()
const marketOpenPrices = new Map()
const triggeredSlugs = new Set()

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

export function isTwapThresholdBreached(slug) {
  return triggeredSlugs.has(slug)
}

export function getTwapStatus() {
  const status = {}
  for (const [asset, data] of latestPrices.entries()) {
    status[asset] = { ...data, threshold: getThreshold(asset) }
  }
  return status
}

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

  const cutoff = tsSec - 2100
  while (list.length > 0 && list[0].ts < cutoff) {
    list.shift()
  }

  current.twap30s = calculateTwap(sym, 30, tsSec)
  current.twap60s = calculateTwap(sym, 60, tsSec)
}

function findHistoricalPrice(asset, targetTsSec) {
  const sym = asset.toLowerCase()
  const list = priceHistory.get(sym)
  if (!list || list.length === 0) return null

  let best = null
  let minDiff = Infinity

  for (const item of list) {
    const diff = Math.abs(item.ts - targetTsSec)
    if (diff < minDiff && diff <= 45) {
      minDiff = diff
      best = item.price
    }
  }

  return best
}

/**
 * Evaluates active markets silently; logs strictly 1 line when a breach occurs.
 */
async function checkThresholdsForActiveMarkets({
  lookupMarketBySlug,
  targets,
}) {
  const nowSec = Math.floor(Date.now() / 1000)

  for (const { asset, duration } of targets) {
    const threshold = getThreshold(asset)
    if (threshold === null) continue

    const durationSec = duration === '15m' ? 900 : 300
    const activeTs = Math.floor(nowSec / durationSec) * durationSec
    const endTime = activeTs + durationSec

    if (nowSec >= endTime) continue

    const slug = `${asset}-updown-${duration}-${activeTs}`
    if (triggeredSlugs.has(slug)) continue

    let openPrice = marketOpenPrices.get(slug)
    if (!openPrice) {
      openPrice = findHistoricalPrice(asset, activeTs)
      if (!openPrice) {
        openPrice = getEffectiveTwap(asset, duration)
      }
      if (openPrice && openPrice > 0) {
        marketOpenPrices.set(slug, openPrice)
      }
    }

    if (!openPrice || openPrice <= 0) continue

    const currentTwap = getEffectiveTwap(asset, duration)
    if (!currentTwap || currentTwap <= 0) continue

    const deltaPercent = Math.abs((currentTwap - openPrice) / openPrice) * 100

    if (deltaPercent >= threshold) {
      triggeredSlugs.add(slug)

      try {
        const market = await lookupMarketBySlug(slug)
        if (!market || !market.marketId) continue

        const allOrders = await fetchAllOpenOrders()
        const marketOrders = allOrders.filter(o => String(o.marketId) === String(market.marketId))

        if (marketOrders.length === 0) {
          console.log(`[${timeStr()}] [BREACH] ${slug}: Delta ${deltaPercent.toFixed(2)}% >= ${threshold}% (Open: $${openPrice.toFixed(2)} -> Now: $${currentTwap.toFixed(2)}) | 0 orders found`)
          continue
        }

        const ids = marketOrders.map(o => o.id)
        await cancelOrders(ids)
        console.log(`[${timeStr()}] [BREACH] ${slug}: Delta ${deltaPercent.toFixed(2)}% >= ${threshold}% (Open: $${openPrice.toFixed(2)} -> Now: $${currentTwap.toFixed(2)}) | Canceled ${ids.length} order(s)`)
      } catch (cancelErr) {
        console.error(`[${timeStr()}] [BREACH] Error for ${slug}: ${cancelErr.message}`)
      }
    }
  }

  for (const [slug] of marketOpenPrices.entries()) {
    const parts = slug.split('-')
    const activeTs = parseInt(parts[parts.length - 1], 10)
    const duration = parts[2]
    const durationSec = duration === '15m' ? 900 : 300
    if (!isNaN(activeTs) && nowSec >= activeTs + durationSec + 60) {
      marketOpenPrices.delete(slug)
      triggeredSlugs.delete(slug)
    }
  }
}

// ─── WebSocket Client for Binance Spot Price Stream ──────────────────────────
let binanceWs = null
let reconnectTimeout = null
let checkInterval = null
let isShuttingDown = false

export function startTwapWatcher({
  lookupMarketBySlug,
  targets = parseConfiguredTargets(),
}) {
  const uniqueAssets = [...new Set(targets.map(t => t.asset))]
  const configuredAssets = uniqueAssets.filter(a => getThreshold(a) !== null)
  if (configuredAssets.length === 0) return { stop: () => {} }

  const streams = uniqueAssets.map(a => `${a.toLowerCase()}usdt@ticker`).join('/')
  const streamUrl = `wss://${BINANCE_WS_HOST}:9443/stream?streams=${streams}`

  function connect() {
    if (isShuttingDown) return

    if (binanceWs) {
      binanceWs.removeAllListeners()
      binanceWs.terminate()
      binanceWs = null
    }

    binanceWs = new WebSocket(streamUrl, {
      lookup: customDohLookup,
      headers: { 'User-Agent': 'pf-sizer/2.0' },
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

    binanceWs.on('close', () => {
      if (!isShuttingDown) {
        reconnectTimeout = setTimeout(connect, 3000)
      }
    })
  }

  connect()

  checkInterval = setInterval(() => {
    checkThresholdsForActiveMarkets({
      lookupMarketBySlug,
      targets,
    }).catch(err => console.error(`[${timeStr()}] [TWAP] Error: ${err.message}`))
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
  const targets = parseConfiguredTargets()

  const watcher = startTwapWatcher({
    lookupMarketBySlug: lookupMarket,
    targets,
  })

  const shutdown = () => {
    if (watcher) watcher.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
