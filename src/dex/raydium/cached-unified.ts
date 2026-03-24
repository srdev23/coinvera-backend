import { getCachedRayAmmPriceInfo } from './cached-amm';
import { getCachedRayClmmPriceInfo } from './cached-clmm';
import { getCachedRayCpmmPriceInfo } from './cached-cpmm';
import { RaydiumCache } from '../../cache/raydiumCache';

export async function getCachedRaydiumPriceInfo(ca: string, poolId?: string) {
  try {
    // If a specific pool ID is provided, try to find which type it belongs to
    if (poolId) {
      const allCachedPools = RaydiumCache.getAllCachedPools(ca);
      const specificPool = allCachedPools.find(p => p.poolId === poolId);
      
      if (specificPool) {
        switch (specificPool.poolType) {
          case 'amm':
            return await getCachedRayAmmPriceInfo(ca, poolId);
          case 'clmm':
            return await getCachedRayClmmPriceInfo(ca, poolId);
          case 'cpmm':
            return await getCachedRayCpmmPriceInfo(ca, poolId);
          default:
            throw new Error(`Unknown pool type: ${specificPool.poolType}`);
        }
      }
    }
    
    // Try each pool type based on cache availability and liquidity ranking
    const allCachedPools = RaydiumCache.getAllCachedPools(ca);
    
    if (allCachedPools.length > 0) {
      // Group by type and get the best pool for each type
      const poolsByType = {
        amm: allCachedPools.filter(p => p.poolType === 'amm').sort((a, b) => a.liquidityRank - b.liquidityRank),
        clmm: allCachedPools.filter(p => p.poolType === 'clmm').sort((a, b) => a.liquidityRank - b.liquidityRank),
        cpmm: allCachedPools.filter(p => p.poolType === 'cpmm').sort((a, b) => a.liquidityRank - b.liquidityRank)
      };
      
      // Try each type in order of preference (AMM, CLMM, CPMM)
      const results = await Promise.allSettled([
        poolsByType.amm.length > 0 ? getCachedRayAmmPriceInfo(ca, poolsByType.amm[0].poolId) : Promise.reject('No AMM pools'),
        poolsByType.clmm.length > 0 ? getCachedRayClmmPriceInfo(ca, poolsByType.clmm[0].poolId) : Promise.reject('No CLMM pools'),
        poolsByType.cpmm.length > 0 ? getCachedRayCpmmPriceInfo(ca, poolsByType.cpmm[0].poolId) : Promise.reject('No CPMM pools')
      ]);
      
      // Return the first successful result with highest liquidity
      const successfulResults = results
        .filter(result => result.status === 'fulfilled')
        .map(result => (result as PromiseFulfilledResult<any>).value)
        .sort((a, b) => b.liquidity - a.liquidity);
      
      if (successfulResults.length > 0) {
        return successfulResults[0];
      }
    }
    
    // No cached data available, try all types fresh
    const results = await Promise.allSettled([
      getCachedRayAmmPriceInfo(ca),
      getCachedRayClmmPriceInfo(ca),
      getCachedRayCpmmPriceInfo(ca)
    ]);
    
    // Return the first successful result
    const successfulResults = results
      .filter(result => result.status === 'fulfilled')
      .map(result => (result as PromiseFulfilledResult<any>).value)
      .sort((a, b) => b.liquidity - a.liquidity);
    
    if (successfulResults.length > 0) {
      return successfulResults[0];
    }
    
    throw new Error(`No valid Raydium pools found for token: ${ca}`);
    
  } catch (error) {
    throw error;
  }
}

// Helper function to populate cache for all pool types
export async function populateAllRaydiumPools(ca: string) {
  try {
    const results = await Promise.allSettled([
      getCachedRayAmmPriceInfo(ca).catch(() => null),
      getCachedRayClmmPriceInfo(ca).catch(() => null),
      getCachedRayCpmmPriceInfo(ca).catch(() => null)
    ]);
    
  } catch (error) {
    console.error(`[CACHE] Error populating all Raydium pools for ${ca}:`, error);
  }
} 