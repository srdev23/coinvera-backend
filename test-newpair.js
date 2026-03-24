const WebSocket = require('ws');

// Test the newpair subscription
function testNewpairSubscription() {
    console.log("🧪 Testing newpair subscription...");
    
    // Connect to the WebSocket server
    const ws = new WebSocket('ws://localhost:3000');
    
    ws.on('open', function open() {
        console.log("✅ Connected to WebSocket server");
        
        // Send subscription request
        const subscriptionRequest = {
            apiKey: "7755479367fa8ee78890bce6b5c71fd285a296cd",  // Replace with your API key
            method: "subscribeNewpair"
        };
        
        console.log("📤 Sending subscription request:", subscriptionRequest);
        ws.send(JSON.stringify(subscriptionRequest));
    });
    
    ws.on('message', function message(data) {
        const parsed = JSON.parse(data);
        console.log("📥 Received message:", JSON.stringify(parsed, null, 2));
    });
    
    ws.on('error', function error(err) {
        console.error("❌ WebSocket error:", err);
    });
    
    ws.on('close', function close() {
        console.log("🔌 WebSocket connection closed");
    });
    
    // Keep the connection alive
    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            console.log("💗 Connection alive - waiting for newpair data...");
        }
    }, 30000);
}

testNewpairSubscription(); 