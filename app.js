const config = window.VOTERS_CONFIG || { mode: "local" };
const INITIAL_COUNTS = { messi: 12533, ronaldo: 14021 };
const MAX_VOTES_PER_USER = 100;
const LOCAL_COUNTS_KEY = "messi-vs-ronaldo-vote";
const LOCAL_USER_KEY = "messi-vs-ronaldo-vote-user";

const state = {
  counts: { ...INITIAL_COUNTS },
  displayState: { ...INITIAL_COUNTS },
  currentUserVotes: { messi: 0, ronaldo: 0, total: 0 },
  currentUid: null,
  isReadyToVote: false,
  castVote: null,
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
};

renderImmediate(state.displayState);
startWaveLoop();

nodes.voteButtons.forEach((button) => {
  button.addEventListener("click", () => handleVote(button.dataset.player));
});

boot();

async function boot() {
  if (config.mode === "firebase" && config.firebase?.projectId) {
    setStatus("실시간 투표 서버에 연결 중...", "live");

    try {
      await initFirebaseMode();
      return;
    } catch (error) {
      console.error("Firebase mode failed, falling back to local mode", error);
      setStatus("Firebase 연결 실패, 로컬 모드로 전환했습니다.", "warn");
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

  state.castVote = async (player) => {
    if (!state.currentUid) {
      setStatus("익명 세션 연결 중입니다. 잠시 후 다시 시도해주세요.", "warn");
      return;
    }

    if (state.currentUserVotes.total >= MAX_VOTES_PER_USER) {
      setStatus(`익명 사용자당 최대 ${MAX_VOTES_PER_USER}표까지 가능합니다.`, "warn");
      return;
    }

    spawnDroplets(player);
    setStatus("투표 반영 중...", "live");

    const userVotesRef = ref(db, `userVotes/${state.currentUid}`);

    const userVoteResult = await runTransaction(userVotesRef, (current) => {
      const next = sanitizeUserVotes(current);

      if (next.total >= MAX_VOTES_PER_USER) {
        return next;
      }

      next[player] += 1;
      next.total += 1;
      next.updatedAt = Date.now();
      return next;
    });

    if (!userVoteResult.committed) {
      setStatus(`익명 사용자당 최대 ${MAX_VOTES_PER_USER}표까지 가능합니다.`, "warn");
      return;
    }

    const committedUserVotes = sanitizeUserVotes(userVoteResult.snapshot?.val());
    if (committedUserVotes.total > MAX_VOTES_PER_USER) {
      setStatus(`익명 사용자당 최대 ${MAX_VOTES_PER_USER}표까지 가능합니다.`, "warn");
      return;
    }

    if (committedUserVotes.total === state.currentUserVotes.total) {
      setStatus(`익명 사용자당 최대 ${MAX_VOTES_PER_USER}표까지 가능합니다.`, "warn");
      return;
    }

    await runTransaction(voteStateRef, (current) => {
      const next = current || createInitialVoteState();
      const counts = sanitizeCounts(next.counts);
      counts[player] += 1;

      return {
        counts,
        updatedAt: Date.now(),
      };
    });
  };

  await runTransaction(voteStateRef, (current) => current || createInitialVoteState());

  onAuthStateChanged(auth, (user) => {
    if (user) {
      state.currentUid = user.uid;
      state.isReadyToVote = true;

      const userVotesRef = ref(db, `userVotes/${user.uid}`);
      onValue(userVotesRef, (snapshot) => {
        state.currentUserVotes = sanitizeUserVotes(snapshot.val());
        refreshVoteButtons();
      });

      setStatus(`실시간 동기화 완료 · 내 남은 표 ${MAX_VOTES_PER_USER}`, "live");
      return;
    }

    state.isReadyToVote = false;
    signInAnonymously(auth).catch((error) => {
      console.error("Anonymous auth failed", error);
      setStatus("익명 로그인에 실패했습니다. Firebase 설정을 확인해주세요.", "warn");
    });
  });

  onValue(voteStateRef, (snapshot) => {
    const next = snapshot.val() || createInitialVoteState();
    state.counts = sanitizeCounts(next.counts || next);
    animateTo(state.counts);
    refreshVoteButtons();
  });
}

function initLocalMode() {
  localChannel = "BroadcastChannel" in window ? new BroadcastChannel("messi-vs-ronaldo") : null;
  state.counts = loadLocalCounts();
  state.displayState = { ...state.counts };
  state.currentUserVotes = loadLocalUserVotes();
  state.isReadyToVote = true;

  state.castVote = (player) => {
    if (state.currentUserVotes.total >= MAX_VOTES_PER_USER) {
      setStatus(`익명 사용자당 최대 ${MAX_VOTES_PER_USER}표까지 가능합니다.`, "warn");
      return;
    }

    spawnDroplets(player);

    state.currentUserVotes[player] += 1;
    state.currentUserVotes.total += 1;
    state.counts[player] += 1;

    persistLocalState();
    animateTo(state.counts);
    refreshVoteButtons();

    if (localChannel) {
      localChannel.postMessage({
        counts: state.counts,
        userVotes: state.currentUserVotes,
      });
    }
  };

  window.addEventListener("storage", (event) => {
    if (event.key === LOCAL_COUNTS_KEY && event.newValue) {
      try {
        state.counts = sanitizeCounts(JSON.parse(event.newValue));
        animateTo(state.counts);
      } catch (error) {
        console.error("Failed to parse local vote state", error);
      }
    }

    if (event.key === LOCAL_USER_KEY && event.newValue) {
      try {
        state.currentUserVotes = sanitizeUserVotes(JSON.parse(event.newValue));
        refreshVoteButtons();
      } catch (error) {
        console.error("Failed to parse local user state", error);
      }
    }
  });

  if (localChannel) {
    localChannel.addEventListener("message", (event) => {
      if (event.data?.counts) {
        state.counts = sanitizeCounts(event.data.counts);
        animateTo(state.counts);
      }

      if (event.data?.userVotes) {
        state.currentUserVotes = sanitizeUserVotes(event.data.userVotes);
        refreshVoteButtons();
      }
    });
  }

  setStatus(`로컬 데모 모드 · 내 남은 표 ${MAX_VOTES_PER_USER - state.currentUserVotes.total}`, "local");
  refreshVoteButtons();
}

function persistLocalState() {
  localStorage.setItem(LOCAL_COUNTS_KEY, JSON.stringify(state.counts));
  localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(state.currentUserVotes));
}

function loadLocalCounts() {
  const saved = localStorage.getItem(LOCAL_COUNTS_KEY);

  if (!saved) {
    return { ...INITIAL_COUNTS };
  }

  try {
    return sanitizeCounts(JSON.parse(saved));
  } catch (error) {
    console.error("Failed to read local vote state", error);
    return { ...INITIAL_COUNTS };
  }
}

function loadLocalUserVotes() {
  const saved = localStorage.getItem(LOCAL_USER_KEY);

  if (!saved) {
    return { messi: 0, ronaldo: 0, total: 0 };
  }

  try {
    return sanitizeUserVotes(JSON.parse(saved));
  } catch (error) {
    console.error("Failed to read local user vote state", error);
    return { messi: 0, ronaldo: 0, total: 0 };
  }
}

function createInitialVoteState() {
  return {
    counts: { ...INITIAL_COUNTS },
    updatedAt: Date.now(),
  };
}

function sanitizeCounts(value) {
  return {
    messi: Math.max(INITIAL_COUNTS.messi, Number(value?.messi) || 0),
    ronaldo: Math.max(INITIAL_COUNTS.ronaldo, Number(value?.ronaldo) || 0),
  };
}

function sanitizeUserVotes(value) {
  const messi = Math.max(0, Number(value?.messi) || 0);
  const ronaldo = Math.max(0, Number(value?.ronaldo) || 0);
  const total = Math.max(0, Number(value?.total) || messi + ronaldo);

  return { messi, ronaldo, total };
}

function handleVote(player) {
  if (!state.isReadyToVote || typeof state.castVote !== "function") {
    setStatus("연결 준비 중입니다. 잠시 후 다시 눌러주세요.", "warn");
    return;
  }

  state.castVote(player);
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
  const splitX = 48 + leftWidth;

  nodes.messiFill.setAttribute("width", `${leftWidth}`);
  nodes.ronaldoFill.setAttribute("x", `${splitX}`);
  nodes.ronaldoFill.setAttribute("width", `${Math.max(424 - leftWidth, 0)}`);

  updateWave(splitX, messiRatio, waveTick);
  updateBubbles(messiRatio, bubbleTick);
}

function refreshVoteButtons() {
  const remainingVotes = Math.max(0, MAX_VOTES_PER_USER - state.currentUserVotes.total);

  nodes.voteButtons.forEach((button) => {
    const player = button.dataset.player;
    const casted = state.currentUserVotes[player];
    button.textContent = `${player === "messi" ? "메시" : "호날두"}에게 투표 (${casted}/${MAX_VOTES_PER_USER})`;
    button.disabled = remainingVotes === 0;
    button.classList.toggle("vote-button-active", casted > 0);
  });

  if (remainingVotes === 0) {
    setStatus(`이 익명 세션은 ${MAX_VOTES_PER_USER}표를 모두 사용했습니다.`, "warn");
    return;
  }

  if (config.mode === "firebase") {
    setStatus(`실시간 동기화 중 · 내 남은 표 ${remainingVotes}`, "live");
    return;
  }

  setStatus(`로컬 데모 모드 · 내 남은 표 ${remainingVotes}`, "local");
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
