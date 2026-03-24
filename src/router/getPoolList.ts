import {
  getPumpPriceInfo,
  getMoonshotPriceInfo,
  getRayCpmmPool,
  getRayClmmPool,
  getRayAmmPool,
  getMeteoraAmmPool,
  getMeteoraDlmmPool,
} from "../dex";

import { getPumpAmmPool } from "../dex/pumpfun/amm";

// Helper function to get token pool list
export async function handlePoolRequest(req: any, res: any) {
  const now_t = Date.now();
  try {
    const ca = req.query.ca as string;
    if (ca) {
      const result = await getPoolList(ca);
      console.log(`\n-[GET] Request (${ca || 'all'}):`, result, Date.now() - now_t + "ms");
      res.status(200).json(result);
    } else {
      res.status(200).json({
        ca,
        success: false,
        error: "Failed to fetch token information",
      });
    }
  } catch (error) {
    console.error(error);
    if(error instanceof Error) {
      if(error.message === "All promises were rejected")
        res.status(400).json({ error: "Couldn't find any pool for this token" });
      else
        res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
}

// Function to get token pool list from various DEXs
async function getPoolList(ca: string) {
  const promise_array = [];
  promise_array.push(getPumpPriceInfo(ca));
  promise_array.push(getPumpAmmPool(ca));
  promise_array.push(getMoonshotPriceInfo(ca));
  promise_array.push(getMeteoraAmmPool(ca, true));
  promise_array.push(getMeteoraDlmmPool(ca, true));
  promise_array.push(getRayAmmPool(ca, undefined, true));
  promise_array.push(getRayClmmPool(ca, undefined, true));
  promise_array.push(getRayCpmmPool(ca, undefined, true));

  const result_promise = await Promise.allSettled(promise_array);
  // Filter successful results and select the best one
  if (result_promise.length === 0) {
    throw new Error('No successful price data found from any DEX');
  }
  const filteredRes = result_promise.map((res, idx) => {
    if(res.status === 'fulfilled'){
      if(idx === 0)
        return {
          dex: "pumpfun"
      }
      else if(idx === 2)
        return {
          dex: "moonshot"
      }
      return res.value;
    }
    else
      return null;
  });
  // Filter out null values
  const validResults = filteredRes.filter((res) => res !== null);
  return validResults;
}