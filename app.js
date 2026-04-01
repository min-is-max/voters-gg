const config = window.VOTERS_CONFIG || { mode: "local" };
const INITIAL_COUNTS = { messi: 12533, ronaldo: 14021 };
const MAX_VOTES_PER_USER = 100;
const TIME_ZONE = "Asia/Seoul";
const LOCAL_STATE_KEY = "messi-vs-ronaldo-vote-state-v2";
const LOCAL_USER_KEY = "messi-vs-ronaldo-vote-user-v2";

const RANGE_LABELS = {
  hour: "시간별 비율",
  day: "일별 비율",
  month: "월별 비율",
  all: "전체 비율",
};

const state = {
  selectedRange: "hour",
  aggregates: {
    hour: { messi: 0, ronaldo: 0 },
    day: { messi: 0, ronaldo: 0 },
    month: { messi: 0, ronaldo: 0 },
    all: { ...INITIAL_COUNTS },
  },
  displayState: { messi: 0, ronaldo: 0 },
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
  centerLabel: document.querySelector("#center-label"),
  messiFill: document.querySelector("#messi-fill"),
  ronaldoFill: document.querySelector("#ronaldo-fill"),
  waveBoundary: document.querySelector("#wave-boundary"),
  waveHighlight: document.querySelector("#wave-highlight"),
  bubbleLayer: document.querySelector("#bubble-layer"),
  dropletLayer: document.querySelector("#droplet-layer"),
  voteButtons: document.querySelectorAll(".vote-button"),
  liveStatus: document.querySelector("#live-status"),
  rangeTabs: document.querySelectorAll(".range-tab"),
  allTotalVotes: document.querySelector("#all-total-votes"),
  allTotalMeta: document.querySelector("#all-total-meta"),
  todayTotalVotes: document.querySelector("#today-total-votes"),
  todayTotalMeta: document.querySelector("#today-total-meta"),
};

nodes.voteButtons.forEach((button) => {
  button.addEventListener("click", () => handleVote(button.dataset.player));
});

nodes.rangeTabs.forEach((button) => {
  button.addEventListener("click", () => {
    state.selectedRange = button.dataset.range;
    refreshRangeTabs();
    animateTo(getSelectedCounts());
    refreshSnapshots();
    refreshVoteButtons();
  });
});

refreshRangeTabs();
renderImmediate(getSelectedCounts());
refreshSnapshots();
startWaveLoop();
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
  const keys = getCurrentTimeKeys();

  await Promise.all([
    runTransaction(ref(db, "voteState"), (current) => current || createVoteState(INITIAL_COUNTS)),
    runTransaction(ref(db, "aggregates/all"), (current) => current || createCountRecord(INITIAL_COUNTS, true)),
    runTransaction(ref(db, `aggregates/day/${keys.dayKey}`), (current) => current || createCountRecord({ messi: 0, ronaldo: 0 })),
    runTransaction(ref(db, `aggregates/month/${keys.monthKey}`), (current) => current || createCountRecord({ messi: 0, ronaldo: 0 })),
    runTransaction(ref(db, `aggregates/hour/${keys.hourKey}`), (current) => current || createCountRecord({ messi: 0, ronaldo: 0 })),
  ]);

  state.castVote = async (player) => {
    if (!state.currentUid) {
      setStatus("익명 세션 연결 중입니다. 잠시 후 다시 시도해주세요.", "warn");
      return;
    }

    if (state.currentUserVotes.total >= MAX_VOTES_PER_USER) {
      setStatus(`익명 사용자당 최대 ${MAX_VOTES_PER_USER}표까지 가능합니다.`, "warn");
      return;
    }

    const previousTotal = state.currentUserVotes.total;
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

    const committedUserVotes = sanitizeUserVotes(userVoteResult.snapshot?.val());
    if (!userVoteResult.committed || committedUserVotes.total <= previousTotal) {
      setStatus(`익명 사용자당 최대 ${MAX_VOTES_PER_USER}표까지 가능합니다.`, "warn");
      return;
    }

    spawnDroplets(player);
    setStatus("투표 반영 중...", "live");

    const currentKeys = getCurrentTimeKeys();
    await Promise.all([
      runTransaction(ref(db, "voteState"), (current) => bumpCountRecord(current, player, true)),
      runTransaction(ref(db, "aggregates/all"), (current) => bumpCountRecord(current, player, true)),
      runTransaction(ref(db, `aggregates/day/${currentKeys.dayKey}`), (current) => bumpCountRecord(current, player, false)),
      runTransaction(ref(db, `aggregates/month/${currentKeys.monthKey}`), (current) => bumpCountRecord(current, player, false)),
      runTransaction(ref(db, `aggregates/hour/${currentKeys.hourKey}`), (current) => bumpCountRecord(current, player, false)),
    ]);
  };

  onAuthStateChanged(auth, (user) => {
    if (user) {
      state.currentUid = user.uid;
      state.isReadyToVote = true;
      onValue(ref(db, `userVotes/${user.uid}`), (snapshot) => {
        state.currentUserVotes = sanitizeUserVotes(snapshot.val());
        refreshVoteButtons();
      });
      refreshVoteButtons();
      return;
    }

    state.isReadyToVote = false;
    signInAnonymously(auth).catch((error) => {
      console.error("Anonymous auth failed", error);
      setStatus("익명 로그인에 실패했습니다. Firebase 설정을 확인해주세요.", "warn");
    });
  });

  onValue(ref(db, "aggregates/all"), (snapshot) => {
    state.aggregates.all = sanitizeCounts(snapshot.val()?.counts || snapshot.val(), true);
    refreshAllVisuals();
  });

  onValue(ref(db, "voteState"), (snapshot) => {
    const legacyCounts = sanitizeCounts(snapshot.val()?.counts || snapshot.val(), true);
    state.aggregates.all = {
      messi: Math.max(state.aggregates.all.messi, legacyCounts.messi),
      ronaldo: Math.max(state.aggregates.all.ronaldo, legacyCounts.ronaldo),
    };
    refreshAllVisuals();
  });

  onValue(ref(db, `aggregates/day/${keys.dayKey}`), (snapshot) => {
    state.aggregates.day = sanitizeCounts(snapshot.val()?.counts || snapshot.val(), false);
    refreshAllVisuals();
  });

  onValue(ref(db, `aggregates/month/${keys.monthKey}`), (snapshot) => {
    state.aggregates.month = sanitizeCounts(snapshot.val()?.counts || snapshot.val(), false);
    refreshAllVisuals();
  });

  onValue(ref(db, `aggregates/hour/${keys.hourKey}`), (snapshot) => {
    state.aggregates.hour = sanitizeCounts(snapshot.val()?.counts || snapshot.val(), false);
    refreshAllVisuals();
  });
}

function initLocalMode() {
  localChannel = "BroadcastChannel" in window ? new BroadcastChannel("messi-vs-ronaldo-vote-v2") : null;
  state.aggregates = sanitizeAggregateObject(loadLocalJson(LOCAL_STATE_KEY, state.aggregates));
  state.currentUserVotes = sanitizeUserVotes(loadLocalJson(LOCAL_USER_KEY, state.currentUserVotes));
  state.isReadyToVote = true;

  state.castVote = (player) => {
    if (state.currentUserVotes.total >= MAX_VOTES_PER_USER) {
      setStatus(`익명 사용자당 최대 ${MAX_VOTES_PER_USER}표까지 가능합니다.`, "warn");
      return;
    }

    spawnDroplets(player);
    state.currentUserVotes[player] += 1;
    state.currentUserVotes.total += 1;
    state.aggregates.hour[player] += 1;
    state.aggregates.day[player] += 1;
    state.aggregates.month[player] += 1;
    state.aggregates.all[player] += 1;
    persistLocalState();
    refreshAllVisuals();

    if (localChannel) {
      localChannel.postMessage({
        aggregates: state.aggregates,
        userVotes: state.currentUserVotes,
      });
    }
  };

  window.addEventListener("storage", (event) => {
    if (event.key === LOCAL_STATE_KEY && event.newValue) {
      state.aggregates = sanitizeAggregateObject(JSON.parse(event.newValue));
      refreshAllVisuals();
    }
    if (event.key === LOCAL_USER_KEY && event.newValue) {
      state.currentUserVotes = sanitizeUserVotes(JSON.parse(event.newValue));
      refreshVoteButtons();
    }
  });

  if (localChannel) {
    localChannel.addEventListener("message", (event) => {
      if (event.data?.aggregates) {
        state.aggregates = sanitizeAggregateObject(event.data.aggregates);
        refreshAllVisuals();
      }
      if (event.data?.userVotes) {
        state.currentUserVotes = sanitizeUserVotes(event.data.userVotes);
        refreshVoteButtons();
      }
    });
  }

  refreshAllVisuals();
}

function loadLocalJson(key, fallback) {
  const saved = localStorage.getItem(key);
  if (!saved) {
    return fallback;
  }
  try {
    return JSON.parse(saved);
  } catch (error) {
    console.error("Failed to parse local JSON", error);
    return fallback;
  }
}

function persistLocalState() {
  localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state.aggregates));
  localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(state.currentUserVotes));
}

function sanitizeAggregateObject(value) {
  return {
    hour: sanitizeCounts(value?.hour, false),
    day: sanitizeCounts(value?.day, false),
    month: sanitizeCounts(value?.month, false),
    all: sanitizeCounts(value?.all, true),
  };
}

function refreshAllVisuals() {
  animateTo(getSelectedCounts());
  refreshSnapshots();
  refreshVoteButtons();
}

function getSelectedCounts() {
  return state.aggregates[state.selectedRange] || state.aggregates.hour;
}

function refreshRangeTabs() {
  nodes.rangeTabs.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.range === state.selectedRange);
  });
  nodes.centerLabel.textContent = RANGE_LABELS[state.selectedRange];
}

function refreshSnapshots() {
  const allCounts = state.aggregates.all;
  const todayCounts = state.aggregates.day;
  nodes.allTotalVotes.textContent = formatNumber(allCounts.messi + allCounts.ronaldo);
  nodes.allTotalMeta.textContent = `Messi ${formatNumber(allCounts.messi)} · Ronaldo ${formatNumber(allCounts.ronaldo)}`;
  nodes.todayTotalVotes.textContent = formatNumber(todayCounts.messi + todayCounts.ronaldo);
  nodes.todayTotalMeta.textContent = `Messi ${formatNumber(todayCounts.messi)} · Ronaldo ${formatNumber(todayCounts.ronaldo)}`;
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
    setStatus(`${RANGE_LABELS[state.selectedRange]} · 내 남은 표 ${remainingVotes}`, "live");
    return;
  }

  setStatus(`로컬 데모 모드 · 내 남은 표 ${remainingVotes}`, "local");
}

function getCurrentTimeKeys() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
  return {
    hourKey: `${parts.year}-${parts.month}-${parts.day}-${parts.hour}`,
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    monthKey: `${parts.year}-${parts.month}`,
  };
}

function createVoteState(counts) {
  return { counts: sanitizeCounts(counts, true), updatedAt: Date.now() };
}

function createCountRecord(counts, floorToInitial = false) {
  return { counts: sanitizeCounts(counts, floorToInitial), updatedAt: Date.now() };
}

function bumpCountRecord(current, player, floorToInitial) {
  const next = current || createCountRecord({ messi: 0, ronaldo: 0 }, floorToInitial);
  const counts = sanitizeCounts(next.counts || next, floorToInitial);
  counts[player] += 1;
  return { counts, updatedAt: Date.now() };
}

function sanitizeCounts(value, floorToInitial = false) {
  const floorMessi = floorToInitial ? INITIAL_COUNTS.messi : 0;
  const floorRonaldo = floorToInitial ? INITIAL_COUNTS.ronaldo : 0;
  return {
    messi: Math.max(floorMessi, Number(value?.messi) || 0),
    ronaldo: Math.max(floorRonaldo, Number(value?.ronaldo) || 0),
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
  nodes.messiCount.textContent = formatNumber(current.messi);
  nodes.ronaldoCount.textContent = formatNumber(current.ronaldo);
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

function formatNumber(value) {
  return Math.round(value).toLocaleString("ko-KR");
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
      side === "left" ? "rgba(194, 241, 255, 0.34)" : "rgba(255, 189, 189, 0.3)"
    }"></circle>`;
  }

  nodes.bubbleLayer.innerHTML = markup;
}

function startWaveLoop() {
  function animate() {
    waveTick += 0.018;
    bubbleTick += 0.012;
    const ratio = getRatio(state.displayState);
    updateWave(48 + 424 * ratio, ratio, waveTick);
    updateBubbles(ratio, bubbleTick);
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
