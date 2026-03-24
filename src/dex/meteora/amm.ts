import AmmImpl, {
  AmmIdl,
  PROGRAM_ID,
} from "@mercurial-finance/dynamic-amm-sdk";
import { PublicKey } from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import { AnchorProvider, Program } from "@project-serum/anchor";
import { CLEAR_CACHE_INTERVAL, connection } from "../../config";
import { calculatePrice, getCachedSolPrice } from "../../service";
import { BN } from "bn.js";

const cachePoolInfo = new Map<string, PublicKey>();
setInterval(() => {
  cachePoolInfo.clear();
}, CLEAR_CACHE_INTERVAL);

export const getMeteAmmPriceInfo = async (ca: string, poolId?: string) => {
  try {
    const mint = new PublicKey(ca);

    //  Get pool ID
    let poolAccount = poolId ? new PublicKey(poolId) : cachePoolInfo.get(ca);
    if (poolAccount === undefined) {
      poolAccount = (await getMeteoraAmmPool(ca)) as PublicKey;
      cachePoolInfo.set(ca, poolAccount);
    }

    // Create Amm object
    const stabelPool = await AmmImpl.create(connection, poolAccount);
    if (!stabelPool) throw new Error("Invalid pool");
    const isBaseToken = stabelPool.vaultA.tokenMint.address.equals(mint);
    const tokenA_amount = stabelPool.poolInfo.tokenAAmount.div(new BN(10).pow(new BN(stabelPool.vaultA.tokenMint.decimals))).toNumber();
    const tokenB_amount = stabelPool.poolInfo.tokenBAmount.div(new BN(10).pow(new BN(stabelPool.vaultB.tokenMint.decimals))).toNumber();

    // const token_amount = isBaseToken? tokenA_amount : tokenB_amount;
    const wsol_amount = isBaseToken ? tokenB_amount : tokenA_amount;
    const liquidity = 2 * wsol_amount * getCachedSolPrice();
    if (liquidity === 0) throw new Error("No liquidity");
    const priceInSol = isBaseToken
      ? calculatePrice(stabelPool.poolInfo.tokenBAmount.toString(), stabelPool.poolInfo.tokenAAmount.toString(),
        stabelPool.vaultA.tokenMint.decimals - stabelPool.vaultB.tokenMint.decimals)
      : calculatePrice(stabelPool.poolInfo.tokenAAmount.toString(), stabelPool.poolInfo.tokenBAmount.toString(),
        stabelPool.vaultB.tokenMint.decimals - stabelPool.vaultA.tokenMint.decimals);

    const priceInUsd = priceInSol * getCachedSolPrice();
    // console.log("Meteora Amm", Date.now);
    return { dex: "Meteora AMM", poolId: poolAccount.toBase58(), liquidity, priceInSol, priceInUsd };
  } catch (error) {
    console.error("Error fetching Meteora AMM token price:", error);
    throw error;
    // return null
  }
};

async function getAmmPool(mint: PublicKey) {
  const provider = new AnchorProvider(
    connection,
    {} as any,
    AnchorProvider.defaultOptions()
  );
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

  return [...poolsForTokenAMint, ...poolsForTokenBMint];
}

export const getMeteoraAmmPool = async (ca: string, isGetAll?: boolean) => {
  const mint = new PublicKey(ca);
  const ammPools = await getAmmPool(mint);
  if (ammPools.length === 0) throw new Error("No Meteora AMM pool found");
  if (isGetAll) {
    const pools = ammPools.map((pool) =>
      pool.publicKey.toBase58(),
    );
    return {
      dex: "Meteora AMM",
      pools
    }
  }
  const tokenAmounts = await Promise.all(
    ammPools.map((pool) =>
      connection.getTokenAccountBalance(
        pool.account.tokenAMint.toBase58() === spl.NATIVE_MINT.toBase58()
          ? pool.account.aVaultLp
          : pool.account.bVaultLp
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
  //   console.log("- Meteora AMM:", ammPools[maxIndex].publicKey.toBase58());
  const poolId = ammPools[maxIndex].publicKey;

  return poolId;
};
