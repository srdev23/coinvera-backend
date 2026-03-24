import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';
import { getCachedSolPrice } from '../service';

let launchlabDb: Database<sqlite3.Database, sqlite3.Statement> | null = null;

export interface LaunchLabCacheData {
  token_address: string;
  pool_id: string;
  vaultA: string;
  vaultB: string;
  token_decimals: number;
  last_updated: Date;
}

export interface LaunchLabPriceResult {
  dex: string;
  poolId: string;
  priceInSol: number;
  priceInUsd: number;
  bondingCurveProgress: number;
}

// Initialize LaunchLab SQLite database
async function initLaunchLabDatabase(): Promise<Database<sqlite3.Database, sqlite3.Statement>> {
  if (launchlabDb) return launchlabDb;

  // Create db/launchlab directory if it doesn't exist
  const dbDir = path.join(process.cwd(), 'db', 'launchlab');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = path.join(dbDir, 'launchlab_cache.db');
  
  launchlabDb = await open({
    filename: dbPath,
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
  });

  // Enable WAL mode for better concurrency
  await launchlabDb.exec('PRAGMA journal_mode = WAL;');
  await launchlabDb.exec('PRAGMA synchronous = NORMAL;');
  await launchlabDb.exec('PRAGMA cache_size = 10000;');
  await launchlabDb.exec('PRAGMA temp_store = MEMORY;');

  // Create tables
  await createLaunchLabTables();

  console.log('✅ SQLite database initialized for LaunchLab caching at db/launchlab/launchlab_cache.db');
  return launchlabDb;
}

async function createLaunchLabTables() {
  if (!launchlabDb) throw new Error('LaunchLab database not initialized');

  // Main LaunchLab cache table
  await launchlabDb.exec(`
    CREATE TABLE IF NOT EXISTS launchlab_cache (
      token_address TEXT PRIMARY KEY,
      pool_id TEXT NOT NULL,
      vaultA TEXT NOT NULL,
      vaultB TEXT NOT NULL,
      token_decimals INTEGER DEFAULT 6,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes for performance
  await launchlabDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_launchlab_cache_updated ON launchlab_cache(last_updated);
  `);
}

async function getLaunchLabDatabase(): Promise<Database<sqlite3.Database, sqlite3.Statement>> {
  if (!launchlabDb) {
    return await initLaunchLabDatabase();
  }
  return launchlabDb;
}

export class LaunchLabCache {
  private static instance: LaunchLabCache;
  
  public static getInstance(): LaunchLabCache {
    if (!LaunchLabCache.instance) {
      LaunchLabCache.instance = new LaunchLabCache();
    }
    return LaunchLabCache.instance;
  }

  // Initialize LaunchLab cache table
  async initializeTable(): Promise<void> {
    await getLaunchLabDatabase();
  }

  // Get cached LaunchLab token data
  async getCachedToken(tokenAddress: string): Promise<LaunchLabCacheData | null> {
    const db = await getLaunchLabDatabase();
    const row = await db.get(
      'SELECT * FROM launchlab_cache WHERE token_address = ?',
      tokenAddress
    );
    
    if (!row) return null;
    
    return {
      ...row,
      last_updated: new Date(row.last_updated),
    };
  }

  // Cache LaunchLab token data
  async cacheToken(
    tokenAddress: string,
    poolId: string,
    vaultA: string,
    vaultB: string,
    tokenDecimals: number = 6
  ): Promise<void> {
    const db = await getLaunchLabDatabase();
    const now = new Date();

    await db.run(`
      INSERT OR REPLACE INTO launchlab_cache (
        token_address, pool_id, vaultA, vaultB, token_decimals, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
      tokenAddress, poolId, vaultA, vaultB, tokenDecimals, now.toISOString()
    ]);
  }

  // Remove token from cache (when graduated to other DEX)
  async removeToken(tokenAddress: string): Promise<void> {
    const db = await getLaunchLabDatabase();
    await db.run('DELETE FROM launchlab_cache WHERE token_address = ?', [tokenAddress]);
    console.log(`[LAUNCHLAB_CACHE] Removed graduated token ${tokenAddress} from cache`);
  }

  // Check if token has cached data
  hasCachedData(tokenAddress: string): boolean {
    // This is a sync method, so we'll implement it differently
    // For now, we'll use the async method in the caller
    return false;
  }

  // Get all cached tokens (for debugging)
  async getAllCachedTokens(): Promise<LaunchLabCacheData[]> {
    const db = await getLaunchLabDatabase();
    const rows = await db.all('SELECT * FROM launchlab_cache ORDER BY last_updated DESC');
    
    return rows.map((row: any) => ({
      ...row,
      last_updated: new Date(row.last_updated),
    }));
  }

  // Get cache statistics
  async getCacheStats(): Promise<{
    totalTokens: number;
    averagePrice: number;
    lastUpdated: Date | null;
  }> {
    const db = await getLaunchLabDatabase();
    const totalTokens = await db.get('SELECT COUNT(*) as count FROM launchlab_cache');
    const avgPrice = await db.get('SELECT AVG(price_usd) as avg FROM launchlab_cache');
    const lastUpdated = await db.get('SELECT MAX(last_updated) as last FROM launchlab_cache');
    
    return {
      totalTokens: totalTokens.count,
      averagePrice: avgPrice.avg || 0,
      lastUpdated: lastUpdated.last ? new Date(lastUpdated.last) : null
    };
  }

  // Clear all cache (for testing/debugging)
  async clearCache(): Promise<void> {
    const db = await getLaunchLabDatabase();
    await db.run('DELETE FROM launchlab_cache');
    console.log('[LAUNCHLAB_CACHE] Cleared all cached tokens');
  }

  // Clear specific token cache (for migration scenarios)
  async clearTokenCache(tokenAddress: string): Promise<void> {
    const db = await getLaunchLabDatabase();
    await db.run('DELETE FROM launchlab_cache WHERE token_address = ?', [tokenAddress]);
    console.log(`[LAUNCHLAB_CACHE] Cleared cache for token ${tokenAddress}`);
  }
}

// Export singleton instance
export const launchlabCache = LaunchLabCache.getInstance(); 