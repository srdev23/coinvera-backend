import { pumpfunCache } from "../cache/pumpfunCache";
import { RaydiumCache } from "../cache/raydiumCache";
import { MeteoraCache } from "../cache/meteoraCache";
import { launchlabCache } from "../cache/launchlabCache";
import { getCachedRaydiumPriceInfo } from "../dex/raydium";
import { getCachedMeteoraPriceInfo } from "../dex/meteora";
import { getCachedLaunchLabPriceInfo } from "../dex/launchlab";
import { getPumpPriceInfo } from "../dex/pumpfun";
import { getPumpAmmPriceInfo } from "../dex/pumpfun/amm";

export interface PoolSearchResult {
  found: boolean;
  dex?: string;
  poolId?: string;
  tokenAddress?: string;
}

/**
 * Search for a specific pool ID for a given token across all DEX caches
 * @param poolId - The pool ID to search for
 * @param tokenAddress - Token address to search for this pool
 * @returns PoolSearchResult with found status and DEX information
 */
export async function findSpecificPool(poolId: string, tokenAddress: string): Promise<PoolSearchResult> {
  console.log(`[POOL_SEARCH] Searching for pool ${poolId} for token ${tokenAddress}...`);
  
  // Search in Pumpfun cache
  try {
    const pumpfunData = await pumpfunCache.getCachedToken(tokenAddress);
    if (pumpfunData) {
      if (pumpfunData.bonding_curve_address === poolId) {
        console.log(`[POOL_SEARCH] Found Pumpfun bonding curve pool ${poolId}`);
        return {
          found: true,
          dex: 'pumpfun',
          poolId,
          tokenAddress
        };
      }
      if (pumpfunData.pool_id === poolId) {
        console.log(`[POOL_SEARCH] Found Pumpfun AMM pool ${poolId}`);
        return {
          found: true,
          dex: 'pumpfun_amm',
          poolId,
          tokenAddress
        };
      }
    }
  } catch (error) {
    console.log(`[POOL_SEARCH] Error searching Pumpfun cache:`, error);
  }
  
  // Search in Raydium cache
  try {
    const raydiumPools = RaydiumCache.getAllCachedPools(tokenAddress);
    for (const pool of raydiumPools) {
      if (pool.poolId === poolId) {
        console.log(`[POOL_SEARCH] Found Raydium ${pool.poolType} pool ${poolId}`);
        return {
          found: true,
          dex: `raydium_${pool.poolType}`,
          poolId,
          tokenAddress
        };
      }
    }
  } catch (error) {
    console.log(`[POOL_SEARCH] Error searching Raydium cache:`, error);
  }
  
  // Search in Meteora cache
  try {
    const meteoraPools = MeteoraCache.getAllCachedPools(tokenAddress);
    for (const pool of meteoraPools) {
      if (pool.poolId === poolId) {
        console.log(`[POOL_SEARCH] Found Meteora ${pool.poolType} pool ${poolId}`);
        return {
          found: true,
          dex: `meteora_${pool.poolType}`,
          poolId,
          tokenAddress
        };
      }
    }
  } catch (error) {
    console.log(`[POOL_SEARCH] Error searching Meteora cache:`, error);
  }
  
  // Search in LaunchLab cache
  try {
    const launchlabData = await launchlabCache.getCachedToken(tokenAddress);
    if (launchlabData && launchlabData.pool_id === poolId) {
      console.log(`[POOL_SEARCH] Found LaunchLab pool ${poolId}`);
      return {
        found: true,
        dex: 'launchlab',
        poolId,
        tokenAddress
      };
    }
  } catch (error) {
    console.log(`[POOL_SEARCH] Error searching LaunchLab cache:`, error);
  }
  
  console.log(`[POOL_SEARCH] Pool ${poolId} not found for token ${tokenAddress}`);
  return { found: false };
}

/**
 * Get price from a specific pool
 * @param poolResult - Result from findSpecificPool
 * @returns Price information
 */
export async function getPriceFromSpecificPool(poolResult: PoolSearchResult): Promise<any> {
  if (!poolResult.found || !poolResult.dex || !poolResult.tokenAddress || !poolResult.poolId) {
    throw new Error("Invalid pool result");
  }

  console.log(`[POOL_SEARCH] Getting price from ${poolResult.dex} pool ${poolResult.poolId}`);

  switch (poolResult.dex) {
    case 'pumpfun':
      return await getPumpPriceInfo(poolResult.tokenAddress);
    case 'pumpfun_amm':
      return await getPumpAmmPriceInfo(poolResult.tokenAddress);
    case 'raydium_amm':
    case 'raydium_clmm':
    case 'raydium_cpmm':
      return await getCachedRaydiumPriceInfo(poolResult.tokenAddress, poolResult.poolId);
    case 'meteora_amm':
    case 'meteora_dlmm':
      return await getCachedMeteoraPriceInfo(poolResult.tokenAddress, poolResult.poolId);
    case 'launchlab':
      return await getCachedLaunchLabPriceInfo(poolResult.tokenAddress);
    default:
      throw new Error(`Unknown DEX: ${poolResult.dex}`);
  }
} 