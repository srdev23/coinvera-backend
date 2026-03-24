import { PlanLimit } from "../config";
import User from "../models/User";
import { getTokenInfo } from "../router/getTokenInfo";
import { setTradeSubscription, unsubscribeTrading } from "./trading/subscribeTrading";

type Tsubscription = {
  subscribeId: number;
  tokens: string[];
  stream: any;
  intervalId?: NodeJS.Timeout;
};

type NewPairSubscription = {
  clientId: number;
  ws: WebSocket;
};

// Unified client list for all subscription types
const unifiedClientsList = new Map<
  number,
  {
    ws: WebSocket;
    tSubscriptions: Tsubscription[];
    newPairSubscription?: NewPairSubscription;
  }
>();

const isValidSubscribeRequest = async (data: any) => {
  const apiKey = data.apiKey;
  if (!apiKey)
    throw new Error("API key is required");
  const user = await User.findOne({ "plan.apiKey": apiKey });
  if (!user)
    throw new Error("Invalid API key");
  if (!Array.isArray(data.tokens))
    throw new Error("Invalid tokens format");
  if (data.tokens.length <= 0)
    throw new Error("No tokens provided");
  if (data.tokens.length > PlanLimit[(user as User).plan.level].wssBatch)
    throw new Error("Exceeded token limit for this plan");
  
  // Check if user has sufficient credits before deducting
  if (user.plan.credits < data.tokens.length) {
    throw new Error(`Insufficient credits. Required: ${data.tokens.length}, Available: ${user.plan.credits}. Please upgrade your plan or purchase more credits.`);
  }
  
  // Only deduct credits if user has enough
  user.plan.credits -= data.tokens.length;
  await user.save();
}

const isValidNewPairRequest = async (data: any) => {
  const apiKey = data.apiKey;
  if (!apiKey)
    throw new Error("API key is required");
  
  try {
    const user = await User.findOne({ "plan.apiKey": apiKey });
    if (!user)
      throw new Error("Invalid API key");
    
    // Check if user has sufficient credits before deducting
    if (user.plan.credits < 1) {
      throw new Error("Insufficient credits. Please upgrade your plan or purchase more credits.");
    }
    
    // Only deduct credits if user has enough
    user.plan.credits -= 1;
    await user.save();
    
  } catch (error) {
    throw error;
  }
}

const subscribeTrade = async (data: any, clientId: number, ws: WebSocket) => {
  await isValidSubscribeRequest(data);
  const subscribeId = Date.now();
  const subscribeInfo = await setTradeSubscription(data.tokens, ws);
  unifiedClientsList.get(clientId)!.tSubscriptions.push(
    {
      subscribeId,
      tokens: data.tokens,
      stream: subscribeInfo?.stream,
      intervalId: undefined,
    }
  );
  ws.send(
    JSON.stringify({
      type: "subscribeTrade",
      status: "success",
      tokens: data.tokens,
      subscribeId,
    })
  );
}

const subscribePrice = async (data: any, clientId: number, ws: WebSocket) => {
  await isValidSubscribeRequest(data);
  const subscribeId = Date.now();
  unifiedClientsList.get(clientId)!.tSubscriptions.push(
    {
      subscribeId,
      tokens: data.tokens,
      stream: null,
      intervalId: setPriceSubscription(data.tokens, ws),
    }
  );
  ws.send(
    JSON.stringify({
      type: "subscribePrice",
      status: "success",
      tokens: data.tokens,
      subscribeId,
    })
  );
}

const subscribeNewpair = async (data: any, clientId: number, ws: WebSocket) => {
  try {
    await isValidNewPairRequest(data);
    
    // Ensure the client exists in the unified list
    if (!unifiedClientsList.has(clientId)) {
      throw new Error("Client not found in unified list");
    }
    
    unifiedClientsList.get(clientId)!.newPairSubscription = {
      clientId,
      ws
    };
    
    ws.send(
      JSON.stringify({
        type: "subscribeNewpair",
        status: "success",
      })
    );
  } catch (error) {
    throw error; // Re-throw to be caught by the main error handler
  }
}

const isValidUnsubscribeRequest = async (data: any) => {
  const apiKey = data.apiKey;
  if (!apiKey)
    throw new Error("API key is required");
  const user = await User.findOne({ "plan.apiKey": apiKey });
  if (!user)
    throw new Error("Invalid API key");
}

const unsubscribeTrade = async (data: any, clientId: number, ws: WebSocket) => {
  await isValidUnsubscribeRequest(data);
  const unSubscribeId = data.unsubscribeId;
  if (!unSubscribeId)
    throw new Error("UnsubscribeId is required");
  unifiedClientsList.get(clientId)!.tSubscriptions = unifiedClientsList
    .get(clientId)!
    .tSubscriptions.filter(async (_tsubscription) => {
      if (_tsubscription.subscribeId === unSubscribeId)
        await unsubscribeTrading(_tsubscription.stream);
      else return _tsubscription;
    });
  ws.send(
    JSON.stringify({
      type: "unsubscribeTrade",
      status: "success",
      tokens: data.tokens,
      unSubscribeId,
    })
  );
}

const unsubscribePrice = async (data: any, clientId: number, ws: WebSocket) => {
  await isValidUnsubscribeRequest(data);
  const unSubscribeId = data.unsubscribeId;
  if (!unSubscribeId)
    throw new Error("UnsubscribeId is required");
  unifiedClientsList.get(clientId)!.tSubscriptions = unifiedClientsList
    .get(clientId)!
    .tSubscriptions.filter(async (_tsubscription) => {
      if (_tsubscription.subscribeId === unSubscribeId)
        clearInterval(_tsubscription.intervalId!);
      else return _tsubscription;
    });
  ws.send(
    JSON.stringify({
      type: "unsubscribePrice",
      status: "success",
      tokens: data.tokens,
      unSubscribeId,
    })
  );
}

const unsubscribeNewpair = async (clientId: number) => {
  const client = unifiedClientsList.get(clientId);
  if (client) {
    client.newPairSubscription = undefined;
  }
}

// Export function to get unified clients list for newpair stream
export const getUnifiedWssList = () => {
  const newPairClients = new Map<number, { ws: WebSocket }>();
  unifiedClientsList.forEach((client, clientId) => {
    if (client.newPairSubscription) {
      newPairClients.set(clientId, { ws: client.ws });
    }
  });
  
  return newPairClients;
}

export const wssUnifiedHandler = (ws: WebSocket) => {
  const clientId = Date.now();
  console.log("Client connected, id:", clientId);
  console.log("- [ WSS ] Unified handler attached successfully");
  unifiedClientsList.set(clientId, {
    ws,
    tSubscriptions: [],
  });

  ws.onmessage = async (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data as string);
      // Handle different message types
      switch (data.method) {
        case "subscribeTrade":
          await subscribeTrade(data, clientId, ws);
          break;
        case "subscribePrice":
          await subscribePrice(data, clientId, ws);
          break;
        case "subscribeNewpair":
          await subscribeNewpair(data, clientId, ws);
          break;
        case "unsubscribeTrade":
          await unsubscribeTrade(data, clientId, ws);
          break;
        case "unsubscribePrice":
          await unsubscribePrice(data, clientId, ws);
          break;
        case "unsubscribeNewpair":
          await unsubscribeNewpair(clientId);
          ws.send(
            JSON.stringify({
              type: "unsubscribeNewpair",
              status: "success",
            })
          );
          break;
        default:
          throw new Error("Unknown method");
      }
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Error while processing request",
        })
      );
    }
  };

  ws.onopen = () => {
    // Connection opened
  };

  ws.onclose = async () => {
    const client = unifiedClientsList.get(clientId);
    if (client) {
      // Clean up trading subscriptions
      const cleanupPromises = client.tSubscriptions.map(async (subToken) => {
        if (subToken.intervalId) {
          // Clean up price subscription intervals
          clearInterval(subToken.intervalId);
        }
        if (subToken.stream) {
          // Clean up trading subscription gRPC streams
          try {
            await unsubscribeTrading(subToken.stream);
          } catch (error) {
            console.error(`[CLEANUP] Error cleaning up trading stream for client ${clientId}:`, error);
          }
        }
      });
      
      // Wait for all cleanup operations to complete
      await Promise.all(cleanupPromises);
      
      // Clean up newpair subscription
      if (client.newPairSubscription) {
        unsubscribeNewpair(clientId);
      }
    }
    unifiedClientsList.delete(clientId);
  };

  ws.onerror = (error) => {
    console.error("WebSocket error:", error);
    ws.close();
  };
};

const setPriceSubscription = (tokens: string[], clientWss: WebSocket) => {
  return setInterval(async () => {
    try {
      const result = await Promise.all(tokens.map(ca => getTokenInfo(ca)));
      clientWss.send(JSON.stringify(result));
    } catch (error) {
      clientWss.send(JSON.stringify({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Error while processing request",
      }));
    }
  }, 2 * 1000);
}; 