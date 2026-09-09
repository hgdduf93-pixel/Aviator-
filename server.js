const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// Game State Variables
let gameState = 'COUNTDOWN'; // COUNTDOWN, FLYING, CRASHED
let multiplier = 1.00;
let crashPoint = 1.00;
let countdownSeconds = 5;
let startTime = 0;
let gameLoopInterval = null;
let history = [1.45, 2.80, 1.15, 5.60, 1.95, 3.20];

// In-Memory Player Database
// socket.id -> { balance, bet1: { amount, cashedOut }, bet2: { amount, cashedOut } }
const players = new Map();

// Generate Provably Crash Point (Casino algorithm)
function getNextCrashPoint() {
  const rand = Math.random();
  // 7% instant house crash
  if (rand < 0.07) return +(1.00 + Math.random() * 0.10).toFixed(2);
  const e = 101;
  const h = Math.floor(Math.random() * 100);
  const crash = Math.floor((100 * e - h) / (e - h)) / 100;
  return Math.max(1.02, +crash.toFixed(2));
}

// Start Round Countdown
function startCountdown() {
  gameState = 'COUNTDOWN';
  multiplier = 1.00;
  countdownSeconds = 5;

  // Reset bets for next round
  players.forEach((p) => {
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

  broadcastActiveBets();

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

// Start Flight
function startFlight() {
  gameState = 'FLYING';
  crashPoint = getNextCrashPoint();
  startTime = Date.now();

  io.emit('flight_start', { timestamp: startTime });

  // 50ms Server Tick Loop (20 updates per second)
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

// Trigger Crash
function triggerCrash() {
  gameState = 'CRASHED';
  history.unshift(crashPoint);
  if (history.length > 20) history.pop();

  // Reset uncashed bets
  players.forEach((p) => {
    if (p.bet1.active && !p.bet1.cashedOut) p.bet1.active = false;
    if (p.bet2.active && !p.bet2.cashedOut) p.bet2.active = false;
  });

  io.emit('game_crash', { 
    crashPoint: crashPoint,
    history: history.slice(0, 10)
  });

  broadcastActiveBets();

  setTimeout(startCountdown, 3000);
}

function broadcastActiveBets() {
  const activeBetsList = [];
  players.forEach((p, id) => {
    if (p.bet1.active) {
      activeBetsList.push({ user: `Player_${id.slice(0, 4)}`, amount: p.bet1.amount, cashedOut: p.bet1.cashedOut });
    }
    if (p.bet2.active) {
      activeBetsList.push({ user: `Player_${id.slice(0, 4)} (2)`, amount: p.bet2.amount, cashedOut: p.bet2.cashedOut });
    }
  });
  io.emit('active_bets_update', activeBetsList);
}

// WebSockets Connection
io.on('connection', (socket) => {
  // New player initialized with ₹2,000 demo balance
  const playerData = {
    balance: 2000.00,
    bet1: { amount: 0, active: false, queued: false, cashedOut: false },
    bet2: { amount: 0, active: false, queued: false, cashedOut: false }
  };
  players.set(socket.id, playerData);

  // Send current state to newly connected player
  socket.emit('init_sync', {
    balance: playerData.balance,
    gameState: gameState,
    multiplier: multiplier,
    countdownSeconds: countdownSeconds,
    history: history.slice(0, 10),
    onlineCount: players.size
  });

  io.emit('online_players', players.size);

  // Place Bet Handler
  socket.on('place_bet', ({ panel, amount }) => {
    const p = players.get(socket.id);
    if (!p) return;

    amount = parseFloat(amount);
    if (isNaN(amount) || amount <= 0 || p.balance < amount) {
      socket.emit('bet_error', { message: "Insufficient balance!" });
      return;
    }

    const betObj = panel === 1 ? p.bet1 : p.bet2;

    p.balance -= amount;
    betObj.amount = amount;
    betObj.cashedOut = false;

    if (gameState === 'COUNTDOWN') {
      betObj.active = true;
      betObj.queued = false;
    } else {
      betObj.queued = true;
      betObj.active = false;
    }

    socket.emit('bet_success', { panel, balance: p.balance, status: betObj.queued ? 'QUEUED' : 'ACTIVE' });
    broadcastActiveBets();
  });

  // Cancel Bet Handler
  socket.on('cancel_bet', ({ panel }) => {
    const p = players.get(socket.id);
    if (!p) return;
    const betObj = panel === 1 ? p.bet1 : p.bet2;

    if (betObj.queued || (betObj.active && gameState === 'COUNTDOWN')) {
      p.balance += betObj.amount;
      betObj.active = false;
      betObj.queued = false;
      betObj.amount = 0;

      socket.emit('cancel_success', { panel, balance: p.balance });
      broadcastActiveBets();
    }
  });

  // Cash Out Handler
  socket.on('cash_out', ({ panel }) => {
    const p = players.get(socket.id);
    if (!p || gameState !== 'FLYING') return;

    const betObj = panel === 1 ? p.bet1 : p.bet2;
    if (betObj.active && !betObj.cashedOut) {
      const win = +(betObj.amount * multiplier).toFixed(2);
      p.balance += win;
      betObj.cashedOut = true;

      socket.emit('cashout_success', { panel, winAmount: win, balance: p.balance, multiplier });
      broadcastActiveBets();
    }
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    io.emit('online_players', players.size);
    broadcastActiveBets();
  });
});

// Start loop
startCountdown();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Aviator Server running live on http://localhost:${PORT}`);
});
