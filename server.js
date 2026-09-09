const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Render ke HTTPS aur CORS ko allow karein
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// Static files support
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  const pPath = path.join(__dirname, 'public', 'index.html');
  const rPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(pPath)) return res.sendFile(pPath);
  if (fs.existsSync(rPath)) return res.sendFile(rPath);
  res.send("index.html nahi mili!");
});

// Game state variables
let gameState = 'WAITING'; // WAITING, FLYING, CRASHED
let currentMultiplier = 1.00;
let crashPoint = 1.00;
let flightStartTime = null;
let gameLoopTimer = null;
let onlineCount = 0;
let history = [1.45, 2.10, 1.15, 4.80, 1.88, 3.20];

function generateCrash() {
  const r = Math.random();
  if (r < 0.05) return 1.00; // 5% house crash
  const point = 0.95 / (1 - r);
  return Math.max(1.00, parseFloat(Math.min(point, 50).toFixed(2)));
}

function startWaitingPhase() {
  gameState = 'WAITING';
  let countdown = 5.0;

  io.emit('game_state', {
    state: 'WAITING',
    countdown: countdown.toFixed(1),
    history
  });

  const timer = setInterval(() => {
    countdown -= 0.1;
    if (countdown <= 0) {
      clearInterval(timer);
      launchFlight();
    } else {
      io.emit('waiting_tick', { countdown: countdown.toFixed(1) });
    }
  }, 100);
}

function launchFlight() {
  gameState = 'FLYING';
  crashPoint = generateCrash();
  flightStartTime = Date.now();
  currentMultiplier = 1.00;

  io.emit('game_state', { state: 'FLYING', multiplier: 1.00 });

  gameLoopTimer = setInterval(() => {
    const elapsed = (Date.now() - flightStartTime) / 1000;
    currentMultiplier = parseFloat((1.00 + Math.pow(elapsed * 0.65, 1.75)).toFixed(2));

    if (currentMultiplier >= crashPoint) {
      triggerCrash();
    } else {
      io.emit('flight_tick', { multiplier: currentMultiplier });
    }
  }, 50);
}

function triggerCrash() {
  clearInterval(gameLoopTimer);
  gameState = 'CRASHED';

  history.unshift(crashPoint);
  if (history.length > 10) history.pop();

  io.emit('game_state', {
    state: 'CRASHED',
    crashPoint,
    history
  });

  setTimeout(() => {
    startWaitingPhase();
  }, 3500);
}

io.on('connection', (socket) => {
  onlineCount++;
  io.emit('online_count', onlineCount);

  // Naye user ko turant current running game me sync karein
  socket.emit('sync_init', {
    state: gameState,
    multiplier: currentMultiplier,
    history,
    onlineCount
  });

  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    io.emit('online_count', onlineCount);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startWaitingPhase();
});
