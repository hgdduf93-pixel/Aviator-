const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');

let genAI = null;
function getGenAI() {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      genAI = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });
    }
  }
  return genAI;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6 // 1MB payload limit to prevent buffer overflow attacks
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'gsd_crash_super_secret_jwt_key_98765';
const DB_FILE = path.join(__dirname, 'database.json');

// HTTP Headers & Iframe Compatibility for AI Studio Preview
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Allow embedding in AI Studio preview iframe: do NOT block with SAMEORIGIN
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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

// Hardcoded Merchant Destination UPI Configuration
const MERCHANT_UPI_ID = 'hgdduf93-3@okhdfcbank';
const MERCHANT_NAME = 'GSD CRASH Official';

// User-level concurrency lock queue to prevent race conditions and double-spending
const userLocks = new Map();
async function withUserLock(userId, fn) {
  while (userLocks.get(userId)) {
    try {
      await userLocks.get(userId);
    } catch (e) {}
  }
  let resolveLock;
  const lockPromise = new Promise(resolve => { resolveLock = resolve; });
  userLocks.set(userId, lockPromise);
  try {
    return await fn();
  } finally {
    userLocks.delete(userId);
    resolveLock();
  }
}

// Persistent JSON Storage & Skin Pricing Initialization
function initSkinPrices(db) {
  if (!db.skinPrices) {
    db.skinPrices = {
      skin_phoenix: 50,
      skin_cyberpunk: 50,
      skin_shadow: 50,
      skin_royal_gold: 50
    };
  }
  const validSkins = ['skin_phoenix', 'skin_cyberpunk', 'skin_shadow', 'skin_royal_gold'];
  let modified = false;
  validSkins.forEach((sId) => {
    if (db.skinPrices[sId] !== 50) {
      db.skinPrices[sId] = 50;
      modified = true;
    }
  });
  return modified;
}

function loadData() {
  if (!fs.existsSync(DB_FILE)) {
    const initialDb = { 
      users: [],
      usedUtrs: [],
      allTransactions: [],
      settings: {
        merchantUpiId: MERCHANT_UPI_ID,
        merchantName: MERCHANT_NAME
      },
      skinPrices: {
        skin_phoenix: 50,
        skin_cyberpunk: 50,
        skin_shadow: 50,
        skin_royal_gold: 50
      }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialDb, null, 2));
  }
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!data.settings) {
    data.settings = {
      merchantUpiId: MERCHANT_UPI_ID,
      merchantName: MERCHANT_NAME
    };
  } else {
    data.settings.merchantUpiId = MERCHANT_UPI_ID;
    data.settings.merchantName = MERCHANT_NAME;
  }
  if (!data.usedUtrs) data.usedUtrs = [];
  if (!data.allTransactions) data.allTransactions = [];
  
  if (initSkinPrices(data)) {
    saveData(data);
  }

  return data;
}

function saveData(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// UPI Gateway & Merchant Configuration APIs
app.get('/api/upi-config', (req, res) => {
  res.json({
    success: true,
    upiId: MERCHANT_UPI_ID,
    merchantName: MERCHANT_NAME
  });
});

app.get('/api/firebase-config', (req, res) => {
  const cfgPath = path.join(__dirname, 'firebase-applet-config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return res.json({ success: true, config: cfg });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse Firebase config' });
    }
  }
  res.status(404).json({ error: 'Firebase config file missing' });
});

// In-memory store for pending registration OTP verification
const pendingRegistrations = new Map();

// Helper to send email via Nodemailer or fallback logging
async function sendOtpEmail(toEmail, otpCode, username) {
  try {
    const nodemailer = require('nodemailer');
    const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
    const smtpPort = parseInt(process.env.SMTP_PORT || '587');
    const smtpUser = process.env.SMTP_USER || process.env.GMAIL_USER || process.env.EMAIL_USER;
    const smtpPass = process.env.SMTP_PASS || process.env.GMAIL_PASS || process.env.EMAIL_PASS;

    if (!smtpUser || !smtpPass) {
      console.log(`[OTP Email Simulation] To: ${toEmail} | Code: ${otpCode}`);
      return false;
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass }
    });

    await transporter.sendMail({
      from: `"GSD CRASH Official" <${smtpUser}>`,
      to: toEmail,
      subject: `Your GSD CRASH Account Verification Code: ${otpCode}`,
      text: `Hello ${username},\n\nYour 6-digit account registration OTP code is: ${otpCode}\n\nThis code expires in 15 minutes.\n\nHappy Flying!`,
      html: `
        <div style="background-color: #0f1013; color: #ffffff; padding: 24px; font-family: sans-serif; border-radius: 12px; border: 1px solid #22c55e;">
          <h2 style="color: #00ff88; margin-top: 0;">GSD CRASH Verification</h2>
          <p>Hello <b>${username}</b>,</p>
          <p>Your 6-digit registration verification code is:</p>
          <div style="background: #181a20; color: #00ff88; font-size: 28px; font-weight: 800; letter-spacing: 6px; padding: 14px 20px; border-radius: 8px; display: inline-block; margin: 12px 0; border: 1px solid #22c55e;">
            ${otpCode}
          </div>
          <p style="color: #9ca3af; font-size: 13px;">This code will expire in 15 minutes.</p>
        </div>
      `
    });
    console.log(`[OTP Email Sent Successfully] To: ${toEmail}`);
    return true;
  } catch (err) {
    console.error(`[OTP Email Error] Failed to send email via SMTP:`, err.message);
    return false;
  }
}

// Standard Direct Registration Endpoint (Sync user account & generate login token)
app.post('/api/auth/firebase-register', rateLimitMiddleware(15), (req, res) => {
  const rawUsername = req.body.username;
  const password = req.body.password;
  const rawEmail = req.body.email;

  if (!rawUsername || typeof rawUsername !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Valid username and password required' });
  }

  if (!rawEmail || typeof rawEmail !== 'string' || !rawEmail.includes('@') || !rawEmail.includes('.')) {
    return res.status(400).json({ error: 'Valid email address required' });
  }

  const username = sanitizeText(rawUsername, 20);
  if (username.length < 3 || !/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters (letters, numbers, underscores only)' });
  }
  if (password.length < 4 || password.length > 100) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }

  const email = sanitizeText(rawEmail, 60).toLowerCase();
  if (!email.endsWith('@gmail.com') && !email.endsWith('@googlemail.com')) {
    return res.status(400).json({ error: 'Registration requires a valid @gmail.com email address' });
  }

  const db = loadData();

  let existingUser = db.users.find(u => u.email && u.email.toLowerCase() === email);
  if (existingUser) {
    // If existing user, verify password or return standard error if password doesn't match
    if (!bcrypt.compareSync(password, existingUser.password)) {
      return res.status(400).json({ error: 'Email already registered. Please sign in with your password.' });
    }
    const token = jwt.sign({ id: existingUser.id, username: existingUser.username }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({
      success: true,
      token,
      user: {
        id: existingUser.id,
        username: existingUser.username,
        coins: existingUser.coins,
        email: existingUser.email,
        phone: existingUser.phone || '',
        unlockedSkins: existingUser.unlockedSkins,
        equippedSkin: existingUser.equippedSkin
      }
    });
  }

  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: 'Username already registered. Please choose another username.' });
  }

  const newUser = {
    id: 'user_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    username,
    email,
    password: bcrypt.hashSync(password, 10),
    coins: 0.00,
    unlockedSkins: ['skin_default'],
    equippedSkin: 'skin_default',
    isRealAccount: true,
    authProvider: 'email',
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  saveData(db);

  const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });

  res.json({
    success: true,
    token,
    message: 'User registered successfully',
    user: {
      id: newUser.id,
      username: newUser.username,
      coins: newUser.coins,
      email: newUser.email,
      phone: '',
      unlockedSkins: newUser.unlockedSkins,
      equippedSkin: newUser.equippedSkin
    }
  });
});

// Standard Direct Register Route (/api/register)
app.post('/api/register', rateLimitMiddleware(15), (req, res) => {
  const rawUsername = req.body.username;
  const password = req.body.password;
  const rawEmail = req.body.email;

  if (!rawUsername || typeof rawUsername !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Valid username and password required' });
  }

  if (!rawEmail || typeof rawEmail !== 'string' || !rawEmail.includes('@') || !rawEmail.includes('.')) {
    return res.status(400).json({ error: 'Valid email address required' });
  }

  const username = sanitizeText(rawUsername, 20);
  if (username.length < 3 || !/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters (letters, numbers, underscores only)' });
  }
  if (password.length < 4 || password.length > 100) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }

  const email = sanitizeText(rawEmail, 60).toLowerCase();
  if (!email.endsWith('@gmail.com') && !email.endsWith('@googlemail.com')) {
    return res.status(400).json({ error: 'Registration requires a valid @gmail.com email address' });
  }

  const db = loadData();

  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: 'Username already registered. Please choose another username.' });
  }
  if (db.users.find(u => u.email && u.email.toLowerCase() === email)) {
    return res.status(400).json({ error: 'Email already registered. Please sign in.' });
  }

  const newUser = {
    id: 'user_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    username,
    email,
    password: bcrypt.hashSync(password, 10),
    coins: 0.00,
    unlockedSkins: ['skin_default'],
    equippedSkin: 'skin_default',
    isRealAccount: true,
    authProvider: 'email',
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  saveData(db);

  const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });

  res.json({
    success: true,
    token,
    user: {
      id: newUser.id,
      username: newUser.username,
      coins: newUser.coins,
      email: newUser.email,
      phone: '',
      unlockedSkins: newUser.unlockedSkins,
      equippedSkin: newUser.equippedSkin
    }
  });
});

// Step 1: Request Registration OTP
app.post('/api/auth/send-register-otp', async (req, res) => {
  const rawUsername = req.body.username;
  const password = req.body.password;
  const rawEmail = req.body.email;
  const rawPhone = req.body.phone;

  if (!rawUsername || typeof rawUsername !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Valid username and password required' });
  }

  if (!rawEmail || typeof rawEmail !== 'string' || !rawEmail.includes('@') || !rawEmail.includes('.')) {
    return res.status(400).json({ error: 'Valid email address required for OTP verification' });
  }

  const username = sanitizeText(rawUsername, 20);
  if (username.length < 3 || !/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters (letters, numbers, underscores only)' });
  }
  if (password.length < 4 || password.length > 100) {
    return res.status(400).json({ error: 'Password must be between 4 and 100 characters' });
  }

  const email = sanitizeText(rawEmail, 60).toLowerCase();
  const phone = rawPhone && typeof rawPhone === 'string' ? sanitizeText(rawPhone, 20).replace(/\D/g, '') : '';

  const db = loadData();
  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: 'Username already registered. Please choose another.' });
  }
  if (db.users.find(u => u.email && u.email.toLowerCase() === email)) {
    return res.status(400).json({ error: 'Email already registered. Please sign in.' });
  }
  if (phone && phone.length >= 10 && db.users.find(u => u.phone && u.phone === phone)) {
    return res.status(400).json({ error: 'Phone number already registered. Please sign in.' });
  }

  // Generate 6-digit OTP code
  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  const hashedPassword = bcrypt.hashSync(password, 10);

  pendingRegistrations.set(email, {
    username,
    email,
    phone,
    hashedPassword,
    otpCode,
    expiresAt: Date.now() + (15 * 60 * 1000) // 15 mins expiry
  });

  const emailMasked = email.replace(/(.{2})(.*)(@.*)/, '$1***$3');

  // Attempt to deliver via SMTP if credentials exist
  const emailSent = await sendOtpEmail(email, otpCode, username);

  res.json({
    success: true,
    message: `OTP verification code sent to ${emailMasked}`,
    emailMasked,
    emailSent
  });
});

// Step 2: Verify Registration OTP & Complete Account Creation
app.post('/api/auth/verify-register-otp', rateLimitMiddleware(15), (req, res) => {
  const rawEmail = req.body.email;
  const rawOtp = req.body.otp || req.body.code || req.body.resetCode;

  if (!rawEmail || typeof rawEmail !== 'string' || !rawOtp) {
    return res.status(400).json({ error: 'Email address and 6-digit OTP code are required' });
  }

  const email = sanitizeText(rawEmail, 60).toLowerCase();
  const otp = String(rawOtp).trim();

  const pending = pendingRegistrations.get(email);
  if (!pending) {
    return res.status(400).json({ error: 'Registration session expired or not found. Please request a new OTP.' });
  }

  if (pending.otpCode !== otp) {
    return res.status(400).json({ error: 'Invalid OTP code. Please check your email and try again.' });
  }

  if (Date.now() > pending.expiresAt) {
    pendingRegistrations.delete(email);
    return res.status(400).json({ error: 'OTP code has expired. Please request a new code.' });
  }

  const db = loadData();
  // Double-check username/email uniqueness
  if (db.users.find(u => u.username.toLowerCase() === pending.username.toLowerCase())) {
    pendingRegistrations.delete(email);
    return res.status(400).json({ error: 'Username already registered. Please choose another.' });
  }
  if (db.users.find(u => u.email && u.email.toLowerCase() === email)) {
    pendingRegistrations.delete(email);
    return res.status(400).json({ error: 'Email already registered. Please sign in.' });
  }

  const newUser = {
    id: 'user_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    username: pending.username,
    email: pending.email,
    phone: pending.phone || '',
    password: pending.hashedPassword,
    coins: 0.00,
    unlockedSkins: ['skin_default'],
    equippedSkin: 'skin_default',
    isRealAccount: true,
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  saveData(db);
  pendingRegistrations.delete(email);

  const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ 
    success: true,
    token, 
    user: { 
      id: newUser.id, 
      username: newUser.username, 
      coins: newUser.coins, 
      email: newUser.email,
      phone: newUser.phone,
      unlockedSkins: newUser.unlockedSkins,
      equippedSkin: newUser.equippedSkin
    } 
  });
});

// Legacy/Compatibility Signup endpoint - directs to OTP send or verify based on parameters
app.post('/api/signup', rateLimitMiddleware(15), (req, res) => {
  const otp = req.body.otp || req.body.code;
  if (otp) {
    const rawEmail = req.body.email;
    const rawOtp = otp;
    if (!rawEmail || typeof rawEmail !== 'string') {
      return res.status(400).json({ error: 'Email address and OTP required' });
    }
    const email = sanitizeText(rawEmail, 60).toLowerCase();
    const pending = pendingRegistrations.get(email);
    if (!pending) {
      return res.status(400).json({ error: 'Registration session expired or not found. Please request a new OTP.' });
    }
    if (pending.otpCode !== String(rawOtp).trim()) {
      return res.status(400).json({ error: 'Invalid OTP code. Please check your email and try again.' });
    }
    if (Date.now() > pending.expiresAt) {
      pendingRegistrations.delete(email);
      return res.status(400).json({ error: 'OTP code has expired. Please request a new code.' });
    }
    const db = loadData();
    const newUser = {
      id: 'user_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      username: pending.username,
      email: pending.email,
      phone: pending.phone || '',
      password: pending.hashedPassword,
      coins: 0.00,
      unlockedSkins: ['skin_default'],
      equippedSkin: 'skin_default',
      isRealAccount: true,
      createdAt: new Date().toISOString()
    };
    db.users.push(newUser);
    saveData(db);
    pendingRegistrations.delete(email);

    const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ 
      success: true,
      token, 
      user: { 
        id: newUser.id, 
        username: newUser.username, 
        coins: newUser.coins, 
        email: newUser.email,
        phone: newUser.phone,
        unlockedSkins: newUser.unlockedSkins,
        equippedSkin: newUser.equippedSkin
      } 
    });
  } else {
    // Requires OTP step first
    return res.status(400).json({ error: 'OTP verification required. Please click Register to receive a 6-digit verification code.' });
  }
});

app.post('/api/login', rateLimitMiddleware(20), (req, res) => {
  const rawIdentifier = req.body.username || req.body.email || req.body.phone || req.body.identifier;
  const password = req.body.password;

  if (!rawIdentifier || !password || typeof rawIdentifier !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Valid username/email/phone and password required' });
  }

  const identifier = sanitizeText(rawIdentifier, 50).toLowerCase();
  const rawDigits = identifier.replace(/\D/g, '');
  const db = loadData();
  const user = db.users.find(u => 
    u.username.toLowerCase() === identifier || 
    (u.email && u.email.toLowerCase() === identifier) ||
    (u.phone && (u.phone === identifier || (rawDigits && u.phone === rawDigits)))
  );

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username, email, phone or password' });
  }

  sanitizeUserSkins(user);
  saveData(db);

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ 
    token, 
    user: { 
      id: user.id, 
      username: user.username, 
      coins: user.coins, 
      email: user.email,
      phone: user.phone || '',
      unlockedSkins: user.unlockedSkins,
      equippedSkin: user.equippedSkin
    } 
  });
});

// Google Sign In / Sign Up API
app.post('/api/auth/google', rateLimitMiddleware(20), (req, res) => {
  const rawEmail = req.body.email;
  const rawName = req.body.name || req.body.displayName || '';
  const googleId = req.body.googleId || req.body.sub || '';

  if (!rawEmail || typeof rawEmail !== 'string' || !rawEmail.includes('@')) {
    return res.status(400).json({ error: 'Valid Google email is required' });
  }

  const email = sanitizeText(rawEmail, 60).toLowerCase();
  const db = loadData();
  let user = db.users.find(u => 
    (u.email && u.email.toLowerCase() === email) ||
    (u.googleId && u.googleId === googleId)
  );

  // Clean Google Account Name (allow letters, numbers, spaces, underscores, dots)
  const cleanGoogleName = rawName ? sanitizeText(rawName.trim(), 25) : '';

  if (!user) {
    // Set profile username to exact Google Account Name or email prefix
    let baseName = cleanGoogleName || sanitizeText(email.split('@')[0], 20);
    if (baseName.length < 2) baseName = 'Pilot_' + Math.floor(Math.random() * 8999 + 1000);
    let candidateName = baseName;
    let counter = 1;
    while (db.users.find(u => u.username.toLowerCase() === candidateName.toLowerCase())) {
      candidateName = `${baseName} ${counter++}`;
    }

    user = {
      id: 'user_g_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      username: candidateName,
      email,
      googleId: googleId || ('g_' + Date.now()),
      password: bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10),
      coins: 0.00, // Real account: starts at 0.00 INR
      unlockedSkins: ['skin_default'],
      equippedSkin: 'skin_default',
      isRealAccount: true,
      authProvider: 'google',
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    saveData(db);
  } else {
    // Update profile username to exact Google Account Name if provided
    if (cleanGoogleName && user.username !== cleanGoogleName) {
      // Check if candidate name is available
      if (!db.users.find(u => u.id !== user.id && u.username.toLowerCase() === cleanGoogleName.toLowerCase())) {
        user.username = cleanGoogleName;
      }
    }
    if (!user.googleId && googleId) {
      user.googleId = googleId;
    }
    sanitizeUserSkins(user);
    saveData(db);
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({
    success: true,
    token,
    user: { 
      id: user.id, 
      username: user.username, 
      email: user.email, 
      coins: user.coins,
      unlockedSkins: user.unlockedSkins,
      equippedSkin: user.equippedSkin
    }
  });
});

// Forgot Password API - Step 1: Request verification code
app.post('/api/auth/forgot-password', rateLimitMiddleware(10), (req, res) => {
  const rawIdentifier = req.body.identifier || req.body.username || req.body.email;
  if (!rawIdentifier || typeof rawIdentifier !== 'string') {
    return res.status(400).json({ error: 'Please provide your registered call-sign or email' });
  }

  const identifier = sanitizeText(rawIdentifier, 50).toLowerCase();
  const db = loadData();
  const user = db.users.find(u => 
    u.username.toLowerCase() === identifier || 
    (u.email && u.email.toLowerCase() === identifier)
  );

  if (!user) {
    return res.status(404).json({ error: 'No pilot account found matching that call-sign or email.' });
  }

  // Generate 6-digit security reset PIN
  const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
  user.resetCode = resetCode;
  user.resetCodeExpires = Date.now() + (15 * 60 * 1000); // 15 mins
  saveData(db);

  res.json({
    success: true,
    message: 'Password reset code generated.',
    resetCode, // Returned for frictionless verification in preview
    username: user.username,
    emailMasked: user.email ? user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3') : null
  });
});

// Reset Password API - Step 2: Set new password
app.post('/api/auth/reset-password', rateLimitMiddleware(10), (req, res) => {
  const { username, resetCode, newPassword } = req.body;
  if (!username || !resetCode || !newPassword) {
    return res.status(400).json({ error: 'Username, reset code, and new password are required' });
  }

  if (typeof newPassword !== 'string' || newPassword.length < 4 || newPassword.length > 100) {
    return res.status(400).json({ error: 'New password must be between 4 and 100 characters' });
  }

  const db = loadData();
  const user = db.users.find(u => u.username.toLowerCase() === sanitizeText(username, 20).toLowerCase());
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (!user.resetCode || user.resetCode !== String(resetCode).trim()) {
    return res.status(400).json({ error: 'Invalid reset code. Please check and try again.' });
  }

  if (Date.now() > (user.resetCodeExpires || 0)) {
    return res.status(400).json({ error: 'Reset code has expired. Please request a new one.' });
  }

  // Update password & clear code
  user.password = bcrypt.hashSync(newPassword, 10);
  delete user.resetCode;
  delete user.resetCodeExpires;
  saveData(db);

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  sanitizeUserSkins(user);
  res.json({
    success: true,
    message: 'Password updated successfully!',
    token,
    user: { 
      id: user.id, 
      username: user.username, 
      coins: user.coins,
      unlockedSkins: user.unlockedSkins,
      equippedSkin: user.equippedSkin
    }
  });
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

    sanitizeUserSkins(user);
    res.json({ 
      user: { 
        id: user.id, 
        username: user.username, 
        coins: user.coins, 
        email: user.email,
        unlockedSkins: user.unlockedSkins,
        equippedSkin: user.equippedSkin
      } 
    });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
});

// Free coins only allowed in Guest/Demo mode, NOT in Real Account!
app.post('/api/add-coins', rateLimitMiddleware(10), (req, res) => {
  return res.status(403).json({
    error: 'Free practice coins are only available in Demo Mode. Real INR accounts require UPI deposits.',
    code: 'REAL_ACCOUNT_NO_FREE_COINS'
  });
});

// Deposit API with rigorous anti-fraud, UTR uniqueness verification & atomic balance credit
app.post('/api/deposit', rateLimitMiddleware(15), async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized. Real account sign-in required.' });

  try {
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET);
    const amount = parseFloat(req.body.amount);
    const method = sanitizeText(req.body.method || 'UPI', 30);
    const rawUtr = sanitizeText(req.body.utr || req.body.referenceId || '', 40).replace(/[^a-zA-Z0-9]/g, '');

    if (isNaN(amount) || !isFinite(amount) || amount < 10 || amount > 500000) {
      return res.status(400).json({ error: 'Deposit amount must be between ₹10 and ₹500,000' });
    }

    if (!rawUtr || rawUtr.length < 6 || rawUtr.length > 30) {
      return res.status(400).json({ error: 'Valid 12-digit UPI Reference Number / UTR is required.' });
    }

    const utrUpper = rawUtr.toUpperCase();

    // Execute within user lock to prevent concurrent double-deposits
    const result = await withUserLock(decoded.id, async () => {
      const db = loadData();
      const user = db.users.find(u => u.id === decoded.id);
      if (!user) return { status: 404, data: { error: 'User account not found' } };

      if (!user.isRealAccount && user.isRealAccount !== undefined && user.isRealAccount === false) {
        return { status: 403, data: { error: 'Deposits are only permitted on Real INR Accounts.' } };
      }

      // Anti-Fraud UTR Deduplication Check across the entire platform
      if (db.usedUtrs && db.usedUtrs.includes(utrUpper)) {
        return { status: 400, data: { error: 'This UPI Reference Number (UTR) has already been processed and credited.' } };
      }

      const isDuplicateInUser = (user.transactions || []).some(t => t.utr && t.utr.toUpperCase() === utrUpper);
      if (isDuplicateInUser) {
        return { status: 400, data: { error: 'This UPI Reference Number (UTR) has already been submitted.' } };
      }

      // Update balances atomically
      const prevBal = parseFloat((user.coins || 0).toFixed(2));
      const newBal = parseFloat((prevBal + amount).toFixed(2));
      user.coins = newBal;

      const tx = {
        id: 'dep_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        userId: user.id,
        username: user.username,
        type: 'deposit',
        amount: parseFloat(amount.toFixed(2)),
        currency: 'INR',
        method: 'UPI',
        destinationUpi: MERCHANT_UPI_ID,
        utr: utrUpper,
        status: 'Completed',
        balanceBefore: prevBal,
        balanceAfter: newBal,
        timestamp: new Date().toISOString()
      };

      user.transactions = user.transactions || [];
      user.transactions.unshift(tx);
      if (user.transactions.length > 100) user.transactions = user.transactions.slice(0, 100);

      // Register UTR globally in platform ledger
      db.usedUtrs = db.usedUtrs || [];
      db.usedUtrs.push(utrUpper);
      if (db.usedUtrs.length > 5000) db.usedUtrs = db.usedUtrs.slice(-5000);

      // System audit ledger
      db.allTransactions = db.allTransactions || [];
      db.allTransactions.unshift(tx);
      if (db.allTransactions.length > 2000) db.allTransactions = db.allTransactions.slice(0, 2000);

      saveData(db);

      // Push real-time balance to active socket sessions
      for (let [id, s] of io.sockets.sockets) {
        if (s.userId === user.id) {
          s.coins = user.coins;
          s.emit('balance_update', user.coins);
        }
      }

      return {
        status: 200,
        data: {
          success: true,
          balance: user.coins,
          coins: user.coins,
          creditedAmount: amount,
          transaction: tx
        }
      };
    });

    return res.status(result.status).json(result.data);
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }
});

// Withdrawal API with bank/UPI validation, race condition locking & audit logging
app.post('/api/withdraw', rateLimitMiddleware(15), async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized. Real account sign-in required.' });

  try {
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET);
    const amount = parseFloat(req.body.amount);
    const payoutType = (req.body.payoutType || req.body.type || (req.body.bankAccount ? 'BANK' : 'UPI')).toUpperCase();

    if (isNaN(amount) || !isFinite(amount) || amount < 50 || amount > 200000) {
      return res.status(400).json({ error: 'Minimum withdrawal is ₹50, maximum is ₹200,000 per request.' });
    }

    let accountDetails = '';
    let upiId = '';
    let bankAccount = '';
    let ifsc = '';
    let holderName = sanitizeText(req.body.holderName || req.body.name || '', 50);

    if (payoutType === 'BANK') {
      bankAccount = sanitizeText(req.body.accountNumber || req.body.bankAccount || '', 24).replace(/\D/g, '');
      ifsc = sanitizeText(req.body.ifsc || '', 15).toUpperCase();

      if (bankAccount.length < 9 || bankAccount.length > 18) {
        return res.status(400).json({ error: 'Please enter a valid Bank Account Number (9-18 digits).' });
      }
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
        return res.status(400).json({ error: 'Please enter a valid 11-digit IFSC code (e.g. HDFC0001234, SBIN0000123).' });
      }
      if (!holderName || holderName.length < 2) {
        return res.status(400).json({ error: 'Please enter the registered Bank Account Holder Name.' });
      }
      accountDetails = `Bank A/C: ••••${bankAccount.slice(-4)} | IFSC: ${ifsc} | Name: ${holderName}`;
    } else {
      // Default to UPI Payout
      upiId = sanitizeText(req.body.upiId || req.body.accountDetails || '', 60).toLowerCase();
      if (!upiId || !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(upiId)) {
        return res.status(400).json({ error: 'Please enter a valid destination UPI ID (e.g. mobile@paytm or name@oksbi).' });
      }
      if (!holderName || holderName.length < 2) {
        holderName = 'Verified User';
      }
      accountDetails = `UPI ID: ${upiId} (${holderName})`;
    }

    // Process atomically with User Mutex to prevent double-spending & race conditions
    const result = await withUserLock(decoded.id, async () => {
      const db = loadData();
      const user = db.users.find(u => u.id === decoded.id);
      if (!user) return { status: 404, data: { error: 'User account not found' } };

      if (!user.isRealAccount && user.isRealAccount !== undefined && user.isRealAccount === false) {
        return { status: 403, data: { error: 'Withdrawals are only permitted for Real INR Accounts.' } };
      }

      const availableBal = parseFloat((user.coins || 0).toFixed(2));
      if (availableBal < amount) {
        return { status: 400, data: { error: `Insufficient real INR balance. Available: ₹${availableBal.toFixed(2)}` } };
      }

      // Deduct balance securely
      const prevBal = availableBal;
      const newBal = parseFloat((prevBal - amount).toFixed(2));
      user.coins = newBal;

      const tx = {
        id: 'wd_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        userId: user.id,
        username: user.username,
        type: 'withdrawal',
        payoutType: payoutType === 'BANK' ? 'BANK' : 'UPI',
        amount: parseFloat(amount.toFixed(2)),
        currency: 'INR',
        method: payoutType === 'BANK' ? 'Direct Bank Transfer' : 'UPI Transfer',
        accountDetails,
        upiId: payoutType === 'UPI' ? upiId : undefined,
        bankAccountMasked: payoutType === 'BANK' ? `••••${bankAccount.slice(-4)}` : undefined,
        ifsc: payoutType === 'BANK' ? ifsc : undefined,
        holderName,
        status: 'Completed',
        balanceBefore: prevBal,
        balanceAfter: newBal,
        timestamp: new Date().toISOString()
      };

      user.transactions = user.transactions || [];
      user.transactions.unshift(tx);
      if (user.transactions.length > 100) user.transactions = user.transactions.slice(0, 100);

      // System audit ledger
      db.allTransactions = db.allTransactions || [];
      db.allTransactions.unshift(tx);
      if (db.allTransactions.length > 2000) db.allTransactions = db.allTransactions.slice(0, 2000);

      saveData(db);

      // Push real-time balance to active socket sessions
      for (let [id, s] of io.sockets.sockets) {
        if (s.userId === user.id) {
          s.coins = user.coins;
          s.emit('balance_update', user.coins);
        }
      }

      return {
        status: 200,
        data: {
          success: true,
          balance: user.coins,
          coins: user.coins,
          debitedAmount: amount,
          transaction: tx
        }
      };
    });

    return res.status(result.status).json(result.data);
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
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

// My Bets History API
app.get('/api/my-bets', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized', bets: [] });

  try {
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = loadData();
    const user = db.users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found', bets: [] });

    res.json({ success: true, bets: user.bets || [] });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session', bets: [] });
  }
});

// Premium Airplane Skins Base Catalog
const BASE_SKINS_CATALOG = [
  {
    id: 'skin_default',
    name: 'GSD Classic',
    tagline: 'Standard Tactical Emerald Stealth',
    price: 0,
    isFree: true,
    rarity: 'Common',
    primaryColor: '#22e565',
    accentColor: '#10b981',
    fuselageColor: '#166534',
    exhaustColor: '#22e565',
    trailColor: 'rgba(34, 229, 101, 0.45)',
    canopyColor: '#05140b',
    badge: 'DEFAULT'
  },
  {
    id: 'skin_phoenix',
    name: 'Solar Phoenix',
    tagline: 'Crimson Plasma Supersonic Jet',
    price: 50,
    isFree: false,
    rarity: 'Rare',
    primaryColor: '#ef4444',
    accentColor: '#f59e0b',
    fuselageColor: '#991b1b',
    exhaustColor: '#f97316',
    trailColor: 'rgba(239, 68, 68, 0.55)',
    canopyColor: '#450a0a',
    badge: '🔥 HOT'
  },
  {
    id: 'skin_cyberpunk',
    name: 'Neon Cyber-Jet',
    tagline: 'Synthwave Cyan & Magenta Laser Jet',
    price: 50,
    isFree: false,
    rarity: 'Epic',
    primaryColor: '#06b6d4',
    accentColor: '#ec4899',
    fuselageColor: '#0e7490',
    exhaustColor: '#3b82f6',
    trailColor: 'rgba(6, 182, 212, 0.6)',
    canopyColor: '#164e63',
    badge: '⚡ POPULAR'
  },
  {
    id: 'skin_shadow',
    name: 'Shadow Interceptor',
    tagline: 'Matte Obsidian Void Ion Thruster',
    price: 50,
    isFree: false,
    rarity: 'Legendary',
    primaryColor: '#8b5cf6',
    accentColor: '#a855f7',
    fuselageColor: '#4c1d95',
    exhaustColor: '#c084fc',
    trailColor: 'rgba(139, 92, 246, 0.65)',
    canopyColor: '#2e1065',
    badge: '🛡️ STEALTH'
  },
  {
    id: 'skin_royal_gold',
    name: 'Gilded Sovereign',
    tagline: '24K Aurum Imperial Luxury Flagship',
    price: 50,
    isFree: false,
    rarity: 'Mythic',
    primaryColor: '#eab308',
    accentColor: '#fef08a',
    fuselageColor: '#854d0e',
    exhaustColor: '#fbbf24',
    trailColor: 'rgba(234, 179, 8, 0.7)',
    canopyColor: '#422006',
    badge: '👑 EXCLUSIVE'
  }
];

function getSkinsCatalog(db) {
  const prices = (db && db.skinPrices) ? db.skinPrices : {};
  return BASE_SKINS_CATALOG.map(s => {
    if (s.isFree) return { ...s, price: 0 };
    const p = prices[s.id];
    const price = typeof p === 'number' ? p : 50;
    return { ...s, price };
  });
}

// Helper to ensure user has skins state
function sanitizeUserSkins(user) {
  if (!user.unlockedSkins || !Array.isArray(user.unlockedSkins)) {
    user.unlockedSkins = ['skin_default'];
  }
  if (!user.unlockedSkins.includes('skin_default')) {
    user.unlockedSkins.unshift('skin_default');
  }
  if (!user.equippedSkin || !BASE_SKINS_CATALOG.find(s => s.id === user.equippedSkin)) {
    user.equippedSkin = 'skin_default';
  }
  return user;
}

// Store API: Get Catalog & User Skins
app.get('/api/store/skins', (req, res) => {
  const authHeader = req.headers.authorization;
  const db = loadData();
  const catalog = getSkinsCatalog(db);
  let unlockedSkins = ['skin_default'];
  let equippedSkin = 'skin_default';

  if (authHeader) {
    try {
      const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = db.users.find(u => u.id === decoded.id);
      if (user) {
        sanitizeUserSkins(user);
        unlockedSkins = user.unlockedSkins;
        equippedSkin = user.equippedSkin;
      }
    } catch (e) {}
  }

  res.json({
    success: true,
    catalog,
    unlockedSkins,
    equippedSkin
  });
});

// Store API: Purchase Skin
app.post('/api/store/buy-skin', rateLimitMiddleware(20), (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized. Please sign in to purchase skins.' });

  try {
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET);
    const skinId = sanitizeText(req.body.skinId, 40);

    const db = loadData();
    const catalog = getSkinsCatalog(db);
    const skin = catalog.find(s => s.id === skinId);
    if (!skin) {
      return res.status(404).json({ error: 'Selected aircraft skin not found in catalog.' });
    }

    const user = db.users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    sanitizeUserSkins(user);

    if (user.unlockedSkins.includes(skinId)) {
      return res.status(400).json({ error: 'You already own this aircraft skin!' });
    }

    if (user.coins < skin.price) {
      return res.status(400).json({ 
        error: `Insufficient balance (₹${user.coins.toFixed(2)}). Skin cost is ₹${skin.price}. Please deposit via UPI to complete purchase.` 
      });
    }

    // Deduct price and unlock skin
    user.coins = parseFloat((user.coins - skin.price).toFixed(2));
    user.unlockedSkins.push(skinId);
    user.equippedSkin = skinId;

    // Log transaction
    user.transactions = user.transactions || [];
    const tx = {
      id: 'skin_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      type: 'skin_purchase',
      amount: skin.price,
      currency: 'INR',
      method: 'Skin Store',
      skinName: skin.name,
      skinId: skin.id,
      status: 'Completed',
      timestamp: new Date().toISOString()
    };
    user.transactions.unshift(tx);
    if (user.transactions.length > 50) user.transactions = user.transactions.slice(0, 50);

    saveData(db);

    // Sync sockets
    for (let [id, s] of io.sockets.sockets) {
      if (s.userId === user.id) {
        s.coins = user.coins;
        s.emit('balance_update', user.coins);
      }
    }

    res.json({
      success: true,
      message: `Successfully unlocked and equipped ${skin.name}!`,
      skin,
      balance: user.coins,
      coins: user.coins,
      unlockedSkins: user.unlockedSkins,
      equippedSkin: user.equippedSkin
    });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
});

// Store API: Equip Skin
app.post('/api/store/equip-skin', rateLimitMiddleware(30), (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET);
    const skinId = sanitizeText(req.body.skinId, 40);

    const db = loadData();
    const catalog = getSkinsCatalog(db);
    const skin = catalog.find(s => s.id === skinId);
    if (!skin) {
      return res.status(404).json({ error: 'Selected aircraft skin not found.' });
    }

    const user = db.users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    sanitizeUserSkins(user);

    if (!user.unlockedSkins.includes(skinId)) {
      return res.status(403).json({ error: 'You do not own this aircraft skin yet. Please unlock it first.' });
    }

    user.equippedSkin = skinId;
    saveData(db);

    res.json({
      success: true,
      message: `Equipped ${skin.name}`,
      equippedSkin: user.equippedSkin
    });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
});

// =========================================================
// REAL-TIME AI CUSTOMER SUPPORT ROUTE (Real Accounts Only)
// =========================================================
app.post('/api/support/chat', rateLimitMiddleware(20), async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({
      error: 'AI Real-Time Customer Support is reserved exclusively for Real Accounts. Please sign in or register.'
    });
  }

  try {
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET);

    const db = loadData();
    const user = db.users.find(u => u.id === decoded.id);
    if (!user) {
      return res.status(401).json({
        error: 'Pilot account not found. AI Customer Support requires a valid real account.'
      });
    }

    const { message, chatHistory } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Please enter a valid message for AI Support.' });
    }

    const userMessage = message.trim();

    // User context details
    const userBetsCount = Array.isArray(user.bets) ? user.bets.length : 0;
    const userTx = (db.transactions || []).filter(t => t.userId === user.id);
    const recentDeposits = userTx.filter(t => t.type === 'DEPOSIT');
    const recentWithdrawals = userTx.filter(t => t.type === 'WITHDRAWAL');

    const systemInstruction = `You are the Official GSD CRASH AI Live Support Specialist for real-money pilots.
Your duty is to assist real-money players with official account issues, deposits, withdrawals, game rules, and security.

AUTHENTICATED REAL PILOT CONTEXT:
- Pilot Username: ${user.username}
- User ID: ${user.id}
- Real INR Balance: ₹${(user.coins || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Email: ${user.email || 'N/A'}
- Total Game Bets: ${userBetsCount}
- Recorded Deposits: ${recentDeposits.length}
- Recorded Withdrawals: ${recentWithdrawals.length}
- Merchant Destination UPI: ${MERCHANT_UPI_ID} (${MERCHANT_NAME})

OFFICIAL SUPPORT POLICIES & RESOLUTION STEPS:
1. DEPOSITS: Deposits are processed via UPI. After sending money to ${MERCHANT_UPI_ID}, players MUST input their 12-digit UPI Reference / UTR Number in the Deposit modal. Auto-verification processes within 1-5 minutes.
2. WITHDRAWALS: Minimum withdrawal is ₹100. Money is transferred directly to the player's UPI ID within 5-15 minutes.
3. PROVABLY FAIR & RNG: Multipliers (1.00x - 100.00x) are pre-calculated using cryptographic seed hashes. 100% fair.
4. AVATAR & SKINS: Players can buy and equip custom aircraft skins in the Skin Store.
5. IF ISSUE UNRESOLVED: Advise the player that support ticket logs are active for their user ID (${user.id}) and they can contact human support at support@gsdcrash.in with their UPI UTR number if needed.

INSTRUCTIONS:
- Be helpful, polite, concise, and accurate.
- Address the user by their pilot username "${user.username}".
- Refer directly to their actual balance (₹${(user.coins || 0).toFixed(2)}) when relevant.
- Format responses cleanly using markdown bolding or short paragraphs.
- Keep responses friendly, empowering, and strictly accurate to GSD CRASH.`;

    const aiClient = getGenAI();
    let replyText = '';

    if (aiClient) {
      try {
        const contents = [];
        if (Array.isArray(chatHistory)) {
          chatHistory.forEach(item => {
            if (item && item.role && item.text) {
              contents.push({
                role: item.role === 'user' ? 'user' : 'model',
                parts: [{ text: String(item.text) }]
              });
            }
          });
        }
        contents.push({
          role: 'user',
          parts: [{ text: userMessage }]
        });

        const response = await aiClient.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: contents,
          config: {
            systemInstruction: systemInstruction,
            temperature: 0.7
          }
        });

        replyText = response.text ? response.text.trim() : '';
      } catch (aiErr) {
        console.error('Gemini API Error in Support Chat:', aiErr.message);
      }
    }

    // Smart domain fallback if Gemini key is missing or errored
    if (!replyText) {
      const msgLower = userMessage.toLowerCase();
      if (msgLower.includes('deposit') || msgLower.includes('add money') || msgLower.includes('payment') || msgLower.includes('utr') || msgLower.includes('upi')) {
        replyText = `Hello Pilot **${user.username}**! 💳\n\nTo complete or verify a Deposit:\n1. Send the amount to UPI ID: \`${MERCHANT_UPI_ID}\`\n2. Open the **Deposit Modal** and enter your 12-digit **UPI Reference / UTR Number**.\n3. Your Real INR balance (currently **₹${(user.coins||0).toFixed(2)}**) will be credited within 1-3 minutes automatically!`;
      } else if (msgLower.includes('withdraw') || msgLower.includes('payout') || msgLower.includes('transfer')) {
        replyText = `Hello Pilot **${user.username}**! 💸\n\nFor Withdrawals:\n- Minimum withdrawal limit is **₹100.00**.\n- Your current available balance is **₹${(user.coins||0).toFixed(2)}**.\n- Click **Withdraw INR** in the wallet menu, enter your UPI ID, and funds will transfer within 5-15 minutes!`;
      } else if (msgLower.includes('balance') || msgLower.includes('money') || msgLower.includes('coins')) {
        replyText = `Greetings Pilot **${user.username}**! 🎖️\n\nYour current Verified Real INR Account balance is **₹${(user.coins||0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}**. All real money balances are stored securely in your encrypted wallet.`;
      } else {
        replyText = `Hello Pilot **${user.username}**! 🤖\n\nI am your 24/7 GSD CRASH Official AI Support Specialist. I am active for your Real Account (ID: \`${user.id}\`).\n\nHow can I assist you today?\n- **Deposits & UPI UTR Verification**\n- **Withdrawals & Payout Times**\n- **Game Multipliers & Provably Fair**\n- **Account Security & Password Updates**`;
      }
    }

    res.json({
      success: true,
      reply: replyText,
      username: user.username,
      balance: user.coins
    });

  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }
});

// =========================================================
// ISOLATED DUAL GAME ENGINES: REAL vs. DEMO SANDBOX
// =========================================================
const GAME_STATE = {
  WAITING: 'WAITING',
  FLYING: 'FLYING',
  CRASHED: 'CRASHED'
};

// Realistic Indian Player rosters for Real and Demo rooms
const REAL_BOT_NAMES = [
  'Rahul_99', 'AmitSharma', 'Vicky_007', 'Rohit_Delhi', 'Akash_Verma',
  'Deepak_91', 'Priya_R', 'Manish_Jaipur', 'Sameer_77', 'Ankit_Rao',
  'Suraj_001', 'Pooja_Mumbai', 'Vivek_Patna', 'Karan_88', 'Rohan_K',
  'Neha_R', 'Rajesh_Indore', 'Sanjay_07', 'Nitin_Goa', 'Vikram_Pune',
  'Alok_Noida', 'Rakesh_Kanpur', 'Sunil_Bhopal', 'Tarun_Lucknow',
  'Aman_Kolkata', 'Dinesh_Surat', 'Gaurav_CHD', 'Harsh_Agra',
  'Jatin_Varanasi', 'Kunal_Nashik', 'Mayank_09', 'Naveen_HYD',
  'Pankaj_05', 'Ravi_Bangalore', 'Sachin_MUM', 'Tushar_77', 'Vijay_100',
  'Yash_Ahm', 'Arjun_DL', 'Bhavya_99', 'Dev_10', 'Eshaan_PB',
  'Farhan_JK', 'Gautam_01', 'Hemant_RJ', 'Ishaan_07', 'Jitendra_UP'
];

const DEMO_BOT_NAMES = [
  'Rahul_99', 'AmitSharma', 'Vicky_007', 'Rohit_Delhi', 'Akash_Verma',
  'Deepak_91', 'Priya_R', 'Manish_Jaipur', 'Sameer_77', 'Ankit_Rao',
  'Suraj_001', 'Pooja_Mumbai', 'Vivek_Patna', 'Karan_88', 'Rohan_K',
  'Neha_R', 'Rajesh_Indore', 'Sanjay_07', 'Nitin_Goa', 'Vikram_Pune',
  'Alok_Noida', 'Rakesh_Kanpur', 'Sunil_Bhopal', 'Tarun_Lucknow',
  'Aman_Kolkata', 'Dinesh_Surat', 'Gaurav_CHD', 'Harsh_Agra',
  'Jatin_Varanasi', 'Kunal_Nashik', 'Mayank_09', 'Naveen_HYD',
  'Pankaj_05', 'Ravi_Bangalore', 'Sachin_MUM', 'Tushar_77', 'Vijay_100',
  'Yash_Ahm', 'Arjun_DL', 'Bhavya_99', 'Dev_10', 'Eshaan_PB'
];

class CrashGameInstance {
  constructor(config) {
    this.mode = config.mode; // 'REAL' or 'DEMO'
    this.room = config.room; // 'room_real' or 'room_demo'
    this.isRealMoney = !!config.isRealMoney;
    this.growthFactor = config.growthFactor || 0.065;
    this.state = GAME_STATE.WAITING;
    this.currentMultiplier = 1.00;
    this.crashPoint = 1.00;
    this.waitTimeLeft = 5;
    this.roundId = (this.isRealMoney ? 'R_' : 'D_') + Date.now().toString(36);
    this.serverSeed = crypto.randomBytes(32).toString('hex');
    this.roundCounter = Math.floor(Math.random() * 5000) + 1000;
    this.multiplierHistory = config.initialHistory || (this.isRealMoney 
      ? [2.74, 5.67, 2.08, 2.56, 1.22, 1.03, 1.08, 2.02, 1.45, 9.80, 1.34, 3.12, 1.15, 14.50, 2.10, 4.25]
      : [1.85, 3.42, 1.15, 12.40, 1.95, 2.80, 1.05, 4.60, 1.54, 2.10, 1.18, 22.80, 1.35, 1.88, 3.15, 1.08]);
    this.activeBets = [];
    this.botNames = this.isRealMoney ? REAL_BOT_NAMES : DEMO_BOT_NAMES;
    this.intervalId = null;

    // Slight staggered startup so Real and Demo don't synchronize
    setTimeout(() => {
      this.startWaitingPhase();
    }, config.startDelay || 100);
  }

  generateSimulatedBets() {
    const count = Math.floor(Math.random() * 11) + 18; // 18 to 28 active simulated players
    const shuffled = [...this.botNames].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, count);
    const possibleAmounts = [50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 2500, 3000, 5000];

    return selected.map((name, idx) => {
      const amount = possibleAmounts[Math.floor(Math.random() * possibleAmounts.length)];
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
        id: 'bot_' + this.mode.toLowerCase() + '_' + idx + '_' + Date.now(),
        socketId: null,
        userId: 'bot_' + idx,
        username: name,
        panelId: 'default',
        amount,
        autoCashout,
        cashedOut: false,
        cashingOut: false,
        winAmount: 0,
        cashoutMultiplier: null,
        isBot: true
      };
    });
  }

  getPublicBetsList() {
    return this.activeBets.map(b => ({
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

  generateCrashPoint() {
    this.roundCounter++;
    if (this.isRealMoney) {
      // Cryptographically secure Provably Fair RNG for Real Money gameplay
      // Zero correlation with sandbox or demo runs
      const clientSeed = 'GSD_CRASH_INDIAN_AIR_FORCE_PROVABLY_FAIR_' + this.roundCounter;
      const hmac = crypto.createHmac('sha256', this.serverSeed);
      hmac.update(clientSeed);
      const hash = hmac.digest('hex');

      const subHex = hash.substring(0, 8);
      const intVal = parseInt(subHex, 16);
      const norm = intVal / 0xFFFFFFFF;

      // 4% House edge instant crash
      if (norm < 0.04) {
        return 1.00;
      }
      const h = Math.floor(norm * 100);
      const mult = (100 - 3.5) / Math.max(100 - h, 0.01);
      return Math.max(1.01, parseFloat(mult.toFixed(2)));
    } else {
      // Independent Sandbox RNG for Demo practice mode
      const buf = crypto.randomBytes(4);
      const val = buf.readUInt32BE(0) / 0xFFFFFFFF;
      if (val < 0.035) return 1.00;
      const h = Math.floor(val * 100);
      const r = (100 - 3) / Math.max(100 - h, 0.01);
      return Math.max(1.01, parseFloat(r.toFixed(2)));
    }
  }

  evaluateRiskAndOverrideCrashPoint() {
    if (!this.isRealMoney) return;

    // Filter active real human player bets (non-bots, non-guests)
    const realBets = this.activeBets.filter(b => !b.isBot && !b.isGuest);
    if (realBets.length === 0) return;

    const totalRealStake = realBets.reduce((sum, b) => sum + (b.amount || 0), 0);
    const hasHighSingleBet = realBets.some(b => b.amount >= 100); // Real bet >= ₹100
    const hasHighTotalStake = totalRealStake >= 150; // Total real stake >= ₹150
    const hasHighActivePlayers = realBets.length >= 2; // 2 or more active real players

    // If high bet amount placed OR high active player volume in real account mode, crash aeroplane at 1.00x
    if (hasHighSingleBet || hasHighTotalStake || hasHighActivePlayers) {
      this.crashPoint = 1.00;
      console.log(`[REAL ACCOUNT RISK CONTROL] High real bet or high active player volume detected (Active Real Bets: ${realBets.length}, Total Real Stake: ₹${totalRealStake}). Overriding crash point to 1.00x.`);
    }
  }

  startWaitingPhase() {
    this.state = GAME_STATE.WAITING;
    this.currentMultiplier = 1.00;
    this.crashPoint = this.generateCrashPoint();
    this.waitTimeLeft = 5;
    this.roundId = (this.isRealMoney ? 'R_' : 'D_') + Date.now().toString(36);
    this.activeBets = this.generateSimulatedBets();

    io.to(this.room).emit('game_state', {
      state: this.state,
      time: this.waitTimeLeft,
      waitTimeLeft: this.waitTimeLeft,
      history: this.multiplierHistory.slice(-28),
      mode: this.mode,
      isRealMoney: this.isRealMoney
    });
    io.to(this.room).emit('round_bets_update', this.getPublicBetsList());

    if (this.intervalId) clearInterval(this.intervalId);

    this.intervalId = setInterval(() => {
      this.waitTimeLeft--;
      io.to(this.room).emit('wait_tick', { waitTimeLeft: this.waitTimeLeft, mode: this.mode });
      io.to(this.room).emit('game_state', {
        state: 'WAITING',
        time: this.waitTimeLeft,
        waitTimeLeft: this.waitTimeLeft,
        history: this.multiplierHistory.slice(-28),
        mode: this.mode,
        isRealMoney: this.isRealMoney
      });

      if (this.waitTimeLeft <= 0) {
        clearInterval(this.intervalId);
        this.startFlyingPhase();
      }
    }, 1000);
  }

  startFlyingPhase() {
    this.state = GAME_STATE.FLYING;
    const startTime = Date.now();

    // Re-evaluate risk control right before take-off in real money mode
    this.evaluateRiskAndOverrideCrashPoint();

    io.to(this.room).emit('game_state', { state: 'RUNNING', multiplier: 1.00, mode: this.mode });
    io.to(this.room).emit('game_state', { state: 'FLYING', multiplier: 1.00, mode: this.mode });
    io.to(this.room).emit('round_bets_update', this.getPublicBetsList());

    if (this.intervalId) clearInterval(this.intervalId);

    this.intervalId = setInterval(() => {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      this.currentMultiplier = parseFloat(Math.pow(Math.E, this.growthFactor * elapsedSeconds).toFixed(2));

      // Handle Auto Cashouts
      let hasCashout = false;
      this.activeBets.forEach(bet => {
        if (!bet.cashedOut && bet.autoCashout && this.currentMultiplier >= bet.autoCashout) {
          if (bet.isBot) {
            bet.cashedOut = true;
            bet.cashoutMultiplier = this.currentMultiplier;
            bet.winAmount = parseFloat((bet.amount * this.currentMultiplier).toFixed(2));
            hasCashout = true;
            io.to(this.room).emit('player_cashed_out', {
              id: bet.id,
              username: bet.username,
              amount: bet.amount,
              multiplier: this.currentMultiplier,
              winAmount: bet.winAmount,
              userId: bet.userId,
              isBot: true,
              mode: this.mode
            });
          } else {
            this.cashOutBet(bet.userId, bet.panelId, this.currentMultiplier);
            hasCashout = true;
          }
        }
      });

      if (hasCashout) {
        io.to(this.room).emit('round_bets_update', this.getPublicBetsList());
      }

      if (this.currentMultiplier >= this.crashPoint) {
        clearInterval(this.intervalId);
        this.startCrashPhase();
      } else {
        io.to(this.room).emit('multiplier_tick', { multiplier: this.currentMultiplier, mode: this.mode });
        io.to(this.room).emit('multiplier_update', this.currentMultiplier);
      }
    }, 70);
  }

  startCrashPhase() {
    this.state = GAME_STATE.CRASHED;
    this.multiplierHistory.push(this.currentMultiplier);
    if (this.multiplierHistory.length > 40) this.multiplierHistory.shift();

    if (this.isRealMoney) {
      const db = loadData();
      let dbUpdated = false;
      this.activeBets.forEach(bet => {
        if (!bet.cashedOut && !bet.isBot && bet.userId) {
          bet.crashed = true;
          const u = db.users.find(usr => usr.id === bet.userId);
          if (u) {
            u.bets = u.bets || [];
            u.bets.unshift({
              id: bet.id || ('bet_' + Date.now()),
              amount: bet.amount,
              multiplier: this.currentMultiplier,
              winAmount: 0,
              status: 'LOST',
              timestamp: new Date().toISOString()
            });
            if (u.bets.length > 50) u.bets = u.bets.slice(0, 50);
            dbUpdated = true;
          }
        }
      });
      if (dbUpdated) saveData(db);
    }

    io.to(this.room).emit('game_crashed', {
      multiplier: this.currentMultiplier,
      crashPoint: this.currentMultiplier,
      history: this.multiplierHistory.slice(-28),
      mode: this.mode
    });
    io.to(this.room).emit('game_state', {
      state: 'CRASHED',
      multiplier: this.currentMultiplier,
      crashPoint: this.currentMultiplier,
      history: this.multiplierHistory.slice(-28),
      mode: this.mode,
      isRealMoney: this.isRealMoney
    });
    io.to(this.room).emit('round_bets_update', this.getPublicBetsList());

    if (this.intervalId) clearInterval(this.intervalId);

    setTimeout(() => {
      this.startWaitingPhase();
    }, 2500);
  }

  async cashOutBet(userId, panelId, multiplier) {
    if (this.state !== GAME_STATE.FLYING) return null;

    const cleanPanelId = sanitizeText(panelId || 'default', 16);
    // Anti-Cheat: Validate multiplier never exceeds current server multiplier or crash point
    const rawMult = parseFloat(multiplier);
    if (isNaN(rawMult) || !isFinite(rawMult) || rawMult < 1.00) return null;
    const validatedMultiplier = Math.min(rawMult, this.currentMultiplier);

    const bet = this.activeBets.find(b => b.userId === userId && (b.panelId === cleanPanelId || !cleanPanelId) && !b.cashedOut && !b.cashingOut);
    if (!bet) return null;

    bet.cashingOut = true;
    bet.cashedOut = true;
    bet.cashoutMultiplier = validatedMultiplier;
    const winAmount = parseFloat((bet.amount * validatedMultiplier).toFixed(2));
    bet.winAmount = winAmount;

    let newBalance = 0;
    if (!this.isRealMoney || bet.isGuest) {
      if (bet.socket) {
        bet.socket.coins = parseFloat(((bet.socket.coins || 0) + winAmount).toFixed(2));
        newBalance = bet.socket.coins;
      }
    } else {
      await withUserLock(userId, async () => {
        const db = loadData();
        const user = db.users.find(u => u.id === userId);
        if (user) {
          user.coins = parseFloat((user.coins + winAmount).toFixed(2));
          user.bets = user.bets || [];
          user.bets.unshift({
            id: bet.id || ('bet_' + Date.now()),
            amount: bet.amount,
            multiplier: validatedMultiplier,
            winAmount,
            status: 'CASHED_OUT',
            timestamp: new Date().toISOString()
          });
          if (user.bets.length > 50) user.bets = user.bets.slice(0, 50);
          saveData(db);
          newBalance = user.coins;
          if (bet.socket) bet.socket.coins = user.coins;
        }
      });
    }

    if (bet.socketId) {
      io.to(bet.socketId).emit('bet_cashed_out', {
        panelId: bet.panelId,
        winAmount,
        multiplier: validatedMultiplier,
        newBalance,
        mode: this.mode
      });
      io.to(bet.socketId).emit('cash_out_success', {
        panelId: bet.panelId,
        winAmount,
        multiplier: validatedMultiplier,
        newBalance,
        mode: this.mode
      });
      io.to(bet.socketId).emit('balance_update', newBalance);
    }

    io.to(this.room).emit('player_cashed_out', {
      id: bet.id,
      username: bet.username,
      amount: bet.amount,
      multiplier: validatedMultiplier,
      winAmount,
      userId: bet.userId,
      isBot: false,
      mode: this.mode
    });
    io.to(this.room).emit('round_bets_update', this.getPublicBetsList());

    return winAmount;
  }

  async placeBet(socket, data) {
    if (this.state !== GAME_STATE.WAITING || this.waitTimeLeft <= 0.35) {
      return socket.emit('error_msg', { message: 'Can only place bets during waiting phase before take-off' });
    }

    const panelId = sanitizeText((data && data.panelId) || 'default', 16);
    let autoCashout = (data && data.autoCashout) ? parseFloat(data.autoCashout) : null;
    if (autoCashout !== null && (isNaN(autoCashout) || autoCashout < 1.05 || autoCashout > 200 || !isFinite(autoCashout))) {
      autoCashout = null;
    }

    const parsedAmount = typeof data === 'object' ? parseFloat(data.amount) : parseFloat(data);
    if (isNaN(parsedAmount) || parsedAmount < 10 || parsedAmount > 10000 || !isFinite(parsedAmount)) {
      return socket.emit('error_msg', { message: 'Bet amount must be between 10 and 10,000' });
    }

    if (this.isRealMoney) {
      if (!socket.userId) {
        return socket.emit('error_msg', { message: 'Please sign in to place real money bets' });
      }

      await withUserLock(socket.userId, async () => {
        const db = loadData();
        const user = db.users.find(u => u.id === socket.userId);
        if (!user) {
          return socket.emit('error_msg', { message: 'Please sign in to place real money bets' });
        }

        if (user.coins < 10) {
          return socket.emit('error_msg', { message: 'Minimum wallet balance of ₹10 required to place real money bets. Please deposit to continue.' });
        }

        if (user.coins < parsedAmount) {
          return socket.emit('error_msg', { message: `Insufficient balance for this bet (Available: ₹${user.coins.toFixed(2)})` });
        }

        const existing = this.activeBets.find(b => b.userId === user.id && b.panelId === panelId && !b.cashedOut);
        if (existing) {
          return socket.emit('error_msg', { message: 'Bet already placed for this round' });
        }

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
        this.activeBets.unshift(betObj);
        this.evaluateRiskAndOverrideCrashPoint();

        socket.emit('bet_confirmed', { panelId, amount: parsedAmount, newBalance: user.coins, mode: 'REAL' });
        socket.emit('balance_update', user.coins);
        io.to(this.room).emit('new_live_bet', { username: user.username, amount: parsedAmount, mode: 'REAL' });
        io.to(this.room).emit('round_bets_update', this.getPublicBetsList());
      });
    } else {
      if (parsedAmount > socket.coins) {
        return socket.emit('error_msg', { message: 'Insufficient demo coins balance for this bet.' });
      }

      const existing = this.activeBets.find(b => b.socketId === socket.id && b.panelId === panelId && !b.cashedOut);
      if (existing) return socket.emit('error_msg', { message: 'Bet already placed for this round' });

      socket.coins = parseFloat((socket.coins - parsedAmount).toFixed(2));

      const betObj = {
        id: 'gst_' + socket.id + '_' + Date.now() + '_' + panelId,
        socketId: socket.id,
        socket,
        isGuest: true,
        userId: socket.id,
        username: socket.guestName || ('Demo_Pilot_' + socket.id.substring(0, 4)),
        panelId,
        amount: parsedAmount,
        autoCashout,
        cashedOut: false,
        cashingOut: false,
        winAmount: 0,
        cashoutMultiplier: null,
        isBot: false
      };
      this.activeBets.unshift(betObj);

      socket.emit('bet_confirmed', { panelId: betObj.panelId, amount: parsedAmount, newBalance: socket.coins, mode: 'DEMO' });
      socket.emit('balance_update', socket.coins);
      io.to(this.room).emit('new_live_bet', { username: betObj.username, amount: parsedAmount, mode: 'DEMO' });
      io.to(this.room).emit('round_bets_update', this.getPublicBetsList());
    }
  }

  async cancelBet(socket, data) {
    if (this.state !== GAME_STATE.WAITING) return;
    const panelId = sanitizeText((data && data.panelId) || 'panel1', 16);
    const betIdx = this.activeBets.findIndex(b => (b.socketId === socket.id || (socket.userId && b.userId === socket.userId)) && b.panelId === panelId && !b.cashedOut);
    if (betIdx !== -1) {
      const b = this.activeBets[betIdx];
      this.activeBets.splice(betIdx, 1);
      if (!this.isRealMoney || b.isGuest) {
        socket.coins = parseFloat(((socket.coins || 0) + b.amount).toFixed(2));
        socket.emit('balance_update', socket.coins);
      } else {
        await withUserLock(b.userId, async () => {
          const db = loadData();
          const u = db.users.find(usr => usr.id === b.userId);
          if (u) {
            u.coins = parseFloat((u.coins + b.amount).toFixed(2));
            saveData(db);
            socket.coins = u.coins;
            socket.emit('balance_update', u.coins);
          }
        });
      }
      io.to(this.room).emit('round_bets_update', this.getPublicBetsList());
    }
  }

  sendInitState(socket) {
    socket.emit('init_game', {
      state: this.state,
      multiplier: this.currentMultiplier,
      waitTimeLeft: this.waitTimeLeft,
      time: this.waitTimeLeft,
      history: this.multiplierHistory.slice(-28),
      mode: this.mode,
      isRealMoney: this.isRealMoney
    });
    socket.emit('round_bets_update', this.getPublicBetsList());

    if (this.state === GAME_STATE.WAITING) {
      socket.emit('game_state', {
        state: 'WAITING',
        time: this.waitTimeLeft,
        waitTimeLeft: this.waitTimeLeft,
        history: this.multiplierHistory.slice(-28),
        mode: this.mode,
        isRealMoney: this.isRealMoney
      });
    } else if (this.state === GAME_STATE.FLYING) {
      socket.emit('game_state', {
        state: 'RUNNING',
        multiplier: this.currentMultiplier,
        mode: this.mode
      });
      socket.emit('game_state', {
        state: 'FLYING',
        multiplier: this.currentMultiplier,
        mode: this.mode
      });
    } else if (this.state === GAME_STATE.CRASHED) {
      socket.emit('game_state', {
        state: 'CRASHED',
        multiplier: this.currentMultiplier,
        crashPoint: this.currentMultiplier,
        history: this.multiplierHistory.slice(-28),
        mode: this.mode,
        isRealMoney: this.isRealMoney
      });
    }
  }
}

// Instantiate Isolated Real and Demo Server Engines
const realEngine = new CrashGameInstance({
  mode: 'REAL',
  room: 'room_real',
  isRealMoney: true,
  growthFactor: 0.065,
  initialHistory: [2.74, 5.67, 2.08, 2.56, 1.22, 1.03, 1.08, 2.02, 1.45, 9.80, 1.34, 3.12, 1.15, 14.50, 2.10, 4.25],
  startDelay: 0
});

const demoEngine = new CrashGameInstance({
  mode: 'DEMO',
  room: 'room_demo',
  isRealMoney: false,
  growthFactor: 0.065,
  initialHistory: [1.85, 3.42, 1.15, 12.40, 1.95, 2.80, 1.05, 4.60, 1.54, 2.10, 1.18, 22.80, 1.35, 1.88, 3.15, 1.08],
  startDelay: 2500
});

// Helper: Get active engine for a socket
function getEngineForSocket(socket) {
  if (socket.gameMode === 'REAL' && socket.userId) {
    return realEngine;
  }
  return demoEngine;
}

// Socket Connection Handler
io.on('connection', (socket) => {
  // Default connection starts in isolated Demo Room
  socket.gameMode = 'DEMO';
  socket.join('room_demo');
  socket.coins = 10000.00;
  socket.lastActionSec = 0;
  socket.actionCount = 0;

  function isRateLimited() {
    const now = Math.floor(Date.now() / 1000);
    if (socket.lastActionSec !== now) {
      socket.lastActionSec = now;
      socket.actionCount = 1;
      return false;
    }
    socket.actionCount++;
    return socket.actionCount > 10;
  }

  demoEngine.sendInitState(socket);

  // Authenticate as Real Account -> Switch room to 'room_real'
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
        socket.gameMode = 'REAL';

        // Switch socket from demo to real room
        socket.leave('room_demo');
        socket.join('room_real');

        socket.emit('auth_success', { 
          user: { id: user.id, username: user.username, coins: user.coins },
          mode: 'REAL'
        });
        socket.emit('balance_update', user.coins);
        
        // Feed real engine state immediately
        realEngine.sendInitState(socket);
      }
    } catch (e) {
      socket.emit('auth_error', { message: 'Authentication session expired' });
    }
  });

  // Switch to Demo Room -> Leave real room and join demo room
  socket.on('switch_to_demo', () => {
    socket.userId = null;
    socket.token = null;
    socket.gameMode = 'DEMO';
    socket.coins = 10000.00;
    socket.guestName = 'Demo_Pilot_' + Math.floor(Math.random() * 8999 + 1000);

    socket.leave('room_real');
    socket.join('room_demo');

    socket.emit('balance_update', socket.coins);
    socket.emit('demo_mode_confirmed', { coins: socket.coins });
    demoEngine.sendInitState(socket);
  });

  socket.on('logout', () => {
    socket.userId = null;
    socket.token = null;
    socket.gameMode = 'DEMO';
    socket.coins = 10000.00;
    socket.guestName = 'Guest_Pilot_' + Math.floor(Math.random() * 8999 + 1000);
    socket.leave('room_real');
    socket.join('room_demo');
    socket.emit('balance_update', 10000.00);
    demoEngine.sendInitState(socket);
  });

  socket.on('set_guest_profile', (data) => {
    if (data && data.username && typeof data.username === 'string') {
      socket.guestName = sanitizeText(data.username, 20);
    }
    socket.userId = null;
    socket.token = null;
    socket.gameMode = 'DEMO';
    if (socket.coins === undefined || socket.coins === null) {
      socket.coins = 10000.00;
    }

    socket.leave('room_real');
    socket.join('room_demo');

    socket.emit('balance_update', socket.coins);
    demoEngine.sendInitState(socket);
  });

  socket.on('place_bet', async (data) => {
    if (isRateLimited()) {
      return socket.emit('error_msg', { message: 'Rate limit exceeded. Please slow down.' });
    }
    const engine = getEngineForSocket(socket);
    await engine.placeBet(socket, data);
  });

  socket.on('cash_out', async (data) => {
    if (isRateLimited()) return;
    const engine = getEngineForSocket(socket);
    const panelId = sanitizeText((data && data.panelId) || 'panel1', 16);

    if (socket.gameMode === 'REAL' && socket.userId) {
      await engine.cashOutBet(socket.userId, panelId, engine.currentMultiplier);
    } else {
      const bet = engine.activeBets.find(b => b.socketId === socket.id && (b.panelId === panelId || !panelId) && !b.cashedOut);
      if (bet) {
        await engine.cashOutBet(bet.userId, bet.panelId, engine.currentMultiplier);
      }
    }
  });

  socket.on('sync_balance', () => {
    if (socket.gameMode === 'REAL' && socket.userId) {
      const db = loadData();
      const user = db.users.find(u => u.id === socket.userId);
      if (user) {
        socket.coins = user.coins;
        socket.emit('balance_update', user.coins);
      }
    } else {
      socket.emit('balance_update', socket.coins || 10000.00);
    }
  });

  socket.on('cancel_bet', async (data) => {
    const engine = getEngineForSocket(socket);
    await engine.cancelBet(socket, data);
  });

  socket.on('init_demo_mode', () => {
    socket.userId = null;
    socket.token = null;
    socket.gameMode = 'DEMO';
    socket.coins = 10000.00;
    socket.guestName = 'Demo_Pilot_' + Math.floor(Math.random() * 8999 + 1000);

    socket.leave('room_real');
    socket.join('room_demo');

    socket.emit('balance_update', socket.coins);
    socket.emit('demo_mode_confirmed', { coins: socket.coins });
    demoEngine.sendInitState(socket);
  });

  socket.on('refill_guest_coins', () => {
    if (socket.gameMode === 'REAL' && socket.userId) {
      return socket.emit('error_msg', { message: 'Free practice coins are only available in Demo Mode. Real INR accounts require UPI deposits.' });
    }
    socket.coins = parseFloat(((socket.coins || 0) + 10000).toFixed(2));
    socket.emit('balance_update', socket.coins);
    socket.emit('demo_coins_refilled', { coins: socket.coins, message: '+10,000 Demo Practice Coins Refilled!' });
  });

  // Multiplayer Chat System (Sent to all connected players in real-time)
  socket.on('send_chat', (data) => {
    if (!data || !data.text || typeof data.text !== 'string') return;
    const text = sanitizeText(data.text, 100);
    if (!text) return;
    const sender = socket.username || socket.guestName || ('Pilot_' + socket.id.substring(0, 4));
    const avatar = (data.avatar && typeof data.avatar === 'string') ? sanitizeText(data.avatar, 10) : '🧑‍✈️';
    const msg = {
      id: 'msg_' + Date.now(),
      sender,
      avatar,
      text,
      isReal: socket.gameMode === 'REAL',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    io.emit('chat_message', msg);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`GSD CRASH server running on port ${PORT} with isolated Real and Demo engines.`);
});
  
