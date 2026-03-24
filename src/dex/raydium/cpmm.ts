import {
  CREATE_CPMM_POOL_PROGRAM,
  CpmmPoolInfoLayout,
  WSOLMint,
} from "@raydium-io/raydium-sdk-v2";
import { CLEAR_CACHE_INTERVAL, connection } from "../../config";
import { AccountInfo, GetProgramAccountsResponse, PublicKey } from "@solana/web3.js";
import { calculatePrice, getCachedSolPrice } from "../../service";
import { BN } from "bn.js";

type PoolInfo = {
  poolId: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
};

const cachePoolInfo = new Map<string, PoolInfo>();
setInterval(() => {
  cachePoolInfo.clear();
}, CLEAR_CACHE_INTERVAL);

const POOL_PROGRAM_ID = CREATE_CPMM_POOL_PROGRAM;
const POOL_LAYOUT = CpmmPoolInfoLayout;
const quoteCA = WSOLMint.toBase58();

// Function to fetch pool info using a mint address
export async function getRayCpmmPriceInfo(ca: string, poolId?: string) {
  try {
    // Fetch program accounts for Raydium's AMM program (AmmV4)

    let poolInfo = cachePoolInfo.get(ca);
    if (poolInfo === undefined) {
      poolInfo = (await getRayCpmmPool(ca, poolId)) as PoolInfo;
      cachePoolInfo.set(ca, poolInfo);
    }

    const [baseData, quoteData] = await Promise.all([
      connection.getTokenAccountBalance(poolInfo.vaultA),
      connection.getTokenAccountBalance(poolInfo.vaultB),
    ]);

    // const baseReserve =
    //   new BN(baseData.value.amount).div(new BN(10).pow(new BN(poolState.mintDecimalA))).toNumber();
    // const quoteReserve =
    //   new BN(quoteData.value.amount).div(new BN(10).pow(new BN(poolState.mintDecimalB))).toNumber();
    const isBaseToken = ca === poolInfo.mintA.toBase58();
    const priceInSol = isBaseToken
      ? calculatePrice(quoteData.value.amount, baseData.value.amount,
        baseData.value.decimals - quoteData.value.decimals)
      : calculatePrice(baseData.value.amount, quoteData.value.amount,
        quoteData.value.decimals - baseData.value.decimals);

    const wsol_amount = isBaseToken ? new BN(quoteData.value.amount) : new BN(baseData.value.amount);
    const liquidity = 2 * wsol_amount.toNumber() / 10 ** 9 * getCachedSolPrice();
    if (liquidity === 0) throw new Error("No liquidity");
    // const priceInSol = isBaseToken ? price : 1 / price;
    const priceInUsd = priceInSol * getCachedSolPrice();
    // console.log("Raydium Cpmm", Date.now());

    return { dex: "Raydium Cpmm", poolId: poolInfo.poolId.toBase58(), liquidity, priceInSol, priceInUsd };
  } catch (error) {
    console.error("Error fetching ray cpmm pool info:", error);
    throw error;
    // return null;
  }
}

const getFilteredAccounts = async (baseToken: string, quoteToken: string) => {
  const filters = [
    { dataSize: POOL_LAYOUT.span }, // Ensure the correct data size for liquidity pool state
    {
      memcmp: {
        // Memory comparison to match base mint
        offset: POOL_LAYOUT.offsetOf("mintA"),
        bytes: baseToken,
      },
    },
    {
      memcmp: {
        offset: POOL_LAYOUT.offsetOf("mintB"),
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
        const isBaseWsol = poolState.mintA.toBase58() === quoteCA;
        const wsolVault = isBaseWsol ? poolState.vaultA : poolState.vaultB;

        // Get WSOL balance
        const wsolBalance = await connection.getTokenAccountBalance(wsolVault);
        const wsolAmount = new BN(wsolBalance.value.amount);

        return {
          poolAccount,
          poolState,
          wsolAmount,
          poolInfo: {
            poolId: poolAccount.pubkey,
            mintA: poolState.mintA,
            mintB: poolState.mintB,
            vaultA: poolState.vaultA,
            vaultB: poolState.vaultB,
          }
        };
      } catch (error) {
        console.error(`Error processing pool ${poolAccount.pubkey.toBase58()}:`, error);
        return null;
      }
    })
  );
}


export const getRayCpmmPool = async (ca: string, poolId?: string, isGetAll?: boolean) => {
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
  let validPools = poolsWithWsolAmounts
    .filter(pool => pool !== null)
    .sort((a, b) => b.wsolAmount.cmp(a.wsolAmount));

  if (validPools.length === 0) {
    throw new Error(`No valid pools found for token: ${ca}`);
  }

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
    validPools = validPools.filter(pool => pool.poolInfo.poolId.toBase58() === poolId)

  // Return the pool with the largest WSOL amount
  return validPools[0].poolInfo;
};