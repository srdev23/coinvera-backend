import {
  getPumpPriceInfo,
  getMoonshotPriceInfo,
  getCachedRaydiumPriceInfo,
  getCachedMeteoraPriceInfo,
  getCachedLaunchLabPriceInfo,
} from "../dex";
import { calculateTotalPercentage, convertNumbersAndCleanObject, getHolders, getTokenMetaData } from "../service";
import { API_TYPE, DEX_TYPE } from "../service/type";
import { getPumpAmmPriceInfo } from "../dex/pumpfun/amm";
import { pumpfunCache } from "../cache/pumpfunCache";
import { RaydiumCache } from "../cache/raydiumCache";
import { MeteoraCache } from "../cache/meteoraCache";
import { launchlabCache } from "../cache/launchlabCache";
import { findSpecificPool, getPriceFromSpecificPool } from "../service/poolSearch";

// Request deduplication and batching system
interface PendingRequest {
  promise: Promise<any>;
  timestamp: number;
  userId: string;
  requestCount: number;
}

interface RequestBatch {
  tokens: Set<string>;
  users: Set<string>;
  timestamp: number;
  promise?: Promise<any>;
}

const pendingRequests = new Map<string, PendingRequest>();
const requestBatches = new Map<string, RequestBatch>();
const REQUEST_TIMEOUT = 15000; // 15 seconds timeout
const BATCH_WINDOW = 50; // 50ms batch window
const MAX_CONCURRENT_REQUESTS = 100; // Max concurrent requests per token

// Performance monitoring
const performanceMetrics = {
  activeRequests: 0,
  totalRequests: 0,
  cacheHitRate: 0,
  avgResponseTime: 0,
  requestsPerSecond: 0,
  lastResetTime: Date.now()
};

// Clean up expired requests and reset metrics
setInterval(() => {
  const now = Date.now();
  
  // Clean up expired requests
  for (const [key, request] of pendingRequests.entries()) {
    if (now - request.timestamp > REQUEST_TIMEOUT) {
      pendingRequests.delete(key);
      performanceMetrics.activeRequests = Math.max(0, performanceMetrics.activeRequests - 1);
    }
  }
  
  // Clean up expired batches
  for (const [key, batch] of requestBatches.entries()) {
    if (now - batch.timestamp > BATCH_WINDOW * 2) {
      requestBatches.delete(key);
    }
  }
  
  // Reset performance metrics every minute
  if (now - performanceMetrics.lastResetTime > 60000) {
    performanceMetrics.requestsPerSecond = performanceMetrics.totalRequests;
    performanceMetrics.totalRequests = 0;
    performanceMetrics.lastResetTime = now;
    
    // Log performance stats
    if (performanceMetrics.requestsPerSecond > 50) {
      console.log(`[PERF] High load: ${performanceMetrics.requestsPerSecond} req/s, Active: ${performanceMetrics.activeRequests}, Cache hit: ${performanceMetrics.cacheHitRate.toFixed(1)}%`);
    }
  }
}, 5000);

// Strict API key-based user identification (no IP fallback)
function getUserId(req: any): string {
  // Try to get user ID from auth middleware first
  if (req.user?.id) {
    return req.user.id;
  }
  
  // Get API key from headers or query - REQUIRED for identification
  const apiKey = req.headers["x-api-key"] || req.query["x-api-key"];
  if (apiKey && typeof apiKey === 'string') {
    return `api_${apiKey.substring(0, 12)}`;
  }
  
  // No API key provided - cannot identify user
  // This should not happen since auth middleware should catch this
  throw new Error("API key is required for user identification");
}

// Smart deduplication that batches requests intelligently
async function smartRequestHandler(userId: string, ca: string, dex?: DEX_TYPE, poolId?: string, type?: API_TYPE): Promise<any> {
  const requestKey = `${ca}:${dex || 'all'}:${poolId || 'none'}`;
  const userRequestKey = `${userId}:${requestKey}`;
  const now = Date.now();
  
  performanceMetrics.activeRequests++;
  performanceMetrics.totalRequests++;
  
  try {
    // Check if this exact request from this user is already in progress
    if (pendingRequests.has(userRequestKey)) {
      const existing = pendingRequests.get(userRequestKey)!;
      existing.requestCount++;
      console.log(`[DEDUP] User ${userId} request for ${ca} already in progress (${existing.requestCount} duplicates)`);
      return await existing.promise;
    }
    
    // Check if we can batch this request with others for the same token
    const batchKey = requestKey;
    if (!requestBatches.has(batchKey)) {
      requestBatches.set(batchKey, {
        tokens: new Set([ca]),
        users: new Set([userId]),
        timestamp: now
      });
      
      // Start batch processing after BATCH_WINDOW
      setTimeout(() => {
        processBatch(batchKey, dex, poolId, type);
      }, BATCH_WINDOW);
    } else {
      // Add to existing batch
      const batch = requestBatches.get(batchKey)!;
      batch.users.add(userId);
      
      // If batch already has a promise, wait for it
      if (batch.promise) {
        return await batch.promise;
      }
    }
    
    // Check concurrent request limits per token
    const concurrentCount = Array.from(pendingRequests.keys())
      .filter(key => key.includes(ca)).length;
    
    if (concurrentCount > MAX_CONCURRENT_REQUESTS) {
      throw new Error(`Too many concurrent requests for token ${ca}. Please try again later.`);
    }
    
    // Create and track the request
    const requestPromise = getTokenInfo(ca, dex, poolId, type);
    
    pendingRequests.set(userRequestKey, {
      promise: requestPromise,
      timestamp: now,
      userId,
      requestCount: 1
    });
    
    try {
      const result = await requestPromise;
      
      // Update performance metrics
      performanceMetrics.avgResponseTime = (performanceMetrics.avgResponseTime + (Date.now() - now)) / 2;
      
      return result;
    } finally {
      pendingRequests.delete(userRequestKey);
      performanceMetrics.activeRequests = Math.max(0, performanceMetrics.activeRequests - 1);
    }
    
  } catch (error) {
    performanceMetrics.activeRequests = Math.max(0, performanceMetrics.activeRequests - 1);
    throw error;
  }
}

// Batch processing for similar requests
async function processBatch(batchKey: string, dex?: DEX_TYPE, poolId?: string, type?: API_TYPE) {
  const batch = requestBatches.get(batchKey);
  if (!batch || batch.promise) return;
  
  const [ca] = Array.from(batch.tokens);
  console.log(`[BATCH] Processing batch for ${ca} with ${batch.users.size} users`);
  
  const batchPromise = getTokenInfo(ca, dex, poolId, type);
  batch.promise = batchPromise;
  
  try {
    const result = await batchPromise;
    console.log(`[BATCH] Completed batch for ${ca} serving ${batch.users.size} users`);
    return result;
  } catch (error) {
    console.error(`[BATCH] Batch failed for ${ca}:`, error instanceof Error ? error.message : error);
    throw error;
  }
}

// Helper function to handle token requests with enhanced error handling
export async function handleTokenRequest(req: any, res: any, dex?: DEX_TYPE, type?: API_TYPE) {
  const startTime = Date.now();
  const userId = getUserId(req);
  
  try {
    const ca = req.query.ca as string;
    const poolId = req.query.poolId as string;
    const tokensParam = req.query.tokens as string;
    
    if (ca) {
      // Single token request
      const result = await smartRequestHandler(userId, ca, dex, poolId, type);
      const duration = Date.now() - startTime;
      
      console.log(`[TOKEN] Request completed for ${ca} (${dex || 'all'}) by ${userId} in ${duration}ms`);
      res.status(200).json(result);
      
    } else if (tokensParam) {
      // Batch token request
      const tokenAddresses = tokensParam.split(",").map((addr) => addr.trim());
      
      // Validate batch size
      if (tokenAddresses.length > 20) {
        return res.status(400).json({ error: "Maximum 20 tokens per batch request" });
      }
      
      const results = await Promise.allSettled(
        tokenAddresses.map(async (tokenCa) => {
          try {
            const result = await smartRequestHandler(userId, tokenCa, dex, undefined, type);
            return {
              ...result,
              success: true,
            };
          } catch (error) {
            return {
              ca: tokenCa,
              success: false,
              error: error instanceof Error ? error.message : "Failed to fetch token information",
            };
          }
        })
      );
      
      const finalResults = results.map(result => 
        result.status === 'fulfilled' ? result.value : {
          success: false,
          error: "Request timeout or internal error"
        }
      );
      
      const duration = Date.now() - startTime;
      console.log(`[BATCH] Completed ${tokenAddresses.length} tokens by ${userId} in ${duration}ms`);
      res.status(200).json(finalResults);
      
    } else {
      res.status(400).json({ error: "Either 'ca' or 'tokens' parameter is required" });
    }
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    // Enhanced error handling for server environment
    if (error instanceof Error) {
      console.error(`[ERROR] Request failed by ${userId} in ${duration}ms:`, error.message);
      
      // Migration-specific error handling
      if (error.message.includes("Token") && error.message.includes("not found on any supported DEX")) {
        res.status(404).json({ 
          error: "Token not found on any supported DEX",
          message: "This token may not exist, may not be actively traded, or may be on an unsupported platform.",
          supportedDexs: ['PumpFun', 'PumpFun AMM', 'Raydium', 'Meteora', 'LaunchLab', 'Moonshot']
        });
      } else if (error.message.includes("graduated from its launch platform")) {
        res.status(400).json({ 
          error: "Token migration detected",
          message: "This token has graduated from its launch platform. It may now be available on other DEXs with higher liquidity.",
          suggestion: "Check permanent DEXs like Raydium, Meteora, or PumpFun AMM for current pricing."
        });
      } else if (error.message.includes("migrated to a new platform")) {
        res.status(400).json({ 
          error: "Token migration possible",
          message: "This token may have migrated to a new platform or may not be actively traded.",
          suggestion: "Token migrations are common as projects grow. Check official project channels for current trading information."
        });
      } else if (error.message.includes("Network issues encountered")) {
        res.status(503).json({ 
          error: "Network connectivity issues",
          message: "Temporary network issues while searching for token price. Please try again in a moment.",
          retryable: true
        });
      } else if (error.message === "All promises were rejected") {
        res.status(400).json({ 
          error: "Token price unavailable",
          message: "Could not retrieve price data for this token. It may have migrated between platforms or may not be actively traded.",
          suggestion: "Try again in a few minutes or check if the token is available on other platforms."
        });
      } else if (error.message.includes("Too many concurrent requests")) {
        res.status(429).json({ error: error.message });
      } else if (error.message.includes("API key is required")) {
        res.status(401).json({ error: "API key is required for authentication" });
      } else if (error.message.includes("circuit breaker is OPEN")) {
        res.status(503).json({ error: "Service temporarily unavailable. Please try again later." });
      } else if (error.message.includes("timeout") || error.message.includes("fetch failed")) {
        res.status(503).json({ error: "Service temporarily unavailable due to network issues. Please try again." });
      } else {
        res.status(400).json({ error: error.message });
      }
    } else {
      console.error(`[ERROR] Unknown error for ${userId} in ${duration}ms:`, error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
}

// Comprehensive DEX refresh function for handling token migrations
async function refreshAllDexPools(ca: string): Promise<{
  results: any[];
  migratedFrom?: string;
  migratedTo?: string;
}> {
  console.log(`[MIGRATION] Performing comprehensive refresh for ${ca}`);
  
  // DON'T use cached functions - import the raw DEX functions for fresh searches
  const refreshPromises = [
    // Pumpfun - try both bonding curve and AMM with fresh searches
    (async () => {
      try {
        const result = await getPumpPriceInfo(ca);
        return { source: 'pumpfun', data: result, success: true };
      } catch (error) {
        return { source: 'pumpfun', success: false, error };
      }
    })(),
    
    (async () => {
      try {
        const result = await getPumpAmmPriceInfo(ca);
        return { source: 'pumpfun_amm', data: result, success: true };
      } catch (error) {
        return { source: 'pumpfun_amm', success: false, error };
      }
    })(),
    
    // Raydium - clear cache first, then try fresh search
    (async () => {
      try {
        RaydiumCache.clearTokenCache(ca);
        const result = await getCachedRaydiumPriceInfo(ca);
        return { source: 'raydium', data: result, success: true };
      } catch (error) {
        return { source: 'raydium', success: false, error };
      }
    })(),
    
    // Meteora - clear cache first, then try fresh search
    (async () => {
      try {
        MeteoraCache.clearTokenCache(ca);
        const result = await getCachedMeteoraPriceInfo(ca);
        return { source: 'meteora', data: result, success: true };
      } catch (error) {
        return { source: 'meteora', success: false, error };
      }
    })(),
    
    // LaunchLab - clear cache first, then try fresh search
    (async () => {
      try {
        await launchlabCache.clearTokenCache(ca);
        const result = await getCachedLaunchLabPriceInfo(ca);
        return { source: 'launchlab', data: result, success: true };
      } catch (error) {
        return { source: 'launchlab', success: false, error };
      }
    })(),
    
    // Moonshot - no cache involved
    (async () => {
      try {
        const result = await getMoonshotPriceInfo(ca);
        return { source: 'moonshot', data: result, success: true };
      } catch (error) {
        return { source: 'moonshot', success: false, error };
      }
    })()
  ];
  
  const refreshResults = await Promise.all(refreshPromises);
  
  // Separate successful and failed results
  const successfulResults = refreshResults.filter(r => r.success);
  const failedResults = refreshResults.filter(r => !r.success);
  
  console.log(`[MIGRATION] Refresh complete: ${successfulResults.length} successful, ${failedResults.length} failed`);
  
  // Handle cache updates for token migrations - only when we have clear evidence
  await handleTokenMigration(ca, successfulResults, failedResults);
  
  return {
    results: successfulResults.map(r => r.data),
    migratedFrom: await detectMigrationSource(ca, failedResults),
    migratedTo: detectMigrationTarget(successfulResults)
  };
}

// Handle token migration cache updates - CONSERVATIVE APPROACH
async function handleTokenMigration(ca: string, successfulResults: any[], failedResults: any[]): Promise<void> {
  // Check what failed and what succeeded
  const pumpfunBondingFailed = failedResults.some(r => r.source === 'pumpfun');
  const launchlabFailed = failedResults.some(r => r.source === 'launchlab');
  
  // Check what permanent platforms succeeded
  const permanentPlatformsSucceeded = successfulResults.filter(r => 
    ['pumpfun_amm', 'raydium', 'meteora'].includes(r.source)
  );
  
  // CONSERVATIVE REMOVAL: Only remove temporary caches if we have strong evidence of migration
  
  // Remove pumpfun bonding curve cache ONLY if:
  // 1. Pumpfun bonding curve failed AND
  // 2. We found the token on permanent platforms (especially pumpfun_amm) AND
  // 3. The error suggests graduation (not just a temporary failure)
  if (pumpfunBondingFailed && permanentPlatformsSucceeded.length > 0) {
    const pumpfunError = failedResults.find(r => r.source === 'pumpfun')?.error;
    const isGraduationError = pumpfunError && (
      pumpfunError.message?.includes('graduated') ||
      pumpfunError.message?.includes('AMM') ||
      pumpfunError.message?.includes('bonding curve not found')
    );
    
    if (isGraduationError) {
      console.log(`[MIGRATION] Token ${ca} graduated from pumpfun, clearing bonding curve cache`);
      try {
        await pumpfunCache.removePumpfunBondingCurveData(ca);
      } catch (error) {
        console.warn(`[MIGRATION] Failed to remove pumpfun bonding curve cache: ${error}`);
      }
    }
  }
  
  // Remove launchlab cache ONLY if:
  // 1. LaunchLab failed AND
  // 2. We found the token on permanent platforms AND
  // 3. The error suggests graduation (not just a temporary failure)
  if (launchlabFailed && permanentPlatformsSucceeded.length > 0) {
    const launchlabError = failedResults.find(r => r.source === 'launchlab')?.error;
    const isGraduationError = launchlabError && (
      launchlabError.message?.includes('graduated') ||
      launchlabError.message?.includes('graduated from LaunchLab')
    );
    
    if (isGraduationError) {
      console.log(`[MIGRATION] Token ${ca} graduated from launchlab, clearing cache`);
      try {
        await launchlabCache.removeToken(ca);
      } catch (error) {
        console.warn(`[MIGRATION] Failed to remove launchlab cache: ${error}`);
      }
    }
  }
  
  // Clear meteora negative results if we successfully found meteora pools
  const meteoraSuccess = successfulResults.some(r => r.source === 'meteora');
  if (meteoraSuccess) {
    try {
      MeteoraCache.clearNegativeResults(ca);
    } catch (error) {
      console.warn(`[MIGRATION] Failed to clear meteora negative results: ${error}`);
    }
  }
  
  // NEVER REMOVE permanent platform caches (raydium, meteora, pumpfun_amm)
  // These are preserved as tokens can exist on multiple DEXs simultaneously
}

// Detect migration source from failed results - only when there's clear graduation evidence
async function detectMigrationSource(ca: string, failedResults: any[]): Promise<string | undefined> {
  // Check if we have cached data for platforms that are now failing with graduation errors
  const pumpfunFailure = failedResults.find(r => r.source === 'pumpfun');
  const launchlabFailure = failedResults.find(r => r.source === 'launchlab');
  
  // Check for pumpfun graduation
  if (pumpfunFailure) {
    const pumpfunCached = await pumpfunCache.getCachedToken(ca);
    const isGraduationError = pumpfunFailure.error && (
      pumpfunFailure.error.message?.includes('graduated') ||
      pumpfunFailure.error.message?.includes('AMM') ||
      pumpfunFailure.error.message?.includes('bonding curve not found')
    );
    
    if (pumpfunCached && isGraduationError) {
      return 'pumpfun';
    }
  }
  
  // Check for launchlab graduation
  if (launchlabFailure) {
    const launchlabCached = await launchlabCache.getCachedToken(ca);
    const isGraduationError = launchlabFailure.error && (
      launchlabFailure.error.message?.includes('graduated') ||
      launchlabFailure.error.message?.includes('graduated from LaunchLab')
    );
    
    if (launchlabCached && isGraduationError) {
      return 'launchlab';
    }
  }
  
  return undefined;
}

// Detect migration target from successful results - prioritize the most likely permanent platform
function detectMigrationTarget(successfulResults: any[]): string | undefined {
  // For tokens migrating from temporary platforms, prioritize likely destinations
  const permanentPlatforms = successfulResults.filter(r => 
    ['pumpfun_amm', 'raydium', 'meteora'].includes(r.source)
  );
  
  if (permanentPlatforms.length === 0) {
    return successfulResults.length > 0 ? successfulResults[0].source : undefined;
  }
  
  // Priority for migration destinations:
  // 1. pumpfun_amm (most common graduation path from pumpfun)
  // 2. raydium (popular permanent DEX)
  // 3. meteora (another permanent DEX)
  const priorities = ['pumpfun_amm', 'raydium', 'meteora'];
  
  for (const priority of priorities) {
    const found = permanentPlatforms.find(r => r.source === priority);
    if (found) {
      return priority;
    }
  }
  
  // Fallback to first permanent platform found
  return permanentPlatforms[0].source;
}

// Function to get token information from various DEXs
// This function aggregates price information from multiple DEXs and returns the best available price
export async function getTokenInfo(ca: string, dex?: DEX_TYPE, poolId?: string, type?: API_TYPE) {
  
  // ENHANCED POOL-SPECIFIC REQUEST HANDLING
  if (poolId && !dex) {
    console.log(`[POOL] Searching for pool ${poolId} for token ${ca}`);
    
    try {
      const poolResult = await findSpecificPool(poolId, ca);
      
      if (poolResult.found) {
        console.log(`[POOL] Found ${poolId} in ${poolResult.dex}`);
        const priceResult = await getPriceFromSpecificPool(poolResult);
        
        let token_info: any = {
          ca,
          ...priceResult,
        };
        
        if(type === "overview") {
          const [tokenMetaData, tokenHolders] = await Promise.all([
            getTokenMetaData(ca),
            getHolders(ca)
          ]);
          const marketCap = priceResult.priceInUsd * tokenMetaData.supply;
          const top10Data = calculateTotalPercentage(tokenHolders.top10, tokenMetaData.supply);
          const top20Data = calculateTotalPercentage(tokenHolders.top20, tokenMetaData.supply);
          const tokenHPercent = {
            top10HoldersBalance: top10Data.amount,
            top10HoldersPercent: top10Data.percentage,
            top20HoldersBalance: top20Data.amount,
            top20HoldersPercent: top20Data.percentage,
          }
          token_info = {
            ca,
            ...tokenMetaData,
            ...tokenHPercent,
            ...priceResult,
            marketCap,
          };
        }
        
        return convertNumbersAndCleanObject(token_info);
      } else {
        throw new Error(`Pool ${poolId} not found for token ${ca}`);
      }
    } catch (error) {
      console.error(`[POOL] Error:`, error);
      throw new Error(`Failed to fetch price from pool ${poolId}`);
    }
  }

  // PARALLEL CACHE OPTIMIZATION: Check all caches simultaneously
  // BUT DON'T RETURN EARLY - verify cached data still works
  let cacheResults: any[] = [];
  if (!dex) {
    const cachePromises = [
      // Meteora cache
      (async () => {
        try {
          const allCachedMeteoraPools = MeteoraCache.getAllCachedPools(ca);
          if (allCachedMeteoraPools.length > 0) {
            const meteoraResult = await getCachedMeteoraPriceInfo(ca);
            if (meteoraResult && meteoraResult.priceInUsd > 0) {
              return { source: 'meteora', data: meteoraResult };
            } else {
              MeteoraCache.clearTokenCache(ca);
            }
          }
        } catch (error) {
          try {
            MeteoraCache.clearTokenCache(ca);
          } catch (clearError) {
            // Silent fail on cache clear
          }
        }
        return null;
      })(),
      
      // Raydium cache
      (async () => {
        try {
          const hasCachedRaydium = RaydiumCache.hasCachedData(ca);
          if (hasCachedRaydium) {
            const raydiumResult = await getCachedRaydiumPriceInfo(ca);
            if (raydiumResult && raydiumResult.priceInUsd > 0) {
              return { source: 'raydium', data: raydiumResult };
            } else {
              RaydiumCache.clearTokenCache(ca);
            }
          }
        } catch (error) {
          try {
            RaydiumCache.clearTokenCache(ca);
          } catch (clearError) {
            // Silent fail on cache clear
          }
        }
        return null;
      })(),
      
      // PumpFun cache
      (async () => {
        try {
          const cachedData = await pumpfunCache.getCachedToken(ca);
          if (cachedData) {
            let cachedDexResult;
            if (cachedData.current_dex === 'pumpfun') {
              cachedDexResult = await getPumpPriceInfo(ca);
            } else if (cachedData.current_dex === 'pumpfun_amm') {
              cachedDexResult = await getPumpAmmPriceInfo(ca);
            }
            
            if (cachedDexResult && cachedDexResult.priceInUsd > 0) {
              return { source: 'pumpfun', data: cachedDexResult };
            } else {
              if (cachedData.current_dex === 'pumpfun') {
                await pumpfunCache.removePumpfunBondingCurveData(ca);
              }
            }
          }
        } catch (error) {
          // Silent fail for cache errors
        }
        return null;
      })(),
      
      // LaunchLab cache
      (async () => {
        try {
          const launchlabCached = await launchlabCache.getCachedToken(ca);
          if (launchlabCached) {
            const launchlabResult = await getCachedLaunchLabPriceInfo(ca);
            if (launchlabResult && launchlabResult.priceInUsd > 0) {
              return { source: 'launchlab', data: launchlabResult };
            }
          }
        } catch (error) {
          // Silent fail for cache errors
        }
        return null;
      })()
    ];
    
    cacheResults = await Promise.all(cachePromises);
    const validCacheResults = cacheResults.filter(result => result !== null);
    
    if (validCacheResults.length > 0) {
      // Sort by liquidity (highest first)
      const bestCacheResult = validCacheResults.sort((a, b) => {
        const liquidityA = a.data.liquidity || 0;
        const liquidityB = b.data.liquidity || 0;
        return liquidityB - liquidityA;
      })[0];
      
      let token_info: any = {
        ca,
        ...bestCacheResult.data,
      };
      
      if(type === "overview") {
        const [tokenMetaData, tokenHolders] = await Promise.all([
          getTokenMetaData(ca),
          getHolders(ca)
        ]);
        const marketCap = bestCacheResult.data.priceInUsd * tokenMetaData.supply;
        const top10Data = calculateTotalPercentage(tokenHolders.top10, tokenMetaData.supply);
        const top20Data = calculateTotalPercentage(tokenHolders.top20, tokenMetaData.supply);
        const tokenHPercent = {
          top10HoldersBalance: top10Data.amount,
          top10HoldersPercent: top10Data.percentage,
          top20HoldersBalance: top20Data.amount,
          top20HoldersPercent: top20Data.percentage,
        }
        token_info = {
          ca,
          ...tokenMetaData,
          ...tokenHPercent,
          ...bestCacheResult.data,
          marketCap,
        };
      }
      
      return convertNumbersAndCleanObject(token_info);
    }
  }
  
  // ENHANCED MULTI-DEX DISCOVERY
  const price_promise = [];
  
  if (dex === "pumpfun") {
    price_promise.push(getPumpPriceInfo(ca));
    price_promise.push(getPumpAmmPriceInfo(ca));
  } else if (dex === "raydium") {
    price_promise.push(getCachedRaydiumPriceInfo(ca, poolId));
  } else if (dex === "moonshot") {
    price_promise.push(getMoonshotPriceInfo(ca));
  } else if (dex === "meteora") {
    price_promise.push(getCachedMeteoraPriceInfo(ca, poolId));
  } else if (dex === "launchlab") {
    price_promise.push(getCachedLaunchLabPriceInfo(ca));
  } else {
    // Try all DEXs - tokens can exist on multiple platforms simultaneously
    // We'll return the pool with the highest liquidity
    price_promise.push(
      (async () => {
        try {
          return await getPumpPriceInfo(ca);
        } catch (error) {
          throw error;
        }
      })()
    );
    
    price_promise.push(
      (async () => {
        try {
          return await getPumpAmmPriceInfo(ca);
        } catch (error) {
          throw error;
        }
      })()
    );
    
    price_promise.push(
      (async () => {
        try {
          return await getCachedRaydiumPriceInfo(ca, poolId);
        } catch (error) {
          throw error;
        }
      })()
    );
    
    price_promise.push(
      (async () => {
        try {
          return await getCachedMeteoraPriceInfo(ca, poolId);
        } catch (error) {
          throw error;
        }
      })()
    );
    
    price_promise.push(
      (async () => {
        try {
          return await getCachedLaunchLabPriceInfo(ca);
        } catch (error) {
          throw error;
        }
      })()
    );
    
    price_promise.push(
      (async () => {
        try {
          return await getMoonshotPriceInfo(ca);
        } catch (error) {
          throw error;
        }
      })()
    );
  }

  const promise_1 = Promise.allSettled(price_promise);
  const final_promise: any = [ promise_1 ];
  if (type === "overview") {
    const promise_2 = getTokenMetaData(ca);
    const promise_3 = getHolders(ca);
    final_promise.push(promise_2);
    final_promise.push(promise_3);
  }
  const result_promise = await Promise.all(final_promise);
  const tokenPriceInfo = result_promise[0];
  
  // Filter successful results
  const successResults = tokenPriceInfo
    .filter((res: any) => res.status === 'fulfilled')
    .map((res: any) => res.value)
    .filter((value: any) => value !== null && value !== undefined);
  
  // Log successful DEX results for debugging
  if (successResults.length > 0) {
    const foundDexs = successResults.map((r: any) => r.dex || 'unknown').join(', ');
    console.log(`[TOKEN_INFO] Found ${ca} on: ${foundDexs}`);
  }
  
  // ENHANCED FALLBACK MECHANISM FOR TOKEN MIGRATIONS
  if (successResults.length === 0) {
    console.log(`[MIGRATION] No results from initial search for ${ca}, triggering comprehensive refresh`);
    
    try {
      const refreshResult = await refreshAllDexPools(ca);
      
      if (refreshResult.results.length > 0) {
        if (refreshResult.migratedFrom && refreshResult.migratedTo) {
          console.log(`[MIGRATION] Token ${ca} migrated from ${refreshResult.migratedFrom} to ${refreshResult.migratedTo}`);
        }
        
        // Use the refreshed results - sort by liquidity to find the best pool
        const priceInfo = refreshResult.results.sort((a: any, b: any) =>
          (b.liquidity||0) - (a.liquidity||0)
        )[0];
        
        if (priceInfo) {
          let token_info = {
            ca,
            ...priceInfo,
            // Add migration info for debugging/logging
            _migrationInfo: refreshResult.migratedFrom && refreshResult.migratedTo ? {
              from: refreshResult.migratedFrom,
              to: refreshResult.migratedTo
            } : undefined
          };
          
          if(type === "overview") {
            const tokenMetaData = result_promise[1];
            const tokenHolders = result_promise[2];
            const marketCap = priceInfo.priceInUsd * tokenMetaData.supply;
            const top10Data = calculateTotalPercentage(tokenHolders.top10, tokenMetaData.supply);
            const top20Data = calculateTotalPercentage(tokenHolders.top20, tokenMetaData.supply);
            const tokenHPercent = {
              top10HoldersBalance: top10Data.amount,
              top10HoldersPercent: top10Data.percentage,
              top20HoldersBalance: top20Data.amount,
              top20HoldersPercent: top20Data.percentage,
            }
            token_info = {
              ca,
              ...tokenMetaData,
              ...tokenHPercent,
              ...priceInfo,
              marketCap,
              // Add migration info for debugging/logging
              _migrationInfo: refreshResult.migratedFrom && refreshResult.migratedTo ? {
                from: refreshResult.migratedFrom,
                to: refreshResult.migratedTo
              } : undefined
            };
          }
          
          // Clean migration info from final response (only for logging)
          const finalTokenInfo = convertNumbersAndCleanObject(token_info);
          if (finalTokenInfo._migrationInfo) {
            delete finalTokenInfo._migrationInfo;
          }
          
          return finalTokenInfo;
        }
      }
      
      // If refresh found no results, provide more specific error message
      const attemptedDexs = ['pumpfun', 'pumpfun_amm', 'raydium', 'meteora', 'launchlab', 'moonshot'];
      throw new Error(`Token ${ca} not found on any supported DEX. Attempted: ${attemptedDexs.join(', ')}`);
      
    } catch (refreshError) {
      console.error(`[MIGRATION] Refresh failed for ${ca}:`, refreshError);
      
      // Provide more specific error message based on the refresh error
      if (refreshError instanceof Error) {
        if (refreshError.message.includes('Token') && refreshError.message.includes('not found')) {
          // Let specific "not found" errors pass through
          throw refreshError;
        } else if (refreshError.message.includes('graduated')) {
          throw new Error(`Token ${ca} has graduated from its launch platform. Please check other DEXs for current price.`);
        } else if (refreshError.message.includes('network') || refreshError.message.includes('timeout')) {
          throw new Error(`Network issues encountered while searching for token ${ca}. Please try again later.`);
        } else {
          throw new Error(`Unable to fetch price for token ${ca}. The token may have migrated to a new platform or may not be actively traded.`);
        }
      }
      
      // Fallback error message
      throw new Error(`Token ${ca} price lookup failed after comprehensive search across all supported DEXs`);
    }
  }
  
  // Select the token info with highest liquidity from available pools
  // Note: Tokens can exist on multiple DEXs, so we pick the best one
  const priceInfo = successResults.sort((a: any, b: any) =>
    (b.liquidity||0) - (a.liquidity||0)
  )[0];

  if (!priceInfo) {
    throw new Error('Failed to select valid price information');
  }
  
  let token_info = {
    ca,
    ...priceInfo,
  };
  
  if(type === "overview") {
    const tokenMetaData = result_promise[1];
    const tokenHolders = result_promise[2];
    const marketCap = priceInfo.priceInUsd * tokenMetaData.supply;
    const top10Data = calculateTotalPercentage(tokenHolders.top10, tokenMetaData.supply);
    const top20Data = calculateTotalPercentage(tokenHolders.top20, tokenMetaData.supply);
    const tokenHPercent = {
      top10HoldersBalance: top10Data.amount,
      top10HoldersPercent: top10Data.percentage,
      top20HoldersBalance: top20Data.amount,
      top20HoldersPercent: top20Data.percentage,
    }
    token_info = {
      ca,
      ...tokenMetaData,
      ...tokenHPercent,
      ...priceInfo,
      marketCap,
    };
  }
  
  return convertNumbersAndCleanObject(token_info);
}
