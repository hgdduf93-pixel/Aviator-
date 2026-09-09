const socket = io();

// User state
let token = localStorage.getItem('avion_token') || null;
let user = null;

// Bet states
const bets = {
  1: { placed: false, active: false, amount: 100 },
  2: { placed: false, active: false, amount: 100 }
};

// Canvas Engine
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
let currentMultiplier = 1.00;
let gameState = 'WAITING';

function resizeCanvas() {
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = canvas.parentElement.clientHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function drawScene() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 1. Draw City Skyline Backdrop
  ctx.fillStyle = '#111216';
  const baseY = canvas.height - 20;
  const buildings = [
    [10, 40], [35, 70], [60, 50], [90, 85], [130, 45],
    [160, 110], [210, 60], [260, 90], [310, 50], [350, 75], [400, 40]
  ];
  buildings.forEach(([x, h]) => {
    ctx.fillRect(x, baseY - h, 24, h);
  });

  // 2. Draw Eiffel Tower Silhouette
  const towerX = canvas.width / 2;
  ctx.fillStyle = '#15171e';
  ctx.beginPath();
  ctx.moveTo(towerX - 25, baseY);
  ctx.lineTo(towerX - 6, baseY - 90);
  ctx.lineTo(towerX, baseY - 120);
  ctx.lineTo(towerX + 6, baseY - 90);
  ctx.lineTo(towerX + 25, baseY);
  ctx.fill();

  // Runway horizontal line
  ctx.strokeStyle = '#292c36';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, baseY);
  ctx.lineTo(canvas.width, baseY);
  ctx.stroke();

  // 3. Draw Plane Trajectory & Plane
  if (gameState === 'FLYING') {
    const progress = Math.min((currentMultiplier - 1.0) / 4.0, 1.0);
    const startX = 20;
    const startY = baseY;
    const targetX = 40 + progress * (canvas.width - 120);
    const targetY = baseY - 20 - (progress * (canvas.height - 70));

    // Curved tail trail
    ctx.strokeStyle = '#e63946';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.quadraticCurveTo(startX + (targetX - startX) * 0.4, baseY, targetX, targetY);
    ctx.stroke();

    // Red Shadow fill under trail
    ctx.fillStyle = 'rgba(230, 57, 70, 0.08)';
    ctx.lineTo(targetX, baseY);
    ctx.lineTo(startX, baseY);
    ctx.fill();

    // Draw White Jet Plane
    ctx.save();
    ctx.translate(targetX, targetY);
    ctx.rotate(-0.15 - progress * 0.2);

    ctx.fillStyle = '#ffffff';
    // Fuselage
    ctx.beginPath();
    ctx.ellipse(0, 0, 16, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    // Wing
    ctx.beginPath();
    ctx.moveTo(-4, 0);
    ctx.lineTo(-8, -12);
    ctx.lineTo(2, 0);
    ctx.fill();
    // Tail
    ctx.beginPath();
    ctx.moveTo(-12, 0);
    ctx.lineTo(-18, -8);
    ctx.lineTo(-14, 0);
    ctx.fill();

    ctx.restore();
  }

  requestAnimationFrame(drawScene);
}
requestAnimationFrame(drawScene);

// Socket Listeners
socket.on('init_game', (data) => {
  renderHistory(data.history);
  handleStateUpdate(data);
});

socket.on('game_state', (data) => {
  handleStateUpdate(data);
  if (data.history) renderHistory(data.history);
});

socket.on('wait_tick', (data) => {
  document.getElementById('statusMessage').innerText = `Wait for next round (${data.waitTimeLeft}s)`;
  document.getElementById('statusMessage').style.display = 'block';
  document.getElementById('multiplierText').style.display = 'none';
});

socket.on('multiplier_tick', (data) => {
  currentMultiplier = data.multiplier;
  const multElem = document.getElementById('multiplierText');
  multElem.innerText = `${currentMultiplier.toFixed(2)}x`;
  multElem.style.display = 'block';
  multElem.style.color = '#ffffff';
  document.getElementById('statusMessage').style.display = 'none';

  // Update dynamic cashout text on buttons
  [1, 2].forEach(panelId => {
    if (bets[panelId].active) {
      const btn = document.getElementById(`action-btn-${panelId}`);
      btn.className = 'action-btn active-bet';
      const winVal = (bets[panelId].amount * currentMultiplier).toFixed(2);
      document.getElementById(`btn-text-${panelId}`).innerText = `Cash Out ${winVal}`;
    }
  });
});

socket.on('game_crashed', (data) => {
  gameState = 'CRASHED';
  const multElem = document.getElementById('multiplierText');
  multElem.innerText = `FLEW AWAY! (${data.multiplier.toFixed(2)}x)`;
  multElem.style.color = '#e63946';
  renderHistory(data.history);

  // Reset active bets
  [1, 2].forEach(p => {
    bets[p].placed = false;
    bets[p].active = false;
    resetButtonUI(p);
  });
});

socket.on('bet_confirmed', (data) => {
  bets[data.panelId].placed = true;
  bets[data.panelId].amount = data.amount;
  updateUserBalance(data.newBalance);

  const btn = document.getElementById(`action-btn-${data.panelId}`);
  btn.className = 'action-btn cancel-bet';
  document.getElementById(`btn-text-${data.panelId}`).innerText = 'Waiting...';
});

socket.on('bet_cashed_out', (data) => {
  bets[data.panelId].active = false;
  bets[data.panelId].placed = false;
  updateUserBalance(data.newBalance);
  resetButtonUI(data.panelId);
  alert(`Cashed Out at ${data.multiplier}x! Won ${data.winAmount} Coins!`);
});

socket.on('error_msg', (data) => {
  alert(data.message);
});

function handleStateUpdate(data) {
  gameState = data.state;
  if (gameState === 'WAITING') {
    document.getElementById('statusMessage').style.display = 'block';
    document.getElementById('statusMessage').innerText = 'Bet Now';
    document.getElementById('multiplierText').style.display = 'none';

    // Check Auto Play
    [1, 2].forEach(p => {
      const isAuto = document.getElementById(`auto-play-${p}`).checked;
      if (isAuto && !bets[p].placed) {
        placeBet(p);
      }
    });
  } else if (gameState === 'FLYING') {
    [1, 2].forEach(p => {
      if (bets[p].placed) bets[p].active = true;
    });
  }
}

function renderHistory(list) {
  const container = document.getElementById('historyRibbon');
  container.innerHTML = '';
  list.slice().reverse().forEach(mult => {
    const pill = document.createElement('div');
    const colorClass = mult >= 2.0 ? 'green' : mult >= 1.2 ? 'blue' : 'red';
    pill.className = `pill ${colorClass}`;
    pill.innerText = `${mult.toFixed(2)}X`;
    container.appendChild(pill);
  });
}

// User Actions
function handleAction(panelId) {
  if (!token) return toggleAuthModal();

  if (gameState === 'WAITING') {
    if (!bets[panelId].placed) {
      placeBet(panelId);
    }
  } else if (gameState === 'FLYING' && bets[panelId].active) {
    socket.emit('cash_out', { token, panelId });
  }
}

function placeBet(panelId) {
  const amount = parseFloat(document.getElementById(`amount-${panelId}`).value);
  const autoCashToggle = document.getElementById(`auto-cash-toggle-${panelId}`).checked;
  const autoCashout = autoCashToggle ? parseFloat(document.getElementById(`auto-val-${panelId}`).value) : null;

  socket.emit('place_bet', { token, panelId, amount, autoCashout });
}

function resetButtonUI(p) {
  const btn = document.getElementById(`action-btn-${p}`);
  btn.className = 'action-btn';
  const val = document.getElementById(`amount-${p}`).value;
  document.getElementById(`btn-text-${p}`).innerText = `${val} COIN`;
}

function adjustBet(panel, delta) {
  const el = document.getElementById(`amount-${panel}`);
  let v = Math.max(10, parseFloat(el.value || 0) + delta);
  el.value = v.toFixed(2);
  if (!bets[panel].placed) resetButtonUI(panel);
}

function setAmount(panel, val) {
  document.getElementById(`amount-${panel}`).value = val.toFixed(2);
  if (!bets[panel].placed) resetButtonUI(panel);
}

function adjustAuto(panel, delta) {
  const el = document.getElementById(`auto-val-${panel}`);
  let v = Math.max(1.1, parseFloat(el.value || 2) + delta);
  el.value = v.toFixed(2);
}

// Coin deposit simulation
function openAddCoinsModal() { document.getElementById('addCoinsModal').classList.add('show'); }
function closeAddCoinsModal() { document.getElementById('addCoinsModal').classList.remove('show'); }

function depositCoins(amt) {
  if (!token) return toggleAuthModal();
  fetch('/api/add-coins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ amount: amt })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      updateUserBalance(data.coins);
      closeAddCoinsModal();
    }
  });
}

function updateUserBalance(val) {
  document.getElementById('userBalance').innerText = parseFloat(val).toFixed(2);
}

// Auth Handlers
function toggleAuthModal() {
  document.getElementById('authModal').classList.toggle('show');
}

function submitAuth(type) {
  const u = document.getElementById('authUsername').value;
  const p = document.getElementById('authPassword').value;

  fetch(`/api/${type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p })
  })
  .then(res => res.json())
  .then(data => {
    if (data.token) {
      token = data.token;
      localStorage.setItem('avion_token', token);
      updateUserBalance(data.user.coins);
      toggleAuthModal();
    } else {
      alert(data.error || 'Authentication error');
    }
  });
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  const c = document.getElementById('tabContent');
  if (tabName === 'my-bets') {
    c.innerHTML = '<div class="empty-state">No bet history recorded for this session.</div>';
  } else if (tabName === 'ratings') {
    c.innerHTML = '<div class="empty-state">Top Player: User9483 - 54.20X Win</div>';
  } else {
    c.innerHTML = '<div class="empty-state">Live bets will appear here</div>';
  }
}
