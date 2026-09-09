const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Cache prevention
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Database file (users.json)
const DB_FILE = path.join(__dirname, 'users.json');
let users = {};

if (fs.existsSync(DB_FILE)) {
  try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { users = {}; }
}

function saveUsers() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); } catch (err) {}
}

function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

// 1. SIGNUP API
app.post('/api/signup', (req, res) => {
  let email = (req.body.email || '').trim().toLowerCase();
  let password = (req.body.password || '').trim();

  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ success: false, message: "Kripya valid Email ID daalein (e.g. yourname@gmail.com)" });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ success: false, message: "Password kam se kam 4 akshar ka hona chahiye!" });
  }
  if (users[email]) {
    return res.status(400).json({ success: false, message: "Yeh Email pehle se registered hai! Login karein." });
  }

  // Create account with ₹500 free bonus
  users[email] = {
    passwordHash: hashPassword(password),
    balance: 500.00,
    registeredAt: new Date().toISOString()
  };
  saveUsers();

  return res.json({
    success: true,
    email: email,
    balance: users[email].balance
  });
});

// 2. LOGIN API
app.post('/api/login', (req, res) => {
  let email = (req.body.email || '').trim().toLowerCase();
  let password = (req.body.password || '').trim();

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email aur Password dono bharein!" });
  }

  const user = users[email];
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(400).json({ success: false, message: "Galat Email ya Password!" });
  }

  return res.json({
    success: true,
    email: email,
    balance: user.balance
  });
});

// Real-Time Aviator Game Engine
let gameState = 'COUNTDOWN'; // 'COUNTDOWN', 'FLYING', 'CRASHED'
let multiplier = 1.00;
let crashPoint = 1.00;
let countdownSeconds = 5;
let startTime = 0;
let gameLoopInterval = null;
let history = [1.84, 2.15, 1.20, 5.60, 1.45, 3.10];

const onlineSockets = new Map();

function generateCrashPoint() {
  const rand = Math.random();
  // 7% chance of instant crash between 1.00x and 1.15x
  if (rand < 0.07) return +(1.00 + Math.random() * 0.15).toFixed(2);
  const e = 101;
  const h = Math.floor(Math.random() * 100);
  const crash = Math.floor((100 * e - h) / (e - h)) / 100;
  return Math.max(1.05, +crash.toFixed(2));
}

function startCountdown() {
  gameState = 'COUNTDOWN';
  multiplier = 1.00;
  countdownSeconds = 5;

  onlineSockets.forEach((p) => {
    p.bet1.active = p.bet1.queued;
    p.bet1.cashedOut = false;
    p.bet1.queued = false;

    p.bet2.active = p.bet2.queued;
    p.bet2.cashedOut = false;
    p.bet2.queued = false;
  });

  io.emit('round_countdown', { 
    seconds: countdownSeconds, 
    history: history.slice(0, 15) 
  });
  broadcastBets();

  const countTimer = setInterval(() => {
    countdownSeconds--;
    if (countdownSeconds > 0) {
      io.emit('countdown_tick', { seconds: countdownSeconds });
    } else {
      clearInterval(countTimer);
      startFlight();
    }
  }, 1000);
}

function startFlight() {
  gameState = 'FLYING';
  crashPoint = generateCrashPoint();
  startTime = Date.now();

  io.emit('flight_start', { timestamp: startTime });

  gameLoopInterval = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    // Authentic Aviator multiplier climb curve
    multiplier = +(1.00 + 0.07 * Math.pow(elapsed, 1.75) + 0.05 * elapsed).toFixed(2);

    if (multiplier >= crashPoint) {
      clearInterval(gameLoopInterval);
      triggerCrash();
    } else {
      io.emit('game_tick', { 
        multiplier: multiplier, 
        elapsed: elapsed 
      });
    }
  }, 50);
}

function triggerCrash() {
  gameState = 'CRASHED';
  history.unshift(crashPoint);
  if (history.length > 20) history.pop();

  onlineSockets.forEach((p) => {
    if (p.bet1.active && !p.bet1.cashedOut) p.bet1.active = false;
    if (p.bet2.active && !p.bet2.cashedOut) p.bet2.active = false;
  });

  io.emit('game_crash', { 
    crashPoint: crashPoint, 
    history: history.slice(0, 15) 
  });
  broadcastBets();

  setTimeout(startCountdown, 3000);
}

function broadcastBets() {
  const activeBets = [];
  onlineSockets.forEach((p) => {
    if (!p.email) return;
    const name = p.email.split('@')[0];
    const masked = name.length > 4 ? name.slice(0, 3) + '***' : name;
    if (p.bet1.active) activeBets.push({ user: masked, amount: p.bet1.amount, cashedOut: p.bet1.cashedOut });
    if (p.bet2.active) activeBets.push({ user: `${masked} (2)`, amount: p.bet2.amount, cashedOut: p.bet2.cashedOut });
  });
  io.emit('bets_update', activeBets);
}

io.on('connection', (socket) => {
  onlineSockets.set(socket.id, {
    email: null,
    bet1: { amount: 0, active: false, queued: false, cashedOut: false },
    bet2: { amount: 0, active: false, queued: false, cashedOut: false }
  });

  io.emit('online_count', onlineSockets.size);

  // CRITICAL: Immediate sync for newly connected players so game never freezes
  socket.emit('init_sync', {
    gameState,
    multiplier,
    elapsed: startTime > 0 ? (Date.now() - startTime) / 1000 : 0,
    countdownSeconds,
    history: history.slice(0, 15)
  });

  socket.on('set_user_email', ({ email }) => {
    email = (email || '').trim().toLowerCase();
    if (email && users[email]) {
      const p = onlineSockets.get(socket.id);
      if (p) p.email = email;
      socket.emit('balance_update', { balance: users[email].balance });
      broadcastBets();
    }
  });

  // Place Bet
  socket.on('place_bet', ({ panel, amount }) => {
    const p = onlineSockets.get(socket.id);
    if (!p || !p.email || !users[p.email]) return;

    amount = parseFloat(amount);
    const user = users[p.email];
    if (isNaN(amount) || amount <= 0 || user.balance < amount) {
      return socket.emit('bet_error', { message: "Wallet me balance kam hai!" });
    }

    const betObj = panel === 1 ? p.bet1 : p.bet2;
    user.balance = +(user.balance - amount).toFixed(2);
    saveUsers();

    betObj.amount = amount;
    betObj.cashedOut = false;
    betObj.active = (gameState === 'COUNTDOWN');
    betObj.queued = (gameState !== 'COUNTDOWN');

    socket.emit('bet_success', { 
      panel, 
      balance: user.balance, 
      status: betObj.queued ? 'QUEUED' : 'ACTIVE' 
    });
    broadcastBets();
  });

  // Cancel Bet
  socket.on('cancel_bet', ({ panel }) => {
    const p = onlineSockets.get(socket.id);
    if (!p || !p.email || !users[p.email]) return;

    const user = users[p.email];
    const betObj = panel === 1 ? p.bet1 : p.bet2;

    if (betObj.queued || (betObj.active && gameState === 'COUNTDOWN')) {
      user.balance = +(user.balance + betObj.amount).toFixed(2);
      saveUsers();

      betObj.active = false;
      betObj.queued = false;
      betObj.amount = 0;

      socket.emit('cancel_success', { panel, balance: user.balance });
      broadcastBets();
    }
  });

  // Cash Out
  socket.on('cash_out', ({ panel }) => {
    const p = onlineSockets.get(socket.id);
    if (!p || !p.email || !users[p.email] || gameState !== 'FLYING') return;

    const user = users[p.email];
    const betObj = panel === 1 ? p.bet1 : p.bet2;

    if (betObj.active && !betObj.cashedOut) {
      const win = +(betObj.amount * multiplier).toFixed(2);
      user.balance = +(user.balance + win).toFixed(2);
      saveUsers();

      betObj.cashedOut = true;
      socket.emit('cashout_success', { 
        panel, 
        winAmount: win, 
        balance: user.balance, 
        multiplier 
      });
      broadcastBets();
    }
  });

  socket.on('disconnect', () => {
    onlineSockets.delete(socket.id);
    io.emit('online_count', onlineSockets.size);
    broadcastBets();
  });
});

startCountdown();

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Aviator Server live on port ${PORT}`);
});
    
