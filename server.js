const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'avion_super_secret_jwt_key_98765';
const DB_FILE = path.join(__dirname, 'database.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Persistent JSON Storage
function loadData() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// User Auth APIs
app.post('/api/signup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 3) {
    return res.status(400).json({ error: 'Valid username & password required' });
  }

  const db = loadData();
  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: 'Username already taken' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const newUser = {
    id: 'user_' + Date.now(),
    username,
    password: hashedPassword,
    coins: 1000.00 // Default welcome coins
  };

  db.users.push(newUser);
  saveData(db);

  const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: newUser.id, username: newUser.username, coins: newUser.coins } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const db = loadData();
  const user = db.users.find(u => u.username.toLowerCase() === (username || '').toLowerCase());

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, coins: user.coins } });
});

app.post('/api/add-coins', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    const amount = parseFloat(req.body.amount);
    if (isNaN(amount) || amount <= 0 || amount > 50000) {
      return res.status(400).json({ error: 'Invalid coin amount' });
    }

    const db = loadData();
    const user = db.users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.coins = parseFloat((user.coins + amount).toFixed(2));
    saveData(db);

    res.json({ success: true, coins: user.coins });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Game Engine State Machine
const GAME_STATE = {
  WAITING: 'WAITING',
  FLYING: 'FLYING',
  CRASHED: 'CRASHED'
};

let currentState = GAME_STATE.WAITING;
let currentMultiplier = 1.00;
let crashPoint = 1.00;
let waitTimeLeft = 5;
let multiplierHistory = [3.67, 1.02, 1.04, 1.09, 3.21, 1.42, 5.88, 2.06];
let activeBets = []; // { socketId, userId, username, panelId, amount, autoCashout, cashedOut, winAmount }

function generateCrashPoint() {
  // 4% House edge instant crash
  if (Math.random() < 0.04) return 1.00;
  const e = 100;
  const h = Math.floor(Math.random() * 100);
  const r = (100 - 3) / (100 - h);
  return Math.max(1.01, parseFloat(r.toFixed(2)));
}

function startWaitingPhase() {
  currentState = GAME_STATE.WAITING;
  currentMultiplier = 1.00;
  crashPoint = generateCrashPoint();
  waitTimeLeft = 5;
  activeBets = [];

  io.emit('game_state', {
    state: currentState,
    waitTimeLeft,
    history: multiplierHistory.slice(-15)
  });

  const waitInterval = setInterval(() => {
    waitTimeLeft--;
    io.emit('wait_tick', { waitTimeLeft });

    if (waitTimeLeft <= 0) {
      clearInterval(waitInterval);
      startFlyingPhase();
    }
  }, 1000);
}

function startFlyingPhase() {
  currentState = GAME_STATE.FLYING;
  const startTime = Date.now();

  io.emit('game_state', { state: currentState, multiplier: 1.00 });

  const flyInterval = setInterval(() => {
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    // Exponential growth curve: ~0.06 factor
    currentMultiplier = parseFloat(Math.pow(Math.E, 0.065 * elapsedSeconds).toFixed(2));

    // Handle Auto Cashouts
    activeBets.forEach(bet => {
      if (!bet.cashedOut && bet.autoCashout && currentMultiplier >= bet.autoCashout) {
        cashOutBet(bet.userId, bet.panelId, currentMultiplier);
      }
    });

    if (currentMultiplier >= crashPoint) {
      clearInterval(flyInterval);
      startCrashPhase();
    } else {
      io.emit('multiplier_tick', { multiplier: currentMultiplier });
    }
  }, 70);
}

function startCrashPhase() {
  currentState = GAME_STATE.CRASHED;
  multiplierHistory.push(currentMultiplier);
  if (multiplierHistory.length > 20) multiplierHistory.shift();

  io.emit('game_crashed', {
    multiplier: currentMultiplier,
    history: multiplierHistory.slice(-15)
  });

  setTimeout(() => {
    startWaitingPhase();
  }, 2500);
}

function cashOutBet(userId, panelId, multiplier) {
  const bet = activeBets.find(b => b.userId === userId && b.panelId === panelId && !b.cashedOut);
  if (!bet || currentState !== GAME_STATE.FLYING) return null;

  bet.cashedOut = true;
  const winAmount = parseFloat((bet.amount * multiplier).toFixed(2));
  bet.winAmount = winAmount;

  // Credit database
  const db = loadData();
  const user = db.users.find(u => u.id === userId);
  if (user) {
    user.coins = parseFloat((user.coins + winAmount).toFixed(2));
    saveData(db);

    io.to(bet.socketId).emit('bet_cashed_out', {
      panelId: bet.panelId,
      winAmount,
      multiplier,
      newBalance: user.coins
    });

    io.emit('general_bet_update', {
      username: bet.username,
      amount: bet.amount,
      multiplier,
      winAmount
    });
  }
  return winAmount;
}

// Socket Connection Handler
io.on('connection', (socket) => {
  socket.emit('init_game', {
    state: currentState,
    multiplier: currentMultiplier,
    waitTimeLeft,
    history: multiplierHistory.slice(-15)
  });

  socket.on('place_bet', (data) => {
    const { token, panelId, amount, autoCashout } = data;
    if (currentState !== GAME_STATE.WAITING) {
      return socket.emit('error_msg', { message: 'Can only bet during wait phase' });
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const db = loadData();
      const user = db.users.find(u => u.id === decoded.id);

      const parsedAmount = parseFloat(amount);
      if (!user || user.coins < parsedAmount || parsedAmount < 10) {
        return socket.emit('error_msg', { message: 'Insufficient balance or minimum 10 required' });
      }

      // Check if panel already has bet
      const existing = activeBets.find(b => b.userId === user.id && b.panelId === panelId);
      if (existing) return socket.emit('error_msg', { message: 'Bet already placed for this panel' });

      user.coins = parseFloat((user.coins - parsedAmount).toFixed(2));
      saveData(db);

      const betObj = {
        socketId: socket.id,
        userId: user.id,
        username: user.username,
        panelId,
        amount: parsedAmount,
        autoCashout: autoCashout ? parseFloat(autoCashout) : null,
        cashedOut: false,
        winAmount: 0
      };
      activeBets.push(betObj);

      socket.emit('bet_confirmed', { panelId, amount: parsedAmount, newBalance: user.coins });
      io.emit('new_live_bet', { username: user.username, amount: parsedAmount });
    } catch (e) {
      socket.emit('error_msg', { message: 'Authentication failed' });
    }
  });

  socket.on('cash_out', (data) => {
    const { token, panelId } = data;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      cashOutBet(decoded.id, panelId, currentMultiplier);
    } catch (e) {
      socket.emit('error_msg', { message: 'Invalid session' });
    }
  });
});

startWaitingPhase();

server.listen(PORT, () => {
  console.log(`Avion server running on port ${PORT}`);
});
  
