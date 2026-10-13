import 'dotenv/config'
import {
  SIGNER_ADDRESS,
  MAKER_ADDRESS,
  IS_KERNEL,
  CHAIN_ID,
  authenticate,
  fetchAllOpenOrders,
  getMarketById
} from './predict-client.js'

async function runFetch() {
  console.log(`\n══════════════════════════════════════════════════════════════`)
  console.log(`Fetching Open Orders on Predict.fun at ${new Date().toISOString()}`)
  console.log(`Signer EOA:    ${SIGNER_ADDRESS}`)
  console.log(`Account/Maker: ${MAKER_ADDRESS}`)
  console.log(`Smart Wallet:  ${IS_KERNEL ? 'ZeroDev Kernel (ENABLED)' : 'Plain EOA'}`)
  console.log(`Chain ID:      ${CHAIN_ID} (BNB Mainnet)`)
  console.log(`══════════════════════════════════════════════════════════════`)

  try {
    await authenticate()
    console.log("✓ Authenticated with Predict.fun API successfully.\n")
  } catch (error) {
    console.error("Failed to authenticate with Predict.fun:", error.message)
    process.exit(1)
  }

  console.log("Fetching live open orders...")
  const orders = await fetchAllOpenOrders()

  if (orders.length === 0) {
    console.log("0 open orders detected on account.")
    return
  }

  // Group orders by marketId
  const marketOrdersMap = new Map()
  for (const order of orders) {
    const marketId = order.marketId || 'unknown'
    if (!marketOrdersMap.has(marketId)) {
      marketOrdersMap.set(marketId, [])
    }
    marketOrdersMap.get(marketId).push(order)
  }

  const showAll = process.argv.includes('--all')
  const uniqueMarketIds = [...marketOrdersMap.keys()]
  const displayLimit = showAll ? uniqueMarketIds.length : Math.min(10, uniqueMarketIds.length)

  console.log(`Total open orders: ${orders.length} across ${marketOrdersMap.size} market(s).`)
  if (!showAll && uniqueMarketIds.length > displayLimit) {
    console.log(`Showing first ${displayLimit} active markets (pass --all to inspect all ${uniqueMarketIds.length} markets):\n`)
  } else {
    console.log(`Displaying details:\n`)
  }

  for (let i = 0; i < displayLimit; i++) {
    const marketId = uniqueMarketIds[i]
    const mOrders = marketOrdersMap.get(marketId)
    const market = await getMarketById(marketId).catch(() => ({ slug: `market-${marketId}`, conditionId: '' }))
    const marketHeader = `[${market.slug}] (Market ID: ${marketId}, Condition: ${market.conditionId ? market.conditionId.slice(0, 12) + '...' : 'N/A'})`
    console.log(`  ${marketHeader}: ${mOrders.length} open order(s)`)

    for (const orderItem of mOrders) {
      const order = orderItem.order || {}
      const side = order.side === 0 ? 'BUY' : 'SELL'
      const tokenId = order.tokenId || ''

      // Identify outcome name (Up vs Down)
      let outcomeName = 'Unknown'
      if (market.upTokenId && tokenId === market.upTokenId) {
        outcomeName = 'Up'
      } else if (market.downTokenId && tokenId === market.downTokenId) {
        outcomeName = 'Down'
      } else if (market.outcomes && market.outcomes.length > 0) {
        const found = market.outcomes.find(o => o.onChainId === tokenId)
        if (found) outcomeName = found.name
      }

      // Calculate price and sizes in USDT and shares
      const makerWei = BigInt(order.makerAmount || '0')
      const takerWei = BigInt(order.takerAmount || '0')

      let price = 0
      let shares = 0
      let usdtValue = 0

      if (side === 'BUY') {
        if (takerWei > 0n) {
          price = Number(makerWei) / Number(takerWei)
        }
        shares = Number(takerWei) / 1e18
        usdtValue = Number(makerWei) / 1e18
      } else {
        if (makerWei > 0n) {
          price = Number(takerWei) / Number(makerWei)
        }
        shares = Number(makerWei) / 1e18
        usdtValue = Number(takerWei) / 1e18
      }

      const orderId = orderItem.id || 'N/A'
      const hash = order.hash ? `${order.hash.slice(0, 12)}...` : 'N/A'
      const tokenShort = tokenId ? `${tokenId.slice(0, 8)}...` : 'N/A'

      console.log(
        `    └─ ID=${orderId} (Hash=${hash}): Outcome=${outcomeName}, Side=${side}, ` +
        `Price=$${price.toFixed(4)}, Shares=${shares.toFixed(2)}, Value=$${usdtValue.toFixed(4)} USDT, Token=${tokenShort}`
      )
    }
  }

  console.log("\nFinished successfully.")
}

runFetch().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); })
