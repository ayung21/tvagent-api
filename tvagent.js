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

const SERVER_URL = "wss://api.namecholdings.my.id/ws";
const SERVER_URL_DAFTAR = "https://api.namecholdings.my.id/api/processcode/registertv";
const cabangId = 1;
const PING_INTERVAL = 60 * 1000; // 1 menit
const RECONNECT_DELAY_MIN = 5000;    // 5 detik
const RECONNECT_DELAY_MAX = 300000;  // 5 menit
const MAX_RECONNECT_ATTEMPTS = 100;   // Optional: stop after 100 attempts

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let isReconnecting = false;
let isRegistered = false;
let reconnectAttempts = 0;
let lastActivityTime = Date.now();
let healthCheckInterval = null;

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

const tv_id = getDeviceId();
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

function sendKey(command, callback) {
  const code = COMMAND_MAP[command] || command;
  
  exec(`adb shell input keyevent ${code}`, (err, stdout, stderr) => {
    if (err) {
      console.log("❌ ADB keyevent GAGAL:", command, "Error:", err.message);
      if (callback) callback({ success: false, command, error: err.message });
      return;
    }
    
    console.log("✅ ADB keyevent BERHASIL:", command);
    if (callback) callback({ success: true, command });
  });
}

// ---------------------- RECONNECT LOGIC ----------------------
function scheduleReconnect() {
  if (isReconnecting) {
    console.log("⏳ Reconnect sudah dijadwalkan, skip...");
    return;
  }
  
  // Optional: Stop after max attempts
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log("🚨 Max reconnect attempts reached. Stopping...");
    cleanup();
    process.exit(1);
  }
  
  isReconnecting = true;
  reconnectAttempts++;
  
  // Exponential backoff
  const delay = Math.min(
    RECONNECT_DELAY_MIN * Math.pow(2, reconnectAttempts - 1),
    RECONNECT_DELAY_MAX
  );
  
  console.log(`❌ Koneksi putus (attempt #${reconnectAttempts})`);
  console.log(`⏱️  Reconnect dalam ${delay/1000} detik...`);
  
  // Clear existing timers
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  
  reconnectTimer = setTimeout(() => {
    isReconnecting = false;
    connect();
  }, delay);
}

// ---------------------- HTTP REGISTRATION ----------------------
async function registerToServer() {
  if (isRegistered) return;

  try {
    const response = await axios.post(SERVER_URL_DAFTAR, {
      tv_id: tv_id,
      model: deviceModel,
      ip: localIp,
      modeltv: modelTv,
      cabangid: cabangId
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    // Cek content-type response
    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      console.log("⚠️ Response bukan JSON, content-type:", contentType);
      console.log("🔄 Retry dalam 30 detik...");
      setTimeout(() => registerToServer(), 30000);
      return;
    }

    if (response.data && response.data.success) {
      console.log("✅ Registrasi HTTP berhasil:", response.data.message);
      console.log("📋 Data TV:", JSON.stringify(response.data.data));
      isRegistered = true;
    } else {
      console.log("⚠️ Response tidak valid:", response.data);
      setTimeout(() => registerToServer(), 30000);
    }

  } catch (err) {
    if (err.response) {
      const contentType = err.response.headers['content-type'] || '';
      if (contentType.includes('text/html')) {
        console.log("⚠️ Server return HTML (status:", err.response.status, ")");
      } else {
        console.log("⚠️ Server error:", err.response.status, err.response.data);
      }
    } else if (err.code === 'ECONNABORTED') {
      console.log("⚠️ Registrasi timeout");
    } else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      console.log("⚠️ Server tidak dapat dijangkau:", err.message);
    } else {
      console.log("⚠️ Gagal registrasi HTTP:", err.message);
    }

    // Retry semua error
    console.log("🔄 Retry registrasi dalam 30 detik...");
    setTimeout(() => {
      isRegistered = false;
      registerToServer();
    }, 30000);
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
  
  try {
    ws = new WebSocket(SERVER_URL);
  } catch (err) {
    console.log("🚨 Error creating WebSocket:", err.message);
    scheduleReconnect();
    return;
  }

  ws.on("open", () => {
    console.log("✅ Tersambung ke server");
    
    reconnectAttempts = 0;
    isReconnecting = false;
    lastActivityTime = Date.now();

    // Send WS registration
    const regData = {
      type: "register",
      tv_id: tv_id,
      model: deviceModel,
      ip: localIp,
      modeltv: modelTv,
      cabangid: cabangId
    };
    
    console.log("📤 Sending:", JSON.stringify(regData));
    ws.send(JSON.stringify(regData));

    // ✅ Delay HTTP registration 3 detik setelah WS connect
    // Memberi waktu network stabil di Android TV
    setTimeout(() => {
      registerToServer();
    }, 3000);

    console.log(`📡 Registered:
      - tv_id: ${tv_id}
      - model: ${deviceModel}
      - brand: ${modelTv}
      - ip: ${localIp}
      - cabangid: ${cabangId}`);

    // HTTP registration
    registerToServer();

    // Clear old timers
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }

    // Ping interval
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ 
            type: "ping", 
            tv_id: tv_id, 
            ip: getLocalIp(), 
            time: new Date().toISOString() 
          }));
          lastActivityTime = Date.now();
          console.log("📶 Ping terkirim");
        } catch (err) {
          console.log("⚠️ Ping error:", err.message);
          scheduleReconnect();
        }
      } else {
        console.log("⚠️ WebSocket not OPEN, reconnecting...");
        scheduleReconnect();
      }
    }, PING_INTERVAL);
    
    // Health check (detect stale connection)
    healthCheckInterval = setInterval(() => {
      const idleTime = Date.now() - lastActivityTime;
      
      if (idleTime > PING_INTERVAL * 3) {
        console.log("🚨 Connection stale, forcing reconnect...");
        if (ws) ws.terminate();
        scheduleReconnect();
      }
    }, PING_INTERVAL * 2);
  });

  ws.on("message", (msg) => {
    lastActivityTime = Date.now();
    console.log("📩 Pesan diterima (raw):", msg.toString());
    
    try {
        const data = JSON.parse(msg);
        console.log("📦 Pesan parsed:", data);
        
        // Handle welcome message
        if (data.type === "welcome") {
          console.log("👋 Welcome message received:", data.message);
          return;
        }
        
        // Handle pong/acknowledgment
        if (data.type === "pong") {
          console.log("🏓 Pong received");
          return;
        }
        
        // Handle command
        if (data.tv_id === tv_id && data.type === "command") {
            console.log("✅ Target match, eksekusi command:", data.command);
            
            // Eksekusi command dengan callback
            sendKey(data.command, (result) => {
              // Send confirmation ke server
              if (ws && ws.readyState === WebSocket.OPEN) {
                const response = {
                  type: "confirm",
                  tv_id: tv_id,
                  command: data.command,
                  status: result.success ? "success" : "failed",
                  error: result.error || null,
                  time: new Date().toISOString()
                };
                
                ws.send(JSON.stringify(response));
                
                if (result.success) {
                  console.log("✅ Konfirmasi SUCCESS dikirim:", data.command);
                } else {
                  console.log("❌ Konfirmasi FAILED dikirim:", data.command, result.error);
                }
              }
            });
            
        } else {
            console.log("⚠️ Target tidak match. Data target:", data.tv_id, "TV ID:", tv_id);
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
  });

  ws.on("ping", (data) => {
    console.log("📶 Server ping received, sending pong...");
    lastActivityTime = Date.now();
    ws.pong();
  });

  ws.on("pong", (data) => {
    console.log("📶 Server pong received");
    lastActivityTime = Date.now();
  });
}

// ---------------------- START ----------------------
connect();