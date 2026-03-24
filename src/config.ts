import { Connection } from "@solana/web3.js";
import { configDotenv } from "dotenv";
configDotenv();

export const PlanLimit = {
  free: {
    // per-minute: 30 requests
    windowMs: 60 * 1000,
    max: 30,
    // per-second: 1 request
    windowSecMs: 1 * 1000,
    maxSec: 1,
    // WebSocket rates mirror HTTP here
    batch: 1,       // RPS
    wssBatch: 1,    // WS RPS
  },
  pro: {
    // per-minute: 500 requests
    windowMs: 60 * 1000,
    max: 500,
    // per-second: 20 requests
    windowSecMs: 1 * 1000,
    maxSec: 20,
    batch: 10,
    wssBatch: 5,
  },
  advanced: {
    // per-minute: 1500 requests
    windowMs: 60 * 1000,
    max: 1500,
    // per-second: 60 requests
    windowSecMs: 1 * 1000,
    maxSec: 60,
    batch: 20,
    wssBatch: 10,
  }
}

export const CLEAR_CACHE_INTERVAL = 1000 * 60 * 60 * 1; // 1 hr
export const DUNE_QUERY_ID = process.env.DUNE_QUERY_ID|| 0;
export const X_DUNE_API_KEY = process.env.X_DUNE_API_KEY || "";
export const HTTP_PORT = process.env.HTTP_PORT || 3003;
export const WSS_PORT = process.env.WSS_PORT || 8080;

// RPC Configuration with fallbacks
console.log(`[CONFIG] Environment variables:`, {
  RPC_URL: process.env.RPC_URL ? process.env.RPC_URL.substring(0, 50) + '...' : 'not set',
  RPC_URL_2: process.env.RPC_URL_2 ? process.env.RPC_URL_2.substring(0, 50) + '...' : 'not set',
  RPC_URL_3: process.env.RPC_URL_3 ? process.env.RPC_URL_3.substring(0, 50) + '...' : 'not set'
});

const configuredRPCs = [
  process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
  process.env.RPC_URL_2 || "https://solana-api.projectserum.com",  
  process.env.RPC_URL_3 || "https://api.mainnet-beta.solana.com"
].filter(Boolean);

// Ensure we always have at least one RPC endpoint
export const RPC_URLS = configuredRPCs.length > 0 ? configuredRPCs : ["https://api.mainnet-beta.solana.com"];

console.log(`[CONFIG] Configured ${RPC_URLS.length} RPC endpoints:`, RPC_URLS.map(url => url.split('?')[0] + (url.includes('?') ? '?[API_KEY]' : '')));
console.log(`[CONFIG] Full URLs (first 60 chars):`, RPC_URLS.map(url => url.substring(0, 60) + (url.length > 60 ? '...' : '')));

export const LASER_STREAM_KEY = process.env.LASER_STREAM_KEY || "";
export const GRPC_URL = process.env.GRPC_URL || "";

// Optional X-TOKEN for gRPC authentication (used for local testing)
// Environment variable: X-TOKEN, used as x-token header in gRPC connection
export const X_TOKEN = process.env["X-TOKEN"] || undefined;

// Log gRPC configuration
console.log(`[CONFIG] gRPC Configuration:`, {
  GRPC_URL: GRPC_URL ? GRPC_URL.substring(0, 50) + '...' : 'not configured',
  'X-TOKEN': X_TOKEN ? 'configured' : 'not configured (optional)'
});

// Circuit Breaker Configuration - Server-friendly settings
export const CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: 10,    // Number of failures before opening circuit (increased from 5)
  resetTimeout: 60000,     // Time to wait before trying half-open (60s - increased from 30s)
  monitoringPeriod: 120000, // Window for tracking failures (2 minutes - increased from 1 minute)
  expectedResponseTime: 30000, // Max expected response time (30s - increased from 5s)
};

// Circuit Breaker Implementation
interface CircuitBreakerState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  consecutiveFailures: number;
}

class CircuitBreaker {
  private state: CircuitBreakerState = {
    state: 'CLOSED',
    failures: 0,
    lastFailureTime: 0,
    lastSuccessTime: Date.now(),
    consecutiveFailures: 0
  };

  async execute<T>(fn: () => Promise<T>, operation: string = 'RPC'): Promise<T> {
    if (this.state.state === 'OPEN') {
      if (Date.now() - this.state.lastFailureTime > CIRCUIT_BREAKER_CONFIG.resetTimeout) {
        this.state.state = 'HALF_OPEN';
        console.log(`[CIRCUIT] ${operation} circuit breaker switching to HALF_OPEN`);
      } else {
        throw new Error(`${operation} circuit breaker is OPEN. Service temporarily unavailable.`);
      }
    }

    const startTime = Date.now();
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error(`${operation} timeout after ${CIRCUIT_BREAKER_CONFIG.expectedResponseTime}ms`)), 
            CIRCUIT_BREAKER_CONFIG.expectedResponseTime)
        )
      ]);

      this.onSuccess(operation);
      return result;
    } catch (error) {
      this.onFailure(error as Error, operation);
      throw error;
    }
  }

  private onSuccess(operation: string) {
    const wasOpen = this.state.state !== 'CLOSED';
    this.state.state = 'CLOSED';
    this.state.consecutiveFailures = 0;
    this.state.lastSuccessTime = Date.now();
    
    if (wasOpen) {
      console.log(`[CIRCUIT] ${operation} circuit breaker restored to CLOSED`);
    }
  }

  private onFailure(error: Error, operation: string) {
    this.state.failures++;
    this.state.consecutiveFailures++;
    this.state.lastFailureTime = Date.now();

    if (this.state.consecutiveFailures >= CIRCUIT_BREAKER_CONFIG.failureThreshold) {
      this.state.state = 'OPEN';
      console.error(`[CIRCUIT] ${operation} circuit breaker OPENED after ${this.state.consecutiveFailures} failures. Last error:`, error.message);
    }
  }

  getState() {
    return { ...this.state };
  }
}

// RPC Connection Pool with Circuit Breaker
class SolanaConnectionPool {
  private connections: Connection[] = [];
  private currentIndex = 0;
  private circuitBreaker = new CircuitBreaker();
  private healthStatus = new Map<string, { healthy: boolean; lastCheck: number }>();

  constructor() {
    // Initialize connections for each RPC URL with server-friendly settings
    RPC_URLS.forEach(url => {
      this.connections.push(new Connection(url, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 30000, // Increased from 10s to 30s
        disableRetryOnRateLimit: false,
        httpAgent: false
      }));
      this.healthStatus.set(url, { healthy: true, lastCheck: Date.now() });
    });

    // Health check every 30 seconds using getHealth RPC method
    setInterval(() => this.healthCheck(), 30000);
    
    // Run initial health check
    this.healthCheck();
  }

  async getConnection(): Promise<Connection> {
    // Priority-based selection: Always prefer RPC_URL (index 0), then RPC_URL_2 (index 1), then RPC_URL_3 (index 2)
    // Health checks are for monitoring only, not for blocking requests
    
    if (this.connections.length === 0) {
      throw new Error('No RPC connections available');
    }
    
    // Always return the connection at currentIndex (starts at 0 for highest priority)
    const connection = this.connections[this.currentIndex];
    return connection;
  }

  // New method to move to next priority RPC on failure
  moveToNextRpc(): void {
    if (this.connections.length > 1) {
      this.currentIndex = (this.currentIndex + 1) % this.connections.length;
      console.log(`[RPC] Switching to RPC priority ${this.currentIndex + 1}: ${RPC_URLS[this.currentIndex].split('?')[0]}`);
    }
  }

  // Reset to highest priority RPC (call after successful operations)
  resetToHighestPriority(): void {
    if (this.currentIndex !== 0) {
      this.currentIndex = 0;
      console.log(`[RPC] Resetting to highest priority RPC: ${RPC_URLS[0].split('?')[0]}`);
    }
  }

  async executeWithRetry<T>(fn: (connection: Connection) => Promise<T>, maxRetries: number = 3): Promise<T> {
    return this.circuitBreaker.execute(async () => {
      let lastError: Error | null = null;
      
      // Always start with highest priority RPC
      this.resetToHighestPriority();
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const connection = await this.getConnection();
          const result = await fn(connection);
          
          // Success - reset to highest priority for next request
          this.resetToHighestPriority();
          return result;
        } catch (error) {
          lastError = error as Error;
          
          // Enhanced error handling for server environment
          if (lastError.message.includes('429') || lastError.message.includes('rate limit')) {
            // Exponential backoff for rate limits, max 10s for server environment
            const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Try next RPC on rate limit
            this.moveToNextRpc();
            continue;
          }
          
          // Handle specific server errors more gracefully
          if (lastError.message.includes('fetch failed') || 
              lastError.message.includes('timeout') ||
              lastError.message.includes('ECONNRESET') ||
              lastError.message.includes('ENOTFOUND')) {
            // Network-related errors - wait before retry
            const delay = Math.min(2000 * (attempt + 1), 8000);
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Try next RPC on network errors
            this.moveToNextRpc();
            
            // If not the last attempt, continue with next RPC
            if (attempt < maxRetries - 1) {
              continue;
            }
          }
          
          // Try next RPC for any other error
          if (attempt < maxRetries - 1) {
            this.moveToNextRpc();
            continue;
          }
        }
      }
      
      throw lastError || new Error('All retry attempts failed');
    }, 'RPC');
  }

  private async healthCheck() {
    for (const url of RPC_URLS) {
      try {
        // Use getHealth RPC method with POST request
        const options = {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            "jsonrpc": "2.0",
            "id": "1",
            "method": "getHealth"
          })
        };
        
        // Use a timeout for health checks to prevent hanging
        const healthCheckPromise = fetch(url, options);
        const response = await Promise.race([
          healthCheckPromise,
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Health check timeout')), 5000)
          )
        ]);
        
        if (response.ok) {
          const data = await response.json();
          
          // Check if the response indicates healthy status
          if (data.result === 'ok' || data.result === 'healthy' || !data.error) {
            this.healthStatus.set(url, { healthy: true, lastCheck: Date.now() });
          } else {
            throw new Error(data.error?.message || 'RPC returned unhealthy status');
          }
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
      } catch (error) {
        this.healthStatus.set(url, { healthy: false, lastCheck: Date.now() });
        // Only log if endpoint was previously healthy (to avoid spam)
        const wasHealthy = this.healthStatus.get(url)?.healthy;
        if (wasHealthy) {
          console.log(`[HEALTH] ❌ ${url.split('?')[0]} is now unhealthy: ${(error as Error).message}`);
        }
      }
    }
  }

  private logHealthSummary() {
    const healthyCount = Array.from(this.healthStatus.values()).filter(status => status.healthy).length;
    const totalCount = this.healthStatus.size;
    const unhealthyCount = totalCount - healthyCount;
    
    // Only log if there are unhealthy endpoints
    if (unhealthyCount > 0) {
      console.log(`[HEALTH] Summary: ${healthyCount}/${totalCount} endpoints healthy, ${unhealthyCount} unhealthy (all still being used)`);
    }
  }

  getHealthStatus() {
    return Object.fromEntries(this.healthStatus);
  }

  getCircuitBreakerState() {
    return this.circuitBreaker.getState();
  }

  // Get the current priority RPC URL for external SDKs
  getCurrentRpcUrl(): string {
    return RPC_URLS[this.currentIndex];
  }
}

// Export singleton instances
export const connectionPool = new SolanaConnectionPool();

// Backwards compatibility - direct connection for immediate use with server-friendly settings
if (RPC_URLS.length === 0) {
  throw new Error('No RPC endpoints configured');
}

export const connection = new Connection(RPC_URLS[0], {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 30000, // Increased from 10s to 30s
  disableRetryOnRateLimit: false,
  httpAgent: false
});

// Helper function for RPC calls with circuit breaker and priority-based RPC selection
export async function executeRpcCall<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
  return connectionPool.executeWithRetry(fn);
}

export const MONGODB_URI = process.env.MONGODB_URI || "http://localhost:27017/SPL-price-api";