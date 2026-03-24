import { Moonshot, Environment } from "@wen-moon-ser/moonshot-sdk";
import { connectionPool } from "../../config";
import { getCachedSolPrice } from "../../service";

export async function getMoonshotPriceInfo(ca: string) {
  try {
    // Get the highest priority RPC URL from connection pool
    const rpcUrl = connectionPool.getCurrentRpcUrl();
    
    const moonshot = new Moonshot({
      rpcUrl: rpcUrl, // Use prioritized RPC URL from connection pool
      authToken: "YOUR_AUTH_TOKEN",
      environment: Environment.MAINNET,
    });

    const token = moonshot.Token({
      mintAddress: ca,
    });
    const curvePos = await token.getCurvePosition();
    const collateralPrice = await token.getCollateralPrice({
      tokenAmount: BigInt(1e9), // 1 token in minimal units
      curvePosition: curvePos,
    });
    const priceInSol = Number(collateralPrice) / 1e9; // Convert lamports to SOL
    const priceInUsd = priceInSol * getCachedSolPrice();
    //   console.log("Moonshot", Date.now());

    return { dex: "Moonshot", liquidity: undefined, priceInSol, priceInUsd };
  } catch (error) {
    console.error("Error fetching moonshot token info", error);
    throw error;
    // return null;
  }
}
