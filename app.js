const socket = io();

// UI Elements
const authModal = document.getElementById('authModal');
const guestBtn = document.getElementById('guestBtn');
const guestNameInput = document.getElementById('guestNameInput');
const userNameEl = document.getElementById('userName');
const userAvatarEl = document.getElementById('userAvatar');
const userBalanceEl = document.getElementById('userBalance');
const historyContainer = document.getElementById('historyContainer');
const multiplierDisplay = document.getElementById('multiplierDisplay');
const waitingState = document.getElementById('waitingState');
const countdownTimer = document.getElementById('countdownTimer');
const betAmountInput = document.getElementById('betAmount');
const mainActionBtn = document.getElementById('mainActionBtn');
const btnMinus = document.getElementById('btnMinus');
const btnPlus = document.getElementById('btnPlus');
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

let currentUser = null;
let currentMultiplier = 1.00;
let gameState = 'WAITING';
let myActiveBet = null;

// Resize Canvas
function resizeCanvas() {
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = canvas.parentElement.clientHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Check User Session
async function checkAuth() {
  try {
    const res = await fetch('/auth/user');
    const data = await res.json();
    if (data.loggedIn) {
      currentUser = data.user;
      setupUserUI();
    }
  } catch (err) {
    console.error(err);
  }
}
checkAuth();

guestBtn.addEventListener('click', async () => {
  const name = guestNameInput.value.trim() || 'Captain';
  const res = await fetch('/auth/guest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const data = await res.json();
  if (data.success) {
    currentUser = data.user;
    setupUserUI();
  }
});

function setupUserUI() {
  authModal.classList.add('hidden');
  userNameEl.textContent = currentUser.name;
  userAvatarEl.src = currentUser.avatar;
  updateBalanceUI(currentUser.balance);
}

function updateBalanceUI(amount) {
  if (currentUser) currentUser.balance = amount;
  userBalanceEl.textContent = `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

// Stepper & Chips
btnMinus.onclick = () => {
  let val = Math.max(10, parseInt(betAmountInput.value || 0) - 10);
  betAmountInput.value = val;
};
btnPlus.onclick = () => {
  let val = parseInt(betAmountInput.value || 0) + 10;
  betAmountInput.value = val;
};
document.querySelectorAll('.chip-btn').forEach(btn => {
  btn.onclick = () => {
    let add = parseInt(btn.dataset.val);
    betAmountInput.value = parseInt(betAmountInput.value || 0) + add;
  };
});

// Canvas Flight Rendering
let flightProgress = 0;

function drawFlightCurve() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (gameState !== 'FLYING' && gameState !== 'CRASHED') return;

  const w = canvas.width;
  const h = canvas.height;
  const pad = 40;

  // Bezier curve calculations
  const startX = pad;
  const startY = h - pad;
  const currentX = Math.min(w - pad, pad + (w - 2 * pad) * (flightProgress / 10));
  const currentY = Math.max(pad, (h - pad) - ((h - 2 * pad) * (flightProgress / 10)));

  // Glowing trail gradient under curve
  const gradient = ctx.createLinearGradient(0, startY, 0, currentY);
  gradient.addColorStop(0, 'rgba(255, 23, 68, 0.0)');
  gradient.addColorStop(1, 'rgba(255, 23, 68, 0.25)');

  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.quadraticCurveTo(startX + (currentX - startX) * 0.4, startY, currentX, currentY);
  ctx.lineTo(currentX, startY);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Draw Stroke Line
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.quadraticCurveTo(startX + (currentX - startX) * 0.4, startY, currentX, currentY);
  ctx.strokeStyle = '#ff1744';
  ctx.lineWidth = 4;
  ctx.shadowColor = '#ff1744';
  ctx.shadowBlur = 15;
  ctx.stroke();
  ctx.shadowBlur = 0; // reset

  // Draw Airplane (Vector Icon)
  ctx.save();
  ctx.translate(currentX, currentY);
  ctx.rotate(-Math.PI / 12); // tilt plane upward
  ctx.fillStyle = '#ffffff';
  
  // Custom Red Aeroplane Body
  ctx.fillStyle = '#ff1744';
  ctx.beginPath();
  ctx.ellipse(0, 0, 16, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  
  // Plane Wing
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(-2, -2);
  ctx.lineTo(-8, -12);
  ctx.lineTo(2, -2);
  ctx.fill();

  ctx.restore();
}

// Socket Listeners
socket.on('init_state', (data) => {
  renderHistory(data.history);
  if (data.gameState === 'WAITING') {
    handleWaiting(data.countdown);
  }
});

socket.on('countdown_tick', (count) => {
  handleWaiting(count);
});

socket.on('flight_started', () => {
  gameState = 'FLYING';
  flightProgress = 0;
  waitingState.style.display = 'none';
  multiplierDisplay.classList.remove('crashed');
  multiplierDisplay.textContent = '1.00x';

  if (myActiveBet) {
    mainActionBtn.className = 'btn-action cashout';
    mainActionBtn.textContent = `CASH OUT ₹${(myActiveBet.amount).toFixed(2)}`;
  } else {
    mainActionBtn.disabled = true;
    mainActionBtn.className = 'btn-action bet';
    mainActionBtn.textContent = 'ROUND IN PROGRESS';
  }
});

socket.on('multiplier_update', (val) => {
  currentMultiplier = val;
  flightProgress += 0.08;
  multiplierDisplay.textContent = `${val.toFixed(2)}x`;

  if (myActiveBet && !myActiveBet.cashedOut) {
    const currentWin = (myActiveBet.amount * currentMultiplier).toFixed(2);
    mainActionBtn.textContent = `CASH OUT ₹${currentWin}`;
  }

  drawFlightCurve();
});

socket.on('flight_crashed', (data) => {
  gameState = 'CRASHED';
  multiplierDisplay.classList.add('crashed');
  multiplierDisplay.textContent = `FLEW AWAY @ ${data.crashPoint.toFixed(2)}x`;
  renderHistory(data.history);

  if (myActiveBet && !myActiveBet.cashedOut) {
    mainActionBtn.disabled = true;
    mainActionBtn.textContent = 'CRASHED!';
  }
  myActiveBet = null;
});

socket.on('bet_accepted', (data) => {
  myActiveBet = { amount: data.amount, cashedOut: false };
  if (currentUser) updateBalanceUI(currentUser.balance - data.amount);
  mainActionBtn.disabled = true;
  mainActionBtn.textContent = 'WAITING FLIGHT...';
});

socket.on('cash_out_success', (data) => {
  if (myActiveBet) myActiveBet.cashedOut = true;
  if (currentUser) updateBalanceUI(currentUser.balance + data.winAmount);
  mainActionBtn.disabled = true;
  mainActionBtn.textContent = `WON ₹${data.winAmount.toFixed(2)} (${data.multiplier}x)`;
});

socket.on('bet_error', (msg) => alert(msg));

// Handle Bet / Cashout Button
mainActionBtn.addEventListener('click', () => {
  if (!currentUser) return (authModal.classList.remove('hidden'));

  if (gameState === 'WAITING' && !myActiveBet) {
    const amount = parseFloat(betAmountInput.value);
    if (amount > currentUser.balance) return alert('Insufficient Balance!');
    socket.emit('place_bet', { amount });
  } else if (gameState === 'FLYING' && myActiveBet && !myActiveBet.cashedOut) {
    socket.emit('cash_out');
  }
});

function handleWaiting(count) {
  gameState = 'WAITING';
  waitingState.style.display = 'flex';
  countdownTimer.textContent = count;
  multiplierDisplay.textContent = 'READY';
  multiplierDisplay.classList.remove('crashed');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!myActiveBet) {
    mainActionBtn.disabled = false;
    mainActionBtn.className = 'btn-action bet';
    mainActionBtn.textContent = 'PLACE BET';
  }
}

function renderHistory(list) {
  historyContainer.innerHTML = '';
  list.forEach(val => {
    const pill = document.createElement('div');
    pill.className = `badge ${val >= 2.0 ? 'purple' : 'blue'}`;
    pill.textContent = `${val.toFixed(2)}x`;
    historyContainer.appendChild(pill);
  });
}
