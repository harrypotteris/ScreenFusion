const { v4: uuidv4 } = require("uuid");

/**
 * In-memory session store.
 *
 * sessions: Map<sessionId, Session>
 * Session = {
 *   id: string,
 *   hostDeviceId: string | null,
 *   createdAt: number,
 *   videoState: { url: string|null, playing: boolean, positionSec: number, updatedAt: number },
 *   devices: Map<deviceId, Device>
 * }
 * Device = {
 *   id: string,
 *   role: 'host' | 'viewer',
 *   ws: WebSocket,
 *   status: 'connected' | 'lagging' | 'disconnected',
 *   tileIndex: number | null,
 *   sensors: { heading: number|null, tilt: number|null, battery: number|null, updatedAt: number|null },
 *   lastSeen: number
 * }
 */
const sessions = new Map();

// How long (ms) without a heartbeat before we mark a device "lagging", then "disconnected".
const LAGGING_THRESHOLD_MS = 8000;
const DISCONNECTED_THRESHOLD_MS = 25000;

function createSession() {
  const id = shortCode();
  sessions.set(id, {
    id,
    hostDeviceId: null,
    createdAt: Date.now(),
    videoState: { url: null, playing: false, positionSec: 0, updatedAt: Date.now() },
    devices: new Map(),
  });
  return id;
}

function shortCode() {
  // 6-char human-typeable code, avoids ambiguous chars (0/O, 1/I)
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (sessions.has(code));
  return code;
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function joinSession(sessionId, ws, requestedRole) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const deviceId = uuidv4();
  const isFirstDevice = session.devices.size === 0;
  const role = requestedRole === "host" || isFirstDevice ? "host" : "viewer";

  if (role === "host") session.hostDeviceId = deviceId;

  session.devices.set(deviceId, {
    id: deviceId,
    role,
    ws,
    status: "connected",
    tileIndex: null,
    sensors: { heading: null, tilt: null, battery: null, updatedAt: null },
    lastSeen: Date.now(),
  });

  return { deviceId, role };
}

function removeDevice(sessionId, deviceId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.devices.delete(deviceId);
  if (session.hostDeviceId === deviceId) {
    session.hostDeviceId = null;
    // Promote the longest-connected remaining device to host, if any.
    const next = session.devices.values().next().value;
    if (next) {
      next.role = "host";
      session.hostDeviceId = next.id;
    }
  }
  if (session.devices.size === 0) sessions.delete(sessionId);
}

function updateSensors(sessionId, deviceId, sensors) {
  const session = sessions.get(sessionId);
  const device = session?.devices.get(deviceId);
  if (!device) return null;
  device.sensors = { ...device.sensors, ...sensors, updatedAt: Date.now() };
  device.lastSeen = Date.now();
  device.status = "connected";
  return device;
}

function touch(sessionId, deviceId) {
  const device = sessions.get(sessionId)?.devices.get(deviceId);
  if (device) device.lastSeen = Date.now();
}

function setTileAssignments(sessionId, assignments) {
  // assignments: { [deviceId]: tileIndex }
  const session = sessions.get(sessionId);
  if (!session) return;
  for (const [deviceId, tileIndex] of Object.entries(assignments)) {
    const device = session.devices.get(deviceId);
    if (device) device.tileIndex = tileIndex;
  }
}

function listDevices(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return [];
  return Array.from(session.devices.values()).map(serializeDevice);
}

function serializeDevice(device) {
  return {
    id: device.id,
    role: device.role,
    status: device.status,
    tileIndex: device.tileIndex,
    sensors: device.sensors,
  };
}

// Sweeps all sessions and demotes devices to 'lagging' / 'disconnected' based on lastSeen.
// Returns a list of { sessionId, deviceId, status } for devices whose status just changed.
function sweepStaleDevices() {
  const changes = [];
  const now = Date.now();
  for (const session of sessions.values()) {
    for (const device of session.devices.values()) {
      const idleMs = now - device.lastSeen;
      let nextStatus = device.status;
      if (idleMs > DISCONNECTED_THRESHOLD_MS) nextStatus = "disconnected";
      else if (idleMs > LAGGING_THRESHOLD_MS) nextStatus = "lagging";
      else nextStatus = "connected";

      if (nextStatus !== device.status) {
        device.status = nextStatus;
        changes.push({ sessionId: session.id, deviceId: device.id, status: nextStatus });
      }
    }
  }
  return changes;
}

module.exports = {
  sessions,
  createSession,
  getSession,
  joinSession,
  removeDevice,
  updateSensors,
  touch,
  setTileAssignments,
  listDevices,
  serializeDevice,
  sweepStaleDevices,
};