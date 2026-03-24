import { connection } from "../../config";
import { MeteoraCache, MeteoraPoolInfo } from "../../cache/meteoraCache";
import { getMeteAmmPriceInfo } from "./amm";
import { PublicKey } from "@solana/web3.js";
import { AmmIdl, PROGRAM_ID } from "@mercurial-finance/dynamic-amm-sdk";
import { AnchorProvider, Program } from "@project-serum/anchor";
import * as spl from "@solana/spl-token";

export async function getCachedMeteAmmPriceInfo(ca: string, poolId?: string) {
  try {
    // Check if we already know there are no AMM pools for this token
    if (MeteoraCache.hasNegativeResults(ca, 'amm')) {
      throw new Error("No AMM pools found for token (cached negative result)");
    }
    
    // Check if we have cached pool data
    const cachedPool = poolId 
      ? MeteoraCache.getCachedPools(ca, 'amm').find(p => p.poolId === poolId)
      : MeteoraCache.getBestPool(ca, 'amm');

    if (cachedPool) {
      // MAJOR OPTIMIZATION: Use original function but skip expensive pool discovery
      // Since we have the poolId cached, directly call the original function
      const result = await getMeteAmmPriceInfo(ca, cachedPool.poolId);
      
      return result;
    }

    // No cached data, fetch fresh and cache the results
    
    // Get fresh pool data - we need the pool account data for vault addresses
    const mint = new PublicKey(ca);
    const provider = new AnchorProvider(connection, {} as any, AnchorProvider.defaultOptions());
    const program = new Program(AmmIdl, PROGRAM_ID, provider);

    const [poolsForTokenAMint, poolsForTokenBMint] = await Promise.all([
      program.account.pool.all([
        {
          memcmp: {
            offset: 40,
            bytes: mint.toBase58(),
          },
        },
        {
          memcmp: {
            offset: 72,
            bytes: spl.NATIVE_MINT.toBase58(),
          },
        },
      ]),
      program.account.pool.all([
        {
          memcmp: {
            offset: 40,
            bytes: spl.NATIVE_MINT.toBase58(),
          },
        },
        {
          memcmp: {
            offset: 72,
            bytes: mint.toBase58(),
          },
        },
      ]),
    ]);

    const ammPools = [...poolsForTokenAMint, ...poolsForTokenBMint];
    if (ammPools.length === 0) {
      // Store negative result to avoid repeated searches
      MeteoraCache.storeNegativeResult(ca, 'amm');
      throw new Error("No Meteora AMM pool found");
    }

    // Get the best pool by liquidity
    const tokenAmounts = await Promise.all(
      ammPools.map((pool) =>
        connection.getTokenAccountBalance(
          (pool.account as any).tokenAMint.toBase58() === spl.NATIVE_MINT.toBase58()
            ? (pool.account as any).aVaultLp
            : (pool.account as any).bVaultLp
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

    const bestPool = ammPools[maxIndex];
    const poolAccount = bestPool.account as any;
    
    // Cache the pool info for future use
    const poolsToCache: MeteoraPoolInfo[] = [{
      tokenAddress: ca,
      poolType: 'amm',
      poolId: bestPool.publicKey.toBase58(),
      tokenAMint: poolAccount.tokenAMint.toBase58(),
      tokenBMint: poolAccount.tokenBMint.toBase58(),
      vaultA: poolAccount.aVault.toBase58(),
      vaultB: poolAccount.bVault.toBase58(),
      aVaultLp: poolAccount.aVaultLp.toBase58(),
      bVaultLp: poolAccount.bVaultLp.toBase58(),
      liquidityRank: 1,
      lastUpdated: Date.now()
    }];
    
    MeteoraCache.storePoolInfo(ca, 'amm', poolsToCache);
    
    // Now get the price using the cached data (recursive call with cache hit)
    return await getCachedMeteAmmPriceInfo(ca, bestPool.publicKey.toBase58());
    
  } catch (error) {
    throw error;
  }
}

// Function to populate cache with multiple pools (for background tasks)
export async function populateMeteAmmPoolCache(ca: string) {
  try {
    // Get all pools for this token using the program account query
    const mint = new PublicKey(ca);
    const provider = new AnchorProvider(connection, {} as any, AnchorProvider.defaultOptions());
    const program = new Program(AmmIdl, PROGRAM_ID, provider);

    const [poolsForTokenAMint, poolsForTokenBMint] = await Promise.all([
      program.account.pool.all([
        {
          memcmp: {
            offset: 40,
            bytes: mint.toBase58(),
          },
        },
        {
          memcmp: {
            offset: 72,
            bytes: spl.NATIVE_MINT.toBase58(),
          },
        },
      ]),
      program.account.pool.all([
        {
          memcmp: {
            offset: 40,
            bytes: spl.NATIVE_MINT.toBase58(),
          },
        },
        {
          memcmp: {
            offset: 72,
            bytes: mint.toBase58(),
          },
        },
      ]),
    ]);

    const ammPools = [...poolsForTokenAMint, ...poolsForTokenBMint];
    if (ammPools.length === 0) {
      // Store negative result to avoid repeated searches
      MeteoraCache.storeNegativeResult(ca, 'amm');
      throw new Error("No Meteora AMM pool found");
    }

    const poolsToCache: MeteoraPoolInfo[] = [];
    
    // Process each pool and collect their info
    for (let i = 0; i < ammPools.length; i++) {
      try {
        const pool = ammPools[i];
        const poolAccount = pool.account as any;
        
        poolsToCache.push({
          tokenAddress: ca,
          poolType: 'amm',
          poolId: pool.publicKey.toBase58(),
          tokenAMint: poolAccount.tokenAMint.toBase58(),
          tokenBMint: poolAccount.tokenBMint.toBase58(),
          vaultA: poolAccount.aVault.toBase58(),
          vaultB: poolAccount.bVault.toBase58(),
          aVaultLp: poolAccount.aVaultLp.toBase58(),
          bVaultLp: poolAccount.bVaultLp.toBase58(),
          liquidityRank: i + 1,
          lastUpdated: Date.now()
        });
      } catch (error) {
        console.error(`[CACHE] Error processing Meteora AMM pool ${ammPools[i].publicKey.toBase58()} details:`, error);
      }
    }
    
    if (poolsToCache.length > 0) {
      MeteoraCache.storePoolInfo(ca, 'amm', poolsToCache);
    }
  } catch (error) {
    console.error(`[CACHE] Error populating AMM cache for ${ca}:`, error);
    throw error;
  }
} 