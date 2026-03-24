import { subscribe, CommitmentLevel, LaserstreamConfig, SubscribeRequest, SubscribeUpdate } from 'helius-laserstream'
import { getUnifiedWssList } from '../unifiedHandler';
import { LASER_STREAM_KEY } from '../../config';
import bs58 from 'bs58';

const Dex_Info = [
  { name: "Pump.fun", programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", key_instruction: "InitializeMint2", creator: 7, pool: 2, token0: 0, token1: undefined },
  { name: "Pump.fun Amm", programId: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", key_instruction: "CreatePool", creator: 2, pool: 0, token0: 3, token1: 4 },
  { name: "Meteora DlmmV2", programId: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", key_instruction: "InitializePool", creator: 0, pool: 6, token0: 8, token1: 9 },
  { name: "LaunchLab", programId: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", key_instruction: "InitializeMint2", creator: 0, pool: 5, token0: 6, token1: 7 },
  { name: "Raydium Cpmm", programId: "RAYpQbFNq9i3mu6cKpTKKRwwHFDeK5AuZz8xvxUrCgw", key_instruction: "MigrateToCpswap", creator: 0, pool: 5, token0: 1, token1: 2 },
  { name: "Raydium AmmV4", programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", key_instruction: "initialize2", creator: 17, pool: 4, token0: 8, token1: 9 },
  { name: "Raydium Cpmm", programId: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", key_instruction: "InitializeMint2", creator: 0, pool: 3, token0: 4, token1: 5 },
  { name: "Raydium Clmm", programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", key_instruction: "CreatePool", creator: 0, pool: 2, token0: 3, token1: 4 },
];

function processTransaction(txUpdate: any) {
  const tx = txUpdate.transaction;
  const meta = tx.meta;
  const message = tx.transaction.message;
  const ins = message.instructions;
  const accountList = message.accountKeys.map((acc: any) => bs58.encode(acc));
  Dex_Info.some((_dex) => {
    if (accountList.includes(_dex.programId)) {
      const progId = accountList.findIndex((acc: any) => acc === _dex.programId);
      const accountsData = ins.find((instruction: any) => instruction.programIdIndex === progId);

      const isCreateTxn = (meta?.logMessages && meta?.logMessages.some((log: any) => log.includes(_dex.key_instruction)));
      if (accountsData && isCreateTxn) {
        const accountsRealData = Array.from(Buffer.from(accountsData.accounts)).map(accId => {
          const _id = Number(accId);
          return accountList[_id]
        })//.filter(item => item !== undefined);
        const signature = bs58.encode(tx.signature);
        const dex = _dex.name;
        const creator = accountsRealData[_dex.creator];
        const pool = accountsRealData[_dex.pool];
        const token0 = _dex.token0 === undefined ? undefined : accountsRealData[_dex.token0];
        const token1 = _dex.token1 === undefined ? undefined : accountsRealData[_dex.token1];

        const newPairInfo = {
          dex,
          signature,
          creator,
          pool,
          token0,
          token1
        }
        broadcastNewPairData(newPairInfo);
        return true;
      }
    }
    return false;
  })
}

export async function startNewpairStream() {
  const subscriptionRequest: SubscribeRequest = {
    transactions: {
      client: {
        accountInclude: Dex_Info.map(dex => dex.programId),
        accountExclude: [],
        accountRequired: [],
        vote: false,
        failed: false
      }
    },
    commitment: CommitmentLevel.PROCESSED,
    accounts: {},
    slots: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    // Optionally, you can replay missed data by specifying a fromSlot:
    // fromSlot: '224339000'
    // Note: Currently, you can only replay data from up to 3000 slots in the past.
  };

  // Replace the values below with your actual LaserStream API key and endpoint
  const config: LaserstreamConfig = {
    apiKey: LASER_STREAM_KEY || "", // Replace with your key from https://dashboard.helius.dev/
    endpoint: 'https://laserstream-mainnet-sgp.helius-rpc.com', // Choose your closest region
  }

  await subscribe(config, subscriptionRequest, async (update: SubscribeUpdate) => {
    if (update.transaction) {
      processTransaction(update.transaction);
    }

  }, async (e: any) => {
    console.error(e.message);
  });
}


// Broadcast new pair data to all connected clients
function broadcastNewPairData(data: any): void {
  try {
    // Remove any undefined fields
    Object.keys(data).forEach(key => {
      if (data[key] === undefined || data[key] === 'unknown') {
        delete data[key];
      }
    });

    // console.table(data);

    // Log the clean format
    //] 🚀 New pair:`, simplifiedData);

    // Get active clients
    const clientsList = getUnifiedWssList();
    const activeClients = new Map();

    // Clean up dead connections inline
    clientsList.forEach((client, id) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        activeClients.set(id, client);
      }
    });

    // Send to all connected clients
    if (activeClients.size > 0) {
      const message = JSON.stringify({
        type: 'newpair',
        data
      });

      let successCount = 0;
      let errorCount = 0;

      activeClients.forEach((client: any, clientId: number) => {
        try {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(message);
            successCount++;
          } else {
            errorCount++;
          }
        } catch (error) {
          console.error(`[BROADCAST] Error sending to client:`, error);
          errorCount++;
        }
      });

      // Silent broadcast - no need to log success
    } else {
      // Silent when no clients connected - no need to log this
    }
  } catch (error) {
    console.error("[BROADCAST] ❌ Error broadcasting new pair data:", error);
  }
}