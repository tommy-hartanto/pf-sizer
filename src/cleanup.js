import 'dotenv/config'
import { ClobClient, createL2Headers } from '@polymarket/clob-client'
import { Wallet } from 'ethers'
import { request } from 'undici'
import { startWatcher } from './fill-watcher.js'
import { startTwapWatcher, isTwapThresholdBreached, getThreshold } from './twap-watcher.js'


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

// Tuning constants
const SIZING_WINDOW_MS = 301000          // 5 minutes + 1 second

// Asset & duration configuration
const ASSETS = (process.env.ASSETS || 'eth,btc,sol,xrp,doge,bnb,hype').split(',').map(s => s.trim()).filter(Boolean)
const DURATIONS = ['5m', '15m']
const DELETE_ALL_ORDERS = process.env.DELETE_ALL_ORDERS === 'true'
const DELETE_ALL_SLUGS = (process.env.DELETE_ALL_SLUGS || '').split(',').map(s => s.trim()).filter(Boolean)
const DELETE_ALL_PRICES = (process.env.DELETE_ALL_PRICES || '').split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => !isNaN(n))
const DELETE_ALL_SIZES = (process.env.DELETE_ALL_SIZES || '').split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => !isNaN(n))
const CANCEL_BEFORE_END_SECONDS = Math.max(0, parseInt(process.env.CANCEL_BEFORE_END_SECONDS || '0', 10) || 0)

// Pre-parse POST_HOURS into a structure
const POST_HOURS = {} // POST_HOURS[asset][duration] = Set of allowed 'HH:MM'
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
      POST_HOURS[asset][duration] = null // null means allow all
    }
  }
}

// Generate all market slugs for 5-minute boundaries within the sizing window
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

// Look up a single market by slug via the Gamma API
// Returns { conditionId, tokens, slug } or null
export async function lookupMarketBySlug(slug) {
  let retries = 3
  while (retries > 0) {
    try {
      const res = await request(`https://gamma-api.polymarket.com/markets?slug=${slug}`)
      if (res.statusCode === 200) {
        const data = await res.body.json()
        // Gamma returns an array; take first match
        const market = Array.isArray(data) ? data[0] : data
        if (!market || !market.conditionId) return null
        // Extract token IDs from clobTokenIds (array, camelCase from Gamma API)
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
      await res.body.text() // consume body
      if (res.statusCode === 429) {
        await new Promise(r => setTimeout(r, 1500))
        retries--
      } else {
        return null // 404 or other — slug doesn't exist
      }
    } catch {
      retries--
      if (retries > 0) await new Promise(r => setTimeout(r, 1000))
    }
  }
  return null
}

let sharedClobClient = null

async function initSharedClobClient() {
  if (sharedClobClient) return;

  const SIGNATURE_TYPE = FUNDER_ADDRESS && SIGNER_ADDRESS.toLowerCase() !== FUNDER_ADDRESS.toLowerCase() ? 1 : 0;

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
    console.log("No CLOB API keys found. Deriving credentials via wallet...")
    creds = await client.createOrDeriveApiKey()
    client = new ClobClient("https://clob.polymarket.com", 137, wallet, creds, SIGNATURE_TYPE, FUNDER_ADDRESS || undefined)
  }

  const keysResp = await client.getApiKeys().catch(e => e)
  if (keysResp && (keysResp.error || keysResp instanceof Error)) {
    console.error("API Key Error:", keysResp.error || keysResp.message)
    console.log("Trying to derive new credentials...")
    creds = await client.createOrDeriveApiKey()
    client = new ClobClient("https://clob.polymarket.com", 137, wallet, creds, SIGNATURE_TYPE, FUNDER_ADDRESS || undefined)
  }

  sharedClobClient = client;
}

const scheduledExpirySlugs = new Set()

function schedulePreExpiryTimers() {
  const nowSec = Math.floor(Date.now() / 1000)

  for (const asset of ASSETS) {
    for (const duration of DURATIONS) {
      const durationSec = duration === '5m' ? 300 : 900
      const intervals = durationSec / 300  // 1 for 5m, 3 for 15m

      // Scan boundaries: from earliest currently-running market
      // to markets starting within the next 20 minutes
      const currentBoundary = Math.floor(nowSec / 300) * 300
      const startFrom = currentBoundary - ((intervals - 1) * 300)
      const startTo = currentBoundary + 1200  // +20 min of future boundaries

      for (let startTs = startFrom; startTs <= startTo; startTs += 300) {
        const endTime = startTs + durationSec
        const cancelAtSec = endTime - CANCEL_BEFORE_END_SECONDS
        
        // Skip if cancel time already passed or market already ended
        if (cancelAtSec <= nowSec) continue
        
        const slug = `${asset}-updown-${duration}-${startTs}`
        if (scheduledExpirySlugs.has(slug)) continue

        // Schedule precise setTimeout
        const delayMs = (cancelAtSec * 1000) - Date.now()
        scheduledExpirySlugs.add(slug)

        setTimeout(async () => {
          try {
            const market = await lookupMarketBySlug(slug)
            if (!market) return

            const l2Args = { method: 'GET', requestPath: '/data/orders' }
            const hdrs = await createL2Headers(wallet, sharedClobClient.creds, l2Args)
            const ordersRes = await request(
              `https://clob.polymarket.com/data/orders?market=${market.conditionId}`,
              { method: 'GET', headers: hdrs, headersTimeout: 10000, bodyTimeout: 10000 }
            )
            const ordersJson = ordersRes.statusCode === 200 ? await ordersRes.body.json() : (await ordersRes.body.text(), [])
            const orders = Array.isArray(ordersJson) ? ordersJson : (ordersJson?.data || [])
            if (orders.length === 0) return

            const ids = orders.map(o => o.id)
            for (let i = 0; i < ids.length; i += 2000) {
              await sharedClobClient.cancelOrders(ids.slice(i, i + 2000))
            }
            console.log(`\n[pre-expiry] ✓ [${slug}] Canceled ${ids.length} order(s) at T-${CANCEL_BEFORE_END_SECONDS}s`)
          } catch (err) {
            console.error(`\n[pre-expiry] Error for ${slug}: ${err.message}`)
          } finally {
            scheduledExpirySlugs.delete(slug) // allow re-schedule if needed
          }
        }, delayMs)
      }
    }
  }
}

function startPreExpiryWatcher() {
  if (CANCEL_BEFORE_END_SECONDS <= 0) return
  console.log(`[pre-expiry] Watcher active: canceling orders exactly ${CANCEL_BEFORE_END_SECONDS}s before market end`)
  
  schedulePreExpiryTimers()                          // schedule immediately
  setInterval(schedulePreExpiryTimers, 60_000)       // refresh every 60s to pick up new markets
}

async function runCleanup() {
  console.log(`\n════════════════════════════════════════`)
  console.log(`Cleanup cycle at ${new Date().toISOString()}`)
  if (DELETE_ALL_ORDERS) {
    console.log(`⚠️  WARNING: DELETE_ALL_ORDERS is set to true. ALL open orders for immediate markets will be canceled!`)
  }
  console.log(`════════════════════════════════════════`)

  // --- Step 1: Initialize CLOB Client ---
  try {
    await initSharedClobClient()
  } catch (error) {
    console.error("Failed to initialize CLOB client:", error.message)
    return
  }
  const clobClient = sharedClobClient;


  // --- Step 2: Generate Upcoming Slugs ---
  const { slugs, timestamps } = generateUpcomingSlugs()
  const tsLabels = timestamps.map(ts => {
    const d = new Date(ts * 1000)
    return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`
  }).join(', ')
  console.log(`\nAssets: ${ASSETS.join(', ')}`)
  console.log(`Durations: ${DURATIONS.join(', ')}`)
  console.log(`Timestamps: ${tsLabels} UTC (${timestamps.join(', ')})`)
  console.log(`Generated ${slugs.length} slugs to check`)

  // --- Step 3: Look Up Slugs via Gamma API ---
  console.log(`\nLooking up markets...`)
  const foundMarkets = []

  for (const slug of slugs) {
    const result = await lookupMarketBySlug(slug)
    if (result) {
      foundMarkets.push(result)
      console.log(`  ✓ ${slug} → ${result.conditionId.slice(0, 12)}...`)
    }
  }

  if (foundMarkets.length === 0) {
    console.log(`No matching markets found. Nothing to size.`)
    return
  }

  console.log(`\nFound ${foundMarkets.length} active market(s)`)

  // --- Step 4: Fetch Orders & Apply Sizing ---
  const sizingToCancel = []

  // Helper: check if a slug should have ALL orders deleted
  const shouldDeleteAll = (slug) => {
    if (DELETE_ALL_ORDERS) return true
    if (DELETE_ALL_SLUGS.some(pattern => slug.includes(pattern))) return true
    if (isTwapThresholdBreached(slug)) return true
    
    // Check POST_HOURS
    const parts = slug.split('-')
    if (parts.length >= 4) {
      const asset = parts[0]
      const duration = parts[2]
      const tsStr = parts.pop() // The timestamp is the last part
      const ts = parseInt(tsStr, 10)
      if (!isNaN(ts) && POST_HOURS[asset] && POST_HOURS[asset][duration] !== undefined) {
        const allowedSet = POST_HOURS[asset][duration]
        if (allowedSet !== null) {
          const d = new Date(ts * 1000)
          const hh = d.getUTCHours().toString().padStart(2, '0')
          const mm = d.getUTCMinutes().toString().padStart(2, '0')
          const timeStr = `${hh}:${mm}`
          if (!allowedSet.has(timeStr)) {
            return true // Not in allowed times, so delete all orders
          }
        }
      }
    }
    
    return false
  }

  if (DELETE_ALL_ORDERS) {
    console.log(`\n--- Precautionary: Canceling all open orders for immediate markets ---`)
  } else if (DELETE_ALL_SLUGS.length > 0) {
    console.log(`\n--- Sizing: Delete-all for slugs matching [${DELETE_ALL_SLUGS.join(', ')}]; keep oldest pair per price for the rest ---`)
  } else {
    console.log(`\n--- Sizing: Keep oldest order pair per (outcome, price) for all markets ---`)
  }
  if (DELETE_ALL_PRICES.length > 0) {
    console.log(`    Also deleting ALL orders at price(s): ${DELETE_ALL_PRICES.join(', ')}`);
  }

  for (const market of foundMarkets) {
    let orders = []
    try {
      const l2HeaderArgs = { method: 'GET', requestPath: '/data/orders' }
      const headers = await createL2Headers(wallet, sharedClobClient.creds, l2HeaderArgs)
      const res = await request(
        `https://clob.polymarket.com/data/orders?market=${market.conditionId}`,
        { method: 'GET', headers, headersTimeout: 10000, bodyTimeout: 10000 }
      )
      if (res.statusCode === 200) {
        const json = await res.body.json()
        orders = Array.isArray(json) ? json : (json?.data || [])
      } else {
        const errBody = await res.body.text()
        console.error(`  [${market.slug}] HTTP ${res.statusCode} fetching orders: ${errBody}`)
        continue
      }
    } catch (e) {
      console.error(`  Error fetching orders for ${market.slug}: ${e.message}`)
      continue
    }

    if (orders.length === 0) {
      console.log(`  ${market.slug}: no open orders`)
      continue
    }

    // Per-market decision: delete all vs keep oldest
    if (shouldDeleteAll(market.slug)) {
      const toCancel = orders.map(o => o.id)
      sizingToCancel.push(...toCancel)
      console.log(`  [${market.slug}] ${orders.length} orders found. All scheduled for cancellation.`)
      continue
    }

    // Group orders by asset_id (Up vs Down)
    const assetGroups = {}
    for (const order of orders) {
      if (!assetGroups[order.asset_id]) assetGroups[order.asset_id] = []
      assetGroups[order.asset_id].push(order)
    }

    // Reverse each group so oldest first (API returns newest first)
    for (const groupOrders of Object.values(assetGroups)) {
      groupOrders.reverse()
    }

    console.log(`\n  [${market.slug}] ${orders.length} orders across ${Object.keys(assetGroups).length} outcomes`)

    for (const [assetId, assetOrders] of Object.entries(assetGroups)) {
      // Sub-group by price within each outcome
      const priceGroups = {}
      for (const order of assetOrders) {
        const priceKey = parseFloat(order.price).toString()
        if (!priceGroups[priceKey]) priceGroups[priceKey] = []
        priceGroups[priceKey].push(order)
      }

      const priceKeys = Object.keys(priceGroups)
      for (const priceKey of priceKeys) {
        const priceOrders = priceGroups[priceKey]
        const price = parseFloat(priceKey)

        // If this price is in DELETE_ALL_PRICES, cancel everything at this price
        if (DELETE_ALL_PRICES.length > 0 && DELETE_ALL_PRICES.includes(price)) {
          const toCancel = priceOrders.map(o => o.id)
          sizingToCancel.push(...toCancel)
          console.log(`    └─ ${assetId.slice(0, 12)}... @ price=${price}: deleting ALL ${toCancel.length} orders (DELETE_ALL_PRICES)`)
          continue
        }

        // Delete orders with specific sizes before picking the oldest
        let validOrders = []
        for (const order of priceOrders) {
          const size = parseFloat(order.original_size || order.size)
          if (DELETE_ALL_SIZES.length > 0 && DELETE_ALL_SIZES.includes(size)) {
            sizingToCancel.push(order.id)
            console.log(`    └─ ${assetId.slice(0, 12)}... @ price=${price}: deleting order id=${order.id.slice(0, 8)}... (size=${size}) (DELETE_ALL_SIZES)`)
          } else {
            validOrders.push(order)
          }
        }

        if (validOrders.length <= 1) {
          if (validOrders.length === 1) {
            const size = parseFloat(validOrders[0].original_size || validOrders[0].size)
            console.log(`    └─ ${assetId.slice(0, 12)}... @ price=${price}: only 1 order (size=${size}), keeping as-is`)
          } else {
            console.log(`    └─ ${assetId.slice(0, 12)}... @ price=${price}: no valid orders remaining after size filtering`)
          }
          continue
        }

        // Keep the first (oldest) valid order at this price, cancel all newer ones
        const kept = validOrders[0]
        const toCancel = validOrders.slice(1).map(o => o.id)
        sizingToCancel.push(...toCancel)

        const keptSize = parseFloat(kept.original_size || kept.size)
        console.log(`    └─ ${assetId.slice(0, 12)}... @ price=${price}: keeping oldest (size=${keptSize}), canceling ${toCancel.length}`)
      }
    }
  }

  // --- Step 5: Execute Cancellations ---
  if (sizingToCancel.length > 0 && clobClient) {
    console.log(`\nCanceling ${sizingToCancel.length} excess orders...`)
    try {
      for (let i = 0; i < sizingToCancel.length; i += 2000) {
        const batch = sizingToCancel.slice(i, i + 2000)
        await clobClient.cancelOrders(batch)
      }
      console.log("Cancellation complete.")
    } catch (cancelErr) {
      console.error("Cancellation error:", cancelErr.message)
    }
  } else {
    console.log("\nNo sizing adjustments needed.")
  }

  console.log(`Cleanup finished at ${new Date().toISOString()}`)
}

async function start() {
  console.log("PM Sizer — Proactive Slug-Based Sizing")
  console.log(`Signer: ${SIGNER_ADDRESS}`)
  console.log(`Assets: ${ASSETS.join(', ')}`)
  console.log(`Durations: ${DURATIONS.join(', ')}`)
  console.log(`Delete All Orders Toggle: ${DELETE_ALL_ORDERS}`)
  console.log(`Delete All Slugs: ${DELETE_ALL_SLUGS.length > 0 ? DELETE_ALL_SLUGS.join(', ') : '(none)'}`)
  console.log(`Delete All Prices: ${DELETE_ALL_PRICES.length > 0 ? DELETE_ALL_PRICES.join(', ') : '(none)'}`)
  console.log(`Delete All Sizes: ${DELETE_ALL_SIZES.length > 0 ? DELETE_ALL_SIZES.join(', ') : '(none)'}`)
  console.log(`Cancel Before End: ${CANCEL_BEFORE_END_SECONDS > 0 ? CANCEL_BEFORE_END_SECONDS + 's' : 'disabled'}`)
  const configuredThres = ASSETS.map(a => {
    const t = getThreshold(a)
    return t !== null ? `${a.toUpperCase()}: ±${t}%` : null
  }).filter(Boolean)
  console.log(`TWAP Thresholds: ${configuredThres.length > 0 ? configuredThres.join(', ') : 'disabled'}`)

  try {
    await initSharedClobClient()
  } catch (err) {
    console.error("Failed to initialize CLOB client on startup:", err.message)
    process.exit(1)
  }

  startPreExpiryWatcher()

  const hasTwapThresholds = ASSETS.some(a => getThreshold(a) !== null)
  if (hasTwapThresholds) {
    startTwapWatcher({
      clobClient: sharedClobClient,
      wallet,
      creds: sharedClobClient.creds,
      lookupMarketBySlug,
      assets: ASSETS,
      durations: DURATIONS,
    })
  }

  if (process.env.CANCEL_OPPOSITE_ON_FILL === 'true') {
    startWatcher().catch(err => console.error("Watcher error:", err))
  }

  while (true) {
    const startTime = Date.now();
    try {
      await runCleanup()
    } catch (err) {
      console.error("Unhandled error in runCleanup:", err)
    }
    const executionTime = Date.now() - startTime;
    const waitMs = Math.max(0, 300000 - executionTime); // 5 minutes minus execution time
    console.log(`\nNext run in ${Math.floor(waitMs / 1000 / 60)}m ${Math.floor((waitMs / 1000) % 60)}s...\n`)
    await new Promise(resolve => setTimeout(resolve, waitMs))
  }
}

start()
