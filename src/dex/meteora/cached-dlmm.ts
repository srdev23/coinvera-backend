import { connection } from "../../config";
import { MeteoraCache, MeteoraPoolInfo } from "../../cache/meteoraCache";
import { getMeteDlmmPriceInfo } from "./dlmm";
import { PublicKey } from "@solana/web3.js";
import { IDL, LBCLMM_PROGRAM_IDS } from "@meteora-ag/dlmm";
import { AnchorProvider, Program } from "@project-serum/anchor";
import * as spl from "@solana/spl-token";

export async function getCachedMeteDlmmPriceInfo(ca: string, poolId?: string) {
  try {
    // Check if we already know there are no DLMM pools for this token
    if (MeteoraCache.hasNegativeResults(ca, 'dlmm')) {
      throw new Error("No DLMM pools found for token (cached negative result)");
    }
    
    // Check if we have cached pool data
    const cachedPool = poolId 
      ? MeteoraCache.getCachedPools(ca, 'dlmm').find(p => p.poolId === poolId)
      : MeteoraCache.getBestPool(ca, 'dlmm');

    if (cachedPool) {
      // MAJOR OPTIMIZATION: Use original function but skip expensive pool discovery
      // Since we have the poolId cached, directly call the original function
      const result = await getMeteDlmmPriceInfo(ca, cachedPool.poolId);
      
      return result;
    }

    // No cached data, fetch fresh and cache the results
    
    // Get fresh pool data - we need the pool account data for reserve addresses
    const mint = new PublicKey(ca);
    const provider = new AnchorProvider(connection, {} as any, AnchorProvider.defaultOptions());
    const program = new Program(IDL, LBCLMM_PROGRAM_IDS["mainnet-beta"], provider);

    const [poolsForTokenXMint, poolsForTokenYMint] = await Promise.all([
      program.account.lbPair.all([
        {
          memcmp: {
            offset: 88,
            bytes: mint.toBase58(),
          },
        },
        {
          memcmp: {
            offset: 120,
            bytes: spl.NATIVE_MINT.toBase58(),
          },
        },
      ]),
      program.account.lbPair.all([
        {
          memcmp: {
            offset: 88,
            bytes: spl.NATIVE_MINT.toBase58(),
          },
        },
        {
          memcmp: {
            offset: 120,
            bytes: mint.toBase58(),
          },
        },
      ]),
    ]);

    const lbPairs = [...poolsForTokenXMint, ...poolsForTokenYMint];
    if (lbPairs.length === 0) {
      // Store negative result to avoid repeated searches
      MeteoraCache.storeNegativeResult(ca, 'dlmm');
      throw new Error("No LB pair found for token");
    }

    // Get the best pool by liquidity
    const tokenAmounts = await Promise.all(
      lbPairs.map((lbPair) =>
        connection.getTokenAccountBalance(
          (lbPair.account as any).tokenXMint.toBase58() === spl.NATIVE_MINT.toBase58()
            ? (lbPair.account as any).reserveX
            : (lbPair.account as any).reserveY
        )
      )
    );

    const maxIndex = tokenAmounts.reduce((maxIdx, current, idx, arr) => {
      const currentValue = current.value.uiAmount;
      const maxValue = arr[maxIdx].value.uiAmount;

      if (currentValue === null) return maxIdx;
      if (maxValue === null || currentValue > maxValue) return idx;

      return maxIdx;
    }, 0);

    const bestPool = lbPairs[maxIndex];
    const poolAccount = bestPool.account as any;
    
    // Cache the pool info for future use
    const poolsToCache: MeteoraPoolInfo[] = [{
      tokenAddress: ca,
      poolType: 'dlmm',
      poolId: bestPool.publicKey.toBase58(),
      tokenXMint: poolAccount.tokenXMint.toBase58(),
      tokenYMint: poolAccount.tokenYMint.toBase58(),
      reserveX: poolAccount.reserveX.toBase58(),
      reserveY: poolAccount.reserveY.toBase58(),
      liquidityRank: 1,
      lastUpdated: Date.now()
    }];
    
    MeteoraCache.storePoolInfo(ca, 'dlmm', poolsToCache);
    
    // Now get the price using the cached data (recursive call with cache hit)
    return await getCachedMeteDlmmPriceInfo(ca, bestPool.publicKey.toBase58());
    
  } catch (error) {
    throw error;
  }
}

// Function to populate cache with multiple pools (for background tasks)
export async function populateMeteDlmmPoolCache(ca: string) {
  try {
    // Get all pools for this token using the program account query
    const mint = new PublicKey(ca);
    const provider = new AnchorProvider(connection, {} as any, AnchorProvider.defaultOptions());
    const program = new Program(IDL, LBCLMM_PROGRAM_IDS["mainnet-beta"], provider);

    const [poolsForTokenXMint, poolsForTokenYMint] = await Promise.all([
      program.account.lbPair.all([
        {
          memcmp: {
            offset: 88,
            bytes: mint.toBase58(),
          },
        },
        {
          memcmp: {
            offset: 120,
            bytes: spl.NATIVE_MINT.toBase58(),
          },
        },
      ]),
      program.account.lbPair.all([
        {
          memcmp: {
            offset: 88,
            bytes: spl.NATIVE_MINT.toBase58(),
          },
        },
        {
          memcmp: {
            offset: 120,
            bytes: mint.toBase58(),
          },
        },
      ]),
    ]);

    const lbPairs = [...poolsForTokenXMint, ...poolsForTokenYMint];
    if (lbPairs.length === 0) {
      // Store negative result to avoid repeated searches
      MeteoraCache.storeNegativeResult(ca, 'dlmm');
      throw new Error("No LB pair found for token");
    }

    const poolsToCache: MeteoraPoolInfo[] = [];
    
    // Process each pool and collect their info
    for (let i = 0; i < lbPairs.length; i++) {
      try {
        const pool = lbPairs[i];
        const poolAccount = pool.account as any;
        
        poolsToCache.push({
          tokenAddress: ca,
          poolType: 'dlmm',
          poolId: pool.publicKey.toBase58(),
          tokenXMint: poolAccount.tokenXMint.toBase58(),
          tokenYMint: poolAccount.tokenYMint.toBase58(),
          reserveX: poolAccount.reserveX.toBase58(),
          reserveY: poolAccount.reserveY.toBase58(),
          liquidityRank: i + 1,
          lastUpdated: Date.now()
        });
      } catch (error) {
        console.error(`[CACHE] Error processing Meteora DLMM pool ${lbPairs[i].publicKey.toBase58()} details:`, error);
      }
    }
    
    if (poolsToCache.length > 0) {
      MeteoraCache.storePoolInfo(ca, 'dlmm', poolsToCache);
    }
  } catch (error) {
    console.error(`[CACHE] Error populating DLMM cache for ${ca}:`, error);
    throw error;
  }
} 