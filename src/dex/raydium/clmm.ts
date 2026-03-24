import {
  CLMM_PROGRAM_ID,
  PoolInfoLayout,
  SqrtPriceMath,
  WSOLMint,
} from "@raydium-io/raydium-sdk-v2";
import { connection } from "../../config";
import { getCachedSolPrice } from "../../service";
import { AccountInfo, PublicKey } from "@solana/web3.js";

type PoolAcct = { account: AccountInfo<Buffer>, pubkey: PublicKey }

const POOL_PROGRAM_ID = CLMM_PROGRAM_ID;
const POOL_LAYOUT = PoolInfoLayout;
const quoteCA = WSOLMint.toBase58();
// Fetch program accounts for Raydium's AMM program (AmmV4)
const getFilteredAccounts = async (
  baseToken: string,
  quoteToken: string
) => {
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

// Function to fetch pool info using a mint address
export async function getRayClmmPriceInfo(ca: string, poolId?: string) {
  try {
    const poolAccount = (await getRayClmmPool(ca, poolId)) as PoolAcct;
    const poolState = POOL_LAYOUT.decode(poolAccount.account.data);

    // const liquidity = poolState.liquidity.toNumber()// * getCachedSolPrice();
    const [baseData, quoteData] = await Promise.all([
      connection.getTokenAccountBalance(poolState.vaultA),
      connection.getTokenAccountBalance(poolState.vaultB),
    ]);
    const isBaseToken = ca === poolState.mintA.toBase58();
    const wsol_amount = isBaseToken ? quoteData.value.uiAmount : baseData.value.uiAmount;
    const spl_amount = isBaseToken ? baseData.value.uiAmount : quoteData.value.uiAmount;

    const price = SqrtPriceMath.sqrtPriceX64ToPrice(
      poolState.sqrtPriceX64,
      poolState.mintDecimalsA,
      poolState.mintDecimalsB
    ).toNumber()
    const priceInSol = poolState.mintA.toBase58() === ca ? price : 1 / price;
    const priceInUsd = priceInSol * getCachedSolPrice();
    const liquidity = Number(spl_amount) * priceInUsd + Number(wsol_amount) * getCachedSolPrice();
    if (liquidity === 0) throw new Error("No liquidity");

    return { dex: "Raydium Clmm", poolId: poolAccount.pubkey.toBase58(), liquidity, priceInSol, priceInUsd };
  } catch (error) {
    console.error("Error fetching ray clmm pool info:", error);
    throw error;
    // return null;
  }
}

// Function to fetch pool info using a mint address
export async function getRayClmmPool(ca: string, poolId?: string, isGetAll?: boolean) {
  // Fetch pools from both directions and combine them
  const [baseQuotePools, quoteBasePools] = await Promise.allSettled([
    getFilteredAccounts(ca, quoteCA),
    getFilteredAccounts(quoteCA, ca),
  ]);

  // Combine all successful pool results
  let allAccounts: PoolAcct[] = [];

  if (baseQuotePools.status === 'fulfilled') {
    allAccounts = allAccounts.concat(baseQuotePools.value);
  }

  if (quoteBasePools.status === 'fulfilled') {
    allAccounts = allAccounts.concat(quoteBasePools.value);
  }

  if (allAccounts.length === 0) {
    throw new Error(`No pools found for token: ${ca}`);
  }

  if (isGetAll) {
    const pools = allAccounts.map((acc) =>
      acc.pubkey.toBase58(),
    );
    return {
      dex: "Raydium AMM",
      pools
    }
  }

  // Filter the pool account accoring to the provided poolid
  if (poolId)
    allAccounts = allAccounts.filter(
      (acc) => acc.pubkey.toBase58() === poolId
    );

  // Use the first account found where mint is baseMint
  const poolAccount = allAccounts.sort(
    (a, b) => POOL_LAYOUT.decode(b.account.data).liquidity.cmp(
      POOL_LAYOUT.decode(a.account.data).liquidity
    )
  )[0];

  return poolAccount;
}