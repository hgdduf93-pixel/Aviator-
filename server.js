const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

let gameState = 'WAITING';
let currentMultiplier = 1.00;
let crashPoint = 1.00;
let flightStartTime = null;
let gameTimer = null;
let history = [1.25, 2.10, 1.15, 5.42, 1.88, 3.20];

let activeBets = new Map();
let queuedBets = new Map();

function getNextCrashPoint() {
  const rand = Math.random();
  if (rand < 0.04) return 1.00;
  const point = 0.96 / (1 - rand);
  return Math.max(1.00, parseFloat(Math.min(point, 100).toFixed(2)));
}

function startWaitingPhase() {
  gameState = 'WAITING';
  let countdown = 5.0;

  activeBets.clear();
  queuedBets.forEach((userBets, socketId) => activeBets.set(socketId, userBets));
  queuedBets.clear();

  io.emit('round_waiting', { countdown });

  const waitTimer = setInterval(() => {
    countdown -= 0.1;
    if (countdown <= 0) {
      clearInterval(waitTimer);
      launchFlightPhase();
    } else {
      io.emit('waiting_tick', { countdown: countdown.toFixed(1) });
    }
  }, 100);
}

function launchFlightPhase() {
  gameState = 'FLYING';
  crashPoint = getNextCrashPoint();
  flightStartTime = Date.now();
  currentMultiplier = 1.00;

  io.emit('round_started');

  gameTimer = setInterval(() => {
    const elapsed = (Date.now() - flightStartTime) / 1000;
    currentMultiplier = parseFloat((1.00 + Math.pow(elapsed * 0.65, 1.8)).toFixed(2));

    if (currentMultiplier >= crashPoint) {
      triggerCrash();
    } else {
      io.emit('multiplier_tick', { multiplier: currentMultiplier });
    }
  }, 50);
}

function triggerCrash() {
  clearInterval(gameTimer);
  gameState = 'CRASHED';

  history.unshift(crashPoint);
  if (history.length > 15) history.pop();

  io.emit('round_crashed', { crashPoint, history });

  setTimeout(() => startWaitingPhase(), 3500);
}

io.on('connection', (socket) => {
  const username = "Pilot_" + socket.id.substring(0, 4);

  socket.emit('init_state', { gameState, currentMultiplier, history, username });

  socket.on('place_bet', (data) => {
    const { betId, amount } = data;
    const betInfo = { id: `${socket.id}_${betId}`, username, betId, amount: parseFloat(amount) };

    if (gameState === 'WAITING') {
      if (!activeBets.has(socket.id)) activeBets.set(socket.id, {});
      activeBets.get(socket.id)[betId] = betInfo;
      io.emit('new_bet_broadcast', betInfo);
    } else {
      if (!queuedBets.has(socket.id)) queuedBets.set(socket.id, {});
      queuedBets.get(socket.id)[betId] = betInfo;
    }
  });

  socket.on('request_cashout', (data) => {
    const { betId } = data;
    if (gameState === 'FLYING' && activeBets.has(socket.id)) {
      const uBets = activeBets.get(socket.id);
      if (uBets && uBets[betId] && !uBets[betId].cashed) {
        uBets[betId].cashed = true;
        const win = parseFloat((uBets[betId].amount * currentMultiplier).toFixed(2));
        io.emit('player_cashed_out', { username, win, multiplier: currentMultiplier });
        socket.emit('cashout_success', { betId, win, multiplier: currentMultiplier });
      }
    }
  });

  socket.on('disconnect', () => {
    activeBets.delete(socket.id);
    queuedBets.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Live on port ${PORT}`);
  startWaitingPhase();
});
