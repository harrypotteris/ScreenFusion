const express = require("express");
const QRCode = require("qrcode");
const sessionManager = require("./sessionManager");

const router = express.Router();

// POST /session/create
// Body: {} (host doesn't need to send anything)
// Returns the session code + a QR code (data URI) encoding a join URL other phones can scan.
router.post("/session/create", async (req, res) => {
  const sessionId = sessionManager.createSession();

  // The join URL the QR code encodes. LAN_HOST should be the server's LAN IP
  // (e.g. 192.168.1.23) so phones on the same Wi-Fi can resolve it.
  const host = req.query.host || req.hostname;
  const port = req.query.port || process.env.PORT || 4000;
  const joinUrl = `screenfusion://join?session=${sessionId}&host=${host}&port=${port}`;

  try {
    const qrDataUri = await QRCode.toDataURL(joinUrl);
    res.json({ sessionId, joinUrl, qrCode: qrDataUri });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate QR code", detail: err.message });
  }
});

// GET /session/:id
router.get("/session/:id", (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({
    id: session.id,
    hostDeviceId: session.hostDeviceId,
    videoState: session.videoState,
    devices: sessionManager.listDevices(session.id),
  });
});

// GET /session/:id/devices
router.get("/session/:id/devices", (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ devices: sessionManager.listDevices(session.id) });
});

// GET /health
router.get("/health", (req, res) => {
  res.json({ status: "ok", activeSessions: sessionManager.sessions.size });
});

module.exports = router;
