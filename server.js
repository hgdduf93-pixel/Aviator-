const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// Game State
let gameState = "WAITING"; // WAITING, FLYING, CRASHED
let multiplier = 1.00;
let crashPoint = 1.00;
let startTime = null;
let countdown = 5;
let history = [3.67, 1.02, 1.09, 2.45, 1.42, 5.88];

// Players state: socketId -> { balance, bets: { 1: { amount, cashedOut }, 2: { amount, cashedOut } } }
const players = new Map();

function generateCrashPoint() {
  const rand = Math.random();
  if (rand < 0.04) return 1.00; // 4% instant crash
  const result = Math.floor((100 / (100 - (rand * 96))) * 100) / 100;
  return Math.min(result, 150.00);
}

function startCountdown() {
  gameState = "WAITING";
  countdown = 5;
  multiplier = 1.00;

  // Reset bets for all players
  players.forEach((p) => {
    p.bets = { 1: null, 2: null };
  });

  io.emit("game_state", { state: gameState, countdown, history });

  const cdInterval = setInterval(() => {
    countdown--;
    if (countdown > 0) {
      io.emit("countdown_tick", { countdown });
    } else {
      clearInterval(cdInterval);
      startFlight();
    }
  }, 1000);
}

function startFlight() {
  gameState = "FLYING";
  crashPoint = generateCrashPoint();
  startTime = Date.now();
  multiplier = 1.00;

  io.emit("game_state", { state: gameState, crashPoint: null });

  const flightInterval = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    // Exponential smooth growth curve
    multiplier = parseFloat((Math.pow(Math.E, 0.07 * elapsed)).toFixed(2));

    if (multiplier >= crashPoint) {
      clearInterval(flightInterval);
      handleCrash();
    } else {
      io.emit("multiplier_tick", { multiplier, elapsed });
    }
  }, 60);
}

function handleCrash() {
  gameState = "CRASHED";
  multiplier = crashPoint;

  history.unshift(crashPoint);
  if (history.length > 12) history.pop();

  io.emit("game_crash", { crashPoint, history });

  // 3 second rest period before next round
  setTimeout(() => {
    startCountdown();
  }, 3000);
}

io.on('connection', (socket) => {
  // Initialize player with 5000 virtual INR
  players.set(socket.id, {
    balance: 5000.00,
    bets: { 1: null, 2: null }
  });

  // Send current state to newly joined user
  const player = players.get(socket.id);
  socket.emit("init_player", {
    balance: player.balance,
    state: gameState,
    multiplier,
    countdown,
    history
  });

  // Place bet
  socket.on("place_bet", ({ panel, amount }) => {
    const p = players.get(socket.id);
    if (!p) return;

    if (gameState === "WAITING" && !p.bets[panel] && p.balance >= amount && amount > 0) {
      p.balance = parseFloat((p.balance - amount).toFixed(2));
      p.bets[panel] = { amount, cashedOut: false };
      socket.emit("bet_confirmed", { panel, amount, balance: p.balance });
    }
  });

  // Cashout
  socket.on("cashout", ({ panel }) => {
    const p = players.get(socket.id);
    if (!p) return;

    if (gameState === "FLYING" && p.bets[panel] && !p.bets[panel].cashedOut) {
      p.bets[panel].cashedOut = true;
      const winAmount = parseFloat((p.bets[panel].amount * multiplier).toFixed(2));
      p.balance = parseFloat((p.balance + winAmount).toFixed(2));
      socket.emit("cashout_success", { panel, winAmount, balance: p.balance, multiplier });
    }
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Real-time server live on port ${PORT}`);
  startCountdown();
});
