const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

app.use(express.json());
// Root folder se direct files serve karega
app.use(express.static(__dirname));

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['polling', 'websocket']
});

// Database
const users = new Map();
const sessions = new Map();

function hashPassword(p) {
  return crypto.createHash('sha256').update(p + "_aviator_secret").digest('hex');
}

// Sign Up API
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.trim().length < 3 || password.length < 4) {
    return res.status(400).json({ error: "Username (min 3) & Password (min 4) daalein." });
  }
  const uname = username.trim().toLowerCase();
  if (users.has(uname)) {
    return res.status(400).json({ error: "Yeh Username pehle se maujood hai!" });
  }

  const newUser = { username: username.trim(), passwordHash: hashPassword(password), balance: 1000.00 };
  users.set(uname, newUser);

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, uname);
  res.json({ success: true, token, user: { username: newUser.username, balance: newUser.balance } });
});

// Login API
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const uname = (username || '').trim().toLowerCase();
  const user = users.get(uname);

  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(400).json({ error: "Galat Username ya Password!" });
  }

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, uname);
  res.json({ success: true, token, user: { username: user.username, balance: user.balance } });
});

// Auto Check Token API
app.post('/api/me', (req, res) => {
  const { token } = req.body;
  if (!token || !sessions.has(token)) return res.status(401).json({ error: "Invalid" });
  const uname = sessions.get(token);
  const user = users.get(uname);
  res.json({ success: true, user: { username: user.username, balance: user.balance } });
});

// Game Engine
let gameState = 'WAITING';
let currentMultiplier = 1.00;
let crashPoint = 1.00;
let flightStartTime = null;
let gameTimer = null;
let onlineUsers = 1;
let history = [1.35, 2.10, 1.15, 5.80, 1.88, 3.20];

const activeBets = new Map();

function getCrash() {
  const r = Math.random();
  if (r < 0.05) return 1.00;
  return Math.max(1.00, parseFloat((0.95 / (1 - r)).toFixed(2)));
}

function startWaitingPhase() {
  gameState = 'WAITING';
  let countdown = 5.0;
  activeBets.clear();
  io.emit('state_waiting', { countdown: countdown.toFixed(1), history });

  const t = setInterval(() => {
    countdown -= 0.1;
    if (countdown <= 0) {
      clearInterval(t);
      startFlight();
    } else {
      io.emit('tick_waiting', { countdown: countdown.toFixed(1) });
    }
  }, 100);
}

function startFlight() {
  gameState = 'FLYING';
  crashPoint = getCrash();
  flightStartTime = Date.now();
  currentMultiplier = 1.00;
  io.emit('state_flying');

  gameTimer = setInterval(() => {
    const elapsed = (Date.now() - flightStartTime) / 1000;
    currentMultiplier = parseFloat((1.00 + Math.pow(elapsed * 0.65, 1.75)).toFixed(2));

    if (currentMultiplier >= crashPoint) {
      clearInterval(gameTimer);
      gameState = 'CRASHED';
      history.unshift(crashPoint);
      if (history.length > 10) history.pop();
      io.emit('state_crashed', { crashPoint, history });
      setTimeout(startWaitingPhase, 3500);
    } else {
      io.emit('tick_multiplier', { multiplier: currentMultiplier });
    }
  }, 50);
}

// Sockets
io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('online_count', onlineUsers);
  let authUser = null;

  socket.on('auth_socket', (tok) => {
    if (sessions.has(tok)) {
      const uname = sessions.get(tok);
      authUser = users.get(uname);
      socket.emit('auth_success', { username: authUser.username, balance: authUser.balance });
    }
  });

  socket.emit('init_sync', { gameState, currentMultiplier, history, onlineUsers });

  socket.on('place_bet', (d) => {
    if (!authUser) return;
    const amt = parseFloat(d.amount);
    if (isNaN(amt) || amt <= 0 || authUser.balance < amt) return;

    authUser.balance = parseFloat((authUser.balance - amt).toFixed(2));
    socket.emit('balance_update', authUser.balance);

    if (!activeBets.has(socket.id)) activeBets.set(socket.id, {});
    activeBets.get(socket.id)[d.betId] = { amount: amt, cashed: false };
  });

  socket.on('request_cashout', (d) => {
    if (!authUser || gameState !== 'FLYING') return;
    const uBets = activeBets.get(socket.id);
    if (uBets && uBets[d.betId] && !uBets[d.betId].cashed) {
      uBets[d.betId].cashed = true;
      const win = parseFloat((uBets[d.betId].amount * currentMultiplier).toFixed(2));
      authUser.balance = parseFloat((authUser.balance + win).toFixed(2));
      socket.emit('balance_update', authUser.balance);
      socket.emit('cashout_success', { betId: d.betId, win });
    }
  });

  socket.on('disconnect', () => {
    activeBets.delete(socket.id);
    onlineUsers = Math.max(1, onlineUsers - 1);
    io.emit('online_count', onlineUsers);
  });
});

// Koi bhi page khole, direct index.html render hogi
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server live on port ${PORT}`);
  startWaitingPhase();
});
    
