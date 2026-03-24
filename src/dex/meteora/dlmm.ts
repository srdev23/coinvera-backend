import { PublicKey, Connection } from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import { AccountLayout } from "@solana/spl-token";
import DLMM, { IDL, LBCLMM_PROGRAM_IDS } from "@meteora-ag/dlmm";
import { AnchorProvider, Program } from "@project-serum/anchor";
import { CLEAR_CACHE_INTERVAL, connection, executeRpcCall } from "../../config";
import { getCachedSolPrice } from "../../service";

const cachePoolInfo = new Map<string, PublicKey>();
setInterval(() => {
  cachePoolInfo.clear();
}, CLEAR_CACHE_INTERVAL);

export const getMeteDlmmPriceInfo = async (ca: string, poolId?: string) => {
  try {
    const mint = new PublicKey(ca);

    //  Get pool ID
    let poolAccount = poolId ? new PublicKey(poolId) : cachePoolInfo.get(ca);

    if (poolAccount === undefined) {
      poolAccount = (await getMeteoraDlmmPool(ca)) as PublicKey;
      cachePoolInfo.set(ca, poolAccount);
    }

    // ULTIMATE OPTIMIZATION: Single RPC call for all data
    const poolAccountInfo = await executeRpcCall(async (connection: Connection) => {
      return connection.getAccountInfo(poolAccount);
    });
    if (!poolAccountInfo) throw new Error("Pool account not found");
    
    // Parse reserve addresses from pool data (DLMM LB Pair structure)
    const poolData = poolAccountInfo.data;
    const tokenXMint = new PublicKey(poolData.slice(88, 120));
    const tokenYMint = new PublicKey(poolData.slice(120, 152)); 
    const reserveX = new PublicKey(poolData.slice(152, 184));
    const reserveY = new PublicKey(poolData.slice(184, 216));
    
    // Determine which token is the base token
    const isBaseToken = tokenXMint.equals(mint);
    
    // SINGLE BATCHED RPC CALL: Get all accounts at once
    const [reserveXInfo, reserveYInfo] = await executeRpcCall(async (connection: Connection) => {
      return connection.getMultipleAccountsInfo([reserveX, reserveY]);
    });
    
    if (!reserveXInfo || !reserveYInfo) {
      throw new Error("Could not fetch reserve account info");
    }
    
    // Parse token account balances manually for speed
    const reserveXData = AccountLayout.decode(reserveXInfo.data);
    const reserveYData = AccountLayout.decode(reserveYInfo.data);
    
    // Get decimals from mint (we know SOL is 9 decimals)
    const wsol_amount = isBaseToken 
      ? Number(reserveYData.amount) / 1e9  // reserveY (SOL)
      : Number(reserveXData.amount) / 1e9; // reserveX (SOL)
    
    const liquidity = 2 * wsol_amount * getCachedSolPrice();
    if (liquidity === 0) throw new Error("No liquidity");
    
    // FASTEST PRICE: Only call DLMM SDK for price (unavoidable for DLMM)
    const priceResult = await executeRpcCall(async (connection: Connection) => {
      const dlmmPool = await DLMM.create(connection, poolAccount);
      const activeBin = await dlmmPool.getActiveBin();
      const price = Number(activeBin.pricePerToken);
      const priceInSol = isBaseToken ? price : 1 / price;
      return { priceInSol };
    });
    const priceInUsd = priceResult.priceInSol * getCachedSolPrice();
    // console.log("Meteora Dlmm", Date.now());

    return { dex: "Meteora DLMM", poolId: poolAccount.toBase58(), liquidity, priceInSol: priceResult.priceInSol, priceInUsd };
  } catch (error) {
    console.error("Error fetching Meteora DLMM token price:", error);
    throw error
    // return null
  }
};

async function getLbPairsForTokens(mint: PublicKey) {
  const provider = new AnchorProvider(
    connection,
    {} as any,
    AnchorProvider.defaultOptions()
  );
  const program = new Program(
    IDL,
    LBCLMM_PROGRAM_IDS["mainnet-beta"],
    provider
  );

  const [poolsForTokenAMint, poolsForTokenBMint] = await Promise.all([
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

  return [...poolsForTokenAMint, ...poolsForTokenBMint];
}

export const getMeteoraDlmmPool = async (ca: string, isGetAll?: boolean) => {
  const mint = new PublicKey(ca);
  const lbPairs = await getLbPairsForTokens(mint);
  if (lbPairs.length === 0) {
    throw new Error("No LB pair found for token");
  }
  if (isGetAll) {
    const pools = lbPairs.map((pool) =>
      pool.publicKey.toBase58(),
    );
    return {
      dex: "Meteora Dlmm",
      pools
    }
  }
  const tokenAmounts = await Promise.all(
    lbPairs.map((lbPair) =>
      connection.getTokenAccountBalance(
        lbPair.account.tokenXMint.toBase58() === spl.NATIVE_MINT.toBase58()
          ? lbPair.account.reserveX
          : lbPair.account.reserveY
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
  //   console.log("- Meteora DLMM:", lbPairs[maxIndex].publicKey.toBase58());

  return lbPairs[maxIndex].publicKey;
};
