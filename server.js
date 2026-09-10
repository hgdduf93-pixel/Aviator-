const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6 // 1MB payload limit to prevent buffer overflow attacks
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'avion_super_secret_jwt_key_98765';
const DB_FILE = path.join(__dirname, 'database.json');

// Security HTTP Headers & Shielding
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// In-Memory Rate Limiter (Anti-Brute Force & Anti-DoS)
const ipRateLimits = new Map();
function rateLimitMiddleware(limitPerMinute = 40) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const clientRecord = ipRateLimits.get(ip) || { count: 0, resetTime: now + 60000 };

    if (now > clientRecord.resetTime) {
      clientRecord.count = 1;
      clientRecord.resetTime = now + 60000;
    } else {
      clientRecord.count++;
      if (clientRecord.count > limitPerMinute) {
        return res.status(429).json({ error: 'Too many requests from this IP. Please wait a minute.' });
      }
    }
    ipRateLimits.set(ip, clientRecord);
    next();
  };
}

// Clean up stale rate limits every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of ipRateLimits.entries()) {
    if (now > rec.resetTime) ipRateLimits.delete(ip);
  }
}, 300000);

// Sanitization Helper
function sanitizeText(str, maxLen = 40) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>'"/\\;]/g, '').trim().slice(0, maxLen);
}

app.use(express.json({ limit: '50kb' })); // Restrict JSON body size against memory flooding
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

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

// User Auth APIs with strict security & sanitization
app.post('/api/signup', rateLimitMiddleware(15), (req, res) => {
  const rawUsername = req.body.username;
  const password = req.body.password;

  if (!rawUsername || typeof rawUsername !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Valid username and password required' });
  }

  const username = sanitizeText(rawUsername, 20);
  if (username.length < 3 || !/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Call-sign must be 3-20 characters (letters, numbers, underscores only)' });
  }
  if (password.length < 4 || password.length > 100) {
    return res.status(400).json({ error: 'Password must be between 4 and 100 characters' });
  }

  const db = loadData();
  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: 'Call-sign already registered. Please choose another.' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const newUser = {
    id: 'user_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    username,
    password: hashedPassword,
    coins: 1000.00 // Default welcome coins
  };

  db.users.push(newUser);
  saveData(db);

  const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: newUser.id, username: newUser.username, coins: newUser.coins } });
});

app.post('/api/login', rateLimitMiddleware(20), (req, res) => {
  const rawUsername = req.body.username;
  const password = req.body.password;

  if (!rawUsername || !password || typeof rawUsername !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Valid username and password required' });
  }

  const username = sanitizeText(rawUsername, 20);
  const db = loadData();
  const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, coins: user.coins } });
});

app.get('/api/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = loadData();
    const user = db.users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ user: { id: user.id, username: user.username, coins: user.coins } });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
});

app.post('/api/add-coins', rateLimitMiddleware(10), (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET);
    const amount = parseFloat(req.body.amount);
    if (isNaN(amount) || amount <= 0 || amount > 5000 || !isFinite(amount)) {
      return res.status(400).json({ error: 'Invalid coin amount' });
    }

    const db = loadData();
    const user = db.users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.coins = parseFloat((user.coins + amount).toFixed(2));
    user.transactions = user.transactions || [];
    user.transactions.unshift({
      id: 'tx_bonus_' + Date.now(),
      type: 'deposit',
      amount,
      method: 'Bonus Faucet',
      status: 'Completed',
      timestamp: new Date().toISOString()
    });
    if (user.transactions.length > 50) user.transactions = user.transactions.slice(0, 50);
    saveData(db);

    // Update any connected sockets
    for (let [id, s] of io.sockets.sockets) {
      if (s.userId === user.id) {
        s.coins = user.coins;
        s.emit('balance_update', user.coins);
      }
    }

    res.json({ success: true, coins: user.coins });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Deposit API with rigorous bounds checking & sanitization
app.post('/api/deposit', rateLimitMiddleware(15), (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET);
    const amount = parseFloat(req.body.amount);
    const method = sanitizeText(req.body.method || 'Credit Card / UPI', 30);

    if (isNaN(amount) || amount < 10 || amount > 100000 || !isFinite(amount)) {
      return res.status(400).json({ error: 'Deposit amount must be between 10 and 100,000 coins' });
    }

    const db = loadData();
    const user = db.users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.coins = parseFloat((user.coins + amount).toFixed(2));
    user.transactions = user.transactions || [];
    const tx = {
      id: 'dep_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      type: 'deposit',
      amount,
      method,
      status: 'Completed',
      timestamp: new Date().toISOString()
    };
    user.transactions.unshift(tx);
    if (user.transactions.length > 50) user.transactions = user.transactions.slice(0, 50);

    saveData(db);

    // Update active sockets
    for (let [id, s] of io.sockets.sockets) {
      if (s.userId === user.id) {
        s.coins = user.coins;
        s.emit('balance_update', user.coins);
      }
    }

    res.json({ success: true, coins: user.coins, transaction: tx });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
});

// Withdrawal API with strict validation
app.post('/api/withdraw', rateLimitMiddleware(15), (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET);
    const amount = parseFloat(req.body.amount);
    const method = sanitizeText(req.body.method || 'Bank Transfer', 30);
    const accountDetails = sanitizeText(req.body.accountDetails || 'Default Account', 60);

    if (isNaN(amount) || amount < 20 || amount > 100000 || !isFinite(amount)) {
      return res.status(400).json({ error: 'Minimum withdrawal is 20 coins' });
    }

    const db = loadData();
    const user = db.users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.coins < amount) {
      return res.status(400).json({ error: `Insufficient balance. Available: ${user.coins} coins` });
    }

    user.coins = parseFloat((user.coins - amount).toFixed(2));
    user.transactions = user.transactions || [];
    const tx = {
      id: 'wd_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      type: 'withdrawal',
      amount,
      method,
      accountDetails,
      status: 'Completed',
      timestamp: new Date().toISOString()
    };
    user.transactions.unshift(tx);
    if (user.transactions.length > 50) user.transactions = user.transactions.slice(0, 50);

    saveData(db);

    // Update active sockets
    for (let [id, s] of io.sockets.sockets) {
      if (s.userId === user.id) {
        s.coins = user.coins;
        s.emit('balance_update', user.coins);
      }
    }

    res.json({ success: true, coins: user.coins, transaction: tx });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
});

// Transactions History API
app.get('/api/transactions', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = loadData();
    const user = db.users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ transactions: user.transactions || [] });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session' });
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
let multiplierHistory = [
  1.24, 2.85, 1.05, 7.42, 1.95, 14.20, 1.12, 3.40,
  1.01, 5.60, 1.54, 2.10, 1.18, 22.80, 1.35, 1.88,
  3.15, 1.08, 4.75, 1.42, 8.90, 1.25, 2.45, 1.62
];
let activeBets = []; // { id, socketId, userId, username, panelId, amount, autoCashout, cashedOut, winAmount, cashoutMultiplier, isBot }

// Simulated community bot pilots for rich real-time multiplayer activity
const BOT_NAMES = [
  'Capt_Jack', 'SkyQueen_7', 'AeroLucky', 'ApexPilot', 'RedBaron_X',
  'StarGazer', 'Maverick_99', 'TopGunner', 'FlightMaster', 'Viper_21',
  'FalconEye', 'ShadowPilot', 'ThunderBolt', 'SonicDash', 'AeroBlade',
  'CloudRacer', 'LuckyStrike', 'SkyWalker_9', 'AlphaJet', 'VectorPro'
];

function generateSimulatedBets() {
  const count = Math.floor(Math.random() * 6) + 8; // 8 to 13 bots
  const shuffled = [...BOT_NAMES].sort(() => 0.5 - Math.random());
  const selected = shuffled.slice(0, count);
  const possibleAmounts = [20, 50, 100, 150, 200, 300, 500];

  return selected.map((name, idx) => {
    const amount = possibleAmounts[Math.floor(Math.random() * possibleAmounts.length)];
    // realistic target cashouts: some low risk (1.20-1.80), some mid (2.0-4.0), some high (5.0-15.0)
    let autoCashout;
    const r = Math.random();
    if (r < 0.45) {
      autoCashout = parseFloat((1.15 + Math.random() * 0.75).toFixed(2));
    } else if (r < 0.8) {
      autoCashout = parseFloat((2.0 + Math.random() * 2.5).toFixed(2));
    } else {
      autoCashout = parseFloat((5.0 + Math.random() * 8.0).toFixed(2));
    }

    return {
      id: 'bot_' + idx + '_' + Date.now(),
      socketId: null,
      userId: 'bot_' + idx,
      username: name,
      panelId: 'default',
      amount,
      autoCashout,
      cashedOut: false,
      winAmount: 0,
      cashoutMultiplier: null,
      isBot: true
    };
  });
}

function getPublicBetsList() {
  return activeBets.map(b => ({
    id: b.id,
    userId: b.userId,
    username: b.username,
    amount: b.amount,
    cashedOut: b.cashedOut,
    cashoutMultiplier: b.cashoutMultiplier,
    winAmount: b.winAmount,
    isBot: !!b.isBot
  }));
}

function generateCrashPoint() {
  // Cryptographically secure RNG using crypto.randomBytes to prevent hacker prediction
  const buf = crypto.randomBytes(4);
  const val = buf.readUInt32BE(0) / 0xFFFFFFFF;
  // 4% House edge instant crash
  if (val < 0.04) return 1.00;
  const h = Math.floor(val * 100);
  const r = (100 - 3) / Math.max(100 - h, 0.01);
  return Math.max(1.01, parseFloat(r.toFixed(2)));
}

function startWaitingPhase() {
  currentState = GAME_STATE.WAITING;
  currentMultiplier = 1.00;
  crashPoint = generateCrashPoint();
  waitTimeLeft = 5;
  activeBets = generateSimulatedBets();

  io.emit('game_state', {
    state: currentState,
    time: waitTimeLeft,
    waitTimeLeft,
    history: multiplierHistory.slice(-28)
  });
  io.emit('round_bets_update', getPublicBetsList());

  const waitInterval = setInterval(() => {
    waitTimeLeft--;
    io.emit('wait_tick', { waitTimeLeft });
    io.emit('game_state', {
      state: 'WAITING',
      time: waitTimeLeft,
      waitTimeLeft,
      history: multiplierHistory.slice(-28)
    });

    if (waitTimeLeft <= 0) {
      clearInterval(waitInterval);
      startFlyingPhase();
    }
  }, 1000);
}

function startFlyingPhase() {
  currentState = GAME_STATE.FLYING;
  const startTime = Date.now();

  io.emit('game_state', { state: 'RUNNING', multiplier: 1.00 });
  io.emit('game_state', { state: 'FLYING', multiplier: 1.00 });
  io.emit('round_bets_update', getPublicBetsList());

  const flyInterval = setInterval(() => {
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    // Exponential growth curve: ~0.065 factor
    currentMultiplier = parseFloat(Math.pow(Math.E, 0.065 * elapsedSeconds).toFixed(2));

    // Handle Auto Cashouts for both real users and bot pilots
    let hasCashout = false;
    activeBets.forEach(bet => {
      if (!bet.cashedOut && bet.autoCashout && currentMultiplier >= bet.autoCashout) {
        if (bet.isBot) {
          bet.cashedOut = true;
          bet.cashoutMultiplier = currentMultiplier;
          bet.winAmount = parseFloat((bet.amount * currentMultiplier).toFixed(2));
          hasCashout = true;
          io.emit('player_cashed_out', {
            id: bet.id,
            username: bet.username,
            amount: bet.amount,
            multiplier: currentMultiplier,
            winAmount: bet.winAmount,
            userId: bet.userId,
            isBot: true
          });
        } else {
          cashOutBet(bet.userId, bet.panelId, currentMultiplier);
          hasCashout = true;
        }
      }
    });

    if (hasCashout) {
      io.emit('round_bets_update', getPublicBetsList());
    }

    if (currentMultiplier >= crashPoint) {
      clearInterval(flyInterval);
      startCrashPhase();
    } else {
      io.emit('multiplier_tick', { multiplier: currentMultiplier });
      io.emit('multiplier_update', currentMultiplier);
    }
  }, 70);
}

function startCrashPhase() {
  currentState = GAME_STATE.CRASHED;
  multiplierHistory.push(currentMultiplier);
  if (multiplierHistory.length > 40) multiplierHistory.shift();

  // Mark all un-cashed bets as crashed
  activeBets.forEach(bet => {
    if (!bet.cashedOut) {
      bet.cashedOut = false;
      bet.crashed = true;
    }
  });

  io.emit('game_crashed', {
    multiplier: currentMultiplier,
    crashPoint: currentMultiplier,
    history: multiplierHistory.slice(-28)
  });
  io.emit('game_state', {
    state: 'CRASHED',
    multiplier: currentMultiplier,
    crashPoint: currentMultiplier,
    history: multiplierHistory.slice(-28)
  });
  io.emit('round_bets_update', getPublicBetsList());

  setTimeout(() => {
    startWaitingPhase();
  }, 2500);
}

function cashOutBet(userId, panelId, multiplier) {
  // Concurrency lock against race conditions / double-spending
  const bet = activeBets.find(b => b.userId === userId && b.panelId === panelId && !b.cashedOut && !b.cashingOut);
  if (!bet || currentState !== GAME_STATE.FLYING) return null;

  bet.cashingOut = true;
  bet.cashedOut = true;
  bet.cashoutMultiplier = multiplier;
  const winAmount = parseFloat((bet.amount * multiplier).toFixed(2));
  bet.winAmount = winAmount;

  let newBalance = 0;
  if (bet.isGuest) {
    bet.socket.coins = parseFloat((bet.socket.coins + winAmount).toFixed(2));
    newBalance = bet.socket.coins;
  } else {
    // Credit database atomically
    const db = loadData();
    const user = db.users.find(u => u.id === userId);
    if (user) {
      user.coins = parseFloat((user.coins + winAmount).toFixed(2));
      saveData(db);
      newBalance = user.coins;
    }
  }

  io.to(bet.socketId).emit('bet_cashed_out', {
    panelId: bet.panelId,
    winAmount,
    multiplier,
    newBalance
  });
  io.to(bet.socketId).emit('cash_out_success', {
    panelId: bet.panelId,
    winAmount,
    multiplier,
    newBalance
  });
  io.to(bet.socketId).emit('balance_update', newBalance);

  io.emit('player_cashed_out', {
    id: bet.id,
    username: bet.username,
    amount: bet.amount,
    multiplier,
    winAmount,
    userId: bet.userId,
    isBot: false
  });
  io.emit('round_bets_update', getPublicBetsList());

  return winAmount;
}

// Socket Connection Handler
io.on('connection', (socket) => {
  socket.coins = 1000.00;
  socket.lastActionSec = 0;
  socket.actionCount = 0;

  // Socket flood protection
  function isRateLimited() {
    const now = Math.floor(Date.now() / 1000);
    if (socket.lastActionSec !== now) {
      socket.lastActionSec = now;
      socket.actionCount = 1;
      return false;
    }
    socket.actionCount++;
    return socket.actionCount > 10; // Max 10 socket requests per second
  }

  socket.emit('balance_update', socket.coins);

  socket.emit('init_game', {
    state: currentState,
    multiplier: currentMultiplier,
    waitTimeLeft,
    time: waitTimeLeft,
    history: multiplierHistory.slice(-28)
  });
  socket.emit('round_bets_update', getPublicBetsList());

  if (currentState === GAME_STATE.WAITING) {
    socket.emit('game_state', {
      state: 'WAITING',
      time: waitTimeLeft,
      waitTimeLeft,
      history: multiplierHistory.slice(-28)
    });
  } else if (currentState === GAME_STATE.FLYING) {
    socket.emit('game_state', {
      state: 'RUNNING',
      multiplier: currentMultiplier
    });
  } else if (currentState === GAME_STATE.CRASHED) {
    socket.emit('game_state', {
      state: 'CRASHED',
      multiplier: currentMultiplier,
      crashPoint: currentMultiplier,
      history: multiplierHistory.slice(-28)
    });
  }

  socket.on('authenticate', (data) => {
    if (!data || !data.token || typeof data.token !== 'string') return;
    try {
      const decoded = jwt.verify(data.token, JWT_SECRET);
      const db = loadData();
      const user = db.users.find(u => u.id === decoded.id);
      if (user) {
        socket.userId = user.id;
        socket.username = user.username;
        socket.token = data.token;
        socket.coins = user.coins;
        socket.emit('auth_success', { user: { id: user.id, username: user.username, coins: user.coins } });
        socket.emit('balance_update', user.coins);
      }
    } catch (e) {
      socket.emit('auth_error', { message: 'Authentication session expired' });
    }
  });

  socket.on('place_bet', (data) => {
    if (isRateLimited()) {
      return socket.emit('error_msg', { message: 'Rate limit exceeded. Please slow down.' });
    }

    if (currentState !== GAME_STATE.WAITING || waitTimeLeft <= 0.35) {
      return socket.emit('error_msg', { message: 'Can only bet during wait phase before take-off' });
    }

    const token = (data && data.token) || socket.token;
    const panelId = sanitizeText((data && data.panelId) || 'default', 16);
    let autoCashout = (data && data.autoCashout) ? parseFloat(data.autoCashout) : null;
    if (autoCashout !== null && (isNaN(autoCashout) || autoCashout < 1.05 || autoCashout > 200 || !isFinite(autoCashout))) {
      autoCashout = null;
    }

    const parsedAmount = typeof data === 'object' ? parseFloat(data.amount) : parseFloat(data);

    if (isNaN(parsedAmount) || parsedAmount < 10 || parsedAmount > 10000 || !isFinite(parsedAmount)) {
      return socket.emit('error_msg', { message: 'Bet amount must be between 10 and 10,000 coins' });
    }

    // Check if user is authenticated
    let user = null;
    let db = null;
    if (token || socket.userId) {
      try {
        db = loadData();
        if (token) {
          const decoded = jwt.verify(token, JWT_SECRET);
          user = db.users.find(u => u.id === decoded.id);
        } else if (socket.userId) {
          user = db.users.find(u => u.id === socket.userId);
        }
      } catch (e) {}
    }

    if (user) {
      if (user.coins < parsedAmount) {
        return socket.emit('error_msg', { message: 'Insufficient balance' });
      }

      const existing = activeBets.find(b => b.userId === user.id && b.panelId === panelId && !b.cashedOut);
      if (existing) return socket.emit('error_msg', { message: 'Bet already placed for this round' });

      user.coins = parseFloat((user.coins - parsedAmount).toFixed(2));
      saveData(db);
      socket.coins = user.coins;

      const betObj = {
        id: 'usr_' + user.id + '_' + Date.now(),
        socketId: socket.id,
        socket,
        isGuest: false,
        userId: user.id,
        username: user.username,
        panelId,
        amount: parsedAmount,
        autoCashout,
        cashedOut: false,
        cashingOut: false,
        winAmount: 0,
        cashoutMultiplier: null,
        isBot: false
      };
      // Put user bet at the top of activeBets
      activeBets.unshift(betObj);

      socket.emit('bet_confirmed', { panelId, amount: parsedAmount, newBalance: user.coins });
      socket.emit('balance_update', user.coins);
      io.emit('new_live_bet', { username: user.username, amount: parsedAmount });
      io.emit('round_bets_update', getPublicBetsList());
      return;
    }

    // Guest bet handling
    if (parsedAmount > socket.coins) {
      return socket.emit('error_msg', { message: 'Insufficient balance' });
    }
    const existing = activeBets.find(b => b.socketId === socket.id && !b.cashedOut);
    if (existing) return socket.emit('error_msg', { message: 'Bet already placed for this round' });

    socket.coins = parseFloat((socket.coins - parsedAmount).toFixed(2));

    const betObj = {
      id: 'gst_' + socket.id + '_' + Date.now(),
      socketId: socket.id,
      socket,
      isGuest: true,
      userId: socket.id,
      username: 'Guest_' + socket.id.substring(0, 4),
      panelId,
      amount: parsedAmount,
      autoCashout,
      cashedOut: false,
      cashingOut: false,
      winAmount: 0,
      cashoutMultiplier: null,
      isBot: false
    };
    activeBets.unshift(betObj);

    socket.emit('bet_confirmed', { panelId: betObj.panelId, amount: parsedAmount, newBalance: socket.coins });
    socket.emit('balance_update', socket.coins);
    io.emit('new_live_bet', { username: betObj.username, amount: parsedAmount });
    io.emit('round_bets_update', getPublicBetsList());
  });

  socket.on('cash_out', (data) => {
    if (isRateLimited()) return;
    const token = (data && data.token) || socket.token;
    const panelId = sanitizeText((data && data.panelId) || 'default', 16);
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        cashOutBet(decoded.id, panelId, currentMultiplier);
        return;
      } catch (e) {}
    }
    if (socket.userId) {
      cashOutBet(socket.userId, panelId, currentMultiplier);
      return;
    }
    const bet = activeBets.find(b => b.socketId === socket.id && !b.cashedOut);
    if (bet) {
      cashOutBet(bet.userId, bet.panelId, currentMultiplier);
    }
  });
});

startWaitingPhase();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Avion server running on port ${PORT}`);
});
  
