import 'dotenv/config'
import { Wallet, hashMessage, keccak256, concat, AbiCoder, getBytes, TypedDataEncoder } from 'ethers'
import { request } from 'undici'

// ─── Environment & Wallet Setup ──────────────────────────────────────────────
const PRIVATE_KEY = process.env.PREDICT_PRIVATE_KEY || process.env.PRIVATE_KEY
const FUNDER_ADDRESS = process.env.PREDICT_ACCOUNT_ADDRESS || process.env.FUNDER_ADDRESS || ''
export const API_KEY = process.env.PREDICT_API_KEY || ''
export const CHAIN_ID = parseInt(process.env.PREDICT_CHAIN_ID || '56', 10)
export const EXCHANGE_ADDRESS = process.env.PREDICT_EXCHANGE_ADDRESS || '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689'
export const BASE_URL = 'https://api.predict.fun/v1'
export const WS_URL = 'wss://ws.predict.fun/ws'

if (!PRIVATE_KEY) {
  console.error("Missing PREDICT_PRIVATE_KEY or PRIVATE_KEY in environment.")
  process.exit(1)
}

// Derive addresses
export const wallet = new Wallet(PRIVATE_KEY)
export const SIGNER_ADDRESS = wallet.address
export const MAKER_ADDRESS = FUNDER_ADDRESS || SIGNER_ADDRESS
export const IS_KERNEL = FUNDER_ADDRESS ? SIGNER_ADDRESS.toLowerCase() !== FUNDER_ADDRESS.toLowerCase() : false

let cachedJwt = null
let jwtExpiresAt = 0

// ─── Authentication & JWT Management ─────────────────────────────────────────

export async function getAuthMessage() {
  const url = `${BASE_URL}/auth/message?address=${MAKER_ADDRESS}`
  const headers = {}
  if (API_KEY) headers['x-api-key'] = API_KEY

  const res = await request(url, { headers, headersTimeout: 10000, bodyTimeout: 10000 })
  if (res.statusCode !== 200) {
    const errText = await res.body.text()
    throw new Error(`Failed to get auth message (${res.statusCode}): ${errText}`)
  }

  const json = await res.body.json()
  const message = json?.data?.message || json?.data || json?.message
  if (!message) throw new Error(`Invalid auth message response: ${JSON.stringify(json)}`)
  return message
}

export async function signAuthMessage(message) {
  if (IS_KERNEL) {
    const messageHash = hashMessage(message)
    const kernelDomain = {
      name: "Kernel",
      version: "0.3.1",
      chainId: CHAIN_ID,
      verifyingContract: MAKER_ADDRESS
    }
    const domainSeparator = TypedDataEncoder.hashDomain(kernelDomain)
    const abiCoder = AbiCoder.defaultAbiCoder()
    const encoder = new TextEncoder()
    const kernelTypeHash = keccak256(encoder.encode("Kernel(bytes32 hash)"))
    const finalMessageHash = keccak256(abiCoder.encode(["bytes32", "bytes32"], [kernelTypeHash, messageHash]))
    const digest = keccak256(concat(["0x1901", domainSeparator, finalMessageHash]))
    const digestBytes = getBytes(digest)
    const signedMessage = await wallet.signMessage(digestBytes)
    const ECDSA_VALIDATOR = "0x845adb2c711129d4f3966735ed98a9f09fc4ce57"
    return concat(["0x01", ECDSA_VALIDATOR, signedMessage])
  } else {
    return await wallet.signMessage(message)
  }
}

export async function authenticate() {
  const message = await getAuthMessage()
  const signature = await signAuthMessage(message)

  const url = `${BASE_URL}/auth`
  const headers = {
    'content-type': 'application/json',
    ...(API_KEY ? { 'x-api-key': API_KEY } : {})
  }

  const res = await request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      signer: MAKER_ADDRESS,
      message,
      signature
    }),
    headersTimeout: 10000,
    bodyTimeout: 10000
  })

  if (res.statusCode !== 200) {
    const errText = await res.body.text()
    throw new Error(`Authentication failed (${res.statusCode}): ${errText}`)
  }

  const json = await res.body.json()
  const token = json?.data?.token || json?.data
  if (!token) throw new Error(`JWT token missing in auth response: ${JSON.stringify(json)}`)

  cachedJwt = token
  // JWT expires in 24 hours; refresh safely 1 hour prior (23 hours from now)
  jwtExpiresAt = Date.now() + 23 * 3600 * 1000
  return token
}

export async function getJwtToken() {
  if (cachedJwt && Date.now() < jwtExpiresAt) {
    return cachedJwt
  }
  return await authenticate()
}

// ─── Market Lookup & Cache ───────────────────────────────────────────────────

const marketCache = new Map() // slug or marketId -> market info

export async function lookupMarketBySlug(slug) {
  if (marketCache.has(slug)) return marketCache.get(slug)

  let retries = 3
  while (retries > 0) {
    try {
      const url = `${BASE_URL}/categories/${slug}`
      const headers = {
        'accept': 'application/json',
        ...(API_KEY ? { 'x-api-key': API_KEY } : {})
      }
      const res = await request(url, { headers, headersTimeout: 10000, bodyTimeout: 10000 })

      if (res.statusCode === 200) {
        const json = await res.body.json()
        const cat = json?.data
        if (!cat || !cat.markets || cat.markets.length === 0) return null

        const m = cat.markets[0]
        const outcomesList = m.outcomes || []
        const upOutcome = outcomesList.find(o => (o.name || '').toLowerCase() === 'up') || outcomesList[0]
        const downOutcome = outcomesList.find(o => (o.name || '').toLowerCase() === 'down') || outcomesList[1]

        const info = {
          slug: cat.slug || slug,
          categorySlug: cat.slug || slug,
          marketId: m.id,
          conditionId: m.conditionId || '',
          question: cat.title || m.title || m.question || slug,
          startsAt: cat.startsAt || m.createdAt,
          endsAt: cat.endsAt,
          tradingStatus: m.tradingStatus || 'OPEN',
          upTokenId: upOutcome?.onChainId || '',
          downTokenId: downOutcome?.onChainId || '',
          outcomes: outcomesList.map(o => ({
            name: o.name,
            onChainId: o.onChainId
          })),
          tokens: outcomesList.map(o => o.onChainId).filter(Boolean),
          variantData: m.variantData || cat.variantData
        }

        marketCache.set(slug, info)
        if (m.id) marketCache.set(String(m.id), info)
        return info
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

export async function getMarketById(marketId) {
  const idStr = String(marketId)
  if (marketCache.has(idStr)) return marketCache.get(idStr)

  let retries = 3
  while (retries > 0) {
    try {
      const url = `${BASE_URL}/markets/${idStr}`
      const headers = {
        'accept': 'application/json',
        ...(API_KEY ? { 'x-api-key': API_KEY } : {})
      }
      const res = await request(url, { headers, headersTimeout: 10000, bodyTimeout: 10000 })

      if (res.statusCode === 200) {
        const json = await res.body.json()
        const m = json?.data
        if (!m) return null

        const outcomesList = m.outcomes || []
        const upOutcome = outcomesList.find(o => (o.name || '').toLowerCase() === 'up') || outcomesList[0]
        const downOutcome = outcomesList.find(o => (o.name || '').toLowerCase() === 'down') || outcomesList[1]

        const info = {
          slug: m.categorySlug || idStr,
          categorySlug: m.categorySlug || idStr,
          marketId: m.id,
          conditionId: m.conditionId || '',
          question: m.question || m.title || idStr,
          tradingStatus: m.tradingStatus || 'OPEN',
          upTokenId: upOutcome?.onChainId || '',
          downTokenId: downOutcome?.onChainId || '',
          outcomes: outcomesList.map(o => ({
            name: o.name,
            onChainId: o.onChainId
          })),
          tokens: outcomesList.map(o => o.onChainId).filter(Boolean),
          variantData: m.variantData
        }

        marketCache.set(idStr, info)
        if (m.categorySlug) marketCache.set(m.categorySlug, info)
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

  const fallback = {
    slug: idStr,
    categorySlug: idStr,
    marketId,
    conditionId: '',
    question: `Market ${idStr}`,
    tradingStatus: 'UNKNOWN',
    upTokenId: '',
    downTokenId: '',
    outcomes: [],
    tokens: []
  }
  marketCache.set(idStr, fallback)
  return fallback
}

// ─── Fetch All Open Orders ───────────────────────────────────────────────────

export async function fetchAllOpenOrders() {
  const allOrders = []
  let cursor = null
  let hasMore = true
  let attempts = 3

  while (hasMore && attempts > 0) {
    try {
      const jwt = await getJwtToken()
      let url = `${BASE_URL}/orders?first=150&status=OPEN`
      if (cursor) url += `&after=${encodeURIComponent(cursor)}`

      const headers = {
        'authorization': `Bearer ${jwt}`,
        ...(API_KEY ? { 'x-api-key': API_KEY } : {})
      }

      const res = await request(url, { headers, headersTimeout: 10000, bodyTimeout: 10000 })

      if (res.statusCode === 200) {
        const json = await res.body.json()
        const items = json?.data || []
        allOrders.push(...items)

        if (json?.cursor && items.length > 0) {
          cursor = json.cursor
        } else {
          hasMore = false
        }
        attempts = 3 // reset attempts on successful page
      } else if (res.statusCode === 401) {
        console.warn("[Predict.fun] 401 Unauthorized fetching orders. Refreshing JWT token...")
        cachedJwt = null
        await authenticate()
        attempts--
      } else if (res.statusCode === 429) {
        console.warn("[Predict.fun] 429 Rate limit on orders. Backing off 2s...")
        await new Promise(r => setTimeout(r, 2000))
        attempts--
      } else {
        const errText = await res.body.text()
        console.warn(`[Predict.fun] HTTP ${res.statusCode} on getOrders: ${errText}`)
        attempts--
        await new Promise(r => setTimeout(r, 1000))
      }
    } catch (err) {
      console.warn(`[Predict.fun] Fetch open orders error: ${err.message}`)
      attempts--
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  return allOrders
}

// ─── Cancel Orders (Remove from Orderbook) ────────────────────────────────────

export async function cancelOrders(orderIds) {
  if (!orderIds || orderIds.length === 0) return { success: true, removed: [] }

  const uniqueIds = [...new Set(orderIds.map(String))].filter(Boolean)
  let removedCount = 0

  // Batch into chunks of up to 50 IDs per request
  for (let i = 0; i < uniqueIds.length; i += 50) {
    const batch = uniqueIds.slice(i, i + 50)
    let retries = 3

    while (retries > 0) {
      try {
        const jwt = await getJwtToken()
        const url = `${BASE_URL}/orders/remove`
        const headers = {
          'authorization': `Bearer ${jwt}`,
          'content-type': 'application/json',
          ...(API_KEY ? { 'x-api-key': API_KEY } : {})
        }

        const res = await request(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ data: { ids: batch } }),
          headersTimeout: 10000,
          bodyTimeout: 10000
        })

        if (res.statusCode === 200) {
          const json = await res.body.json()
          const removed = Array.isArray(json?.removed) ? json.removed : []
          const noop = Array.isArray(json?.noop) ? json.noop : []
          const rejected = Array.isArray(json?.rejected) ? json.rejected : []
          removedCount += removed.length

          if (noop.length > 0 || rejected.length > 0) {
            console.warn(`[Predict.fun] Cancel batch result: ${removed.length} removed, ${noop.length} noop (already filled/closed), ${rejected.length} rejected`)
          }
          break
        }

        if (res.statusCode === 401) {
          const errText = await res.body.text()
          if (errText.includes('belong to this wallet') || errText.includes('invalid')) {
            console.warn(`[Predict.fun] Order cancel rejected (ownership): ${errText}`)
            break
          }
          cachedJwt = null
          await authenticate()
          retries--
          continue
        }

        const errText = await res.body.text()
        console.warn(`[Predict.fun] HTTP ${res.statusCode} on remove orders: ${errText}`)
        retries--
        if (retries > 0) await new Promise(r => setTimeout(r, 1000))
      } catch (err) {
        console.error(`[Predict.fun] Error removing orders: ${err.message}`)
        retries--
        if (retries > 0) await new Promise(r => setTimeout(r, 1000))
      }
    }
  }

  return { success: true, removedCount }
}
