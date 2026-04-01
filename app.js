const config = window.VOTERS_CONFIG || { mode: "local" };

const state = {
  counts: { messi: 0, ronaldo: 0 },
  displayState: { messi: 0, ronaldo: 0 },
  currentUserVote: null,
  currentUid: null,
  isReadyToVote: false,
};

let animationFrame = 0;
let waveTick = 0;
let bubbleTick = 0;
let localChannel = null;

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
  voteButtons: document.querySelectorAll(".vote-button"),
  liveStatus: document.querySelector("#live-status"),
  syncNote: document.querySelector("#sync-note"),
};

renderImmediate(state.displayState);
startWaveLoop();

nodes.voteButtons.forEach((button) => {
  button.addEventListener("click", () => handleVote(button.dataset.player));
});

boot();

async function boot() {
  if (config.mode === "firebase" && config.firebase?.projectId) {
    setStatus("공용 실시간 투표 서버에 연결 중...", "live");
    try {
      await initFirebaseMode();
      return;
    } catch (error) {
      console.error("Firebase mode failed, falling back to local mode", error);
      setStatus("Firebase 연결에 실패해서 로컬 모드로 전환했습니다.", "warn");
      nodes.syncNote.textContent = "지금은 이 브라우저 안에서만 투표가 저장됩니다.";
    }
  }

  initLocalMode();
}

async function initFirebaseMode() {
  const [{ initializeApp }, authSdk, dbSdk] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/12.7.0/firebase-database.js"),
  ]);

  const { getAuth, onAuthStateChanged, signInAnonymously } = authSdk;
  const { getDatabase, onValue, ref, runTransaction } = dbSdk;

  const app = initializeApp(config.firebase);
  const auth = getAuth(app);
  const db = getDatabase(app);
  const voteStateRef = ref(db, "voteState");

  const castVote = async (player) => {
    if (!state.currentUid) {
      setStatus("사용자 세션을 연결하는 중입니다. 잠시 후 다시 눌러주세요.", "warn");
      return;
    }

    spawnDroplets(player);
    setStatus("표를 반영하는 중...", "live");

    await runTransaction(voteStateRef, (current) => {
      const next = current || { counts: { messi: 0, ronaldo: 0 }, voters: {} };
      const counts = {
        messi: Math.max(0, Number(next.counts?.messi) || 0),
        ronaldo: Math.max(0, Number(next.counts?.ronaldo) || 0),
      };
      const voters = { ...(next.voters || {}) };
      const previousVote = voters[state.currentUid];

      if (previousVote === player) {
        return next;
      }

      if (previousVote === "messi" || previousVote === "ronaldo") {
        counts[previousVote] = Math.max(0, counts[previousVote] - 1);
      }

      counts[player] += 1;
      voters[state.currentUid] = player;

      return {
        counts,
        voters,
        updatedAt: Date.now(),
      };
    });
  };

  state.castVote = castVote;

  onAuthStateChanged(auth, (user) => {
    if (user) {
      state.currentUid = user.uid;
      state.isReadyToVote = true;
      setStatus("전 세계 사용자와 실시간 동기화 중", "live");
      return;
    }

    state.isReadyToVote = false;
    signInAnonymously(auth).catch((error) => {
      console.error("Anonymous auth failed", error);
      setStatus("익명 로그인에 실패했습니다. Firebase 설정을 확인해주세요.", "warn");
    });
  });

  onValue(voteStateRef, (snapshot) => {
    const next = snapshot.val() || {};
    const counts = sanitizeCounts(next.counts || next);
    state.currentUserVote = next.voters?.[state.currentUid] || null;
    state.counts = counts;
    animateTo(counts);
    refreshVoteButtons();
  });
}

function initLocalMode() {
  const STORAGE_KEY = "messi-vs-ronaldo-vote";
  localChannel = "BroadcastChannel" in window ? new BroadcastChannel("messi-vs-ronaldo") : null;
  state.counts = loadLocalCounts(STORAGE_KEY);
  state.displayState = { ...state.counts };
  state.isReadyToVote = true;
  state.castVote = (player) => {
    const next = {
      ...state.counts,
      [player]: state.counts[player] + 1,
    };

    spawnDroplets(player);
    state.counts = next;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));

    if (localChannel) {
      localChannel.postMessage(next);
    }

    animateTo(next);
  };

  renderImmediate(state.displayState);
  setStatus("로컬 데모 모드", "local");
  nodes.syncNote.textContent = "Firebase를 연결하면 모든 방문자에게 실시간으로 공유됩니다.";

  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) {
      return;
    }

    try {
      const next = JSON.parse(event.newValue);
      state.counts = sanitizeCounts(next);
      animateTo(state.counts);
    } catch (error) {
      console.error("Failed to parse local vote state", error);
    }
  });

  if (localChannel) {
    localChannel.addEventListener("message", (event) => {
      state.counts = sanitizeCounts(event.data);
      animateTo(state.counts);
    });
  }
}

function loadLocalCounts(storageKey) {
  const saved = localStorage.getItem(storageKey);

  if (!saved) {
    return { messi: 0, ronaldo: 0 };
  }

  try {
    return sanitizeCounts(JSON.parse(saved));
  } catch (error) {
    console.error("Failed to read local vote state", error);
    return { messi: 0, ronaldo: 0 };
  }
}

function handleVote(player) {
  if (!state.isReadyToVote || typeof state.castVote !== "function") {
    setStatus("연결이 준비되면 투표할 수 있습니다. 잠시만 기다려주세요.", "warn");
    return;
  }

  state.castVote(player);
}

function sanitizeCounts(value) {
  return {
    messi: Math.max(0, Number(value?.messi) || 0),
    ronaldo: Math.max(0, Number(value?.ronaldo) || 0),
  };
}

function animateTo(target) {
  cancelAnimationFrame(animationFrame);
  const start = { ...state.displayState };
  const startedAt = performance.now();
  const duration = 900;

  function frame(now) {
    const progress = Math.min((now - startedAt) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);

    state.displayState = {
      messi: start.messi + (target.messi - start.messi) * eased,
      ronaldo: start.ronaldo + (target.ronaldo - start.ronaldo) * eased,
    };

    renderImmediate(state.displayState);

    if (progress < 1) {
      animationFrame = requestAnimationFrame(frame);
      return;
    }

    state.displayState = { ...target };
    renderImmediate(state.displayState);
  }

  animationFrame = requestAnimationFrame(frame);
}

function renderImmediate(current) {
  const total = current.messi + current.ronaldo;
  const messiRatio = total === 0 ? 0.5 : current.messi / total;
  const ronaldoRatio = 1 - messiRatio;

  nodes.messiCount.textContent = Math.round(current.messi).toLocaleString("ko-KR");
  nodes.ronaldoCount.textContent = Math.round(current.ronaldo).toLocaleString("ko-KR");
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

function refreshVoteButtons() {
  nodes.voteButtons.forEach((button) => {
    const isMine = state.currentUserVote === button.dataset.player;
    button.classList.toggle("vote-button-active", isMine);
    button.textContent = isMine
      ? `${button.dataset.player === "messi" ? "메시" : "호날두"}에게 투표함`
      : `${button.dataset.player === "messi" ? "메시" : "호날두"}에게 투표`;
  });
}

function setStatus(message, mode) {
  nodes.liveStatus.textContent = message;
  nodes.liveStatus.dataset.mode = mode;
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
    updateWave(48 + 424 * getRatio(state.displayState), getRatio(state.displayState), waveTick);
    updateBubbles(getRatio(state.displayState), bubbleTick);
    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}

function getRatio(current) {
  const total = current.messi + current.ronaldo;
  return total === 0 ? 0.5 : current.messi / total;
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
