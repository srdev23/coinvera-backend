import Client, {
    CommitmentLevel,
    SubscribeRequest,
} from "@triton-one/yellowstone-grpc";
import bs58 from 'bs58';
import { GRPC_URL, X_TOKEN } from "../../config";

const WSOL = "So11111111111111111111111111111111111111112"

const Dex_Info = [
    { name: "Jupiter", programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" },
    { name: "Pump.fun", programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" },
    { name: "Pump.fun Amm", programId: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA" },
    { name: "Fluxbeam", programId: "FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X" },
    { name: "Meteora Pool", programId: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB" },
    { name: "Meteora Dlmm", programId: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo" },
    { name: "Orca Whirlpool", programId: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc" },
    { name: "Raydium AmmV4", programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" },
    { name: "Raydium Cpmm", programId: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C" },
    { name: "Raydium Clmm", programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" },
    { name: "Raydium AMM Route", programId: "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS" },
    { name: "Raydium Launchpad", programId: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj" },
];

const unsubscribeRequest: SubscribeRequest = {
    "slots": {},
    "accounts": {},
    "transactions": {},
    "transactionsStatus": {},
    "entry": {},
    "blocks": {},
    "blocksMeta": {},
    "accountsDataSlice": [],
};

export async function setTradeSubscription(keys: string[], ws: WebSocket) {
    console.log("[TRADE] Starting trade subscription for", keys.length, "tokens");
    
    try {
        const client = new Client(GRPC_URL, X_TOKEN, {
            // "grpc.max_receive_message_length": 1024 * 1024 * 1024, // 64MiB/
        });

        // Subscribe for events
        const stream = await client.subscribe();

        // Create `error` / `end` handler
        const streamClosed = new Promise<void>((resolve, reject) => {
            stream.on("error", (error) => {
                console.error("[TRADE] Stream error", error);
                reject(error);
                stream.end();
            });
            stream.on("end", () => {
                console.error("[TRADE] Stream end");
                resolve();
            });
            stream.on("close", () => {
                console.error("[TRADE] Stream close");
                resolve();
            });
        });

        // Handle updates
        stream.on("data", (data) => {
            try {
                if (data && data.transaction) {
                    const convertedTx = convertBuffers(data.transaction);
                    if (!convertedTx.transaction) return;
                    if (!convertedTx.transaction.transaction.message) return;
                    if (!convertedTx.transaction.transaction.message.accountKeys) return;

                    const signature = convertedTx.transaction.signature;
                    const accountList = convertedTx.transaction.transaction.message.accountKeys;
                    const signer = accountList[0];

                    const dexs = Dex_Info.filter((dex) =>
                        accountList.includes(dex.programId)
                    ).map((d) => d.name);
                    if(dexs.length === 0)
                        dexs.push("Unknown");
                    const txMeta = convertedTx.transaction.meta;
                    if (!txMeta) return;
                    const solAmount = getDeltaSolAmount(txMeta.preBalances, txMeta.postBalances, txMeta.fee) / 1e9;
                    if (Math.abs(solAmount) === 0) return;

                    const tokenData = analyzeTokenTransfer(signer, txMeta.preTokenBalances, txMeta.postTokenBalances);
                    if (!tokenData) return;
                    if (
                        (tokenData.is_buy && solAmount > 0) ||
                        (!tokenData.is_buy && solAmount < 0)
                    )
                        return;
                    if (tokenData.significantMints.length > 0) {
                        if (!keys.includes(signer) && !keys.includes(tokenData?.significantMints[0]?.mint))
                            return;
                        const trade = tokenData.is_buy ? "buy" : "sell";
                        const ca = tokenData?.significantMints[0]?.mint;
                        const tokenAmount = tokenData?.significantMints[0]?.amount;
                        const priceInSol = Math.abs(solAmount / tokenAmount);
                        const txnData = {
                            signature,
                            signer,
                            dexs,
                            ca,
                            trade,
                            priceInSol,
                            solAmount,
                            tokenAmount,
                            TokenDelta: tokenData.significantMints,
                        };
                        ws.send(JSON.stringify(txnData));
                    }
                }
            } catch (error) {
                console.error(error);
            }
        });

        // Example subscribe request.
        const request: SubscribeRequest = {
            commitment: CommitmentLevel.CONFIRMED,
            accountsDataSlice: [],
            ping: undefined,
            transactions: {
                client: {
                    vote: false,
                    failed: false,
                    accountInclude: keys,
                    accountExclude: [],
                    accountRequired: [],
                },
            },
            // unused arguments
            accounts: {},
            slots: {},
            transactionsStatus: {},
            entry: {},
            blocks: {},
            blocksMeta: {},
        };

        // Send subscribe request
        await new Promise<void>((resolve, reject) => {
            stream.write(request, (err: any) => {
                if (err === null || err === undefined) {
                    console.log("[TRADE] ✓ Subscription active");
                    resolve();
                } else {
                    console.log("[TRADE] Error in subscribe request", err);
                    reject(err);
                }
            });
        }).catch((reason) => {
            console.error("[TRADE] Subscription request failed:", reason);
            throw reason;
        });

        streamClosed;
        return { stream };
    } catch (e) {
        console.error("Error in subscribeTrading function", e);
        throw e;
    }
}

export async function unsubscribeTrading(stream: any) {
    try {
        if (!stream) {
            console.log("[CLEANUP] No stream to unsubscribe");
            return;
        }

        console.log("[CLEANUP] Starting gRPC stream cleanup...");
        
        // Check if stream is already destroyed
        if (stream.destroyed) {
            console.log("[CLEANUP] Stream already destroyed");
            return;
        }

        // Send unsubscribe request with timeout
        try {
            await Promise.race([
                new Promise<void>((resolve, reject) => {
                    stream.write(unsubscribeRequest, (err: any) => {
                        if (err === null || err === undefined) {
                            console.log("[CLEANUP] Unsubscribe request sent successfully");
                            resolve();
                        } else {
                            console.error("[CLEANUP] Error sending unsubscribe request:", err);
                            reject(err);
                        }
                    });
                }),
                new Promise<void>((_, reject) => {
                    setTimeout(() => reject(new Error("Unsubscribe request timeout")), 5000);
                })
            ]);
        } catch (error) {
            console.error("[CLEANUP] Failed to send unsubscribe request:", error);
            // Continue with stream destruction even if unsubscribe fails
        }

        // Force close the stream
        try {
            stream.destroy();
            console.log("[CLEANUP] Stream destroyed successfully");
        } catch (error) {
            console.error("[CLEANUP] Error destroying stream:", error);
        }

    } catch (e) {
        console.error("[CLEANUP] Error in unsubscribeTrading function:", e);
        // Force destroy stream even if other operations fail
        try {
            if (stream && !stream.destroyed) {
                stream.destroy();
                console.log("[CLEANUP] Force destroyed stream after error");
            }
        } catch (forceError) {
            console.error("[CLEANUP] Failed to force destroy stream:", forceError);
        }
    }
}

// Add this utility function to process the transaction object
function convertBuffers(obj: any): any {
    if (obj === null || obj === undefined) {
        return obj;
    }

    // Handle Buffer objects
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
        return bs58.encode(new Uint8Array(obj.data));
    }

    // Handle arrays
    if (Array.isArray(obj)) {
        return obj.map(item => convertBuffers(item));
    }

    // Handle objects
    if (typeof obj === 'object') {
        // Handle Uint8Array directly
        if (obj instanceof Uint8Array) {
            return bs58.encode(obj);
        }

        const converted: any = {};
        for (const [key, value] of Object.entries(obj)) {
            // Skip certain keys that shouldn't be converted
            if (key === 'uiAmount' || key === 'decimals' || key === 'uiAmountString') {
                converted[key] = value;
            } else {
                converted[key] = convertBuffers(value);
            }
        }
        return converted;
    }

    return obj;
}

const getDeltaSolAmount = (preBalance: string[], postBalance: string[], txnFee: string): number => {
    const preBal = preBalance.map(Number);
    const postBal = postBalance.map(Number);
    const fee = Number(txnFee);
    let deltaSol: number[] = [];
    for (let i = 0; i < preBal.length; i++) {
        deltaSol[i] = postBal[i] - preBal[i];
    }
    let result = postBal[0] - preBal[0];
    for (let i = preBal.length - 1; i >= 0; i--) {
        const _flag = deltaSol.some(
            (delta) => Math.ceil(delta / deltaSol[i]) === -1 && delta !== 0
        );
        if (_flag) {
            result = result > 0 ? Math.abs(deltaSol[i]) : -1 * Math.abs(deltaSol[i]);
            break;
        }
        if (Math.abs(deltaSol[i]) === 2039280)
            result = result > 0 ? result - 2039280 - fee : result + 2039280 + fee;
    }
    return result;
};

type TokenBalance = {
    accountIndex: number,
    mint: string,
    uiTokenAmount: {
        uiAmount: number,
        decimals: number,
        amount: string,
        uiAmountString: string
    },
    owner: string,
    programId: string
}

const analyzeTokenTransfer = (
    signer: string,
    preData: TokenBalance[],
    postData: TokenBalance[],
) => {
    const mints: { mint: string; amount: number }[] = [];
    const preMintBalances = new Map<string, { mint: string; amount: number }>();
    const postMintBalances = new Map<string, { mint: string; amount: number }>();

    // Fill pre balances map
    preData.forEach((item) => {
        if (item.owner === signer) {
            preMintBalances.set(item.accountIndex.toString(), {
                mint: item.mint,
                amount: Number(item.uiTokenAmount.uiAmount),
            });
        }
    });

    // Fill post balances map and detect changes
    postData.forEach((item) => {
        if (item.owner === signer) {
            postMintBalances.set(item.accountIndex.toString(), {
                mint: item.mint,
                amount: Number(item.uiTokenAmount.uiAmount),
            });

            const preBalance = preMintBalances.get(item.accountIndex.toString());
            if (!preBalance) {
                // New token detected
                mints.push({
                    mint: item.mint,
                    amount: Number(item.uiTokenAmount.uiAmount),
                });
            } else {
                // Existing token change
                const deltaAmount =
                    Number(item.uiTokenAmount.uiAmount) - preBalance.amount;
                if (deltaAmount !== 0) {
                    mints.push({
                        mint: item.mint,
                        amount: deltaAmount,
                    });
                }
            }
        }
    });

    let is_buy = true;
    let is_wSolReceived = false;
    const significantMints = mints.filter((item) => Math.abs(item.amount) > 0);

    significantMints.forEach((item) => {
        const isWSol = item.mint === WSOL;
        if (isWSol && item.amount > 0) is_wSolReceived = true;
        if (!isWSol && item.amount < 0) is_buy = false;
    });

    if (is_wSolReceived && is_buy) return null;

    const onlyWsolChanges =
        significantMints.length === 1 &&
        significantMints[0].mint === WSOL;

    return onlyWsolChanges ? null : { is_buy, significantMints };
};