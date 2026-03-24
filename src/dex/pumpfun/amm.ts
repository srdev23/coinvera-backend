import { bool, publicKey, struct, u16, u64, u8 } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import { BN } from "bn.js";
import { executeRpcCall } from "../../config";
import { NATIVE_MINT } from "@solana/spl-token";
import { getCachedSolPrice } from "../../service";
import { PUMP_AMM_PROGRAM, PUMP_FUN_PROGRAM, PUMP_TOKEN_DECIMALS } from "./constants";
import { pumpfunCache } from "../../cache/pumpfunCache";

function poolPda(
  index: number,
  owner: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  programId: PublicKey = PUMP_AMM_PROGRAM
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      new BN(index).toArrayLike(Buffer, "le", 2),
      owner.toBuffer(),
      baseMint.toBuffer(),
      quoteMint.toBuffer(),
    ],
    programId
  );
}

function pumpPoolAuthorityPda(
  mint: PublicKey,
  pumpProgramId: PublicKey = PUMP_FUN_PROGRAM
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), mint.toBuffer()],
    pumpProgramId
  );
}

function canonicalPumpPoolPda(
  mint: PublicKey,
  programId: PublicKey = PUMP_AMM_PROGRAM,
  pumpProgramId: PublicKey = PUMP_FUN_PROGRAM,
): [PublicKey, number] {
  const [pumpPoolAuthority] = pumpPoolAuthorityPda(mint, pumpProgramId);

  return poolPda(
    0, //CANONICAL_POOL_INDEX,
    pumpPoolAuthority,
    mint,
    NATIVE_MINT,
    programId
  );
}

export function getPumpAmmPool(ca: string){
  const mint = new PublicKey(ca);
  const pool = canonicalPumpPoolPda(mint)[0];
  return {
    dex: "Pumpfun Amm",
    pool: pool.toBase58()
  }
}

export async function getPumpAmmPriceInfo(ca: string) {
  try {
    const solPrice = getCachedSolPrice();
    const cached = await pumpfunCache.getCachedToken(ca);
    
    if (cached && cached.pool_id && cached.pool_base_token_account && cached.pool_quote_token_account) {
      // Use cached vault addresses
      const poolId = cached.pool_id;
      const baseTokenAccount = new PublicKey(cached.pool_base_token_account);
      const quoteTokenAccount = new PublicKey(cached.pool_quote_token_account);
      
      // Fetch real-time vault balances using circuit breaker
      const [baseTokenBalance, quoteTokenBalance] = await Promise.all([
        executeRpcCall(async (connection) => connection.getTokenAccountBalance(baseTokenAccount)),
        executeRpcCall(async (connection) => connection.getTokenAccountBalance(quoteTokenAccount))
      ]);
      
      const priceInSol = baseTokenBalance.value.uiAmount && quoteTokenBalance.value.uiAmount
        ? quoteTokenBalance.value.uiAmount / baseTokenBalance.value.uiAmount
        : 0;
      
      const priceInUsd = priceInSol * solPrice;
      const liquidity = baseTokenBalance.value.uiAmount && quoteTokenBalance.value.uiAmount
        ? (baseTokenBalance.value.uiAmount * priceInUsd) + (quoteTokenBalance.value.uiAmount * solPrice)
        : 0;
      
      return {
        dex: "PumpFun AMM",
        poolId,
        liquidity,
        priceInSol,
        priceInUsd,
      };
    }
    
    // No cached data or token not migrated, fetch fresh data
    const mint = new PublicKey(ca);
    const pumpAmmPoolId = canonicalPumpPoolPda(mint)[0];
    const poolAccountInfo = await executeRpcCall(async (connection) => {
      return connection.getAccountInfo(pumpAmmPoolId);
    });
    
    if (!poolAccountInfo) {
      throw new Error("AMM pool not found");
    }
    
    const poolData = Buffer.from(poolAccountInfo.data);
    const baseTokenAccount = new PublicKey(poolData.subarray(72, 104));
    const quoteTokenAccount = new PublicKey(poolData.subarray(104, 136));
    
    const [baseTokenBalance, quoteTokenBalance] = await Promise.all([
      executeRpcCall(async (connection) => connection.getTokenAccountBalance(baseTokenAccount)),
      executeRpcCall(async (connection) => connection.getTokenAccountBalance(quoteTokenAccount))
    ]);
    
    const priceInSol = baseTokenBalance.value.uiAmount && quoteTokenBalance.value.uiAmount
      ? quoteTokenBalance.value.uiAmount / baseTokenBalance.value.uiAmount
      : 0;
    
    const priceInUsd = priceInSol * solPrice;
    const liquidity = baseTokenBalance.value.uiAmount && quoteTokenBalance.value.uiAmount
      ? (baseTokenBalance.value.uiAmount * priceInUsd) + (quoteTokenBalance.value.uiAmount * solPrice)
      : 0;
    
    // Cache the vault addresses for future use
    await pumpfunCache.cachePumpfunAmmVaultData(
      ca,
      pumpAmmPoolId.toBase58(),
      baseTokenAccount.toBase58(),
      quoteTokenAccount.toBase58(),
      PUMP_TOKEN_DECIMALS
    );
    
    return {
      dex: "PumpFun AMM",
      poolId: pumpAmmPoolId.toBase58(),
      liquidity,
      priceInSol,
      priceInUsd,
    };
  } catch (error) {
    throw new Error(`PumpFun AMM price fetch failed: ${error instanceof Error ? error.message : error}`);
  }
}

// Calculate AMM price using cached vault addresses (fresh balance data)
async function calculateAmmPriceFromCachedVaults(ca: string, cached: any) {
  const [baseTokenBalance, quoteTokenBalance] = await Promise.all([
    executeRpcCall(async (connection) => connection.getTokenAccountBalance(new PublicKey(cached.pool_base_token_account))),
    executeRpcCall(async (connection) => connection.getTokenAccountBalance(new PublicKey(cached.pool_quote_token_account)))
  ]);

  const liquidity = 2 * (quoteTokenBalance.value.uiAmount ?? 0) * getCachedSolPrice();
  const priceInSol = (quoteTokenBalance.value.uiAmount ?? 0) / (baseTokenBalance.value.uiAmount ?? 1);
  const priceInUsd = priceInSol * getCachedSolPrice();
  
  return {
    dex: "pumpfun amm",
    poolId: cached.pool_id,
    liquidity,
    priceInSol,
    priceInUsd
  };
}

// Fetch AMM data from chain and cache vault addresses
async function fetchAndCacheAmmData(ca: string) {
  const mint = new PublicKey(ca);
  const pool = canonicalPumpPoolPda(mint)[0];
  const accountInfo = await executeRpcCall(async (connection) => {
    return connection.getAccountInfo(pool);
  });
  if (!accountInfo)
    throw new Error("Not a pumpAmm token");

  const poolStructure = struct([
    u8("poolBump"),
    u16("index"),
    publicKey("creator"),
    publicKey("baseMint"),
    publicKey("quoteMint"),
    publicKey("lpMint"),
    publicKey("poolBaseTokenAccount"),
    publicKey("poolQuoteTokenAccount"),
    u64("lpSupply"),
    publicKey("coinCreator"),
  ]);

  const dataWithoutDiscriminator = accountInfo.data.slice(8);
  const decoded = poolStructure.decode(dataWithoutDiscriminator);

  // Cache the AMM vault addresses (permanent)
  await pumpfunCache.cachePumpfunAmmVaultData(
    ca,
    pool.toBase58(),
    decoded.poolBaseTokenAccount.toBase58(),
    decoded.poolQuoteTokenAccount.toBase58(),
    6 // Default token decimals
  );

  // Calculate price from the fetched data
  const [baseTokenBalance, quoteTokenBalance] = await Promise.all([
    executeRpcCall(async (connection) => connection.getTokenAccountBalance(decoded.poolBaseTokenAccount)),
    executeRpcCall(async (connection) => connection.getTokenAccountBalance(decoded.poolQuoteTokenAccount))
  ]);

  const liquidity = 2 * (quoteTokenBalance.value.uiAmount ?? 0) * getCachedSolPrice();
  const priceInSol = (quoteTokenBalance.value.uiAmount ?? 0) / (baseTokenBalance.value.uiAmount ?? 1);
  const priceInUsd = priceInSol * getCachedSolPrice();
  
  return {
    dex: "pumpfun amm",
    poolId: pool.toBase58(),
    liquidity,
    priceInSol,
    priceInUsd
  };
}