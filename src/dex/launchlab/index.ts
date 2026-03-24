import { PublicKey } from '@solana/web3.js';
import { AccountLayout } from '@solana/spl-token';
import { 
  LaunchpadPool,  
  getPdaLaunchpadPoolId, 
} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { getCachedSolPrice } from '../../service';
import { launchlabCache, LaunchLabCacheData } from '../../cache/launchlabCache';
import { executeRpcCall } from "../../config";

// LaunchLab price result interface
export interface LaunchLabPriceInfo {
  dex: string;
  poolId: string;
  priceInSol: number;
  priceInUsd: number;
  bondingCurveProgress: number;
}

// Initialize LaunchLab cache table on module load
launchlabCache.initializeTable().catch(console.error);

// Helper function to parse token account data manually with fallback
function parseTokenAccountData(accountData: Buffer | null, decimals: number): { uiAmount: number; amount: bigint } {
  if (!accountData) {
    throw new Error('Token account data is null');
  }
  
  try {
    const tokenAccount = AccountLayout.decode(accountData);
    const amount = tokenAccount.amount;
    const uiAmount = Number(amount) / Math.pow(10, decimals);
    
    return { uiAmount, amount };
  } catch (error) {
    throw new Error(`Failed to parse token account data: ${error}`);
  }
}

// Function to get vault balances with batched RPC call and fallback
async function getVaultBalances(vaultA: PublicKey, vaultB: PublicKey, tokenDecimals: number): Promise<{
  vaultABalance: { uiAmount: number; amount: bigint };
  vaultBBalance: { uiAmount: number; amount: bigint };
}> {
  try {
    // Primary approach: Batched RPC call for better performance with circuit breaker
    const accountInfos = await executeRpcCall(async (connection) => {
      return connection.getMultipleAccountsInfo([vaultA, vaultB]);
    });
    
    if (accountInfos[0]?.data && accountInfos[1]?.data) {
      const vaultABalance = parseTokenAccountData(accountInfos[0].data, tokenDecimals);
      const vaultBBalance = parseTokenAccountData(accountInfos[1].data, 9); // SOL decimals
      
      if (vaultABalance && vaultBBalance) {
        return { vaultABalance, vaultBBalance };
      }
    }
    
    throw new Error('Batched RPC failed or returned invalid data');
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Fallback: Individual RPC calls if batch fails
    try {
      const [vaultAInfo, vaultBInfo] = await Promise.all([
        executeRpcCall(async (connection) => connection.getTokenAccountBalance(vaultA)),
        executeRpcCall(async (connection) => connection.getTokenAccountBalance(vaultB))
      ]);
      
      const vaultABalance = {
        uiAmount: vaultAInfo.value.uiAmount || 0,
        amount: BigInt(vaultAInfo.value.amount)
      };
      const vaultBBalance = {
        uiAmount: vaultBInfo.value.uiAmount || 0,
        amount: BigInt(vaultBInfo.value.amount)
      };
      
      return { vaultABalance, vaultBBalance };
      
    } catch (fallbackError) {
      const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`Both batched and individual RPC calls failed: ${fallbackErrorMessage}`);
    }
  }
}

// Function to calculate price from cached vault addresses
async function calculatePriceFromCachedVaults(tokenAddress: string, cached: LaunchLabCacheData): Promise<LaunchLabPriceInfo> {
  try {
    const solPrice = getCachedSolPrice();
    
    // Get vault balances using cached addresses
    const vaultA = new PublicKey(cached.vaultA);
    const vaultB = new PublicKey(cached.vaultB);
    
    const { vaultABalance, vaultBBalance } = await getVaultBalances(vaultA, vaultB, cached.token_decimals);
    
    // Check if vaults have valid balances (graduation check)
    if (!vaultABalance.uiAmount || !vaultBBalance.uiAmount) {
      await launchlabCache.removeToken(tokenAddress);
      throw new Error('LaunchLab pool not found - token has graduated');
    }
    
    // Calculate price from vault balances
    const priceInSol = vaultBBalance.uiAmount / vaultABalance.uiAmount;
    const priceInUsd = priceInSol * solPrice;
    
    // For cached data, we need to get the pool info to calculate bonding curve progress
    const poolId = new PublicKey(cached.pool_id);
    const poolInfo = await executeRpcCall(async (connection) => {
      return connection.getAccountInfo(poolId);
    });
    
    if (!poolInfo) {
      await launchlabCache.removeToken(tokenAddress);
      throw new Error('LaunchLab pool not found - token has graduated');
    }
    
    const decodedPoolInfo = LaunchpadPool.decode(poolInfo.data);
    const realBInSol = new BN(decodedPoolInfo.realB.toString())
      .div(new BN(10).pow(new BN(decodedPoolInfo.mintDecimalsB)))
      .toNumber();
    const bondingCurveProgress = (realBInSol / 85) * 100;
    
    // Check for graduation (85 SOL = 100% progress)
    if (priceInSol === Infinity || priceInUsd === Infinity || realBInSol >= 85) {
      // Remove from cache
      await launchlabCache.removeToken(tokenAddress);
      throw new Error(`Token has graduated from LaunchLab (${bondingCurveProgress.toFixed(2)}% complete)`);
    }
    
    return {
      dex: "LaunchLab",
      poolId: cached.pool_id,
      priceInSol: priceInSol,
      priceInUsd: priceInUsd,
      bondingCurveProgress: bondingCurveProgress
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

// Main function to get LaunchLab price info
export async function getLaunchLabPriceInfo(ca: string): Promise<LaunchLabPriceInfo> {
  try {
    // Step 1: Check cache first
    const cached = await launchlabCache.getCachedToken(ca);
    
    if (cached) {
      // Calculate real-time price from cached vault addresses
      return await calculatePriceFromCachedVaults(ca, cached);
    }

    // Step 2: No cache, fetch from LaunchLab
    const priceInfo = await fetchLaunchLabPriceInfo(ca);
    
    // Step 3: Check for graduation (Infinity prices)
    if (priceInfo.priceInSol === Infinity || priceInfo.priceInUsd === Infinity) {
      
      // Remove from cache if it exists
      await launchlabCache.removeToken(ca);
      
      // Throw error to trigger multi-DEX search
      throw new Error("Token has graduated from LaunchLab to other pools");
    }

    // Step 4: Cache the vault addresses (will be extracted during fetch)
    // Caching is now handled inside fetchLaunchLabPriceInfo

    return priceInfo;

  } catch (error) {
    throw error;
  }
}

// Function to fetch fresh LaunchLab price info and cache vault addresses
async function fetchLaunchLabPriceInfo(ca: string): Promise<LaunchLabPriceInfo> {
  try {
    const solPrice = getCachedSolPrice();
    const mint = new PublicKey(ca);
    
    // Get LaunchLab pool address
    const LAUNCHPAD_PROGRAM = new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
    const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
    const poolId = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mint, WSOL).publicKey;
    
    // Get pool account info with circuit breaker
    const poolAccountInfo = await executeRpcCall(async (connection) => {
      return connection.getAccountInfo(poolId);
    });
    
    if (!poolAccountInfo || !poolAccountInfo.data) {
      throw new Error("LaunchLab pool not found");
    }
    
    // Decode pool info
    const poolInfo = LaunchpadPool.decode(poolAccountInfo.data);
    
    // Extract vault addresses
    const vaultA = poolInfo.vaultA;
    const vaultB = poolInfo.vaultB;
    const tokenDecimals = poolInfo.mintDecimalsA;
    
    // Get vault balances
    const { vaultABalance, vaultBBalance } = await getVaultBalances(vaultA, vaultB, tokenDecimals);
    
    // Calculate price
    const priceInSol = vaultBBalance.uiAmount / vaultABalance.uiAmount;
    const priceInUsd = priceInSol * solPrice;
    
    // Calculate bonding curve progress (realB / 85 SOL * 100)
    const realBInSol = new BN(poolInfo.realB.toString())
      .div(new BN(10).pow(new BN(poolInfo.mintDecimalsB)))
      .toNumber();
    const bondingCurveProgress = (realBInSol / 85) * 100;
    
    // Check for graduation
    if (priceInSol === Infinity || priceInUsd === Infinity || realBInSol >= 85) {
      throw new Error("Token has graduated from LaunchLab");
    }
    
    // Cache the vault addresses for future use
    await launchlabCache.cacheToken(
      ca,
      poolId.toBase58(),
      vaultA.toBase58(),
      vaultB.toBase58(),
      tokenDecimals
    );
    
    return {
      dex: "LaunchLab",
      poolId: poolId.toBase58(),
      priceInSol,
      priceInUsd,
      bondingCurveProgress
    };
    
  } catch (error) {
    throw error;
  }
}

// Helper function for cached LaunchLab price info
export async function getCachedLaunchLabPriceInfo(ca: string): Promise<LaunchLabPriceInfo> {
  return await getLaunchLabPriceInfo(ca);
} 