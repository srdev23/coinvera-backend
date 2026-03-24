import Database from 'better-sqlite3';
import { PublicKey } from '@solana/web3.js';
import path from 'path';
import fs from 'fs';

// Database path
const dbDir = path.join(process.cwd(), 'db', 'raydium');
const dbPath = path.join(dbDir, 'raydium_cache.db');

// Ensure directory exists
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Pool metadata interface
export interface RaydiumPoolInfo {
    tokenAddress: string;
    poolType: 'amm' | 'clmm' | 'cpmm';
    poolId: string;
    baseMint: string;
    quoteMint: string;
    baseVault: string;
    quoteVault: string;
    liquidityRank: number; // 1 = highest liquidity
    lastUpdated: number;
}

// Database row interface
interface RaydiumPoolRow {
    token_address: string;
    pool_type: string;
    pool_id: string;
    base_mint: string;
    quote_mint: string;
    base_vault: string;
    quote_vault: string;
    liquidity_rank: number;
    last_updated: number;
}

// Create tables
db.exec(`
    CREATE TABLE IF NOT EXISTS raydium_pools (
        token_address TEXT NOT NULL,
        pool_type TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        base_mint TEXT NOT NULL,
        quote_mint TEXT NOT NULL,
        base_vault TEXT NOT NULL,
        quote_vault TEXT NOT NULL,
        liquidity_rank INTEGER NOT NULL,
        last_updated INTEGER NOT NULL,
        PRIMARY KEY (token_address, pool_type, pool_id)
    )
`);

db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_address ON raydium_pools(token_address);
    CREATE INDEX IF NOT EXISTS idx_pool_type ON raydium_pools(pool_type);
    CREATE INDEX IF NOT EXISTS idx_liquidity_rank ON raydium_pools(token_address, pool_type, liquidity_rank);
`);

// Prepared statements
const insertPoolStmt = db.prepare(`
    INSERT OR REPLACE INTO raydium_pools 
    (token_address, pool_type, pool_id, base_mint, quote_mint, base_vault, quote_vault, liquidity_rank, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getPoolsStmt = db.prepare(`
    SELECT * FROM raydium_pools 
    WHERE token_address = ? AND pool_type = ?
    ORDER BY liquidity_rank ASC
`);

const getAllPoolsStmt = db.prepare(`
    SELECT * FROM raydium_pools 
    WHERE token_address = ?
    ORDER BY pool_type, liquidity_rank ASC
`);

const getBestPoolStmt = db.prepare(`
    SELECT * FROM raydium_pools 
    WHERE token_address = ? AND pool_type = ?
    ORDER BY liquidity_rank ASC
    LIMIT 1
`);

const deleteTokenPoolsStmt = db.prepare(`
    DELETE FROM raydium_pools WHERE token_address = ?
`);

const getPoolCountStmt = db.prepare(`
    SELECT COUNT(*) as count FROM raydium_pools WHERE token_address = ?
`);

// Cache operations
export class RaydiumCache {
    // Store pool info for a token
    static storePoolInfo(tokenAddress: string, poolType: 'amm' | 'clmm' | 'cpmm', pools: RaydiumPoolInfo[]) {
        const transaction = db.transaction(() => {
            // First, delete existing pools for this token and type
            db.prepare(`DELETE FROM raydium_pools WHERE token_address = ? AND pool_type = ?`)
                .run(tokenAddress, poolType);

            // Insert new pools
            pools.forEach((pool, index) => {
                insertPoolStmt.run(
                    tokenAddress,
                    poolType,
                    pool.poolId,
                    pool.baseMint,
                    pool.quoteMint,
                    pool.baseVault,
                    pool.quoteVault,
                    index + 1, // liquidity_rank starts from 1
                    Date.now()
                );
            });
        });

        transaction();
    }

    // Get cached pools for a token and specific type
    static getCachedPools(tokenAddress: string, poolType: 'amm' | 'clmm' | 'cpmm'): RaydiumPoolInfo[] {
        const rows = getPoolsStmt.all(tokenAddress, poolType) as RaydiumPoolRow[];
        return rows.map((row) => ({
            tokenAddress: row.token_address,
            poolType: row.pool_type as 'amm' | 'clmm' | 'cpmm',
            poolId: row.pool_id,
            baseMint: row.base_mint,
            quoteMint: row.quote_mint,
            baseVault: row.base_vault,
            quoteVault: row.quote_vault,
            liquidityRank: row.liquidity_rank,
            lastUpdated: row.last_updated
        }));
    }

    // Get all cached pools for a token (all types)
    static getAllCachedPools(tokenAddress: string): RaydiumPoolInfo[] {
        const rows = getAllPoolsStmt.all(tokenAddress) as RaydiumPoolRow[];
        return rows.map((row) => ({
            tokenAddress: row.token_address,
            poolType: row.pool_type as 'amm' | 'clmm' | 'cpmm',
            poolId: row.pool_id,
            baseMint: row.base_mint,
            quoteMint: row.quote_mint,
            baseVault: row.base_vault,
            quoteVault: row.quote_vault,
            liquidityRank: row.liquidity_rank,
            lastUpdated: row.last_updated
        }));
    }

    // Get the best (highest liquidity) pool for a token and type
    static getBestPool(tokenAddress: string, poolType: 'amm' | 'clmm' | 'cpmm'): RaydiumPoolInfo | null {
        const row = getBestPoolStmt.get(tokenAddress, poolType) as RaydiumPoolRow | undefined;
        if (!row) return null;

        return {
            tokenAddress: row.token_address,
            poolType: row.pool_type as 'amm' | 'clmm' | 'cpmm',
            poolId: row.pool_id,
            baseMint: row.base_mint,
            quoteMint: row.quote_mint,
            baseVault: row.base_vault,
            quoteVault: row.quote_vault,
            liquidityRank: row.liquidity_rank,
            lastUpdated: row.last_updated
        };
    }

    // Clear cache for a token
    static clearTokenCache(tokenAddress: string) {
        deleteTokenPoolsStmt.run(tokenAddress);
    }

    // Check if token has cached data
    static hasCachedData(tokenAddress: string): boolean {
        const result = getPoolCountStmt.get(tokenAddress) as { count: number };
        return result.count > 0;
    }

    // Force refresh cache for a token (clear existing entries) - used sparingly for migrations only
    static forceRefresh(tokenAddress: string) {
        console.log(`[RAYDIUM_CACHE] Force refreshing cache for ${tokenAddress}`);
        this.clearTokenCache(tokenAddress);
    }

    // Get cache statistics
    static getCacheStats(): {
        totalTokens: number;
        ammPools: number;
        clmmPools: number;
        cpmmPools: number;
        totalPools: number;
    } {
        const totalTokensStmt = db.prepare(`
            SELECT COUNT(DISTINCT token_address) as count 
            FROM raydium_pools
        `);
        const ammPoolsStmt = db.prepare(`
            SELECT COUNT(*) as count 
            FROM raydium_pools 
            WHERE pool_type = 'amm'
        `);
        const clmmPoolsStmt = db.prepare(`
            SELECT COUNT(*) as count 
            FROM raydium_pools 
            WHERE pool_type = 'clmm'
        `);
        const cpmmPoolsStmt = db.prepare(`
            SELECT COUNT(*) as count 
            FROM raydium_pools 
            WHERE pool_type = 'cpmm'
        `);
        const totalPoolsStmt = db.prepare(`
            SELECT COUNT(*) as count 
            FROM raydium_pools
        `);

        return {
            totalTokens: (totalTokensStmt.get() as { count: number }).count,
            ammPools: (ammPoolsStmt.get() as { count: number }).count,
            clmmPools: (clmmPoolsStmt.get() as { count: number }).count,
            cpmmPools: (cpmmPoolsStmt.get() as { count: number }).count,
            totalPools: (totalPoolsStmt.get() as { count: number }).count,
        };
    }

    // Check if token has any valid pools
    static hasValidPools(tokenAddress: string): boolean {
        const result = getPoolCountStmt.get(tokenAddress) as { count: number };
        return result.count > 0;
    }

    // Get pools by liquidity rank
    static getPoolsByLiquidity(tokenAddress: string): RaydiumPoolInfo[] {
        const stmt = db.prepare(`
            SELECT * FROM raydium_pools 
            WHERE token_address = ? 
            ORDER BY liquidity_rank ASC
        `);
        const rows = stmt.all(tokenAddress) as any[];
        
        return rows.map((row: any) => ({
            tokenAddress: row.token_address,
            poolType: row.pool_type,
            poolId: row.pool_id,
            baseMint: row.base_mint,
            quoteMint: row.quote_mint,
            baseVault: row.base_vault,
            quoteVault: row.quote_vault,
            liquidityRank: row.liquidity_rank,
            lastUpdated: row.last_updated
        }));
    }

    // Update pool liquidity rank
    static updatePoolRank(tokenAddress: string, poolId: string, newRank: number) {
        const stmt = db.prepare(`
            UPDATE raydium_pools 
            SET liquidity_rank = ?, last_updated = ? 
            WHERE token_address = ? AND pool_id = ?
        `);
        stmt.run(newRank, Date.now(), tokenAddress, poolId);
    }
}

export default RaydiumCache; 