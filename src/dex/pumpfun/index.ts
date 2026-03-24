import * as spl from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { PUMP_FUN_PROGRAM, PUMP_TOKEN_DECIMALS } from "./constants";
import { readBigUintLE } from "./utils";
import { executeRpcCall } from "../../config";
import { getCachedSolPrice } from "../../service";
import { pumpfunCache, PumpfunPriceResult } from "../../cache/pumpfunCache";
import { getPumpAmmPriceInfo } from "./amm";

export async function getPumpPriceInfo(ca: string) {
  // Check cache first
  const cached = await pumpfunCache.getCachedToken(ca);
  
  if (cached && cached.bonding_curve_address) {
    // Use cached bonding curve address
    const bondingCurveAddress = new PublicKey(cached.bonding_curve_address);
    const fromCache = true;
    return await calculatePumpPrice(ca, bondingCurveAddress, fromCache);
  } else {
    // Derive bonding curve address
    const mint = new PublicKey(ca);
    const [bondingCurveAddress] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mint.toBuffer()],
      new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
    );
    
    // Calculate price
    const result = await calculatePumpPrice(ca, bondingCurveAddress, false);
    
    // If successful, cache the data for future requests
    if (result.priceInUsd && !isNaN(result.priceInUsd)) {
      await pumpfunCache.cachePumpfunBondingCurveAddress(
        ca, 
        bondingCurveAddress.toBase58(), 
        PUMP_TOKEN_DECIMALS
      );
    }
    
    return result;
  }
}

async function calculatePumpPrice(
  ca: string,
  bondingCurveAddress: PublicKey,
  fromCache: boolean
): Promise<PumpfunPriceResult> {
  try {
    const solPrice = getCachedSolPrice();
    
    // Use circuit breaker for RPC calls
    const bondingCurveData = await executeRpcCall(async (connection) => {
      return connection.getAccountInfo(bondingCurveAddress);
    });

    if (!bondingCurveData) {
      // If bonding curve not found, token might have graduated to AMM
      try {
        console.log(`[PUMPFUN] Bonding curve not found for ${ca}, checking AMM...`);
        return await getPumpAmmPriceInfo(ca);
      } catch (ammError) {
        throw new Error("Token not found on PumpFun bonding curve or AMM");
      }
    }

    // Use the CORRECT offsets from the old working code
    const PUMP_CURVE_STATE_OFFSETS = {
      VIRTUAL_TOKEN_RESERVES: 0x08,
      VIRTUAL_SOL_RESERVES: 0x10,
      REAL_TOKEN_RESERVES: 0x18,
      REAL_SOL_RESERVES: 0x20,
      TOTAL_SUPPLY: 0x28,
    };

    // Use BigInt to read the big numbers in the data buffer (matching old working code)
    const virtualTokenReserves = readBigUintLE(
      bondingCurveData.data,
      PUMP_CURVE_STATE_OFFSETS.VIRTUAL_TOKEN_RESERVES,
      8
    );
    const virtualSolReserves = readBigUintLE(
      bondingCurveData.data,
      PUMP_CURVE_STATE_OFFSETS.VIRTUAL_SOL_RESERVES,
      8
    );
    const realTokenReserves = readBigUintLE(
      bondingCurveData.data,
      PUMP_CURVE_STATE_OFFSETS.REAL_TOKEN_RESERVES,
      8
    );
    const realSolReserves = readBigUintLE(
      bondingCurveData.data,
      PUMP_CURVE_STATE_OFFSETS.REAL_SOL_RESERVES,
      8
    );
    const totalSupply = readBigUintLE(
      bondingCurveData.data,
      PUMP_CURVE_STATE_OFFSETS.TOTAL_SUPPLY,
      8
    );

    // Validate reserves to avoid division by zero 
    if (virtualSolReserves === 0 || virtualTokenReserves === 0) {
      throw new Error("Invalid bonding curve reserves");
    }

    // Calculate price using the OLD WORKING FORMULA
    const priceInSol = virtualSolReserves / LAMPORTS_PER_SOL / (virtualTokenReserves / 10 ** PUMP_TOKEN_DECIMALS);

    // Calculate price per token: price = SOL reserves / Token reserves
    const priceInUsd = priceInSol * solPrice;

    // Calculate bonding curve progress using the OLD WORKING FORMULA
    const leftTokens = realTokenReserves - 206900000;
    const initialRealTokenReserves = totalSupply - 206900000;
    const progress = 100 - (leftTokens * 100) / initialRealTokenReserves;

    // Removed debug logging - comment out if needed for debugging
    // console.log(`[PUMPFUN] Price: ${priceInSol} SOL, Progress: ${progress}%`);

    return {
      dex: "PumpFun",
      liquidity: undefined, // The old code had liquidity undefined
      priceInSol,
      priceInUsd,
      bondingCurveProgress: progress,
    };
  } catch (error) {
    throw new Error(`Failed to fetch PumpFun price: ${error instanceof Error ? error.message : error}`);
  }
}
