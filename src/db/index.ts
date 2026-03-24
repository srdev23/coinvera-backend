import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';

let db: Database<sqlite3.Database, sqlite3.Statement> | null = null;

// Initialize SQLite database
export async function initDatabase(): Promise<Database<sqlite3.Database, sqlite3.Statement>> {
  if (db) return db;

  // Create db/pumpfun directory if it doesn't exist
  const dbDir = path.join(process.cwd(), 'db', 'pumpfun');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = path.join(dbDir, 'pumpfun_cache.db');
  
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
  });

  // Enable WAL mode for better concurrency
  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec('PRAGMA synchronous = NORMAL;');
  await db.exec('PRAGMA cache_size = 10000;');
  await db.exec('PRAGMA temp_store = MEMORY;');

  // Create tables
  await createTables();

  console.log('✅ SQLite database initialized for pumpfun caching at db/pumpfun/pumpfun_cache.db');
  return db;
}

async function createTables() {
  if (!db) throw new Error('Database not initialized');

  // Main token cache table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS token_cache (
      token_address TEXT PRIMARY KEY,
      current_dex TEXT NOT NULL CHECK (current_dex IN ('pumpfun', 'pumpfun_amm')),
      
      -- Pumpfun bonding curve address (permanent cache)
      bonding_curve_address TEXT,
      
      -- Pumpfun AMM vault addresses (permanent cache)
      pool_base_token_account TEXT,
      pool_quote_token_account TEXT,
      pool_id TEXT,
      
      -- Metadata
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      token_decimals INTEGER DEFAULT 6,
      is_graduated BOOLEAN DEFAULT FALSE
    )
  `);

  // Create indexes for performance
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_cache_dex ON token_cache(current_dex);
  `);

  // Token state history table for debugging and analytics
  await db.exec(`
    CREATE TABLE IF NOT EXISTS token_state_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT,
      previous_state TEXT,
      new_state TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      price_at_transition REAL,
      FOREIGN KEY (token_address) REFERENCES token_cache(token_address)
    )
  `);
}

export async function getDatabase(): Promise<Database<sqlite3.Database, sqlite3.Statement>> {
  if (!db) {
    return await initDatabase();
  }
  return db;
}

export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}

// Cleanup function to remove old state history entries (keep last 1000)
export async function cleanupOldHistoryEntries(): Promise<void> {
  const database = await getDatabase();
  await database.run(`
    DELETE FROM token_state_history 
    WHERE id NOT IN (
      SELECT id FROM token_state_history 
      ORDER BY timestamp DESC 
      LIMIT 1000
    )
  `);
}

// Run cleanup every 24 hours
setInterval(cleanupOldHistoryEntries, 24 * 60 * 60 * 1000); 