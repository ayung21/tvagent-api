/**
 * TVAgent v3.2 - Memory Safe & Leak-Free
 * ----------------------------------------
 * ✅ Cleanup WebSocket instance properly
 * ✅ Prevent multiple reconnect timers
 * ✅ Remove all event listeners on close
 * ✅ Single reconnect logic (no duplicate)
 * ✅ Graceful shutdown
 */

const WebSocket = require('ws');
const { execSync, exec } = require('child_process');
const os = require('os');
const fs = require('fs');
const axios = require('axios');

const SERVER_URL = "wss://nflspotlight24.com/ws";
const SERVER_URL_DAFTAR = "https://nflspotlight24.com/api/processcode/registertv";
const cabangId = "CABANG-001";
const PING_INTERVAL = 60 * 1000; // 1 menit
const RECONNECT_DELAY = 5000; // 5 detik

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let isReconnecting = false;
let isRegistered = false;

// ---------------------- LOCK FILE ----------------------
const lockPath = "/data/data/com.termux/files/home/tvagent.lock";
if (fs.existsSync(lockPath)) {
  try {
    const oldPid = parseInt(fs.readFileSync(lockPath, "utf8"));
    process.kill(oldPid, 0);
    console.log("⚠️ TVAgent sudah berjalan (PID:", oldPid, ")");
    process.exit(0);
  } catch {
    console.log("🧹 Lock lama tidak aktif, lanjut...");
    fs.unlinkSync(lockPath);
  }
}
fs.writeFileSync(lockPath, process.pid.toString());

// Cleanup on exit
function cleanup() {
  console.log("🧹 Cleaning up...");
  if (pingTimer) clearInterval(pingTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) {
    ws.removeAllListeners();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
  if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  exec("termux-wake-unlock", () => {
    console.log("🔓 Wake-lock released");
  });
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

// ---------------------- WAKELOCK ----------------------
exec("termux-wake-lock", (err) => {
  if (err) console.log("⚠️ Gagal aktifkan wake-lock:", err.message);
  else console.log("🔒 Wake-lock aktif");
});

// ---------------------- DEVICE INFO ----------------------
function getDeviceId() {
  const path = "/data/data/com.termux/files/home/tv_id.txt";
  if (fs.existsSync(path)) return fs.readFileSync(path, "utf8").trim();
  const newId = "TV-" + Math.random().toString(36).substring(2, 10).toUpperCase();
  fs.writeFileSync(path, newId);
  return newId;
}

function getProp(prop) {
  try {
    return execSync(`getprop ${prop}`).toString().trim() || "unknown";
  } catch { return "unknown"; }
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "unknown";
}

const tvId = getDeviceId();
const deviceModel = getProp("ro.product.model");
const modelTv = getProp("ro.product.brand").toUpperCase();
const localIp = getLocalIp();

// ---------------------- MAPPING COMMAND ----------------------
const COMMAND_MAP = {
  sleep: 223,
  wake: 224,
  power: 26,
  volup: 24,
  voldown: 25,
  mute: 164,
};

function sendKey(command) {
  const code = COMMAND_MAP[command] || command;
  exec(`adb shell input keyevent ${code}`, (err) => {
    if (err) console.log("⚠️ ADB gagal:", err.message);
    else console.log("🎮 ADB keyevent:", command);
  });
}

// ---------------------- RECONNECT LOGIC ----------------------
function scheduleReconnect() {
  // Prevent multiple reconnect timers
  if (isReconnecting) {
    console.log("⏳ Reconnect sudah dijadwalkan, skip...");
    return;
  }
  
  isReconnecting = true;
  console.log(`❌ Koneksi putus, reconnect dalam ${RECONNECT_DELAY/1000} detik...`);
  
  // Clear existing timers
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  
  reconnectTimer = setTimeout(() => {
    isReconnecting = false;
    connect();
  }, RECONNECT_DELAY);
}

// ---------------------- HTTP REGISTRATION ----------------------
async function registerToServer() {
  if (isRegistered) return;

  try {
    const response = await axios.post(SERVER_URL_DAFTAR, {
      tv_id: tvId,
      model: deviceModel,
      ip: localIp,
      modeltv: modelTv,
      cabangid: cabangId
    });
    console.log("✅ Registrasi HTTP berhasil:", response.data);
    isRegistered = true;
  } catch (err) {
    console.log("⚠️ Gagal registrasi HTTP:", err.message);
  }
}

// ---------------------- WEBSOCKET ----------------------
function connect() {
  // Cleanup old connection
  if (ws) {
    ws.removeAllListeners();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }

  console.log("🔌 Menghubungkan ke server...");
  ws = new WebSocket(SERVER_URL);

  ws.on("open", () => {
    console.log("✅ Tersambung ke server");
    isReconnecting = false;

    // Send registration
    ws.send(JSON.stringify({
      type: "register",
      tv_id: tvId,
      model: deviceModel,
      ip: localIp,
      modeltv: modelTv,
      cabangid: cabangId
    }));

    console.log(`📡 Registered:
      - tv_id: ${tvId}
      - model: ${deviceModel}
      - brand: ${modelTv}
      - ip: ${localIp}
      - cabangid: ${cabangId}`);

    registerToServer();

    // Clear old ping timer
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }

    // Start new ping interval
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ 
          type: "ping", 
          tv_id: tvId, 
          ip: getLocalIp(), 
          time: new Date().toISOString() 
        }));
        console.log("📶 Ping terkirim");
      }
    }, PING_INTERVAL);
  });

  ws.on("message", (msg) => {
    console.log("📩 Pesan diterima (raw):", msg.toString()); // ← TAMBAHKAN INI
    
    try {
        const data = JSON.parse(msg);
        console.log("📦 Pesan parsed:", data); // ← TAMBAHKAN INI
        
        if (data.target === tvId || data.target === "all") {
            console.log("✅ Target match, eksekusi command:", data.command);
            sendKey(data.command);
            
            // Send confirmation
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: "confirm",
                    tv_id: tvId,
                    command: data.command,
                    status: "ok",
                    time: new Date().toISOString()
                }));
                console.log("✅ Konfirmasi dikirim");
            }
        } else {
            console.log("⚠️ Target tidak match. Data target:", data.target, "TV ID:", tvId);
        }
    } catch (err) {
        console.log("⚠️ Error parsing message:", err.message);
    }
});

  ws.on("close", (code, reason) => {
    console.log(`🔴 Connection closed (code: ${code}, reason: ${reason || 'none'})`);
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.log("⚠️ WebSocket error:", err.message);
    // Don't reconnect here, let close event handle it
  });
}

// ---------------------- START ----------------------
connect();