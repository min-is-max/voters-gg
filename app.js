const STORAGE_KEY = "messi-vs-ronaldo-vote";
const channel = "BroadcastChannel" in window ? new BroadcastChannel("messi-vs-ronaldo") : null;

const counts = loadCounts();
let displayState = { ...counts };
let animationFrame = 0;
let waveTick = 0;
let bubbleTick = 0;

const nodes = {
  messiCount: document.querySelector("#messi-count"),
  ronaldoCount: document.querySelector("#ronaldo-count"),
  messiPercent: document.querySelector("#messi-percent"),
  ronaldoPercent: document.querySelector("#ronaldo-percent"),
  centerRatio: document.querySelector("#center-ratio"),
  messiFill: document.querySelector("#messi-fill"),
  ronaldoFill: document.querySelector("#ronaldo-fill"),
  waveBoundary: document.querySelector("#wave-boundary"),
  waveHighlight: document.querySelector("#wave-highlight"),
  bubbleLayer: document.querySelector("#bubble-layer"),
  dropletLayer: document.querySelector("#droplet-layer"),
  resetButton: document.querySelector("#reset-button"),
  voteButtons: document.querySelectorAll(".vote-button"),
};

renderImmediate(displayState);
startWaveLoop();

nodes.voteButtons.forEach((button) => {
  button.addEventListener("click", () => handleVote(button.dataset.player));
});

nodes.resetButton.addEventListener("click", () => {
  const next = { messi: 0, ronaldo: 0 };
  updateCounts(next, "reset");
});

window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY || !event.newValue) {
    return;
  }

  try {
    const next = JSON.parse(event.newValue);
    syncFromOutside(next);
  } catch (error) {
    console.error("Failed to parse synced vote state", error);
  }
});

if (channel) {
  channel.addEventListener("message", (event) => {
    syncFromOutside(event.data);
  });
}

function loadCounts() {
  const saved = localStorage.getItem(STORAGE_KEY);

  if (!saved) {
    return { messi: 0, ronaldo: 0 };
  }

  try {
    const parsed = JSON.parse(saved);
    return sanitizeCounts(parsed);
  } catch (error) {
    console.error("Failed to read saved vote state", error);
    return { messi: 0, ronaldo: 0 };
  }
}

function sanitizeCounts(value) {
  return {
    messi: Math.max(0, Number(value?.messi) || 0),
    ronaldo: Math.max(0, Number(value?.ronaldo) || 0),
  };
}

function handleVote(player) {
  const next = {
    ...counts,
    [player]: counts[player] + 1,
  };

  spawnDroplets(player);
  updateCounts(next, "vote");
}

function updateCounts(nextCounts, source) {
  counts.messi = nextCounts.messi;
  counts.ronaldo = nextCounts.ronaldo;

  localStorage.setItem(STORAGE_KEY, JSON.stringify(counts));

  if (channel) {
    channel.postMessage(counts);
  }

  animateTo(counts);

  if (source === "reset") {
    clearDroplets();
  }
}

function syncFromOutside(nextCounts) {
  const sanitized = sanitizeCounts(nextCounts);
  counts.messi = sanitized.messi;
  counts.ronaldo = sanitized.ronaldo;
  animateTo(counts);
}

function animateTo(target) {
  cancelAnimationFrame(animationFrame);
  const start = { ...displayState };
  const startedAt = performance.now();
  const duration = 900;

  function frame(now) {
    const progress = Math.min((now - startedAt) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);

    displayState = {
      messi: start.messi + (target.messi - start.messi) * eased,
      ronaldo: start.ronaldo + (target.ronaldo - start.ronaldo) * eased,
    };

    renderImmediate(displayState);

    if (progress < 1) {
      animationFrame = requestAnimationFrame(frame);
      return;
    }

    displayState = { ...target };
    renderImmediate(displayState);
  }

  animationFrame = requestAnimationFrame(frame);
}

function renderImmediate(state) {
  const total = state.messi + state.ronaldo;
  const messiRatio = total === 0 ? 0.5 : state.messi / total;
  const ronaldoRatio = 1 - messiRatio;

  nodes.messiCount.textContent = Math.round(state.messi).toLocaleString("ko-KR");
  nodes.ronaldoCount.textContent = Math.round(state.ronaldo).toLocaleString("ko-KR");
  nodes.messiPercent.textContent = `${Math.round(messiRatio * 100)}%`;
  nodes.ronaldoPercent.textContent = `${Math.round(ronaldoRatio * 100)}%`;
  nodes.centerRatio.textContent = `${Math.round(messiRatio * 100)} : ${Math.round(ronaldoRatio * 100)}`;

  const leftWidth = 424 * messiRatio;
  const rightWidth = 424 - leftWidth;
  const splitX = 48 + leftWidth;

  nodes.messiFill.setAttribute("width", `${leftWidth}`);
  nodes.ronaldoFill.setAttribute("x", `${splitX}`);
  nodes.ronaldoFill.setAttribute("width", `${Math.max(rightWidth, 0)}`);

  updateWave(splitX, messiRatio, waveTick);
  updateBubbles(messiRatio, bubbleTick);
}

function updateWave(splitX, messiRatio, tick) {
  const top = 46;
  const bottom = 594;
  const amplitude = 10 + Math.abs(messiRatio - 0.5) * 16;
  const width = 26;
  const segments = 10;
  let path = `M ${splitX - width} ${top} `;

  for (let i = 0; i <= segments; i += 1) {
    const y = top + (i / segments) * (bottom - top);
    const sway = Math.sin(tick * 1.8 + i * 0.9) * amplitude;
    const x = splitX + sway;

    if (i === 0) {
      path += `L ${x} ${y} `;
      continue;
    }

    const prevY = top + ((i - 1) / segments) * (bottom - top);
    const midY = (prevY + y) / 2;
    path += `Q ${splitX + sway} ${midY}, ${x} ${y} `;
  }

  path += `L ${splitX + width} ${bottom} L ${splitX + width} ${top} Z`;
  nodes.waveBoundary.setAttribute("d", path);

  let line = "";
  for (let i = 0; i <= 28; i += 1) {
    const y = top + (i / 28) * (bottom - top);
    const sway = Math.sin(tick * 1.8 + i * 0.82) * amplitude;
    const x = splitX + sway;
    line += `${i === 0 ? "M" : "L"} ${x} ${y} `;
  }
  nodes.waveHighlight.setAttribute("d", line);
}

function updateBubbles(messiRatio, tick) {
  const totalBubbles = 12;
  const splitX = 48 + 424 * messiRatio;
  let markup = "";

  for (let i = 0; i < totalBubbles; i += 1) {
    const side = i % 2 === 0 ? "left" : "right";
    const baseX = side === "left" ? 72 : splitX + 18;
    const laneWidth = side === "left" ? Math.max(splitX - 72, 36) : Math.max(456 - splitX, 36);
    const x = baseX + ((i * 37 + tick * 120) % laneWidth);
    const y = 560 - ((tick * 90 + i * 43) % 460);
    const size = 6 + ((i * 3) % 10);
    markup += `<circle class="bubble" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size}" fill="${
      side === "left" ? "rgba(194, 241, 255, 0.34)" : "rgba(255, 236, 165, 0.3)"
    }"></circle>`;
  }

  nodes.bubbleLayer.innerHTML = markup;
}

function startWaveLoop() {
  function animate() {
    waveTick += 0.018;
    bubbleTick += 0.012;
    updateWave(48 + 424 * getRatio(displayState), getRatio(displayState), waveTick);
    updateBubbles(getRatio(displayState), bubbleTick);
    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}

function getRatio(state) {
  const total = state.messi + state.ronaldo;
  return total === 0 ? 0.5 : state.messi / total;
}

function spawnDroplets(player) {
  const count = 6;

  for (let i = 0; i < count; i += 1) {
    const droplet = document.createElement("span");
    droplet.className = `droplet ${player === "messi" ? "droplet-left" : "droplet-right"}`;
    droplet.style.left = `${player === "messi" ? 25 + i * 4 : 75 - i * 4}%`;
    droplet.style.animationDelay = `${i * 80}ms`;
    droplet.style.animationDuration = `${820 + i * 60}ms`;
    nodes.dropletLayer.appendChild(droplet);
    setTimeout(() => droplet.remove(), 1400 + i * 60);
  }
}

function clearDroplets() {
  nodes.dropletLayer.innerHTML = "";
}
