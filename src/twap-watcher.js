import 'dotenv/config'
import dns from 'dns'
import https from 'https'
import WebSocket from 'ws'
import { createL2Headers } from '@polymarket/clob-client'
import { request } from 'undici'

// ─── DoH (DNS over HTTPS) Helper ─────────────────────────────────────────────
// Resolves hostnames via Cloudflare DoH to bypass regional DNS blocks/poisoning.
const dnsCache = new Map()

export async function resolveDoH(hostname) {
  if (dnsCache.has(hostname)) return dnsCache.get(hostname)

  // Direct IP address check
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
const RTDS_WS_URL = 'wss://ws-live-data.polymarket.com'
const DEFAULT_ASSETS = ['eth', 'btc', 'sol', 'xrp', 'doge', 'bnb', 'hype']
const DEFAULT_DURATIONS = ['5m', '15m']

// In-memory state
// latestPrices[asset] = { twap30s, twap60s, spot, lastUpdateMs }
const latestPrices = new Map()

// twapHistory[asset][window] = array of { ts: epochSeconds, price }
const twapHistory = new Map()

// marketOpenPrices: slug -> openPrice (float)
const marketOpenPrices = new Map()

// triggeredSlugs: Set of slugs whose orders were already canceled this window
const triggeredSlugs = new Set()

// Cache for market lookup by slug: slug -> { conditionId, tokens, slug }
const marketCache = new Map()

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
 * Returns effective TWAP for an asset given market duration.
 * 5m markets resolve on 30s TWAP (or spot fallback).
 * 15m markets resolve on 60s TWAP (or 30s / spot fallback).
 */
export function getEffectiveTwap(asset, duration) {
  const sym = asset.toLowerCase()
  const data = latestPrices.get(sym)
  if (!data) return null

  if (duration === '5m') {
    return data.twap30s ?? data.spot ?? null
  } else {
    return data.twap60s ?? data.twap30s ?? data.spot ?? null
  }
}

/**
 * Records a TWAP price tick into latest state and historical ring buffer.
 */
function recordTwapTick(asset, window, value, tsMs) {
  const sym = asset.toLowerCase()
  const tsSec = Math.floor(tsMs / 1000)

  if (!latestPrices.has(sym)) {
    latestPrices.set(sym, { twap30s: null, twap60s: null, spot: null, lastUpdateMs: tsMs })
  }
  const current = latestPrices.get(sym)
  current.lastUpdateMs = tsMs

  if (window === 30) current.twap30s = value
  else if (window === 60) current.twap60s = value
  else if (window === 0) current.spot = value

  // Push to history
  if (!twapHistory.has(sym)) twapHistory.set(sym, {})
  const assetHist = twapHistory.get(sym)
  if (!assetHist[window]) assetHist[window] = []

  const list = assetHist[window]
  list.push({ ts: tsSec, price: value })

  // Prune history older than 35 minutes (2100s)
  const cutoff = tsSec - 2100
  while (list.length > 0 && list[0].ts < cutoff) {
    list.shift()
  }
}

/**
 * Finds historical TWAP price at or closest to a specific timestamp.
 */
function findHistoricalTwap(asset, window, targetTsSec) {
  const sym = asset.toLowerCase()
  const assetHist = twapHistory.get(sym)
  if (!assetHist || !assetHist[window] || assetHist[window].length === 0) return null

  const list = assetHist[window]
  // Find tick at or immediately preceding targetTsSec
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
 * Market lookup via Gamma API with caching.
 */
async function lookupMarket(slug, customLookupFn) {
  if (marketCache.has(slug)) return marketCache.get(slug)
  if (customLookupFn) {
    const res = await customLookupFn(slug)
    if (res) {
      marketCache.set(slug, res)
      return res
    }
  }

  // Fallback direct request
  try {
    const res = await request(`https://gamma-api.polymarket.com/markets?slug=${slug}`)
    if (res.statusCode === 200) {
      const data = await res.body.json()
      const m = Array.isArray(data) ? data[0] : data
      if (m && m.conditionId) {
        let tokens = []
        if (Array.isArray(m.clobTokenIds)) tokens = m.clobTokenIds
        else if (typeof m.clobTokenIds === 'string') {
          try { tokens = JSON.parse(m.clobTokenIds) } catch {}
        }
        const info = { conditionId: m.conditionId, tokens, slug: m.slug || slug }
        marketCache.set(slug, info)
        return info
      }
    } else {
      await res.body.text()
    }
  } catch {}

  return null
}

/**
 * Fetches all open orders for a specific market condition ID from Polymarket CLOB.
 */
async function fetchOpenOrdersForMarket(conditionId, wallet, creds) {
  try {
    const l2Args = { method: 'GET', requestPath: '/data/orders' }
    const headers = await createL2Headers(wallet, creds, l2Args)
    const res = await request(
      `https://clob.polymarket.com/data/orders?market=${conditionId}`,
      { method: 'GET', headers, headersTimeout: 10000, bodyTimeout: 10000 }
    )
    if (res.statusCode === 200) {
      const json = await res.body.json()
      return Array.isArray(json) ? json : (json?.data || [])
    } else {
      await res.body.text()
      return []
    }
  } catch (err) {
    console.error(`[twap-threshold] Error fetching orders for ${conditionId.slice(0, 10)}...: ${err.message}`)
    return []
  }
}

/**
 * Main watcher loop: checks active markets and cancels orders if TWAP delta exceeds threshold.
 */
async function checkThresholdsForActiveMarkets({
  clobClient,
  wallet,
  creds,
  lookupMarketBySlug,
  assets,
  durations,
}) {
  const nowSec = Math.floor(Date.now() / 1000)

  for (const asset of assets) {
    const threshold = getThreshold(asset)
    if (threshold === null) continue // No threshold configured for this asset

    for (const duration of durations) {
      const durationSec = duration === '5m' ? 300 : 900
      const windowSec = duration === '5m' ? 30 : 60

      // Scan currently active windows for this duration:
      // A market is active if startTs <= nowSec < startTs + durationSec
      // Check 5-minute boundaries going back durationSec
      const currentBoundary = Math.floor(nowSec / 300) * 300
      const startFrom = currentBoundary - durationSec + 300

      for (let startTs = startFrom; startTs <= currentBoundary; startTs += 300) {
        const endTime = startTs + durationSec
        if (nowSec < startTs || nowSec >= endTime) continue

        const slug = `${asset}-updown-${duration}-${startTs}`

        // If already triggered and canceled for this window, skip
        if (triggeredSlugs.has(slug)) continue

        // 1. Determine open price for this market window
        let openPrice = marketOpenPrices.get(slug)
        if (!openPrice) {
          // Check historical ticks around startTs
          openPrice = findHistoricalTwap(asset, windowSec, startTs)
          if (!openPrice) {
            // If historical tick not found, use current effective TWAP if we are near market start
            openPrice = getEffectiveTwap(asset, duration)
          }

          if (openPrice && openPrice > 0) {
            marketOpenPrices.set(slug, openPrice)
            console.log(`[twap-threshold] 📌 [${slug}] Registered Open Price: $${openPrice.toFixed(4)} (Threshold: ±${threshold}%)`)
          }
        }

        if (!openPrice || openPrice <= 0) continue

        // 2. Get current live TWAP
        const currentTwap = getEffectiveTwap(asset, duration)
        if (!currentTwap || currentTwap <= 0) continue

        // 3. Compute absolute percentage delta against open price
        const deltaPercent = Math.abs((currentTwap - openPrice) / openPrice) * 100

        // 4. Check if delta exceeds threshold
        if (deltaPercent >= threshold) {
          triggeredSlugs.add(slug)

          console.log(`\n═══════════════════════════════════════════════════════════════════`)
          console.log(`[twap-threshold] 🚨 BREACH DETECTED for [${slug}]!`)
          console.log(`  Current TWAP: $${currentTwap.toFixed(4)}`)
          console.log(`  Open Price:   $${openPrice.toFixed(4)}`)
          console.log(`  Delta:        ${deltaPercent.toFixed(4)}% >= Threshold: ${threshold}%`)
          console.log(`  Action:       Canceling ALL open orders for market...`)
          console.log(`═══════════════════════════════════════════════════════════════════`)

          try {
            const market = await lookupMarket(slug, lookupMarketBySlug)
            if (!market) {
              console.warn(`[twap-threshold] Could not resolve market conditionId for ${slug}`)
              continue
            }

            const orders = await fetchOpenOrdersForMarket(market.conditionId, wallet, creds)
            if (orders.length === 0) {
              console.log(`[twap-threshold] [${slug}] 0 open orders found.`)
              continue
            }

            const ids = orders.map(o => o.id)
            for (let i = 0; i < ids.length; i += 2000) {
              await clobClient.cancelOrders(ids.slice(i, i + 2000))
            }
            console.log(`[twap-threshold] ✓ [${slug}] Successfully canceled all ${ids.length} open order(s)!`)
          } catch (cancelErr) {
            console.error(`[twap-threshold] Error canceling orders for ${slug}: ${cancelErr.message}`)
          }
        }
      }
    }
  }

  // Periodic cleanup of expired market state (markets that ended > 60s ago)
  for (const [slug] of marketOpenPrices.entries()) {
    const parts = slug.split('-')
    const startTs = parseInt(parts[parts.length - 1], 10)
    const duration = parts[2]
    const durationSec = duration === '5m' ? 300 : 900
    if (!isNaN(startTs) && nowSec >= startTs + durationSec + 60) {
      marketOpenPrices.delete(slug)
      triggeredSlugs.delete(slug)
      marketCache.delete(slug)
    }
  }
}

// ─── WebSocket Client for Polymarket RTDS ────────────────────────────────────
let rtdsWs = null
let pingInterval = null
let reconnectTimeout = null
let checkInterval = null
let isShuttingDown = false

export function startTwapWatcher({
  clobClient,
  wallet,
  creds,
  lookupMarketBySlug,
  assets = DEFAULT_ASSETS,
  durations = DEFAULT_DURATIONS,
}) {
  // Check if any threshold is configured
  const configuredAssets = assets.filter(a => getThreshold(a) !== null)
  if (configuredAssets.length === 0) {
    console.log("[twap-threshold] No CANCEL_THRES_* variables configured. Watcher inactive.")
    return { stop: () => {} }
  }

  console.log(`[twap-threshold] 🚀 Initializing TWAP Threshold Watcher...`)
  for (const a of configuredAssets) {
    console.log(`  └─ ${a.toUpperCase()}: threshold = ${getThreshold(a)}%`)
  }

  const effectiveCreds = creds || clobClient.creds

  function connect() {
    if (isShuttingDown) return

    if (rtdsWs) {
      rtdsWs.removeAllListeners()
      rtdsWs.terminate()
      rtdsWs = null
    }
    if (pingInterval) clearInterval(pingInterval)

    rtdsWs = new WebSocket(RTDS_WS_URL, {
      lookup: customDohLookup,
      servername: 'ws-live-data.polymarket.com',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://polymarket.com',
      },
    })

    rtdsWs.on('open', () => {
      console.log('[twap-threshold] Connected to Polymarket RTDS WebSocket.')
      const subMsg = {
        action: 'subscribe',
        subscriptions: [
          { topic: 'crypto_prices_twap_thirty', type: 'update' },
          { topic: 'crypto_prices_twap_sixty', type: 'update' },
          { topic: 'crypto_prices_chainlink', type: 'update' },
        ],
      }
      rtdsWs.send(JSON.stringify(subMsg))

      // Keepalive PING every 5 seconds (Polymarket RTDS requires plain text "ping")
      pingInterval = setInterval(() => {
        if (rtdsWs && rtdsWs.readyState === WebSocket.OPEN) {
          rtdsWs.send('ping')
        }
      }, 5000)
    })

    rtdsWs.on('message', (data) => {
      const text = data.toString()
      const clean = text.trim().toLowerCase()
      if (clean === 'pong' || clean === 'ping' || !clean) return

      try {
        const msg = JSON.parse(text)
        const topic = msg.topic
        if (!topic) return

        let window = 0
        if (topic.includes('twap_thirty')) window = 30
        else if (topic.includes('twap_sixty')) window = 60
        else if (topic.includes('chainlink')) window = 0
        else return

        const payload = msg.payload
        if (!payload) return

        const items = Array.isArray(payload) ? payload : (Array.isArray(payload.data) ? payload.data : [payload])

        for (const item of items) {
          if (!item || typeof item !== 'object') continue
          const rawSym = (item.symbol || '').toUpperCase()
          if (!rawSym) continue

          const baseSym = rawSym
            .replace(/\/USD$/, '')
            .replace(/USDT$/, '')
            .replace(/-USD$/, '')
            .replace(/\/USDT$/, '')
            .toLowerCase()

          if (!assets.includes(baseSym)) continue

          const val = item.value
          if (val === null || val === undefined) continue
          const valFloat = parseFloat(val)
          if (isNaN(valFloat)) continue

          const tsMs = item.timestamp || msg.timestamp || Date.now()
          recordTwapTick(baseSym, window, valFloat, tsMs)
        }
      } catch (e) {
        // Ignore unparseable non-JSON messages
      }
    })

    rtdsWs.on('error', (err) => {
      if (!isShuttingDown) console.warn(`[twap-threshold] RTDS WS error: ${err.message}`)
    })

    rtdsWs.on('close', (code, reason) => {
      if (pingInterval) clearInterval(pingInterval)
      if (!isShuttingDown) {
        console.log(`[twap-threshold] RTDS WS disconnected (${code}). Reconnecting in 3s...`)
        reconnectTimeout = setTimeout(connect, 3000)
      }
    })
  }

  connect()

  // High-frequency threshold checker (evaluates every 1 second)
  checkInterval = setInterval(() => {
    checkThresholdsForActiveMarkets({
      clobClient,
      wallet,
      creds: effectiveCreds,
      lookupMarketBySlug,
      assets,
      durations,
    }).catch(err => console.error(`[twap-threshold] Check loop error: ${err.message}`))
  }, 1000)

  return {
    stop: () => {
      isShuttingDown = true
      if (pingInterval) clearInterval(pingInterval)
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
      if (checkInterval) clearInterval(checkInterval)
      if (rtdsWs) rtdsWs.close()
    },
  }
}

// ─── Standalone CLI Runner ───────────────────────────────────────────────────
import { fileURLToPath } from 'url'
import { Wallet } from 'ethers'
import { ClobClient } from '@polymarket/clob-client'

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS || ''

  if (!PRIVATE_KEY) {
    console.error("Missing PRIVATE_KEY")
    process.exit(1)
  }

  const wallet = new Wallet(PRIVATE_KEY)
  const SIGNER_ADDRESS = wallet.address
  const SIGNATURE_TYPE = FUNDER_ADDRESS && SIGNER_ADDRESS.toLowerCase() !== FUNDER_ADDRESS.toLowerCase() ? 1 : 0

  async function runStandalone() {
    console.log("PM Sizer — Real-Time TWAP Threshold Watcher (Standalone)")
    console.log(`Signer: ${SIGNER_ADDRESS}`)

    let creds = null
    if (process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_API_PASSPHRASE) {
      creds = {
        key: process.env.POLY_API_KEY,
        secret: process.env.POLY_API_SECRET,
        passphrase: process.env.POLY_API_PASSPHRASE,
      }
    }

    let client = new ClobClient("https://clob.polymarket.com", 137, wallet, creds || undefined, SIGNATURE_TYPE, FUNDER_ADDRESS || undefined)

    if (!creds) {
      console.log("Deriving credentials via wallet...")
      creds = await client.createOrDeriveApiKey()
      client = new ClobClient("https://clob.polymarket.com", 137, wallet, creds, SIGNATURE_TYPE, FUNDER_ADDRESS || undefined)
    }

    const { lookupMarketBySlug } = await import('./cleanup.js').catch(() => ({ lookupMarketBySlug: null }))

    const ASSETS = (process.env.ASSETS || 'eth,btc,sol,xrp,doge,bnb,hype').split(',').map(s => s.trim()).filter(Boolean)
    const DURATIONS = ['5m', '15m']

    const watcher = startTwapWatcher({
      clobClient: client,
      wallet,
      creds,
      lookupMarketBySlug,
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

  runStandalone().catch(err => {
    console.error("[twap-threshold] Fatal:", err)
    process.exit(1)
  })
}
