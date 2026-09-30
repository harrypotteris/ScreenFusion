const WebSocket = require("ws");
const sessionManager = require("./sessionManager");

/**
 * Wire protocol (all messages are JSON):
 *
 * Client -> Server
 *   { type: "join", sessionId, role?: "host" }
 *   { type: "sensor_update", heading, tilt, battery }
 *   { type: "sync_ack", clientTime }
 *   { type: "video_control", action: "play"|"pause"|"seek", url?, positionSec? }   (host only)
 *   { type: "tile_assignment", assignments: { [deviceId]: tileIndex } }            (host only, or from LLM engine via host)
 *   { type: "ping" }
 *
 * Server -> Client
 *   { type: "joined", deviceId, role, sessionId }
 *   { type: "device_list", devices: [...] }
 *   { type: "tile_assignment", deviceId, tileIndex }
 *   { type: "video_control", action, url, positionSec, serverTime }
 *   { type: "sync_tick", serverTime }
 *   { type: "device_status", deviceId, status }
 *   { type: "error", message }
 *   { type: "pong" }
 */

const HEARTBEAT_INTERVAL_MS = 10000; // ws-level ping cadence — loose enough for a shaky phone hotspot
const SYNC_TICK_INTERVAL_MS = 2000;

function attachWebSocketServer(server) {
  const wss = new WebSocket.Server({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    // Each socket tracks which session/device it belongs to once it joins.
    ws.sessionId = null;
    ws.deviceId = null;
    ws.isAlive = true;
    ws.missedPings = 0;

    ws.on("pong", () => {
      ws.isAlive = true;
      ws.missedPings = 0;
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: "error", message: "Malformed JSON" });
      }
      handleMessage(ws, msg);
    });

    ws.on("close", () => {
      if (ws.sessionId && ws.deviceId) {
        sessionManager.removeDevice(ws.sessionId, ws.deviceId);
        broadcastDeviceList(ws.sessionId);
      }
    });
  });

  // Detect dead sockets (client vanished without a clean close).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.missedPings = (ws.missedPings || 0) + 1;
        // Give a flaky connection two misses (~20s) before we actually drop it.
        if (ws.missedPings >= 2) {
          if (ws.sessionId && ws.deviceId) sessionManager.removeDevice(ws.sessionId, ws.deviceId);
          ws.terminate();
          continue;
        }
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Periodic sweep: flip device status between connected/lagging/disconnected based on lastSeen,
  // and let every session know when a device's status changes.
  const statusSweep = setInterval(() => {
    const changes = sessionManager.sweepStaleDevices();
    for (const change of changes) {
      broadcastToSession(change.sessionId, {
        type: "device_status",
        deviceId: change.deviceId,
        status: change.status,
      });
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Sync ticks keep every viewer's playback clock aligned to the server clock.
  const syncTicker = setInterval(() => {
    for (const session of sessionManager.sessions.values()) {
      broadcastToSession(session.id, { type: "sync_tick", serverTime: Date.now() });
    }
  }, SYNC_TICK_INTERVAL_MS);

  wss.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(statusSweep);
    clearInterval(syncTicker);
  });

  return wss;
}

function handleMessage(ws, msg) {
  // Any message at all proves the device is alive — keep its lastSeen fresh
  // regardless of whether it's actively streaming sensor data.
  if (ws.sessionId && ws.deviceId) sessionManager.touch(ws.sessionId, ws.deviceId);

  switch (msg.type) {
    case "join":
      return handleJoin(ws, msg);
    case "sensor_update":
      return handleSensorUpdate(ws, msg);
    case "sync_ack":
      return sessionManager.touch(ws.sessionId, ws.deviceId);
    case "video_control":
      return handleVideoControl(ws, msg);
    case "tile_assignment":
      return handleTileAssignment(ws, msg);
    case "ping":
      return send(ws, { type: "pong" });
    default:
      return send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
  }
}

function handleJoin(ws, msg) {
  const { sessionId, role } = msg;
  const session = sessionManager.getSession(sessionId);
  if (!session) return send(ws, { type: "error", message: "Session not found" });

  const result = sessionManager.joinSession(sessionId, ws, role);
  ws.sessionId = sessionId;
  ws.deviceId = result.deviceId;

  send(ws, { type: "joined", deviceId: result.deviceId, role: result.role, sessionId });
  broadcastDeviceList(sessionId);
}

function handleSensorUpdate(ws, msg) {
  if (!requireJoined(ws)) return;
  const { heading, tilt, battery } = msg;
  sessionManager.updateSensors(ws.sessionId, ws.deviceId, { heading, tilt, battery });
  broadcastDeviceList(ws.sessionId);
}

function handleVideoControl(ws, msg) {
  if (!requireJoined(ws)) return;
  const session = sessionManager.getSession(ws.sessionId);
  if (!session || session.hostDeviceId !== ws.deviceId) {
    return send(ws, { type: "error", message: "Only the host can control video" });
  }
  if (msg.url !== undefined) session.videoState.url = msg.url;
  if (msg.action === "play") session.videoState.playing = true;
  if (msg.action === "pause") session.videoState.playing = false;
  if (msg.positionSec !== undefined) session.videoState.positionSec = msg.positionSec;
  session.videoState.updatedAt = Date.now();

  broadcastToSession(ws.sessionId, {
    type: "video_control",
    action: msg.action,
    url: session.videoState.url,
    positionSec: session.videoState.positionSec,
    serverTime: Date.now(),
  });
}

function handleTileAssignment(ws, msg) {
  if (!requireJoined(ws)) return;
  const session = sessionManager.getSession(ws.sessionId);
  if (!session || session.hostDeviceId !== ws.deviceId) {
    return send(ws, { type: "error", message: "Only the host can assign tiles" });
  }
  sessionManager.setTileAssignments(ws.sessionId, msg.assignments || {});
  for (const [deviceId, tileIndex] of Object.entries(msg.assignments || {})) {
    const device = session.devices.get(deviceId);
    if (device) send(device.ws, { type: "tile_assignment", deviceId, tileIndex });
  }
  broadcastDeviceList(ws.sessionId);
}

function requireJoined(ws) {
  if (!ws.sessionId || !ws.deviceId) {
    send(ws, { type: "error", message: "Join a session first" });
    return false;
  }
  return true;
}

function broadcastDeviceList(sessionId) {
  const devices = sessionManager.listDevices(sessionId);
  broadcastToSession(sessionId, { type: "device_list", devices });
}

function broadcastToSession(sessionId, payload) {
  const session = sessionManager.getSession(sessionId);
  if (!session) return;
  for (const device of session.devices.values()) {
    send(device.ws, payload);
  }
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

module.exports = { attachWebSocketServer };