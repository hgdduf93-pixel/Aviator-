const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// User Database Persistence (users.json)
const DB_FILE = path.join(__dirname, 'users.json');
let users = {};

if (fs.existsSync(DB_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    users = {};
  }
}

function saveUsers() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("Save error:", err);
  }
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Game State
let gameState = 'COUNTDOWN';
let multiplier = 1.00;
let crashPoint = 1.00;
let countdownSeconds = 5;
let startTime = 0;
let gameLoopInterval = null;
let history = [1.54, 2.30, 5.00, 6.67, 1.62];

// Active Connected Players: socket.id -> { username, bet1: {}, bet2: {} }
const onlineSockets = new Map();

function generateCrashPoint() {
  const rand = Math.random();
  if (rand < 0.08) return +(1.00 + Math.random() * 0.12).toFixed(2);
  const e = 101;
  const h = Math.floor(Math.random() * 100);
  const crash = Math.floor((100 * e - h) / (e - h)) / 100;
  return Math.max(1.02, +crash.toFixed(2));
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
    history: history.slice(0, 10)
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
    multiplier = +(1.00 + 0.06 * Math.pow(elapsed, 1.7) + 0.04 * elapsed).toFixed(2);

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
  if (history.length > 15) history.pop();

  onlineSockets.forEach((p) => {
    if (p.bet1.active && !p.bet1.cashedOut) p.bet1.active = false;
    if (p.bet2.active && !p.bet2.cashedOut) p.bet2.active = false;
  });

  io.emit('game_crash', { 
    crashPoint: crashPoint,
    history: history.slice(0, 10)
  });

  broadcastBets();
  setTimeout(startCountdown, 3000);
}

function broadcastBets() {
  const activeBets = [];
  onlineSockets.forEach((p) => {
    if (!p.username) return;
    if (p.bet1.active) {
      activeBets.push({ user: p.username, amount: p.bet1.amount, cashedOut: p.bet1.cashedOut });
    }
    if (p.bet2.active) {
      activeBets.push({ user: `${p.username} (2)`, amount: p.bet2.amount, cashedOut: p.bet2.cashedOut });
    }
  });
  io.emit('bets_update', activeBets);
}

// Socket Connection & Authentication
io.on('connection', (socket) => {
  onlineSockets.set(socket.id, {
    username: null,
    bet1: { amount: 0, active: false, queued: false, cashedOut: false },
    bet2: { amount: 0, active: false, queued: false, cashedOut: false }
  });

  io.emit('online_count', onlineSockets.size);

  // Sign Up Event
  socket.on('auth_signup', ({ username, password }) => {
    username = (username || '').trim().toLowerCase();
    if (!username || username.length < 3) {
      return socket.emit('auth_error', { message: "Username kam se kam 3 akshar ka hona chahiye!" });
    }
    if (!password || password.length < 4) {
      return socket.emit('auth_error', { message: "Password kam se kam 4 akshar ka hona chahiye!" });
    }
    if (users[username]) {
      return socket.emit('auth_error', { message: "Yeh username pehle se registered hai! Login karein." });
    }

    // Welcome Bonus: ₹500
    users[username] = {
      passwordHash: hashPassword(password),
      balance: 500.00,
      createdAt: new Date().toISOString()
    };
    saveUsers();

    const p = onlineSockets.get(socket.id);
    if (p) p.username = username;

    socket.emit('auth_success', {
      username: username,
      balance: users[username].balance
    });
    broadcastBets();
  });

  // Login Event
  socket.on('auth_login', ({ username, password }) => {
    username = (username || '').trim().toLowerCase();
    if (!users[username] || users[username].passwordHash !== hashPassword(password)) {
      return socket.emit('auth_error', { message: "Galat Username ya Password!" });
    }

    const p = onlineSockets.get(socket.id);
    if (p) p.username = username;

    socket.emit('auth_success', {
      username: username,
      balance: users[username].balance
    });
    broadcastBets();
  });

  // Reconnect with saved session
  socket.on('auth_token_verify', ({ username }) => {
    username = (username || '').trim().toLowerCase();
    if (users[username]) {
      const p = onlineSockets.get(socket.id);
      if (p) p.username = username;

      socket.emit('auth_success', {
        username: username,
        balance: users[username].balance
      });
      broadcastBets();
    }
  });

  // Place Bet
  socket.on('place_bet', ({ panel, amount }) => {
    const p = onlineSockets.get(socket.id);
    if (!p || !p.username || !users[p.username]) return;

    amount = parseFloat(amount);
    const userAccount = users[p.username];

    if (isNaN(amount) || amount <= 0 || userAccount.balance < amount) {
      socket.emit('bet_error', { message: "Balance kam hai!" });
      return;
    }

    const betObj = panel === 1 ? p.bet1 : p.bet2;
    userAccount.balance -= amount;
    saveUsers();

    betObj.amount = amount;
    betObj.cashedOut = false;

    if (gameState === 'COUNTDOWN') {
      betObj.active = true;
      betObj.queued = false;
    } else {
      betObj.queued = true;
      betObj.active = false;
    }

    socket.emit('bet_success', { panel, balance: userAccount.balance, status: betObj.queued ? 'QUEUED' : 'ACTIVE' });
    broadcastBets();
  });

  // Cancel Bet
  socket.on('cancel_bet', ({ panel }) => {
    const p = onlineSockets.get(socket.id);
    if (!p || !p.username || !users[p.username]) return;

    const userAccount = users[p.username];
    const betObj = panel === 1 ? p.bet1 : p.bet2;

    if (betObj.queued || (betObj.active && gameState === 'COUNTDOWN')) {
      userAccount.balance += betObj.amount;
      saveUsers();

      betObj.active = false;
      betObj.queued = false;
      betObj.amount = 0;

      socket.emit('cancel_success', { panel, balance: userAccount.balance });
      broadcastBets();
    }
  });

  // Cash Out
  socket.on('cash_out', ({ panel }) => {
    const p = onlineSockets.get(socket.id);
    if (!p || !p.username || !users[p.username] || gameState !== 'FLYING') return;

    const userAccount = users[p.username];
    const betObj = panel === 1 ? p.bet1 : p.bet2;

    if (betObj.active && !betObj.cashedOut) {
      const win = +(betObj.amount * multiplier).toFixed(2);
      userAccount.balance += win;
      saveUsers();

      betObj.cashedOut = true;
      socket.emit('cashout_success', { panel, winAmount: win, balance: userAccount.balance, multiplier });
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
  console.log(`Live Server on port ${PORT}`);
});
