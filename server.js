const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['polling', 'websocket']
});

// In-Memory Database for Users & Sessions
const users = new Map();     // username -> { username, passwordHash, balance }
const sessions = new Map();  // token -> username

// Helper: Hash Password
function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass + "_aviator_salt").digest('hex');
}

// REST API: Register
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.trim().length < 3 || password.length < 4) {
    return res.status(400).json({ error: "Username (min 3) aur Password (min 4) sahi daalein." });
  }

  const uname = username.trim().toLowerCase();
  if (users.has(uname)) {
    return res.status(400).json({ error: "Yeh username pehle se registered hai!" });
  }

  // New user gets ₹1,000 welcome balance
  const newUser = {
    username: username.trim(),
    passwordHash: hashPassword(password),
    balance: 1000.00
  };
  users.set(uname, newUser);

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, uname);

  res.json({ success: true, token, user: { username: newUser.username, balance: newUser.balance } });
});

// REST API: Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username aur Password dono zaroori hain." });
  }

  const uname = username.trim().toLowerCase();
  const user = users.get(uname);

  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(400).json({ error: "Galat Username ya Password!" });
  }

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, uname);

  res.json({ success: true, token, user: { username: user.username, balance: user.balance } });
});

// REST API: Verify Token (Auto Login)
app.post('/api/me', (req, res) => {
  const { token } = req.body;
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "Invalid session" });
  }
  const uname = sessions.get(token);
  const user = users.get(uname);
  res.json({ success: true, user: { username: user.username, balance: user.balance } });
});

// Aviator Game Synchronized Engine
let gameState = 'WAITING'; // WAITING, FLYING, CRASHED
let currentMultiplier = 1.00;
let crashPoint = 1.00;
let flightStartTime = null;
let gameTimer = null;
let onlineUsers = 1;
let history = [1.45, 2.10, 1.15, 5.80, 1.88, 3.20, 14.60];

// Active bets tracked on server to protect wallet
const activeBets = new Map(); // socketId -> { [betId]: { username, amount, cashed, win } }

function generateCrash() {
  const r = Math.random();
  if (r < 0.05) return 1.00; // 5% house edge
  return Math.max(1.00, parseFloat((0.95 / (1 - r)).toFixed(2)));
}

function startWaitingPhase() {
  gameState = 'WAITING';
  let countdown = 5.0;

  activeBets.clear();
  io.emit('state_waiting', { countdown: countdown.toFixed(1), history });

  const waitInterval = setInterval(() => {
    countdown -= 0.1;
    if (countdown <= 0) {
      clearInterval(waitInterval);
      launchFlight();
    } else {
      io.emit('tick_waiting', { countdown: countdown.toFixed(1) });
    }
  }, 100);
}

function launchFlight() {
  gameState = 'FLYING';
  crashPoint = generateCrash();
  flightStartTime = Date.now();
  currentMultiplier = 1.00;

  io.emit('state_flying');

  gameTimer = setInterval(() => {
    const elapsed = (Date.now() - flightStartTime) / 1000;
    currentMultiplier = parseFloat((1.00 + Math.pow(elapsed * 0.65, 1.75)).toFixed(2));

    if (currentMultiplier >= crashPoint) {
      triggerCrash();
    } else {
      io.emit('tick_multiplier', { multiplier: currentMultiplier });
    }
  }, 50);
}

function triggerCrash() {
  clearInterval(gameTimer);
  gameState = 'CRASHED';

  history.unshift(crashPoint);
  if (history.length > 10) history.pop();

  io.emit('state_crashed', { crashPoint, history });

  setTimeout(() => {
    startWaitingPhase();
  }, 3500);
}

// Socket Connection & Player Authentication
io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('online_count', onlineUsers);

  let currentAuthUser = null;

  // Authenticate socket connection
  socket.on('auth_socket', (token) => {
    if (sessions.has(token)) {
      const uname = sessions.get(token);
      currentAuthUser = users.get(uname);
      socket.emit('auth_success', { username: currentAuthUser.username, balance: currentAuthUser.balance });
    }
  });

  socket.emit('init_sync', { gameState, currentMultiplier, history, onlineUsers });

  // Place Bet
  socket.on('place_bet', (data) => {
    if (!currentAuthUser) return;
    const { betId, amount } = data;
    const betAmt = parseFloat(amount);

    if (isNaN(betAmt) || betAmt <= 0 || currentAuthUser.balance < betAmt) {
      return socket.emit('bet_error', { msg: "Insufficient balance!" });
    }

    // Deduct Balance on Server
    currentAuthUser.balance = parseFloat((currentAuthUser.balance - betAmt).toFixed(2));
    socket.emit('balance_update', currentAuthUser.balance);

    if (!activeBets.has(socket.id)) activeBets.set(socket.id, {});
    activeBets.get(socket.id)[betId] = {
      username: currentAuthUser.username,
      amount: betAmt,
      cashed: false
    };

    io.emit('player_bet_placed', { username: currentAuthUser.username, amount: betAmt });
  });

  // Cash Out
  socket.on('request_cashout', (data) => {
    if (!currentAuthUser || gameState !== 'FLYING') return;
    const { betId } = data;
    const userBets = activeBets.get(socket.id);

    if (userBets && userBets[betId] && !userBets[betId].cashed) {
      userBets[betId].cashed = true;
      const winAmount = parseFloat((userBets[betId].amount * currentMultiplier).toFixed(2));

      // Credit winnings to User Balance on Server
      currentAuthUser.balance = parseFloat((currentAuthUser.balance + winAmount).toFixed(2));
      socket.emit('balance_update', currentAuthUser.balance);

      socket.emit('cashout_success', { betId, win: winAmount, multiplier: currentMultiplier });
      io.emit('player_won', { username: currentAuthUser.username, win: winAmount, multiplier: currentMultiplier });
    }
  });

  socket.on('disconnect', () => {
    activeBets.delete(socket.id);
    onlineUsers = Math.max(1, onlineUsers - 1);
    io.emit('online_count', onlineUsers);
  });
});

// Single File Serving Complete UI
app.get('*', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Aviator - Play Online</title>
  <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0c1017; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 8px; }

    /* Auth Modal Screen */
    .auth-overlay {
      position: fixed;
      inset: 0;
      background: rgba(8, 11, 16, 0.95);
      z-index: 100;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 16px;
    }
    .auth-card {
      width: 100%;
      max-width: 360px;
      background: #141b26;
      border: 1px solid #253347;
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 15px 50px rgba(0,0,0,0.8);
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .auth-brand { font-size: 26px; font-weight: 900; font-style: italic; color: #e52538; text-align: center; }
    .tabs { display: flex; background: #0a0d13; border-radius: 8px; padding: 4px; }
    .tab-btn { flex: 1; padding: 8px; border: none; background: transparent; color: #8fa0b5; font-weight: bold; border-radius: 6px; cursor: pointer; }
    .tab-btn.active { background: #e52538; color: #fff; }
    .auth-field { display: flex; flex-direction: column; gap: 6px; }
    .auth-field label { font-size: 12px; color: #8fa0b5; }
    .auth-field input { padding: 12px; background: #0b1016; border: 1px solid #273549; border-radius: 8px; color: #fff; font-size: 15px; outline: none; }
    .auth-field input:focus { border-color: #e52538; }
    .btn-submit { padding: 14px; background: #22c55e; border: none; border-radius: 8px; color: #052e16; font-size: 16px; font-weight: 900; cursor: pointer; transition: 0.2s; }
    .btn-submit:hover { background: #16a34a; }
    .auth-err { font-size: 13px; color: #ef4444; text-align: center; min-height: 18px; }

    /* Main App */
    .app { width: 100%; max-width: 440px; background: #131924; border: 1px solid #1f2a3a; border-radius: 16px; display: none; flex-direction: column; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.8); }

    .top-bar { padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; background: #101520; border-bottom: 1px solid #1c2637; }
    .brand { color: #e52538; font-weight: 900; font-size: 20px; font-style: italic; }
    .user-pill { font-size: 12px; color: #94a3b8; font-weight: bold; }
    .top-right { display: flex; gap: 8px; align-items: center; }
    .bal-tag { background: #090c12; border: 1px solid #273549; color: #4ade80; font-size: 13px; font-weight: bold; padding: 4px 12px; border-radius: 20px; }
    .btn-logout { background: #243144; border: none; color: #cbd5e1; padding: 5px 10px; border-radius: 14px; font-size: 11px; cursor: pointer; font-weight: bold; }

    .history { display: flex; gap: 6px; padding: 8px 12px; background: #0b0f16; overflow-x: auto; border-bottom: 1px solid #182232; }
    .pill { font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 10px; }
    .p-blue { color: #38bdf8; background: rgba(56, 189, 248, 0.15); }
    .p-purple { color: #c084fc; background: rgba(192, 132, 252, 0.15); }
    .p-red { color: #f43f5e; background: rgba(244, 63, 94, 0.15); }

    .arena { position: relative; height: 260px; background: radial-gradient(circle at 35% 65%, #182333 0%, #090d14 100%); overflow: hidden; }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; }

    #airplane { position: absolute; width: 75px; height: 45px; z-index: 2; transform: translate(-50%, -50%); filter: drop-shadow(0 0 10px rgba(229, 37, 56, 0.8)); opacity: 0; }
    .prop { transform-origin: 89px 28px; animation: spin 0.08s linear infinite; }
    @keyframes spin { 0% { transform: scaleY(1); } 50% { transform: scaleY(-0.1); } 100% { transform: scaleY(1); } }

    .hud { position: absolute; top: 48%; left: 50%; transform: translate(-50%, -50%); text-align: center; z-index: 3; pointer-events: none; }
    .mult { font-size: 64px; font-weight: 900; letter-spacing: -2px; }
    .sub { font-size: 14px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; margin-top: 2px; color: #94a3b8; }
    .crashed { color: #e52538 !important; }

    .controls { padding: 12px; display: flex; flex-direction: column; gap: 10px; background: #101520; }
    .card { background: #161d29; border: 1px solid #233044; border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
    .card-head { display: flex; justify-content: space-between; font-size: 11px; color: #8fa0b5; font-weight: bold; }
    .card-row { display: flex; gap: 10px; height: 48px; }
    .stepper { flex: 1; display: flex; background: #0b0e14; border: 1px solid #243347; border-radius: 8px; overflow: hidden; }
    .stepper button { width: 34px; background: #192332; border: none; color: #fff; font-size: 18px; cursor: pointer; }
    .stepper input { flex: 1; background: transparent; border: none; text-align: center; color: #fff; font-size: 16px; font-weight: bold; outline: none; }

    .btn-act { width: 125px; border: none; border-radius: 8px; font-size: 18px; font-weight: 900; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .btn-bet { background: #22c55e; color: #052e16; }
    .btn-cashout { background: #f59e0b; color: #451a03; box-shadow: 0 0 14px rgba(245, 158, 11, 0.4); }
    .btn-cancel { background: #ef4444; color: #fff; }
  </style>
</head>
<body>

<!-- Login & Register Modal -->
<div class="auth-overlay" id="authModal">
  <div class="auth-card">
    <div class="auth-brand">✈ AVIATOR</div>
    <div class="tabs">
      <button class="tab-btn active" id="tabLogin" onclick="switchTab('login')">LOGIN</button>
      <button class="tab-btn" id="tabSignup" onclick="switchTab('signup')">SIGN UP</button>
    </div>

    <div class="auth-field">
      <label>Username</label>
      <input type="text" id="authUname" placeholder="Apna username daalein">
    </div>

    <div class="auth-field">
      <label>Password</label>
      <input type="password" id="authPass" placeholder="Password daalein">
    </div>

    <div class="auth-err" id="authErr"></div>

    <button class="btn-submit" id="authSubmitBtn" onclick="handleAuthSubmit()">LOGIN KAREIN</button>
  </div>
</div>

<!-- Main Game Console -->
<div class="app" id="gameApp">
  <div class="top-bar">
    <div>
      <div class="brand">AVIATOR</div>
      <div class="user-pill" id="userDisplay">Player</div>
    </div>
    <div class="top-right">
      <div class="bal-tag">₹ <span id="bal">0.00</span></div>
      <button class="btn-logout" onclick="logout()">Logout</button>
    </div>
  </div>

  <div class="history" id="hist"></div>

  <div class="arena" id="arena">
    <canvas id="cvs"></canvas>

    <svg id="airplane" viewBox="0 0 100 60">
      <polygon points="10,29 0,25 0,33" fill="#ff7700"/>
      <path d="M15,29 C30,22 65,22 85,27 C92,29 95,31 85,33 C65,38 30,38 15,31 Z" fill="#e52538"/>
      <path d="M42,26 L60,8 L68,8 L54,26 Z" fill="#b91c1c"/>
      <path d="M42,32 L60,50 L68,50 L54,32 Z" fill="#991b1b"/>
      <ellipse cx="72" cy="27" rx="6" ry="2.5" fill="#38bdf8"/>
      <circle cx="89" cy="29" r="3" fill="#fff"/>
      <line class="prop" x1="89" y1="11" x2="89" y2="47" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
    </svg>

    <div class="hud">
      <div id="mult" class="mult">1.00x</div>
      <div id="sub" class="sub">STARTING...</div>
    </div>
  </div>

  <div class="controls">
    <!-- Panel 1 -->
    <div class="card">
      <div class="card-head"><span>BET PANEL 1</span></div>
      <div class="card-row">
        <div class="stepper">
          <button onclick="adj(1, -10)">-</button>
          <input type="number" id="inp1" value="50">
          <button onclick="adj(1, 10)">+</button>
        </div>
        <button id="btn1" class="btn-act btn-bet" onclick="doAction(1)">
          <span>BET</span><small style="font-size:11px;">₹50</small>
        </button>
      </div>
    </div>

    <!-- Panel 2 -->
    <div class="card">
      <div class="card-head"><span>BET PANEL 2</span></div>
      <div class="card-row">
        <div class="stepper">
          <button onclick="adj(2, -10)">-</button>
          <input type="number" id="inp2" value="100">
          <button onclick="adj(2, 10)">+</button>
        </div>
        <button id="btn2" class="btn-act btn-bet" onclick="doAction(2)">
          <span>BET</span><small style="font-size:11px;">₹100</small>
        </button>
      </div>
    </div>
  </div>
</div>

<script>
  let currentAuthMode = 'login';
  let token = localStorage.getItem('aviator_user_token');
  let socket = null;

  let balance = 0.00;
  let currentMultiplier = 1.00;
  let gameState = 'WAITING';

  const bets = { 1: { active: false, amt: 0, cashed: false }, 2: { active: false, amt: 0, cashed: false } };

  const authModal = document.getElementById("authModal");
  const gameApp = document.getElementById("gameApp");
  const authErr = document.getElementById("authErr");
  const userDisplay = document.getElementById("userDisplay");
  const balEl = document.getElementById("bal");

  const cvs = document.getElementById("cvs");
  const ctx = cvs.getContext("2d");
  const arena = document.getElementById("arena");
  const plane = document.getElementById("airplane");
  const multText = document.getElementById("mult");
  const subText = document.getElementById("sub");
  const histEl = document.getElementById("hist");

  function switchTab(mode) {
    currentAuthMode = mode;
    authErr.textContent = "";
    document.getElementById("tabLogin").className = mode === 'login' ? 'tab-btn active' : 'tab-btn';
    document.getElementById("tabSignup").className = mode === 'signup' ? 'tab-btn active' : 'tab-btn';
    document.getElementById("authSubmitBtn").textContent = mode === 'login' ? 'LOGIN KAREIN' : 'SIGN UP KAREIN (FREE ₹1,000)';
  }

  async function handleAuthSubmit() {
    const username = document.getElementById("authUname").value.trim();
    const password = document.getElementById("authPass").value;
    authErr.textContent = "";

    const endpoint = currentAuthMode === 'login' ? '/api/login' : '/api/register';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();

      if (!res.ok) {
        authErr.textContent = data.error || "Kuch gadbad hui!";
        return;
      }

      localStorage.setItem('aviator_user_token', data.token);
      token = data.token;
      initGameScreen(data.user);
    } catch(err) {
      authErr.textContent = "Server connect nahi ho paya.";
    }
  }

  // Check existing session
  async function checkSession() {
    if (!token) return;
    try {
      const res = await fetch('/api/me', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        initGameScreen(data.user);
      } else {
        localStorage.removeItem('aviator_user_token');
      }
    } catch(e) {}
  }
  checkSession();

  function logout() {
    localStorage.removeItem('aviator_user_token');
    location.reload();
  }

  function initGameScreen(user) {
    authModal.style.display = "none";
    gameApp.style.display = "flex";
    userDisplay.textContent = user.username;
    balance = parseFloat(user.balance);
    balEl.textContent = balance.toFixed(2);

    fitCanvas();
    setupSockets();
  }

  function fitCanvas() {
    cvs.width = arena.clientWidth;
    cvs.height = arena.clientHeight;
  }
  window.addEventListener('resize', fitCanvas);

  function setupSockets() {
    socket = io({ transports: ['polling', 'websocket'] });

    socket.on('connect', () => {
      socket.emit('auth_socket', token);
    });

    socket.on('balance_update', (newBal) => {
      balance = parseFloat(newBal);
      balEl.textContent = balance.toFixed(2);
    });

    socket.on('init_sync', d => renderHistory(d.history));

    socket.on('tick_waiting', (d) => {
      gameState = 'WAITING';
      multText.style.display = "none";
      subText.style.display = "block";
      subText.textContent = "WAITING: " + d.countdown + "s";
      plane.style.opacity = "0";
      ctx.clearRect(0, 0, cvs.width, cvs.height);
    });

    socket.on('state_waiting', (d) => {
      gameState = 'WAITING';
      multText.style.display = "none";
      subText.style.display = "block";
      subText.textContent = "WAITING: " + d.countdown + "s";
      plane.style.opacity = "0";
      ctx.clearRect(0, 0, cvs.width, cvs.height);
    });

    socket.on('state_flying', () => {
      gameState = 'FLYING';
      subText.style.display = "none";
      multText.style.
