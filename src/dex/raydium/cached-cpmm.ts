import { connection } from "../../config";
import { calculatePrice, getCachedSolPrice } from "../../service";
import { RaydiumCache, RaydiumPoolInfo } from "../../cache/raydiumCache";
import { getRayCpmmPool, getRayCpmmPriceInfo } from "./cpmm";
import { PublicKey } from "@solana/web3.js";
import { BN } from "bn.js";
import { AccountLayout } from "@solana/spl-token";

// Helper function to parse token account data properly using SPL Token layout
function parseTokenAccountData(data: Buffer) {
  try {
    const decoded = AccountLayout.decode(data);
    return {
      amount: decoded.amount.toString(),
      decimals: 9, // We'll handle decimals from mint info separately
      mint: decoded.mint.toBase58()
    };
  } catch (error) {
    console.error("Error parsing token account data:", error);
    throw error;
  }
}

export async function getCachedRayCpmmPriceInfo(ca: string, poolId?: string) {
  try {
    // Check if we have cached pool data
    const cachedPool = poolId 
      ? RaydiumCache.getCachedPools(ca, 'cpmm').find(p => p.poolId === poolId)
      : RaydiumCache.getBestPool(ca, 'cpmm');

    if (cachedPool) {
      // Use the original function with poolId for efficiency
      const result = await getRayCpmmPriceInfo(ca, cachedPool.poolId);
      
      return result;
    }

    // No cached data, fetch fresh and cache the results
    
    // Get fresh pool data
    const freshPoolInfo = await getRayCpmmPool(ca, poolId) as any;

    // Cache the pool info for future use
    const poolsToCache: RaydiumPoolInfo[] = [{
      tokenAddress: ca,
      poolType: 'cpmm',
      poolId: freshPoolInfo.poolId.toBase58(),
      baseMint: freshPoolInfo.baseMint.toBase58(),
      quoteMint: freshPoolInfo.quoteMint.toBase58(),
      baseVault: freshPoolInfo.baseVault.toBase58(),
      quoteVault: freshPoolInfo.quoteVault.toBase58(),
      liquidityRank: 1,
      lastUpdated: Date.now()
    }];
    
    RaydiumCache.storePoolInfo(ca, 'cpmm', poolsToCache);
    
    // Now get the price using the fresh data
    return await getRayCpmmPriceInfo(ca, poolId);
    
  } catch (error) {
    throw error;
  }
}

// Function to populate cache with multiple pools (for background tasks)
export async function populateCpmmPoolCache(ca: string) {
  try {
    // Get all pools for this token
    const allPools = await getRayCpmmPool(ca, undefined, true);
    
    if (allPools && 'pools' in allPools) {
      const poolsToCache: RaydiumPoolInfo[] = [];
      
      // Fetch detailed info for each pool and rank by liquidity
      for (let i = 0; i < allPools.pools.length; i++) {
        try {
          const poolId = allPools.pools[i];
          const poolInfo = await getRayCpmmPool(ca, poolId) as any;
          
          poolsToCache.push({
            tokenAddress: ca,
            poolType: 'cpmm',
            poolId: poolInfo.poolId.toBase58(),
            baseMint: poolInfo.baseMint.toBase58(),
            quoteMint: poolInfo.quoteMint.toBase58(),
            baseVault: poolInfo.baseVault.toBase58(),
            quoteVault: poolInfo.quoteVault.toBase58(),
            liquidityRank: i + 1,
            lastUpdated: Date.now()
          });
        } catch (error) {
          console.error(`[CACHE] Error fetching pool ${allPools.pools[i]} details:`, error);
        }
      }
      
      if (poolsToCache.length > 0) {
        RaydiumCache.storePoolInfo(ca, 'cpmm', poolsToCache);
      }
    }
  } catch (error) {
    console.error(`[CACHE] Error populating CPMM cache for ${ca}:`, error);
    throw error;
  }
} 