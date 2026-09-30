const express = require("express");
const cors = require("cors");
const http = require("http");
const os = require("os");

const routes = require("./src/routes");
const { attachWebSocketServer } = require("./src/websocketHandler");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use("/", routes);

const server = http.createServer(app);
attachWebSocketServer(server);

const PORT = process.env.PORT || 4000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`ScreenFusion server listening on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://<LAN_IP>:${PORT}/ws`);
  console.log(`LAN IPs to use for the QR code / mobile client:`);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        console.log(`  ${name}: ${addr.address}`);
      }
    }
  }
});