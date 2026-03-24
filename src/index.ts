import express from 'express';
import bodyParser from 'body-parser';
import mongoose from 'mongoose';
import http from 'http';
import WssSocket from "ws";
import { router } from './router';
import { initLogger } from './log/logger';
import { HTTP_PORT, MONGODB_URI, WSS_PORT } from './config';
import { wssUnifiedHandler } from './wsClient/unifiedHandler';
import { startNewpairStream } from './wsClient/newPair/streamServer';
import { scheduleTrendDataFetch } from './service/trendTokenList/fetchTrendTokens';
import { initDatabase } from './db';

// logger
initLogger()

console.log('=== CoinVera Backend Server v2.0 (Unified WebSocket) ===');

// API routes
const app = express();
app.use(bodyParser.json());
app.use('/api/v1', router);

// Connect to MONGODB
mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('- Connected to MongoDB');
    
    // Initialize SQLite database for pumpfun caching
    try {
      await initDatabase();
      console.log('- SQLite database initialized for pumpfun caching');
    } catch (error) {
      console.error('- Error initializing SQLite database:', error);
    }
    
    // Start newpair monitoring server with proper error handling
    try {
      console.log('- Starting newpair stream...');
      startNewpairStream();
      console.log('- ✓ Newpair stream started successfully');
    } catch (error) {
      console.error('- ✗ Failed to start newpair stream:', error);
      console.error('- Warning: Newpair monitoring will not be available');
    }

    // Schedule fetching trend token list
    try {
      scheduleTrendDataFetch();
      console.log('- ✓ Trend data fetching scheduled');
    } catch (error) {
      console.error('- ✗ Failed to schedule trend data fetching:', error);
    }
  })
  .catch((error) => {
    console.error('- Error connecting to MongoDB:', error);
    process.exit(1); // Exit if MongoDB connection fails
  });

// Create HTTP server
app.listen(HTTP_PORT, () => {
  console.log(`- [ HTTP ] Server listening on port ${HTTP_PORT}`);
});

// Create WEBSOCKET server
console.log(`- [ WSS ] Starting WebSocket server on port ${WSS_PORT}...`);
const server = http.createServer();
const wss = new WssSocket.Server({ server });

wss.on("connection", (ws: WebSocket, request) => {
  const pathname = request.url;
  console.log(`- [ WSS ] New connection from ${request.socket.remoteAddress}:${request.socket.remotePort} on path: ${pathname}`);
  
  // All WebSocket connections now go through the unified handler
  // regardless of the pathname - no more endpoint restrictions
  console.log('WebSocket connection established - using unified handler');
  
  // Debug: Log when connection closes
  // (ws as any).on('close', (code: number, reason: string) => {
  //   console.log(`- [ WSS ] Connection closed with code: ${code}, reason: ${reason}`);
  // });
  
  try {
    wssUnifiedHandler(ws);
    console.log('- [ WSS ] Unified handler attached successfully');
  } catch (error) {
    console.error('- [ WSS ] Error in unified handler:', error);
    ws.close(1011, 'Internal server error');
  }
});

wss.on("error", (error) => {
  console.error("- [ WSS ] WebSocket server error:", error);
});

server.listen(WSS_PORT, () => {
  console.log(`- [ WSS ] Server is running on port: ${WSS_PORT}`);
}).on('error', (error) => {
  console.error("- [ WSS ] Failed to start WebSocket server:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Handle the error or exit the process
  // process.exit(1); // Uncomment to exit the process
});