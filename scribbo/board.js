/* =========================================================
   SCRIBBO — board.js
   Step 2: local canvas drawing.
   Step 3: session lifecycle wired up (auth, attach, participants).
   Step 4: real-time stroke sync.
   Step 5: mobile/touch polish — palm rejection, dvh sizing,
           connection status, session-ended overlay, pen widths,
           live name labels for in-progress remote strokes.
   Strokes are stored in a normalized (0-1) coordinate space
   so they look consistent across different screen sizes.
   ========================================================= */

(() => {
  // ---------- URL params ----------
  const urlParams = new URLSearchParams(window.location.search);
  const sessionCode = (urlParams.get('code') || '').toUpperCase();
  const role        = urlParams.get('role') === 'teacher' ? 'teacher' : 'student';
  const userName    = urlParams.get('name') || sessionStorage.getItem('scribbo:name') ||
                      (role === 'teacher' ? 'Teacher' : 'Student');

  if (!sessionCode || sessionCode.length !== 6) {
    alert('No valid session code in the URL. Returning to home.');
    window.location.href = 'index.html';
    return;
  }

  // ---------- DOM ----------
  const canvas       = document.getElementById('board-canvas');
  const ctx          = canvas.getContext('2d');
  const stage        = document.querySelector('.canvas-stage');
  const hint         = document.querySelector('.canvas-hint');
  const swatches     = document.querySelectorAll('.swatch');
  const widthBtns    = document.querySelectorAll('.width-btn');
  const toolBtns     = document.querySelectorAll('.tool-btn');
  const clearBtn     = [...toolBtns].find(b => b.title === 'Clear board');
  const penBtn       = [...toolBtns].find(b => b.title === 'Pen');
  const saveBtn      = document.querySelector('.icon-btn[title="Save as image"]');
  const peopleBtn    = document.querySelector('.icon-btn[title="Participants"]');
  const fullscreenBtn = document.getElementById('fullscreen-btn');
  const participants = document.querySelector('.participants');
  const codeDisplay  = document.querySelector('.code-display');
  const codeValueEl  = document.getElementById('session-code');
  const endBtn       = document.querySelector('.btn-end');
  const participantList  = document.getElementById('participant-list');
  const participantCount = document.getElementById('participant-count');
  const liveLabelsEl     = document.getElementById('live-labels');
  const connStatus       = document.getElementById('connection-status');
  const endedOverlay     = document.getElementById('ended-overlay');
  const loadingOverlay   = document.getElementById('loading-overlay');

  // Show the real session code immediately
  codeValueEl.textContent = sessionCode;
  document.title = `Scribbo — ${sessionCode}`;

  // ---------- State ----------
  const state = {
    color: '#1a1a1a',
    width: 4,
    drawing: false,
    activePointerId: null,       // only one pointer draws at a time (palm rejection)
    seenPenInput: false,         // once we've seen a pen, ignore touch (Apple Pencil mode)
    currentStroke: null,         // stroke being drawn right now (local user)
    strokes: [],                 // all completed strokes (normalized coords)
    syncedStrokeIds: new Set(),  // Firebase keys we've already drawn (avoid double-render)
    liveStrokes: new Map(),      // userId -> in-progress stroke from other users
    dpr: window.devicePixelRatio || 1,
    cssWidth: 0,                 // canvas size in CSS pixels
    cssHeight: 0,
    hintVisible: true,
    me: null,                    // participant object once attached
    role,                        // 'teacher' or 'student'
    unsubStrokes: null,
    unsubLive: null,
    unsubMeta: null,
    participantsByUid: new Map(),  // uid -> participant (for label lookups)
    ended: false,
  };

  // ---------- Throttling for live stroke publishing ----------
  const LIVE_PUBLISH_INTERVAL_MS = 50;   // 20fps
  let livePublishTimer = null;
  let livePublishPending = false;
  function schedulePublishLive() {
    if (!Scribbo.isReady() || !state.currentStroke) return;
    if (livePublishTimer) { livePublishPending = true; return; }
    publishLiveNow();
    livePublishTimer = setTimeout(() => {
      livePublishTimer = null;
      if (livePublishPending) {
        livePublishPending = false;
        schedulePublishLive();
      }
    }, LIVE_PUBLISH_INTERVAL_MS);
  }
  function publishLiveNow() {
    if (!state.currentStroke) return;
    Scribbo.publishLiveStroke(sessionCode, state.currentStroke).catch(() => {});
  }

  // ---------- Canvas sizing (high-DPI aware) ----------
  // ---------- Board geometry ----------
  // A "board" is a fixed 16:10 logical rectangle, letterboxed into the available
  // canvas-stage space. Strokes are stored in board coords normalized 0-1.
  const BOARD_ASPECT = 16 / 10;     // width / height

  // Board placement in CSS pixels (recomputed on resize)
  const board = {
    width:  0,    // board pixel width on screen
    height: 0,    // board pixel height on screen
    offsetX: 0,   // letterbox offset from left edge of canvas (CSS px)
    offsetY: 0,   // letterbox offset from top edge of canvas (CSS px)
  };

  function resizeCanvas() {
    const rect = stage.getBoundingClientRect();
    state.cssWidth  = rect.width;
    state.cssHeight = rect.height;
    state.dpr = window.devicePixelRatio || 1;

    canvas.width  = Math.floor(rect.width  * state.dpr);
    canvas.height = Math.floor(rect.height * state.dpr);
    canvas.style.width  = rect.width  + 'px';
    canvas.style.height = rect.height + 'px';

    // Reset transform and scale to DPR so we draw in CSS pixels
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    // Compute the largest 16:10 rectangle that fits inside the stage
    const stageAspect = state.cssWidth / state.cssHeight;
    if (stageAspect > BOARD_ASPECT) {
      // Stage is wider than the board — letterbox on the left/right
      board.height = state.cssHeight;
      board.width  = state.cssHeight * BOARD_ASPECT;
      board.offsetX = (state.cssWidth - board.width) / 2;
      board.offsetY = 0;
    } else {
      // Stage is taller than the board — letterbox on top/bottom
      board.width  = state.cssWidth;
      board.height = state.cssWidth / BOARD_ASPECT;
      board.offsetX = 0;
      board.offsetY = (state.cssHeight - board.height) / 2;
    }

    // Position the dotted-paper background to match the board area exactly.
    // (Set as inline custom properties so the CSS rule can reference them.)
    stage.style.setProperty('--board-w', board.width + 'px');
    stage.style.setProperty('--board-h', board.height + 'px');
    stage.style.setProperty('--board-x', board.offsetX + 'px');
    stage.style.setProperty('--board-y', board.offsetY + 'px');

    redraw();
  }

  // ---------- Coordinate helpers ----------
  // Strokes are stored normalized 0-1 in BOARD coordinate space (both axes).
  function toNormalized(cssX, cssY) {
    return {
      x: (cssX - board.offsetX) / board.width,
      y: (cssY - board.offsetY) / board.height,
    };
  }
  function fromNormalized(nx, ny) {
    return {
      x: board.offsetX + nx * board.width,
      y: board.offsetY + ny * board.height,
    };
  }
  // True if a CSS-pixel point falls inside the board area (vs. the letterbox)
  function isInsideBoard(cssX, cssY) {
    return cssX >= board.offsetX && cssX <= board.offsetX + board.width
        && cssY >= board.offsetY && cssY <= board.offsetY + board.height;
  }

  function getPointerCss(e) {
    const rect = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return {
      x: t.clientX - rect.left,
      y: t.clientY - rect.top,
    };
  }

  // ---------- Drawing primitives ----------
  // The pen width values (2 / 4 / 8) are tuned for a ~1280px-wide board.
  // We scale them up/down on other devices so a "medium" line looks similar everywhere.
  const REFERENCE_BOARD_WIDTH = 1280;
  function scaledWidth(strokeWidth) {
    const scale = board.width / REFERENCE_BOARD_WIDTH;
    // Clamp so lines stay readable on tiny boards (phones) without going microscopic
    return Math.max(1, strokeWidth * Math.max(scale, 0.5));
  }

  function drawStroke(stroke) {
    const pts = stroke.points;
    if (pts.length === 0) return;

    // Ignore strokes from the v1 coordinate scheme (pre-board-model).
    // New strokes are tagged with v: 2. Old strokes have no version.
    if (stroke.v !== 2) return;

    const w = scaledWidth(stroke.width);
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth   = w;
    ctx.beginPath();

    const first = fromNormalized(pts[0].x, pts[0].y);

    if (pts.length === 1) {
      // Single dot: draw a small filled circle
      ctx.fillStyle = stroke.color;
      ctx.arc(first.x, first.y, w / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    ctx.moveTo(first.x, first.y);

    // Quadratic-curve smoothing using midpoints
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = fromNormalized(pts[i].x,     pts[i].y);
      const p1 = fromNormalized(pts[i + 1].x, pts[i + 1].y);
      const midX = (p0.x + p1.x) / 2;
      const midY = (p0.y + p1.y) / 2;
      ctx.quadraticCurveTo(p0.x, p0.y, midX, midY);
    }

    // Final segment to last point
    const last = fromNormalized(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  function redraw() {
    ctx.clearRect(0, 0, state.cssWidth, state.cssHeight);
    for (const s of state.strokes) drawStroke(s);
    // Other users' in-progress strokes
    for (const s of state.liveStrokes.values()) drawStroke(s);
    // Local in-progress stroke (drawn last so it's on top)
    if (state.currentStroke) drawStroke(state.currentStroke);
    updateLiveLabels();
  }

  function updateLiveLabels() {
    if (!liveLabelsEl) return;
    const wanted = new Map();
    for (const [uid, stroke] of state.liveStrokes.entries()) {
      const pts = stroke?.points;
      if (!pts || pts.length === 0) continue;
      const lastPt = pts[pts.length - 1];
      const { x, y } = fromNormalized(lastPt.x, lastPt.y);
      const participant = state.participantsByUid.get(uid);
      const name = participant?.name || 'Someone';
      const color = participant?.color || stroke.color || '#1a1a1a';
      wanted.set(uid, { x, y, name, color });
    }

    // Reuse existing label DOM nodes where possible to avoid flicker
    const existing = new Map();
    liveLabelsEl.querySelectorAll('.live-label').forEach(el => {
      existing.set(el.dataset.uid, el);
    });

    // Update or create
    for (const [uid, info] of wanted.entries()) {
      let el = existing.get(uid);
      if (!el) {
        el = document.createElement('div');
        el.className = 'live-label';
        el.dataset.uid = uid;
        liveLabelsEl.appendChild(el);
      } else {
        existing.delete(uid);
      }
      el.textContent = info.name;
      el.style.setProperty('--label-color', info.color);
      el.style.left = info.x + 'px';
      el.style.top  = info.y + 'px';
    }
    // Remove orphans
    for (const el of existing.values()) el.remove();
  }

  // ---------- Pointer handlers ----------
  function shouldAcceptPointer(e) {
    // Once we've seen pen input, reject finger touches (palm rejection for Apple Pencil etc)
    if (state.seenPenInput && e.pointerType === 'touch') return false;
    // If already drawing with another pointer, ignore extras (e.g. resting palm)
    if (state.drawing && state.activePointerId !== null && e.pointerId !== state.activePointerId) return false;
    return true;
  }

  function startStroke(e) {
    if (state.ended) return;
    if (!shouldAcceptPointer(e)) return;
    if (e.pointerType === 'pen') state.seenPenInput = true;

    const { x, y } = getPointerCss(e);

    // Reject taps that start in the letterbox area (outside the board)
    if (!isInsideBoard(x, y)) return;

    e.preventDefault();
    state.drawing = true;
    state.activePointerId = e.pointerId;

    const norm = toNormalized(x, y);

    state.currentStroke = {
      v: 2,                                   // coord scheme version
      id: cryptoRandomId(),
      userId: state.me?.userId || 'local',
      color: state.color,
      width: state.width,
      points: [norm],
    };

    if (state.hintVisible) hideHint();
    schedulePublishLive();
  }

  function moveStroke(e) {
    if (!state.drawing || !state.currentStroke) return;
    if (e.pointerId !== state.activePointerId) return;
    e.preventDefault();
    const { x, y } = getPointerCss(e);
    let norm = toNormalized(x, y);
    // Clamp so strokes can't escape the board into the letterbox area
    norm = { x: Math.max(0, Math.min(1, norm.x)), y: Math.max(0, Math.min(1, norm.y)) };

    // Skip points too close together (cuts noise, smooths line)
    const pts = state.currentStroke.points;
    const last = pts[pts.length - 1];
    const dx = norm.x - last.x;
    const dy = norm.y - last.y;
    if (dx * dx + dy * dy < 0.000003) return;   // ~tiny normalized threshold

    pts.push(norm);
    redraw();
    schedulePublishLive();
  }

  function endStroke(e) {
    if (!state.drawing) return;
    // Only end if it's our active pointer (or we don't know which it was)
    if (e && e.pointerId !== state.activePointerId && state.activePointerId !== null) return;
    if (e) e.preventDefault();

    state.drawing = false;
    state.activePointerId = null;

    const finished = state.currentStroke;
    state.currentStroke = null;

    if (finished) {
      state.strokes.push(finished);

      // Publish to Firebase, then remove the live slot
      if (Scribbo.isReady()) {
        Scribbo.publishStroke(sessionCode, finished)
          .then((key) => {
            // Mark this Firebase key as already-drawn so the echo doesn't add a duplicate
            if (key) state.syncedStrokeIds.add(key);
          })
          .catch((err) => console.error('[Scribbo] publishStroke failed:', err));

        Scribbo.clearLiveStroke(sessionCode).catch(() => {});
      }
    }

    redraw();
  }

  // ---------- Tools ----------
  function setColor(color) {
    state.color = color;
    swatches.forEach(s => {
      const isActive = s.style.getPropertyValue('--swatch').trim() === color;
      s.classList.toggle('swatch-active', isActive);
    });
  }

  function clearBoard() {
    // Only the teacher can clear the whole board
    if (state.role !== 'teacher') {
      flashToast('Only the teacher can clear the board');
      return;
    }
    if (state.strokes.length === 0 && !state.currentStroke && state.liveStrokes.size === 0) return;
    if (!confirm('Clear the whole board for everyone?')) return;

    state.strokes = [];
    state.currentStroke = null;
    state.liveStrokes.clear();
    state.syncedStrokeIds.clear();
    redraw();

    if (Scribbo.isReady()) {
      Scribbo.clearStrokes(sessionCode).catch((err) => {
        console.error('[Scribbo] clearStrokes failed:', err);
      });
    }
  }

  function saveAsImage() {
    // Save just the board area (not the letterbox) at the board's pixel resolution
    const dpr = state.dpr;
    const bx = Math.floor(board.offsetX * dpr);
    const by = Math.floor(board.offsetY * dpr);
    const bw = Math.floor(board.width   * dpr);
    const bh = Math.floor(board.height  * dpr);

    const out = document.createElement('canvas');
    out.width  = bw;
    out.height = bh;
    const octx = out.getContext('2d');

    // Paper color from the CSS variable
    const paper = getComputedStyle(document.documentElement)
      .getPropertyValue('--paper').trim() || '#f5efe2';
    octx.fillStyle = paper;
    octx.fillRect(0, 0, bw, bh);
    // Crop the board region out of the source canvas
    octx.drawImage(canvas, bx, by, bw, bh, 0, 0, bw, bh);

    const link = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    link.download = `scribbo-${stamp}.png`;
    link.href = out.toDataURL('image/png');
    link.click();
  }

  function toggleParticipants() {
    if (!participants) return;
    participants.hidden = !participants.hidden;
  }

  async function copyCode() {
    const code = document.querySelector('.code-value')?.textContent?.trim();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      flashToast('Code copied');
    } catch {
      flashToast('Could not copy');
    }
  }

  function fullscreenSupported() {
    return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  }
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  async function toggleFullscreen() {
    if (!fullscreenSupported()) {
      flashToast("Fullscreen isn't supported on this device");
      return;
    }
    try {
      if (isFullscreen()) {
        if (document.exitFullscreen)            await document.exitFullscreen();
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      } else {
        const el = document.documentElement;
        if (el.requestFullscreen)             await el.requestFullscreen();
        else if (el.webkitRequestFullscreen)  await el.webkitRequestFullscreen();
      }
    } catch (e) {
      flashToast("Couldn't toggle fullscreen");
    }
  }
  function syncFullscreenIcon() {
    if (!fullscreenBtn) return;
    const inFs = isFullscreen();
    const enterIcon = fullscreenBtn.querySelector('.icon-fullscreen-enter');
    const exitIcon  = fullscreenBtn.querySelector('.icon-fullscreen-exit');
    if (enterIcon) enterIcon.hidden = inFs;
    if (exitIcon)  exitIcon.hidden  = !inFs;
    fullscreenBtn.title = inFs ? 'Exit fullscreen' : 'Fullscreen';
  }

  async function endSession() {
    const msg = state.role === 'teacher'
      ? 'End this session? Students will be disconnected and the board will be cleared.'
      : 'Leave this session?';
    if (!confirm(msg)) return;

    try {
      if (state.role === 'teacher') {
        await Scribbo.endSession(sessionCode);
      } else {
        await Scribbo.leaveSession(sessionCode);
      }
    } catch (e) { /* ignore — going home anyway */ }
    window.location.href = 'index.html';
  }

  // ---------- UI helpers ----------
  function hideHint() {
    if (!hint) return;
    hint.style.transition = 'opacity 0.4s ease';
    hint.style.opacity = '0';
    state.hintVisible = false;
    setTimeout(() => hint.remove(), 500);
  }

  function flashToast(msg) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('toast-show');
    clearTimeout(flashToast._t);
    flashToast._t = setTimeout(() => toast.classList.remove('toast-show'), 1600);
  }

  function cryptoRandomId() {
    if (window.crypto?.randomUUID) return crypto.randomUUID();
    return 's_' + Math.random().toString(36).slice(2, 11);
  }

  // ---------- Participants rendering ----------
  function renderParticipants(list) {
    // Maintain uid -> participant map so live labels can look up names/colors
    state.participantsByUid.clear();
    for (const p of list) state.participantsByUid.set(p.userId, p);

    if (!participantList) return;
    const myId = state.me?.userId;
    participantList.innerHTML = list.map(p => {
      const isMe    = p.userId === myId;
      const suffix  = p.role === 'teacher' ? ' (teacher)' : '';
      const youTag  = isMe ? ' — you' : '';
      const cls     = `participant${isMe ? ' participant-you' : ''}`;
      return `
        <li class="${cls}">
          <span class="dot" style="--dot:${p.color}"></span>
          <span class="participant-name">${escapeHtml(p.name)}${suffix}${youTag}</span>
        </li>
      `;
    }).join('');
    if (participantCount) {
      participantCount.textContent = list.length || (state.me ? 1 : 0);
    }
    // Re-render labels in case a name/color changed
    updateLiveLabels();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- Event wiring ----------
  // Pointer events cover mouse + touch + stylus uniformly
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    startStroke(e);
  });
  canvas.addEventListener('pointermove', moveStroke);
  canvas.addEventListener('pointerup',     endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave',  endStroke);

  // Prevent iOS scroll/zoom from hijacking drawing
  canvas.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  canvas.addEventListener('touchmove',  e => e.preventDefault(), { passive: false });

  // Tools
  swatches.forEach(s => {
    s.addEventListener('click', () => {
      const c = s.style.getPropertyValue('--swatch').trim();
      setColor(c);
    });
  });

  // Pen widths
  function setWidth(w) {
    state.width = w;
    widthBtns.forEach(b => {
      b.classList.toggle('width-btn-active', Number(b.dataset.width) === w);
    });
  }
  widthBtns.forEach(b => {
    b.addEventListener('click', () => setWidth(Number(b.dataset.width)));
  });

  if (clearBtn)    clearBtn.addEventListener('click', clearBoard);
  if (saveBtn)     saveBtn.addEventListener('click', saveAsImage);
  if (peopleBtn)   peopleBtn.addEventListener('click', toggleParticipants);
  if (fullscreenBtn) {
    if (!fullscreenSupported()) {
      fullscreenBtn.hidden = true;
    } else {
      fullscreenBtn.addEventListener('click', toggleFullscreen);
      document.addEventListener('fullscreenchange', () => { syncFullscreenIcon(); scheduleResize(); });
      document.addEventListener('webkitfullscreenchange', () => { syncFullscreenIcon(); scheduleResize(); });
    }
  }
  if (codeDisplay) codeDisplay.addEventListener('click', copyCode);
  if (endBtn)      endBtn.addEventListener('click', endSession);

  // Pen button currently just visually re-affirms pen mode (only tool we have)
  if (penBtn) penBtn.addEventListener('click', () => {
    toolBtns.forEach(b => b.classList.remove('tool-btn-active'));
    penBtn.classList.add('tool-btn-active');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'c' && (e.metaKey || e.ctrlKey)) return; // let copy work
    if (e.key.toLowerCase() === 'c') clearBoard();
    if (e.key.toLowerCase() === 's' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveAsImage();
    }
    // Catch undo muscle memory — Scribbo doesn't support undo (yet)
    if (e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      flashToast("Undo isn't supported yet. Try Clear to start over.");
    }
  });

  // Resize handling — debounced to ride out iOS URL-bar show/hide
  let resizeTimer = null;
  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resizeCanvas(); updateLiveLabels(); }, 80);
  }
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', scheduleResize);
  // When the browser comes back from being hidden, the viewport may have changed
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleResize();
  });

  // Best-effort cleanup when the tab closes
  window.addEventListener('pagehide', () => {
    Scribbo.leaveSession(sessionCode).catch(() => {});
  });

  // Customize End button label for students
  if (endBtn && state.role === 'student') {
    endBtn.textContent = 'Leave';
    endBtn.title = 'Leave session';
  }

  // ---------- Init ----------
  resizeCanvas();

  (async () => {
    try {
      await Scribbo.init();
      const me = await Scribbo.attachToSession(sessionCode, state.role, userName);
      state.me = me;
      // Default color = your assigned color
      setColor(me.color);

      // If your color isn't in the swatch row, swap the first swatch for yours
      // so you have a visual anchor for "this is me".
      ensureColorInPalette(me.color);

      // Hide the clear button for students — only the teacher can clear
      if (state.role !== 'teacher' && clearBtn) {
        clearBtn.hidden = true;
      }

      // Subscribe to participants
      Scribbo.onParticipants(sessionCode, renderParticipants);

      // Subscribe to completed strokes
      state.unsubStrokes = Scribbo.onStrokes(sessionCode, (evt) => {
        if (evt.type === 'add') {
          // Skip strokes we drew locally (they're already in state.strokes)
          if (state.syncedStrokeIds.has(evt.key)) return;
          // Skip strokes authored by us, in case key matching missed
          if (evt.stroke.userId === state.me?.userId) return;

          state.syncedStrokeIds.add(evt.key);
          state.strokes.push(evt.stroke);
          redraw();
          if (state.hintVisible) hideHint();
        } else if (evt.type === 'clear') {
          // Teacher cleared; wipe everyone's local state too
          state.strokes = [];
          state.liveStrokes.clear();
          state.syncedStrokeIds.clear();
          redraw();
        }
      });

      // Subscribe to live (in-progress) strokes from other users
      state.unsubLive = Scribbo.onLiveStrokes(sessionCode, ({ userId, stroke }) => {
        // Ignore our own echo
        if (userId === state.me?.userId) return;

        if (stroke === null) {
          state.liveStrokes.delete(userId);
        } else {
          state.liveStrokes.set(userId, stroke);
          if (state.hintVisible) hideHint();
        }
        redraw();
      });

      // Connection status indicator
      Scribbo.onConnection((connected) => {
        if (state.ended) return;
        setConnectionStatus(connected ? 'ok' : 'warn');
      });

      // Watch session meta — react if teacher ends the session
      state.unsubMeta = Scribbo.onMeta(sessionCode, (meta) => {
        if (!meta || meta.active === false) {
          // Teacher ended (or session was deleted). For students this is a real "ended" state.
          // For the teacher who triggered it, they're already navigating away, so the overlay
          // wouldn't normally show — but guard with state.ended just in case.
          if (state.role !== 'teacher') showEndedOverlay();
        }
      });

      // If we're in local-only mode (no Firebase), at least show ourselves
      if (!Scribbo.isReady()) {
        renderParticipants([me]);
        setConnectionStatus('ok');
      }

      // Dismiss the loading overlay
      hideLoadingOverlay();
    } catch (err) {
      console.error('[Scribbo] Could not attach to session:', err);
      hideLoadingOverlay();
      alert(err.message || 'Could not join the session.');
      window.location.href = 'index.html';
    }
  })();

  function hideLoadingOverlay() {
    if (!loadingOverlay) return;
    loadingOverlay.classList.add('is-hiding');
    setTimeout(() => loadingOverlay.remove(), 350);
  }

  function ensureColorInPalette(color) {
    const has = [...swatches].some(s =>
      s.style.getPropertyValue('--swatch').trim().toLowerCase() === color.toLowerCase()
    );
    if (!has && swatches.length) {
      // Replace the first non-active swatch with the user's color
      const target = [...swatches].find(s => !s.classList.contains('swatch-active')) || swatches[0];
      target.style.setProperty('--swatch', color);
      target.setAttribute('aria-label', 'Your color');
    }
    // Re-run setColor so the active ring lands on the right swatch
    setColor(color);
  }

  // ---------- Connection status ----------
  function setConnectionStatus(stateName) {
    if (!connStatus) return;
    connStatus.classList.remove('conn-status-ok', 'conn-status-warn', 'conn-status-bad');
    const labelEl = connStatus.querySelector('.conn-label');
    if (stateName === 'ok') {
      connStatus.classList.add('conn-status-ok');
      connStatus.title = 'Connected';
      if (labelEl) labelEl.textContent = 'live';
    } else if (stateName === 'warn') {
      connStatus.classList.add('conn-status-warn');
      connStatus.title = 'Reconnecting…';
      if (labelEl) labelEl.textContent = 'reconnecting';
    } else {
      connStatus.classList.add('conn-status-bad');
      connStatus.title = 'Disconnected';
      if (labelEl) labelEl.textContent = 'offline';
    }
  }

  // ---------- Session ended overlay ----------
  function showEndedOverlay() {
    if (state.ended) return;
    state.ended = true;
    state.drawing = false;
    state.currentStroke = null;
    if (endedOverlay) endedOverlay.hidden = false;
    // Stop publishing
    if (state.unsubStrokes) state.unsubStrokes();
    if (state.unsubLive)    state.unsubLive();
    if (state.unsubMeta)    state.unsubMeta();
  }
})();
