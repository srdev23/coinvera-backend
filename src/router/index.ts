import express from "express";
import { authenticateKey } from "../middleware/auth";
import { handleTokenRequest } from "./getTokenInfo";
import { handlePoolRequest } from "./getPoolList";
import { handleTrendTokenRequest } from "./getTrendToken";
import { connectionPool } from "../config";
import { pumpfunCache } from "../cache/pumpfunCache";

export const router = express.Router();

// Health check endpoint (no auth required)
router.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Performance monitoring endpoint (no auth required)
router.get('/metrics', (req, res) => {
  const memoryUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  
  const metrics = {
    timestamp: new Date().toISOString(),
    system: {
      uptime: process.uptime(),
      memory: {
        used: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        total: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        external: Math.round(memoryUsage.external / 1024 / 1024),
        rss: Math.round(memoryUsage.rss / 1024 / 1024)
      },
      cpu: {
        user: Math.round(cpuUsage.user / 1000),
        system: Math.round(cpuUsage.system / 1000)
      }
    },
    rpc: {
      healthStatus: connectionPool.getHealthStatus(),
      circuitBreaker: connectionPool.getCircuitBreakerState()
    },
    version: process.version,
    platform: process.platform
  };
  
  res.status(200).json(metrics);
});

// Apply authentication middleware to all routes below
router.use(authenticateKey);

// ========== BACKWARD COMPATIBILITY ENDPOINTS ==========
// Original endpoints that clients expect to work
router.get("/price", (req, res) => handleTokenRequest(req, res));
router.get("/overview", (req, res) => handleTokenRequest(req, res, undefined, "overview"));
router.get("/pumpfun", (req, res) => handleTokenRequest(req, res, "pumpfun"));
router.get("/raydium", (req, res) => handleTokenRequest(req, res, "raydium"));
router.get("/moonshot", (req, res) => handleTokenRequest(req, res, "moonshot"));
router.get("/meteora", (req, res) => handleTokenRequest(req, res, "meteora"));
router.get("/launchlab", (req, res) => handleTokenRequest(req, res, "launchlab"));

// ========== NEW STRUCTURED ENDPOINTS ==========
// Token price endpoints
router.get("/token", (req, res) => handleTokenRequest(req, res));
router.get("/token/all", (req, res) => handleTokenRequest(req, res));
router.get("/token/pumpfun", (req, res) => handleTokenRequest(req, res, "pumpfun"));
router.get("/token/raydium", (req, res) => handleTokenRequest(req, res, "raydium"));
router.get("/token/moonshot", (req, res) => handleTokenRequest(req, res, "moonshot"));
router.get("/token/meteora", (req, res) => handleTokenRequest(req, res, "meteora"));
router.get("/token/launchlab", (req, res) => handleTokenRequest(req, res, "launchlab"));

// Token overview endpoints
router.get("/token/overview", (req, res) => handleTokenRequest(req, res, undefined, "overview"));
router.get("/token/overview/all", (req, res) => handleTokenRequest(req, res, undefined, "overview"));
router.get("/token/overview/pumpfun", (req, res) => handleTokenRequest(req, res, "pumpfun", "overview"));
router.get("/token/overview/raydium", (req, res) => handleTokenRequest(req, res, "raydium", "overview"));
router.get("/token/overview/moonshot", (req, res) => handleTokenRequest(req, res, "moonshot", "overview"));
router.get("/token/overview/meteora", (req, res) => handleTokenRequest(req, res, "meteora", "overview"));
router.get("/token/overview/launchlab", (req, res) => handleTokenRequest(req, res, "launchlab", "overview"));

// Pool list endpoint
router.get("/pools", handlePoolRequest);

// Trend tokens endpoint
router.get("/trend", handleTrendTokenRequest);

// Cache management endpoints
router.get("/cache/stats", async (req, res) => {
  try {
    const stats = await pumpfunCache.getCacheStats();
    res.status(200).json({
      success: true,
      data: stats,
      message: "Cache statistics retrieved successfully"
    });
  } catch (error) {
    console.error("Error getting cache stats:", error);
    res.status(500).json({
      success: false,
      error: "Failed to retrieve cache statistics"
    });
  }
});

router.post("/cache/clear", async (req, res) => {
  try {
    await pumpfunCache.clearCache();
    res.status(200).json({
      success: true,
      message: "Cache cleared successfully"
    });
  } catch (error) {
    console.error("Error clearing cache:", error);
    res.status(500).json({
      success: false,
      error: "Failed to clear cache"
    });
  }
});
