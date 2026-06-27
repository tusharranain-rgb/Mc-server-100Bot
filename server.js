import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import mineflayer from "mineflayer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const MAX_SLOTS = 100;
const DATA_FILE = path.join(__dirname, "bot-slots.json");

// ─── Persistence ─────────────────────────────────────────────────────────────
function loadSlots() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {}
  return {};
}

function saveSlots(slots) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(slots, null, 2), "utf-8"); } catch {}
}

let slotsData = loadSlots(); // { "1": { host, port, version, username, password, registered } }

function getSlotData(id) {
  return slotsData[String(id)] ?? null;
}

function setSlotData(id, data) {
  slotsData[String(id)] = data;
  saveSlots(slotsData);
}

function deleteSlotData(id) {
  delete slotsData[String(id)];
  saveSlots(slotsData);
}

// ─── Bot State ────────────────────────────────────────────────────────────────
const botStates = new Map(); // slotId -> state object

function freshState(slotId) {
  return {
    slotId,
    bot: null,
    reconnectTimer: null,
    afkTimer: null,
    shouldReconnect: false,
    isReconnecting: false,
    destroyed: true,
  };
}

function getState(slotId) {
  const id = String(slotId);
  if (!botStates.has(id)) botStates.set(id, freshState(id));
  return botStates.get(id);
}

function emitStatus(slotId) {
  const state = getState(slotId);
  const data = getSlotData(slotId);
  const status = { slotId: String(slotId), online: false, reconnecting: state.isReconnecting, playerCount: null, players: [], serverHost: data?.host ?? null };
  if (state.bot?.entity) {
    const players = Object.values(state.bot.players ?? {}).map(p => p.username);
    status.online = true;
    status.reconnecting = false;
    status.playerCount = players.length;
    status.players = players;
  }
  io.emit("botStatus", status);
  return status;
}

function emitLog(slotId, sender, message) {
  io.emit("botLog", { slotId: String(slotId), sender, message, timestamp: new Date().toISOString() });
}

function stopAfk(state) {
  if (state.afkTimer) { clearInterval(state.afkTimer); state.afkTimer = null; }
}

function startAfk(state) {
  stopAfk(state);
  state.afkTimer = setInterval(() => {
    if (!state.bot?.entity) return;
    try {
      state.bot.look(state.bot.entity.yaw + (Math.random() - 0.5) * 0.5, state.bot.entity.pitch + (Math.random() - 0.5) * 0.2, false);
      if (Math.random() < 0.25) { state.bot.setControlState("forward", true); setTimeout(() => state.bot?.setControlState("forward", false), 200); }
    } catch {}
  }, 9000 + Math.random() * 3000);
}

function cancelReconnect(state) {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
}

function destroyBot(state) {
  if (state.destroyed) return;
  state.destroyed = true;
  stopAfk(state);
  const b = state.bot;
  state.bot = null;
  emitStatus(state.slotId);
  try { b?.quit?.(); } catch {}
  try { b?.end?.(); } catch {}
}

function scheduleReconnect(state, delayMs) {
  cancelReconnect(state);
  if (!state.shouldReconnect) return;
  state.isReconnecting = true;
  emitStatus(state.slotId);
  const delay = delayMs ?? (5000 + Math.random() * 5000);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.shouldReconnect) {
      const data = getSlotData(state.slotId);
      if (data) createMineflayerBot(state.slotId, data);
    }
  }, delay);
}

function createMineflayerBot(slotId, cfg) {
  const state = getState(slotId);
  state.destroyed = false;

  const b = mineflayer.createBot({
    host: cfg.host,
    port: Number(cfg.port),
    username: cfg.username,
    version: cfg.version || "1.21",
    auth: "offline",
    hideErrors: false,
  });
  state.bot = b;

  b.once("spawn", () => {
    if (b !== state.bot) return;
    state.isReconnecting = false;
    emitStatus(slotId);
    emitLog(slotId, "[System]", `✅ Joined ${cfg.host}:${cfg.port} as ${cfg.username}`);
    startAfk(state);
    // Auto /login
    if (cfg.password) {
      setTimeout(() => {
        if (b !== state.bot) return;
        try { b.chat(`/login ${cfg.password}`); } catch {}
      }, 1500);
    }
  });

  b.on("chat", (username, message) => {
    if (b !== state.bot || username === b.username) return;
    emitLog(slotId, username, message);
  });

  b.on("message", (jsonMsg) => {
    if (b !== state.bot) return;
    const raw = jsonMsg.toString();
    const lower = raw.toLowerCase();
    if (cfg.password) {
      if (lower.includes("/register") || lower.includes("please register") || lower.includes("register with")) {
        setTimeout(() => { if (b !== state.bot) return; try { b.chat(`/register ${cfg.password} ${cfg.password}`); } catch {} }, 800);
        return;
      }
      if (lower.includes("/login") || lower.includes("please login") || lower.includes("log in")) {
        setTimeout(() => { if (b !== state.bot) return; try { b.chat(`/login ${cfg.password}`); } catch {} }, 800);
        return;
      }
    }
    if (raw.trim()) emitLog(slotId, "[Server]", raw);
  });

  b.on("playerJoined", () => { if (b === state.bot) emitStatus(slotId); });
  b.on("playerLeft", () => { if (b === state.bot) emitStatus(slotId); });

  b.on("error", (err) => {
    if (b !== state.bot) return;
    emitLog(slotId, "[Error]", err.message);
  });

  b.on("kicked", (reason) => {
    if (b !== state.bot) return;
    let msg = reason;
    try { msg = JSON.parse(reason)?.text ?? reason; } catch {}
    emitLog(slotId, "[System]", `❌ Kicked: ${msg}`);
    destroyBot(state);
    const isGhost = msg.toLowerCase().includes("already online") || msg.toLowerCase().includes("already connected");
    scheduleReconnect(state, isGhost ? 30000 : undefined);
  });

  b.on("end", (reason) => {
    if (b !== state.bot) return;
    emitLog(slotId, "[System]", `🔄 Disconnected (${reason ?? "unknown"}). Reconnecting...`);
    destroyBot(state);
    scheduleReconnect(state);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────
function startSlot(slotId) {
  const data = getSlotData(slotId);
  if (!data?.registered) return { ok: false, error: "Slot not registered" };
  if (!data.host) return { ok: false, error: "No host configured" };
  const state = getState(slotId);
  state.shouldReconnect = false;
  cancelReconnect(state);
  destroyBot(state);
  state.shouldReconnect = true;
  state.isReconnecting = false;
  state.destroyed = false;
  createMineflayerBot(slotId, data);
  return { ok: true };
}

function stopSlot(slotId) {
  const state = getState(slotId);
  state.shouldReconnect = false;
  state.isReconnecting = false;
  cancelReconnect(state);
  destroyBot(state);
  emitStatus(slotId);
  return { ok: true };
}

function restartSlot(slotId) {
  stopSlot(slotId);
  setTimeout(() => startSlot(slotId), 1500);
  return { ok: true };
}

// ─── Express ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// All slots summary
app.get("/api/slots", (_req, res) => {
  const result = {};
  for (let i = 1; i <= MAX_SLOTS; i++) {
    const id = String(i);
    const data = slotsData[id] ?? null;
    const state = getState(id);
    const online = !!(state.bot?.entity);
    result[id] = {
      registered: data?.registered ?? false,
      username: data?.username ?? null,
      host: data?.host ?? null,
      online,
      reconnecting: state.isReconnecting,
    };
  }
  res.json(result);
});

// Single slot status
app.get("/api/slot/:id/status", (req, res) => {
  const id = req.params.id;
  const state = getState(id);
  const data = getSlotData(id);
  const online = !!(state.bot?.entity);
  const players = online ? Object.values(state.bot.players ?? {}).map(p => p.username) : [];
  res.json({ slotId: id, registered: data?.registered ?? false, online, reconnecting: state.isReconnecting, playerCount: players.length, players, host: data?.host ?? null, username: data?.username ?? null });
});

// Register / save settings
app.post("/api/slot/:id/register", (req, res) => {
  const id = req.params.id;
  const num = Number(id);
  if (!num || num < 1 || num > MAX_SLOTS) { res.status(400).json({ error: "Invalid slot ID (1-100)" }); return; }
  const { host, port, version, username, password } = req.body;
  if (!host || !username) { res.status(400).json({ error: "host and username required" }); return; }
  const existing = getSlotData(id) ?? {};
  setSlotData(id, { ...existing, host, port: Number(port) || 25565, version: version || "1.21", username, password: password || null, registered: true });
  emitLog(id, "[System]", `📝 Slot ${id} registered: ${username} @ ${host}`);
  res.json({ ok: true });
});

// Start
app.post("/api/slot/:id/start", (req, res) => {
  const result = startSlot(req.params.id);
  if (!result.ok) { res.status(400).json(result); return; }
  emitLog(req.params.id, "[System]", "🚀 Bot starting...");
  res.json(result);
});

// Stop
app.post("/api/slot/:id/stop", (req, res) => {
  res.json(stopSlot(req.params.id));
  emitLog(req.params.id, "[System]", "⏹ Bot stopped.");
});

// Restart
app.post("/api/slot/:id/restart", (req, res) => {
  res.json(restartSlot(req.params.id));
  emitLog(req.params.id, "[System]", "🔄 Restarting bot...");
});

// Chat
app.post("/api/slot/:id/chat", (req, res) => {
  const state = getState(req.params.id);
  const { message } = req.body;
  if (!message) { res.status(400).json({ error: "message required" }); return; }
  if (!state.bot?.entity) { res.status(400).json({ error: "Bot not online" }); return; }
  try { state.bot.chat(message); res.json({ ok: true }); } catch { res.status(500).json({ error: "Failed to send" }); }
});

// Delete slot
app.delete("/api/slot/:id", (req, res) => {
  const id = req.params.id;
  stopSlot(id);
  deleteSlotData(id);
  emitLog(id, "[System]", `🗑 Slot ${id} deleted.`);
  io.emit("slotDeleted", { slotId: id });
  res.json({ ok: true });
});

// Get settings
app.get("/api/slot/:id/settings", (req, res) => {
  res.json(getSlotData(req.params.id) ?? {});
});

// Keep-alive
app.get("/api/healthz", (_req, res) => res.json({ status: "ok", activeBots: [...botStates.values()].filter(s => s.bot?.entity).length }));

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("[WS] Client connected:", socket.id);
  // Send all current statuses
  for (let i = 1; i <= MAX_SLOTS; i++) emitStatus(String(i));
  socket.on("disconnect", () => console.log("[WS] Client disconnected:", socket.id));
});

// ─── Auto-start slots that were running ───────────────────────────────────────
for (const [id, data] of Object.entries(slotsData)) {
  if (data?.registered && data?.host) {
    console.log(`[Boot] Auto-starting slot ${id}...`);
    setTimeout(() => startSlot(id), 3000 + Number(id) * 200);
  }
}

// ─── Keep-alive ───────────────────────────────────────────────────────────────
const domains = process.env.RENDER_EXTERNAL_URL || process.env.REPLIT_DOMAINS;
if (domains) {
  const selfUrl = domains.startsWith("http") ? `${domains}/api/healthz` : `https://${domains.split(",")[0]}/api/healthz`;
  setInterval(async () => { try { await fetch(selfUrl); } catch {} }, 4 * 60 * 1000);
  console.log("[KeepAlive] Pinging:", selfUrl);
}

httpServer.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
