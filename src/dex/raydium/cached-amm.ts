import { connection } from "../../config";
import { calculatePrice, getCachedSolPrice } from "../../service";
import { RaydiumCache, RaydiumPoolInfo } from "../../cache/raydiumCache";
import { getRayAmmPool, getRaydiumAmmPriceInfo } from "./amm";
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

export async function getCachedRayAmmPriceInfo(ca: string, poolId?: string) {
  try {
    // Check if we have cached pool data
    const cachedPool = poolId 
      ? RaydiumCache.getCachedPools(ca, 'amm').find(p => p.poolId === poolId)
      : RaydiumCache.getBestPool(ca, 'amm');

    if (cachedPool) {
      // Use cached pool info but fetch fresh vault balances
      const poolInfo = {
        poolId: new PublicKey(cachedPool.poolId),
        baseMint: new PublicKey(cachedPool.baseMint),
        quoteMint: new PublicKey(cachedPool.quoteMint),
        baseVault: new PublicKey(cachedPool.baseVault),
        quoteVault: new PublicKey(cachedPool.quoteVault),
      };

      // OPTIMIZATION: Batch vault calls and mint info calls
      const [baseVaultInfo, quoteVaultInfo, baseMintInfo, quoteMintInfo] = await connection.getMultipleAccountsInfo([
        poolInfo.baseVault,
        poolInfo.quoteVault,
        poolInfo.baseMint,
        poolInfo.quoteMint
      ]);
      
      if (!baseVaultInfo || !quoteVaultInfo || !baseMintInfo || !quoteMintInfo) {
        throw new Error("Could not fetch vault or mint account info");
      }
      
      // Parse token account data
      const baseVaultData = parseTokenAccountData(baseVaultInfo.data);
      const quoteVaultData = parseTokenAccountData(quoteVaultInfo.data);
      
      // Parse mint data to get decimals
      const baseMintDecimals = baseMintInfo.data[44]; // Decimals are at offset 44 in mint layout
      const quoteMintDecimals = quoteMintInfo.data[44];
      
      // Construct data objects similar to getTokenAccountBalance response
      const baseData = {
        value: {
          amount: baseVaultData.amount,
          decimals: baseMintDecimals
        }
      };
      const quoteData = {
        value: {
          amount: quoteVaultData.amount,
          decimals: quoteMintDecimals
        }
      };

      const isBaseToken = ca === poolInfo.baseMint.toBase58();
      const priceInSol = isBaseToken
        ? calculatePrice(quoteData.value.amount, baseData.value.amount,
          baseData.value.decimals - quoteData.value.decimals)
        : calculatePrice(baseData.value.amount, quoteData.value.amount,
          quoteData.value.decimals - baseData.value.decimals);

      const wsol_amount = isBaseToken ? new BN(quoteData.value.amount) : new BN(baseData.value.amount);
      const liquidity = 2 * wsol_amount.toNumber() / 10 ** 9 * getCachedSolPrice();
      
      if (liquidity === 0) throw new Error("No liquidity");
      
      const priceInUsd = priceInSol * getCachedSolPrice();
      
      return { 
        dex: "Raydium Amm", 
        poolId: poolInfo.poolId.toBase58(), 
        liquidity, 
        priceInSol, 
        priceInUsd 
      };
    }

    // No cached data, fetch fresh and cache the results
    
    // Get fresh pool data
    const freshPoolInfo = await getRayAmmPool(ca, poolId) as any;

    // Cache the pool info for future use
    const poolsToCache: RaydiumPoolInfo[] = [{
      tokenAddress: ca,
      poolType: 'amm',
      poolId: freshPoolInfo.poolId.toBase58(),
      baseMint: freshPoolInfo.baseMint.toBase58(),
      quoteMint: freshPoolInfo.quoteMint.toBase58(),
      baseVault: freshPoolInfo.baseVault.toBase58(),
      quoteVault: freshPoolInfo.quoteVault.toBase58(),
      liquidityRank: 1,
      lastUpdated: Date.now()
    }];
    
    RaydiumCache.storePoolInfo(ca, 'amm', poolsToCache);
    
    // Now get the price using the fresh data
    return await getRaydiumAmmPriceInfo(ca);
    
  } catch (error) {
    throw error;
  }
}

// Function to populate cache with multiple pools (for background tasks)
export async function populateAmmPoolCache(ca: string) {
  try {
    // Get all pools for this token
    const allPools = await getRayAmmPool(ca, undefined, true);
    
    if (allPools && 'pools' in allPools) {
      const poolsToCache: RaydiumPoolInfo[] = [];
      
      // Fetch detailed info for each pool and rank by liquidity
      for (let i = 0; i < allPools.pools.length; i++) {
        try {
          const poolId = allPools.pools[i];
          const poolInfo = await getRayAmmPool(ca, poolId) as any;
          
          poolsToCache.push({
            tokenAddress: ca,
            poolType: 'amm',
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
        RaydiumCache.storePoolInfo(ca, 'amm', poolsToCache);
      }
    }
  } catch (error) {
    console.error(`[CACHE] Error populating AMM cache for ${ca}:`, error);
    throw error;
  }
} 