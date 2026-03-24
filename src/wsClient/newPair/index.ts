import User from "../../models/User";

// DEPRECATED: This handler is deprecated. Use wssUnifiedHandler instead.
// This is kept for backwards compatibility but should not be used in new implementations.

const wssList = new Map<
  number,
  {
    ws: WebSocket;
  }
>();

export const getWssList = () => wssList;

const isValidSubscribeRequest = async (data: any) => {
  const apiKey = data.apiKey;
  if (!apiKey)
    throw new Error("API key is required");
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
}

const subscribeNewpair = async (data: any, clientId: number, ws: WebSocket) => {
  console.warn("⚠️  DEPRECATED: Using deprecated newPair handler. Please use unified handler instead.");
  await isValidSubscribeRequest(data);
  wssList.set(clientId, {
    ws
  });
}

const unsubscribeNewpair = async (clientId: number) => {
  wssList.delete(clientId);
}

export const wssNewPairHandler = (ws: WebSocket) => {
  console.warn("⚠️  DEPRECATED: wssNewPairHandler is deprecated. Use wssUnifiedHandler instead.");
  
  const clientId = Date.now();
  console.log("Client connected, id:", clientId);

  ws.onmessage = async (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data as string);
      // Handle different message types
      switch (data.method) {
        case "subscribeNewpair":
          await subscribeNewpair(data, clientId, ws);
          break;
        case "unsubscribeNewpair":
          await unsubscribeNewpair(clientId);
          break;
        default:
          throw new Error("Unknown method");
      }
      ws.send(
        JSON.stringify({
          type: data.method,
          status: "success",
        })
      );
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
    console.log("WebSocket connection opened", clientId);
  };

  ws.onclose = () => {
    console.log("WebSocket connection closed", clientId);
    unsubscribeNewpair(clientId);
  };

  ws.onerror = (error) => {
    console.error("WebSocket error:", error);
    ws.close();
  };
};