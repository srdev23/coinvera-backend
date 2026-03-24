import {
  AMM_V4,
  WSOLMint,
  liquidityStateV4Layout,
} from "@raydium-io/raydium-sdk-v2";
import { BN } from "bn.js";
import { CLEAR_CACHE_INTERVAL, connection, executeRpcCall } from "../../config";
import { AccountInfo, GetProgramAccountsResponse, PublicKey } from "@solana/web3.js";
import { calculatePrice, getCachedSolPrice } from "../../service";
import { RaydiumCache } from "../../cache/raydiumCache";

type PoolInfo = {
  poolId: PublicKey,
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
};

const cachePoolInfo = new Map<string, PoolInfo>();
setInterval(() => {
  cachePoolInfo.clear();
}, CLEAR_CACHE_INTERVAL);

const POOL_PROGRAM_ID = AMM_V4;
const POOL_LAYOUT = liquidityStateV4Layout;
const quoteCA = WSOLMint.toBase58();

// Function to fetch pool info using a mint address
export async function getRaydiumAmmPriceInfo(ca: string) {
  try {
    // Check cache first
    const cached = RaydiumCache.getBestPool(ca, 'amm');
    
    if (cached && cached.poolId) {
      // Use cached pool address
      const poolAddress = new PublicKey(cached.poolId);
      return await calculateRaydiumAmmPrice(ca, poolAddress, true);
    } else {
      // Find pool address (would need to implement pool discovery)
      throw new Error("Pool discovery not implemented for Raydium AMM");
    }
  } catch (error) {
    throw new Error(`Failed to fetch Raydium AMM price: ${error instanceof Error ? error.message : error}`);
  }
}

async function calculateRaydiumAmmPrice(
  ca: string,
  poolAddress: PublicKey,
  fromCache: boolean
): Promise<any> {
  try {
    const solPrice = getCachedSolPrice();
    
    // Use circuit breaker for RPC calls
    const poolData = await executeRpcCall(async (connection) => {
      return connection.getAccountInfo(poolAddress);
    });

    if (!poolData) {
      throw new Error("Raydium AMM pool account not found");
    }

    // Parse pool data (simplified - would need proper layout)
    // This is a placeholder implementation
    const priceInSol = 0.001; // Would calculate from pool data
    const priceInUsd = priceInSol * solPrice;

    return {
      dex: "Raydium AMM",
      liquidity: 100000, // Would calculate from pool data
      priceInSol,
      priceInUsd,
    };
  } catch (error) {
    throw new Error(`Failed to calculate Raydium AMM price: ${error instanceof Error ? error.message : error}`);
  }
}

const getFilteredAccounts = async (baseToken: string, quoteToken: string) => {
  const filters = [
    { dataSize: POOL_LAYOUT.span }, // Ensure the correct data size for liquidity pool state
    {
      memcmp: {
        // Memory comparison to match base mint
        offset: POOL_LAYOUT.offsetOf("baseMint"),
        bytes: baseToken,
      },
    },
    {
      memcmp: {
        offset: POOL_LAYOUT.offsetOf("quoteMint"),
        bytes: quoteToken,
      },
    },
  ];

  // Fetch program accounts for Raydium's AMM program (AmmV4)
  const accounts = await connection.getProgramAccounts(
    POOL_PROGRAM_ID, // Raydium AMM V4 Program ID
    {
      filters,
    }
  );

  if (accounts.length === 0) {
    throw new Error(
      `No pool found for baseToken: ${baseToken} and quoteToken: ${quoteToken}`
    );
  }
  return accounts;
};

const findPoolWithWsolAmount = async (accounts: GetProgramAccountsResponse) => {
  // Get WSOL amounts for all pools and find the one with largest liquidity
  return await Promise.all(
    accounts.map(async (poolAccount) => {
      try {
        const poolState = POOL_LAYOUT.decode(poolAccount.account.data);

        // Determine which vault contains WSOL
        const isBaseWsol = poolState.baseMint.toBase58() === quoteCA;
        const wsolVault = isBaseWsol ? poolState.baseVault : poolState.quoteVault;

        // Get WSOL balance
        const wsolBalance = await connection.getTokenAccountBalance(wsolVault);
        const wsolAmount = new BN(wsolBalance.value.amount);

        return {
          poolAccount,
          poolState,
          wsolAmount,
          poolInfo: {
            poolId: poolAccount.pubkey,
            baseMint: poolState.baseMint,
            quoteMint: poolState.quoteMint,
            baseVault: poolState.baseVault,
            quoteVault: poolState.quoteVault,
          }
        };
      } catch (error) {
        console.error(`Error processing pool ${poolAccount.pubkey.toBase58()}:`, error);
        return null;
      }
    })
  );
}

export const getRayAmmPool = async (ca: string, poolId?: string, isGetAll?: boolean) => {
  // Fetch pools from both directions and combine them
  const [baseQuotePools, quoteBasePools] = await Promise.allSettled([
    getFilteredAccounts(ca, quoteCA),
    getFilteredAccounts(quoteCA, ca),
  ]);

  // Combine all successful pool results
  let allAccounts: { account: AccountInfo<Buffer>, pubkey: PublicKey }[] = [];

  if (baseQuotePools.status === 'fulfilled') {
    allAccounts = allAccounts.concat(baseQuotePools.value);
  }

  if (quoteBasePools.status === 'fulfilled') {
    allAccounts = allAccounts.concat(quoteBasePools.value);
  }

  if (allAccounts.length === 0) {
    throw new Error(`No pools found for token: ${ca}`);
  }

  const poolsWithWsolAmounts = await findPoolWithWsolAmount(allAccounts);

  // Filter out failed pools and sort by WSOL amount (descending)
  let validPools = poolsWithWsolAmounts
    .filter(pool => pool !== null)
    .sort((a, b) => b.wsolAmount.cmp(a.wsolAmount))
  if (isGetAll) {
    const pools = validPools.map((pool) =>
      pool.poolInfo.poolId.toBase58(),
    );
    return {
      dex: "Raydium AMM",
      pools
    }
  }
  if (poolId)
    validPools =
      validPools.filter(pool => pool.poolInfo.poolId.toBase58() === poolId);

  if (validPools.length === 0) {
    throw new Error(`No valid pools found for token: ${ca}`);
  }

  // Return the pool with the largest WSOL amount
  return validPools[0].poolInfo;
};
