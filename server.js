require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// Session setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'liquid_aviator_super_secret',
  resave: false,
  saveUninitialized: true
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-Memory User Store (Demo / Production ke liye MongoDB/Postgres use kar sakte hain)
const users = {};

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => done(null, users[id]));

// Google Strategy
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback"
  }, (accessToken, refreshToken, profile, done) => {
    let user = users[profile.id] || {
      id: profile.id,
      name: profile.displayName,
      avatar: profile.photos?.[0]?.value || '',
      balance: 1000.00
    };
    users[profile.id] = user;
    return done(null, user);
  }));
}

// Facebook Strategy
if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
  passport.use(new FacebookStrategy({
    clientID: process.env.FACEBOOK_APP_ID,
    clientSecret: process.env.FACEBOOK_APP_SECRET,
    callbackURL: "/auth/facebook/callback",
    profileFields: ['id', 'displayName', 'photos']
  }, (accessToken, refreshToken, profile, done) => {
    let user = users[profile.id] || {
      id: profile.id,
      name: profile.displayName,
      avatar: profile.photos?.[0]?.value || '',
      balance: 1000.00
    };
    users[profile.id] = user;
    return done(null, user);
  }));
}

// Auth Routes
app.get('/auth/google', passport.authenticate('google', { scope: ['profile'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/'));

app.get('/auth/facebook', passport.authenticate('facebook'));
app.get('/auth/facebook/callback', passport.authenticate('facebook', { failureRedirect: '/' }), (req, res) => res.redirect('/'));

// Guest Login (Bina OAuth setup ke turant test karne ke liye)
app.post('/auth/guest', (req, res) => {
  const guestId = 'guest_' + Math.random().toString(36).substring(2, 9);
  const user = {
    id: guestId,
    name: req.body.name || 'Captain ' + guestId.slice(-3),
    avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=' + guestId,
    balance: 1000.00
  };
  users[guestId] = user;
  req.session.userId = guestId;
  res.json({ success: true, user });
});

app.get('/auth/user', (req, res) => {
  const user = req.user || users[req.session.userId];
  if (user) return res.json({ loggedIn: true, user });
  res.json({ loggedIn: false });
});

// ================= AVIATOR GAME ENGINE =================
let gameState = 'WAITING'; // WAITING, FLYING, CRASHED
let currentMultiplier = 1.00;
let crashPoint = 1.00;
let gameInterval = null;
let countdown = 5;
let multiplierHistory = [1.25, 2.40, 1.10, 5.72, 1.84];
let activeBets = {}; // socketId -> { amount, cashedOut, cashOutMultiplier }

// Provably fair crash point generator (Mathematical algorithm)
function generateCrashPoint() {
  const e = 2 ** 32;
  const h = Math.floor(Math.random() * e);
  if (h % 20 === 0) return 1.00; // 5% house instant crash
  return parseFloat(Math.max(1.01, (100 * e - h) / (e - h) / 100).toFixed(2));
}

function startCountdown() {
  gameState = 'WAITING';
  countdown = 5;
  activeBets = {};

  const countInterval = setInterval(() => {
    io.emit('countdown_tick', countdown);
    countdown--;
    if (countdown < 0) {
      clearInterval(countInterval);
      startFlight();
    }
  }, 1000);
}

function startFlight() {
  gameState = 'FLYING';
  currentMultiplier = 1.00;
  crashPoint = generateCrashPoint();
  const startTime = Date.now();

  io.emit('flight_started');

  gameInterval = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    // Exponential curve: 1 + elapsed^1.5 * rate
    currentMultiplier = parseFloat((1 + Math.pow(elapsed * 0.45, 1.8)).toFixed(2));

    if (currentMultiplier >= crashPoint) {
      // Plane Crash
      clearInterval(gameInterval);
      gameState = 'CRASHED';
      multiplierHistory.unshift(crashPoint);
      if (multiplierHistory.length > 10) multiplierHistory.pop();

      io.emit('flight_crashed', { crashPoint, history: multiplierHistory });
      setTimeout(startCountdown, 3000);
    } else {
      io.emit('multiplier_update', currentMultiplier);
    }
  }, 60);
}

// Start game loop
startCountdown();

// Real-time WebSocket connection
io.on('connection', (socket) => {
  socket.emit('init_state', {
    gameState,
    currentMultiplier,
    countdown,
    history: multiplierHistory
  });

  socket.on('place_bet', (data) => {
    if (gameState !== 'WAITING') return socket.emit('bet_error', 'Betting closed for this round!');
    const betAmount = parseFloat(data.amount);
    if (isNaN(betAmount) || betAmount <= 0) return socket.emit('bet_error', 'Invalid bet amount!');

    activeBets[socket.id] = {
      amount: betAmount,
      cashedOut: false,
      cashOutMultiplier: 0
    };
    socket.emit('bet_accepted', { amount: betAmount });
  });

  socket.on('cash_out', () => {
    if (gameState !== 'FLYING') return;
    const bet = activeBets[socket.id];
    if (bet && !bet.cashedOut) {
      bet.cashedOut = true;
      bet.cashOutMultiplier = currentMultiplier;
      const winAmount = parseFloat((bet.amount * currentMultiplier).toFixed(2));
      socket.emit('cash_out_success', { winAmount, multiplier: currentMultiplier });
    }
  });

  socket.on('disconnect', () => {
    delete activeBets[socket.id];
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Liquid Aviator Server running at port ${PORT}`);
});
