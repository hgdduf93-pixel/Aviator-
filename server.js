const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// JSON Body Parser for instant API
app.use(express.json());
app.use(express.static(__dirname));

// Database file
const DB_FILE = path.join(__dirname, 'users.json');
let users = {};

if (fs.existsSync(DB_FILE)) {
  try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { users = {}; }
}

function saveUsers() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); } catch (err) {}
}

// In-Memory OTP Store
const otpStore = new Map();

// REST API 1: Send OTP (Super Fast - No Socket lag)
app.post('/api/send-otp', (req, res) => {
  const phone = (req.body.phone || '').trim();
  if (!phone || phone.length !== 10 || isNaN(phone)) {
    return res.status(400).json({ success: false, message: "Kripya valid 10-digit mobile number daalein!" });
  }

  // 6-digit real OTP
  const generatedOTP = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(phone, {
    otp: generatedOTP,
    expiresAt: Date.now() + 5 * 60 * 1000
  });

  console.log(`>>> OTP GENERATED FOR +91 ${phone}: ${generatedOTP} <<<`);

  return res.json({
    success: true,
    phone: phone,
    otp: generatedOTP, // Screen banner me dikhane ke liye
    message: "OTP successfully sent!"
  });
});

// REST API 2: Verify OTP
app.post('/api/verify-otp', (req, res) => {
  const phone = (req.body.phone || '').trim();
  const otp = (req.body.otp || '').trim();

  const record = otpStore.get(phone);
  if (!record) {
    return res.status(400).json({ success: false, message: "Pehle SEND OTP par click karein!" });
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(phone);
    return res.status(400).json({ success: false, message: "OTP expire ho gaya hai, dobara try karein!" });
  }

  if (record.otp !== otp) {
    return res.status(400).json({ success: false, message: "Galat OTP! Kripya sahi OTP daalein." });
  }

  otpStore.delete(phone);

  // User save with ₹500 bonus
  if (!users[phone]) {
    users[phone] = { balance: 500.00, registeredAt: new Date().toISOString() };
    saveUsers();
  }

  return res.json({
    success: true,
    phone: phone,
    balance: users[phone].balance
  });
});

// Game Loop Variables
let gameState = 'COUNTDOWN';
let multiplier = 1.00;
let crashPoint = 1.00;
let countdownSeconds = 5;
let startTime = 0;
let gameLoopInterval = null;
let history = [1.54, 2.30, 5.00, 6.67, 1.62];

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

  io.emit('round_countdown', { seconds: countdownSeconds, history: history.slice(0, 10) });
  broadcastBets();

  const countTimer = setInterval(() => {
    countdownSeconds--;
    if (countdownSeconds > 0) io.emit('countdown_tick', { seconds: countdownSeconds });
    else { clearInterval(countTimer); startFlight(); }
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
      io.emit('game_tick', { multiplier: multiplier, elapsed: elapsed });
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

  io.emit('game_crash', { crashPoint: crashPoint, history: history.slice(0, 10) });
  broadcastBets();
  setTimeout(startCountdown, 3000);
}

function broadcastBets() {
  const activeBets = [];
  onlineSockets.forEach((p) => {
    if (!p.phone) return;
    const masked = p.phone.slice(0, 2) + '******' + p.phone.slice(-2);
    if (p.bet1.active) activeBets.push({ user: masked, amount: p.bet1.amount, cashedOut: p.bet1.cashedOut });
    if (p.bet2.active) activeBets.push({ user: `${masked} (2)`, amount: p.bet2.amount, cashedOut: p.bet2.cashedOut });
  });
  io.emit('bets_update', activeBets);
}

io.on('connection', (socket) => {
  onlineSockets.set(socket.id, {
    phone: null,
    bet1: { amount: 0, active: false, queued: false, cashedOut: false },
    bet2: { amount: 0, active: false, queued: false, cashedOut: false }
  });

  io.emit('online_count', onlineSockets.size);

  socket.on('set_user_phone', ({ phone }) => {
    if (phone && users[phone]) {
      const p = onlineSockets.get(socket.id);
      if (p) p.phone = phone;
      broadcastBets();
    }
  });

  socket.on('place_bet', ({ panel, amount }) => {
    const p = onlineSockets.get(socket.id);
    if (!p || !p.phone || !users[p.phone]) return;

    amount = parseFloat(amount);
    const user = users[p.phone];
    if (isNaN(amount) || amount <= 0 || user.balance < amount) {
      socket.emit('bet_error', { message: "Balance kam hai!" });
      return;
    }

    const betObj = panel === 1 ? p.bet1 : p.bet2;
    user.balance -= amount;
    saveUsers();

    betObj.amount = amount;
    betObj.cashedOut = false;
    betObj.active = (gameState === 'COUNTDOWN');
    betObj.queued = (gameState !== 'COUNTDOWN');

    socket.emit('bet_success', { panel, balance: user.balance, status: betObj.queued ? 'QUEUED' : 'ACTIVE' });
    broadcastBets();
  });

  socket.on('cancel_bet', ({ panel }) => {
    const p = onlineSockets.get(socket.id);
    if (!p || !p.phone || !users[p.phone]) return;

    const user = users[p.phone];
    const betObj = panel === 1 ? p.bet1 : p.bet2;

    if (betObj.queued || (betObj.active && gameState === 'COUNTDOWN')) {
      user.balance += betObj.amount;
      saveUsers();
      betObj.active = false;
      betObj.queued = false;
      betObj.amount = 0;
      socket.emit('cancel_success', { panel, balance: user.balance });
      broadcastBets();
    }
  });

  socket.on('cash_out', ({ panel }) => {
    const p = onlineSockets.get(socket.id);
    if (!p || !p.phone || !users[p.phone] || gameState !== 'FLYING') return;

    const user = users[p.phone];
    const betObj = panel === 1 ? p.bet1 : p.bet2;

    if (betObj.active && !betObj.cashedOut) {
      const win = +(betObj.amount * multiplier).toFixed(2);
      user.balance += win;
      saveUsers();
      betObj.cashedOut = true;
      socket.emit('cashout_success', { panel, winAmount: win, balance: user.balance, multiplier });
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
  console.log(`Server live on port ${PORT}`);
});
    
