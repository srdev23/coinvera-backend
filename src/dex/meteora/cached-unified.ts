import { MeteoraCache } from "../../cache/meteoraCache";
import { getCachedMeteAmmPriceInfo } from "./cached-amm";
import { getCachedMeteDlmmPriceInfo } from "./cached-dlmm";

export async function getCachedMeteoraPriceInfo(ca: string, poolId?: string) {
  try {
    // If a specific pool ID is provided, try to find which type it belongs to
    if (poolId) {
      const allCachedPools = MeteoraCache.getAllCachedPools(ca);
      const specificPool = allCachedPools.find(p => p.poolId === poolId);
      
      if (specificPool) {
        switch (specificPool.poolType) {
          case 'amm':
            return await getCachedMeteAmmPriceInfo(ca, poolId);
          case 'dlmm':
            return await getCachedMeteDlmmPriceInfo(ca, poolId);
          default:
            throw new Error(`Unknown pool type: ${specificPool.poolType}`);
        }
      }
    }
    
    // Try each pool type based on cache availability and liquidity ranking
    const allCachedPools = MeteoraCache.getAllCachedPools(ca);
    
    if (allCachedPools.length > 0) {
      const poolTypes = [...new Set(allCachedPools.map(p => p.poolType))];
      
      // Try each cached type
      const results = await Promise.allSettled(
        poolTypes.map(poolType => {
          switch (poolType) {
            case 'amm':
              return getCachedMeteAmmPriceInfo(ca);
            case 'dlmm':
              return getCachedMeteDlmmPriceInfo(ca);
            default:
              return Promise.reject(`Unknown pool type: ${poolType}`);
          }
        })
      );
      
      // Return the first successful result with highest liquidity
      const successfulResults = results
        .filter(result => result.status === 'fulfilled')
        .map(result => (result as PromiseFulfilledResult<any>).value)
        .sort((a, b) => Number(b.liquidity || 0) - Number(a.liquidity || 0));
      
      if (successfulResults.length > 0) {
        return successfulResults[0];
      }
    }
    
    // No cached data available, try all types fresh
    const results = await Promise.allSettled([
      getCachedMeteAmmPriceInfo(ca),
      getCachedMeteDlmmPriceInfo(ca)
    ]);
    
    // Return the first successful result
    const successfulResults = results
      .filter(result => result.status === 'fulfilled')
      .map(result => (result as PromiseFulfilledResult<any>).value)
      .sort((a, b) => Number(b.liquidity || 0) - Number(a.liquidity || 0));
    
    if (successfulResults.length > 0) {
      return successfulResults[0];
    }
    
    throw new Error(`No valid Meteora pools found for token: ${ca}`);
    
  } catch (error) {
    throw error;
  }
}

// Helper function to get price info for a specific pool type
export async function getCachedMeteoraPriceInfoByType(ca: string, poolType: 'amm' | 'dlmm', poolId?: string) {
  switch (poolType) {
    case 'amm':
      return getCachedMeteAmmPriceInfo(ca, poolId);
    case 'dlmm':
      return getCachedMeteDlmmPriceInfo(ca, poolId);
    default:
      throw new Error(`Unknown Meteora pool type: ${poolType}`);
  }
}

// Function to populate cache for both pool types
export async function populateMeteoraCacheForToken(ca: string) {
  try {
    // Try to populate cache for both pool types
    await Promise.allSettled([
      getCachedMeteAmmPriceInfo(ca),
      getCachedMeteDlmmPriceInfo(ca)
    ]);
    
  } catch (error) {
    console.error(`[CACHE] Error populating Meteora cache for ${ca}:`, error);
    throw error;
  }
} 