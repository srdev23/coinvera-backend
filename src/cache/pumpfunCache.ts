import { getDatabase } from '../db';
import { getCachedSolPrice } from '../service';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { PUMP_TOKEN_DECIMALS } from '../dex/pumpfun/constants';

export interface TokenCacheData {
  token_address: string;
  current_dex: 'pumpfun' | 'pumpfun_amm';
  
  // Pumpfun bonding curve address (permanent cache)
  bonding_curve_address?: string;
  
  // Pumpfun AMM vault data (permanent cache)
  pool_base_token_account?: string;
  pool_quote_token_account?: string;
  pool_id?: string;
  
  // Common fields
  last_updated: Date;
  token_decimals: number;
  is_graduated: boolean;
}

export interface PumpfunPriceResult {
  dex: string;
  liquidity?: number;
  priceInSol: number;
  priceInUsd: number;
  bondingCurveProgress?: number;
}

export interface PumpfunAmmPriceResult {
  dex: string;
  poolId: string;
  liquidity: number;
  priceInSol: number;
  priceInUsd: number;
}

// Addresses are cached permanently (no expiry needed)
// Fresh data is fetched from cached addresses each time

export class PumpfunCache {
  private static instance: PumpfunCache;
  
  public static getInstance(): PumpfunCache {
    if (!PumpfunCache.instance) {
      PumpfunCache.instance = new PumpfunCache();
    }
    return PumpfunCache.instance;
  }

  // Get cached token data
  async getCachedToken(tokenAddress: string): Promise<TokenCacheData | null> {
    const db = await getDatabase();
    const row = await db.get(
      'SELECT * FROM token_cache WHERE token_address = ?',
      tokenAddress
    );
    
    if (!row) return null;
    
    return {
      ...row,
      last_updated: new Date(row.last_updated),
    };
  }

  // Cache pumpfun bonding curve address (permanent)
  async cachePumpfunBondingCurveAddress(
    tokenAddress: string,
    bondingCurveAddress: string,
    tokenDecimals: number = 6
  ): Promise<void> {
    const db = await getDatabase();
    const now = new Date();

    await db.run(`
      INSERT OR REPLACE INTO token_cache (
        token_address, current_dex, bonding_curve_address,
        last_updated, token_decimals, is_graduated
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
      tokenAddress, 'pumpfun', bondingCurveAddress,
      now.toISOString(), tokenDecimals, false
    ]);
  }

  // Cache pumpfun AMM vault data (permanent)
  async cachePumpfunAmmVaultData(
    tokenAddress: string,
    poolId: string,
    poolBaseTokenAccount: string,
    poolQuoteTokenAccount: string,
    tokenDecimals: number = 6
  ): Promise<void> {
    const db = await getDatabase();
    const now = new Date();
    
    // Get previous state for history tracking
    const previousState = await this.getCachedToken(tokenAddress);

    await db.run(`
      INSERT OR REPLACE INTO token_cache (
        token_address, current_dex, pool_id, pool_base_token_account,
        pool_quote_token_account, last_updated, token_decimals, is_graduated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      tokenAddress, 'pumpfun_amm', poolId, poolBaseTokenAccount,
      poolQuoteTokenAccount, now.toISOString(), tokenDecimals, true
    ]);

    // Record state transition in history
    if (previousState && previousState.current_dex !== 'pumpfun_amm') {
      await this.recordStateTransition(tokenAddress, previousState.current_dex, 'pumpfun_amm');
    }
  }

  // Record state transition in history
  async recordStateTransition(
    tokenAddress: string,
    previousState: string,
    newState: string,
    priceAtTransition?: number
  ): Promise<void> {
    const db = await getDatabase();
    await db.run(`
      INSERT INTO token_state_history (token_address, previous_state, new_state, price_at_transition)
      VALUES (?, ?, ?, ?)
    `, [tokenAddress, previousState, newState, priceAtTransition || null]);
  }

  // Remove pumpfun bonding curve address (when graduated)
  async removePumpfunBondingCurveData(tokenAddress: string): Promise<void> {
    const db = await getDatabase();
    await db.run(`
      UPDATE token_cache 
      SET bonding_curve_address = NULL
      WHERE token_address = ?
    `, [tokenAddress]);
  }

  // Check if token has graduated (helper method)
  async isTokenGraduated(tokenAddress: string): Promise<boolean> {
    const cached = await this.getCachedToken(tokenAddress);
    return cached?.current_dex === 'pumpfun_amm' && cached?.is_graduated === true;
  }

  // Remove token completely from cache (for full migration)
  async removeToken(tokenAddress: string): Promise<void> {
    const db = await getDatabase();
    await db.run('DELETE FROM token_cache WHERE token_address = ?', [tokenAddress]);
    console.log(`[PUMPFUN_CACHE] Removed token ${tokenAddress} from cache`);
  }

  // Update token's current DEX status (for migrations)
  async updateTokenDex(tokenAddress: string, newDex: 'pumpfun' | 'pumpfun_amm'): Promise<void> {
    const db = await getDatabase();
    const now = new Date();
    
    // Get previous state for history tracking
    const previousState = await this.getCachedToken(tokenAddress);
    
    await db.run(`
      UPDATE token_cache 
      SET current_dex = ?, last_updated = ?
      WHERE token_address = ?
    `, [newDex, now.toISOString(), tokenAddress]);

    // Record state transition in history
    if (previousState && previousState.current_dex !== newDex) {
      await this.recordStateTransition(tokenAddress, previousState.current_dex, newDex);
    }
  }

  // Check if token should have bonding curve cache cleared (only when confirmed graduated)
  async shouldClearBondingCurve(tokenAddress: string): Promise<boolean> {
    const cached = await this.getCachedToken(tokenAddress);
    if (!cached) return false;
    
    // Only clear if token has definitively moved to AMM (graduated)
    return cached.current_dex === 'pumpfun_amm' && cached.is_graduated === true;
  }

  // Get tokens that have migrated from pumpfun to AMM
  async getMigratedTokens(): Promise<TokenCacheData[]> {
    const db = await getDatabase();
    const rows = await db.all(`
      SELECT * FROM token_cache 
      WHERE current_dex = 'pumpfun_amm' AND is_graduated = true
    `);
    
    return rows.map(row => ({
      ...row,
      last_updated: new Date(row.last_updated),
    }));
  }

  // Get cache statistics
  async getCacheStats(): Promise<{
    totalTokens: number;
    pumpfunTokens: number;
    ammTokens: number;
    graduatedTokens: number;
  }> {
    const db = await getDatabase();
    const totalTokens = await db.get('SELECT COUNT(*) as count FROM token_cache');
    const pumpfunTokens = await db.get('SELECT COUNT(*) as count FROM token_cache WHERE current_dex = "pumpfun"');
    const ammTokens = await db.get('SELECT COUNT(*) as count FROM token_cache WHERE current_dex = "pumpfun_amm"');
    const graduatedTokens = await db.get('SELECT COUNT(*) as count FROM token_cache WHERE is_graduated = true');
    
    return {
      totalTokens: totalTokens.count,
      pumpfunTokens: pumpfunTokens.count,
      ammTokens: ammTokens.count,
      graduatedTokens: graduatedTokens.count
    };
  }

  // Clear all cache (for testing/debugging)
  async clearCache(): Promise<void> {
    const db = await getDatabase();
    await db.run('DELETE FROM token_cache');
    await db.run('DELETE FROM token_state_history');
  }
}

// Export singleton instance
export const pumpfunCache = PumpfunCache.getInstance(); 