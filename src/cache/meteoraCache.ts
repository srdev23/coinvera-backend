import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

export interface MeteoraPoolInfo {
  tokenAddress: string;
  poolType: 'amm' | 'dlmm';
  poolId: string;
  
  // AMM fields
  tokenAMint?: string;
  tokenBMint?: string;
  aVaultLp?: string;
  bVaultLp?: string;
  vaultA?: string;
  vaultB?: string;
  
  // DLMM fields
  tokenXMint?: string;
  tokenYMint?: string;
  reserveX?: string;
  reserveY?: string;
  
  liquidityRank: number;
  lastUpdated: number;
}

export class MeteoraCache {
  private static db: Database.Database;
  private static dbPath = path.join(process.cwd(), 'db', 'meteora', 'meteora_cache.db');
  
  static {
    this.initializeDatabase();
  }
  
  private static initializeDatabase() {
    // Ensure the directory exists
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    
    // Create table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meteora_pools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_address TEXT NOT NULL,
        pool_type TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        
        -- AMM fields
        token_a_mint TEXT,
        token_b_mint TEXT,
        a_vault_lp TEXT,
        b_vault_lp TEXT,
        vault_a TEXT,
        vault_b TEXT,
        
        -- DLMM fields
        token_x_mint TEXT,
        token_y_mint TEXT,
        reserve_x TEXT,
        reserve_y TEXT,
        
        liquidity_rank INTEGER NOT NULL,
        last_updated INTEGER NOT NULL,
        
        UNIQUE(token_address, pool_type, pool_id)
      )
    `);
    
    // Create indexes for better performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_meteora_token_address ON meteora_pools(token_address);
      CREATE INDEX IF NOT EXISTS idx_meteora_pool_type ON meteora_pools(pool_type);
      CREATE INDEX IF NOT EXISTS idx_meteora_liquidity_rank ON meteora_pools(liquidity_rank);
    `);
  }
  
  static storePoolInfo(tokenAddress: string, poolType: 'amm' | 'dlmm', pools: MeteoraPoolInfo[]) {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO meteora_pools (
        token_address, pool_type, pool_id,
        token_a_mint, token_b_mint, a_vault_lp, b_vault_lp, vault_a, vault_b,
        token_x_mint, token_y_mint, reserve_x, reserve_y,
        liquidity_rank, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const transaction = this.db.transaction((pools: MeteoraPoolInfo[]) => {
      for (const pool of pools) {
        insert.run(
          pool.tokenAddress,
          pool.poolType,
          pool.poolId,
          pool.tokenAMint,
          pool.tokenBMint,
          pool.aVaultLp,
          pool.bVaultLp,
          pool.vaultA,
          pool.vaultB,
          pool.tokenXMint,
          pool.tokenYMint,
          pool.reserveX,
          pool.reserveY,
          pool.liquidityRank,
          pool.lastUpdated
        );
      }
    });
    
    transaction(pools);
  }
  
  static getCachedPools(tokenAddress: string, poolType: 'amm' | 'dlmm'): MeteoraPoolInfo[] {
    const stmt = this.db.prepare(`
      SELECT * FROM meteora_pools 
      WHERE token_address = ? AND pool_type = ? 
      ORDER BY liquidity_rank ASC
    `);
    
    const rows = stmt.all(tokenAddress, poolType) as any[];
    return rows.map((row: any) => ({
      tokenAddress: row.token_address,
      poolType: row.pool_type,
      poolId: row.pool_id,
      tokenAMint: row.token_a_mint,
      tokenBMint: row.token_b_mint,
      aVaultLp: row.a_vault_lp,
      bVaultLp: row.b_vault_lp,
      vaultA: row.vault_a,
      vaultB: row.vault_b,
      tokenXMint: row.token_x_mint,
      tokenYMint: row.token_y_mint,
      reserveX: row.reserve_x,
      reserveY: row.reserve_y,
      liquidityRank: row.liquidity_rank,
      lastUpdated: row.last_updated
    }));
  }
  
  static getBestPool(tokenAddress: string, poolType: 'amm' | 'dlmm'): MeteoraPoolInfo | null {
    const pools = this.getCachedPools(tokenAddress, poolType);
    return pools.length > 0 ? pools[0] : null;
  }
  
  static getAllCachedPools(tokenAddress: string): MeteoraPoolInfo[] {
    const stmt = this.db.prepare(`
      SELECT * FROM meteora_pools 
      WHERE token_address = ? 
      ORDER BY pool_type ASC, liquidity_rank ASC
    `);
    
    const rows = stmt.all(tokenAddress) as any[];
    return rows.map((row: any) => ({
      tokenAddress: row.token_address,
      poolType: row.pool_type,
      poolId: row.pool_id,
      tokenAMint: row.token_a_mint,
      tokenBMint: row.token_b_mint,
      aVaultLp: row.a_vault_lp,
      bVaultLp: row.b_vault_lp,
      vaultA: row.vault_a,
      vaultB: row.vault_b,
      tokenXMint: row.token_x_mint,
      tokenYMint: row.token_y_mint,
      reserveX: row.reserve_x,
      reserveY: row.reserve_y,
      liquidityRank: row.liquidity_rank,
      lastUpdated: row.last_updated
    }));
  }
  
  static clearTokenCache(tokenAddress: string) {
    const stmt = this.db.prepare('DELETE FROM meteora_pools WHERE token_address = ?');
    stmt.run(tokenAddress);
  }
  
  // Store negative result (no pools found) to avoid repeated searches
  static storeNegativeResult(tokenAddress: string, poolType: 'amm' | 'dlmm') {
    // Store a special entry with poolId 'NO_POOLS_FOUND' to indicate no pools exist
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO meteora_pools (
        token_address, pool_type, pool_id,
        liquidity_rank, last_updated
      ) VALUES (?, ?, 'NO_POOLS_FOUND', 0, ?)
    `);
    stmt.run(tokenAddress, poolType, Date.now());
  }

  // Remove negative results (when token is found in other pools)
  static clearNegativeResults(tokenAddress: string) {
    const stmt = this.db.prepare(`
      DELETE FROM meteora_pools 
      WHERE token_address = ? AND pool_id = 'NO_POOLS_FOUND'
    `);
    stmt.run(tokenAddress);
  }

  // Check if we have negative results cached (to avoid repeated failed searches)
  static hasNegativeResults(tokenAddress: string, poolType?: 'amm' | 'dlmm'): boolean {
    let query = `
      SELECT COUNT(*) as count 
      FROM meteora_pools 
      WHERE token_address = ? AND pool_id = 'NO_POOLS_FOUND'
    `;
    const params: any[] = [tokenAddress];
    
    if (poolType) {
      query += ` AND pool_type = ?`;
      params.push(poolType);
    }
    
    const stmt = this.db.prepare(query);
    const result = stmt.get(...params) as { count: number };
    return result.count > 0;
  }

  // Get cache statistics
  static getCacheStats(): {
    totalTokens: number;
    ammPools: number;
    dlmmPools: number;
    negativeResults: number;
  } {
    const totalTokensStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT token_address) as count 
      FROM meteora_pools 
      WHERE pool_id != 'NO_POOLS_FOUND'
    `);
    const ammPoolsStmt = this.db.prepare(`
      SELECT COUNT(*) as count 
      FROM meteora_pools 
      WHERE pool_type = 'amm' AND pool_id != 'NO_POOLS_FOUND'
    `);
    const dlmmPoolsStmt = this.db.prepare(`
      SELECT COUNT(*) as count 
      FROM meteora_pools 
      WHERE pool_type = 'dlmm' AND pool_id != 'NO_POOLS_FOUND'
    `);
    const negativeResultsStmt = this.db.prepare(`
      SELECT COUNT(*) as count 
      FROM meteora_pools 
      WHERE pool_id = 'NO_POOLS_FOUND'
    `);

    return {
      totalTokens: (totalTokensStmt.get() as { count: number }).count,
      ammPools: (ammPoolsStmt.get() as { count: number }).count,
      dlmmPools: (dlmmPoolsStmt.get() as { count: number }).count,
      negativeResults: (negativeResultsStmt.get() as { count: number }).count,
    };
  }

  // Force refresh cache for a token (clear existing entries) - used sparingly
  static forceRefresh(tokenAddress: string) {
    console.log(`[METEORA_CACHE] Force refreshing cache for ${tokenAddress}`);
    this.clearTokenCache(tokenAddress);
  }

  // Check if token has any valid pools
  static hasValidPools(tokenAddress: string): boolean {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count 
      FROM meteora_pools 
      WHERE token_address = ? AND pool_id != 'NO_POOLS_FOUND'
    `);
    const result = stmt.get(tokenAddress) as { count: number };
    return result.count > 0;
  }
} 