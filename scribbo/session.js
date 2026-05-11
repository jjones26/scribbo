/* =========================================================
   SCRIBBO — session.js
   Shared session, auth, and participant logic.
   Uses Firebase Realtime Database + Anonymous Auth.

   Public API (window.Scribbo):
     init()                              -> Promise<void>     // call once on page load
     createSession()                     -> Promise<{code}>   // teacher
     joinSession(code, name)             -> Promise<{code,color,role,userId}>  // student
     attachToSession(code, role, name?)  -> Promise<participant>  // board page
     leaveSession(code)                  -> Promise<void>
     onParticipants(code, cb)            -> () => void  // unsub
     endSession(code)                    -> Promise<void>
     isReady()                           -> boolean
   ========================================================= */

(() => {
  // --- Color pool (12 distinguishable, accessible-ish) ---
  const STUDENT_COLORS = [
    '#e63946', // red
    '#1d7874', // teal
    '#f4a261', // orange
    '#264653', // navy
    '#9d4edd', // purple
    '#06a77d', // green
    '#d62828', // crimson
    '#fb8500', // amber
    '#0077b6', // blue
    '#bc4749', // brick
    '#7209b7', // violet
    '#2a9d8f', // sea
  ];
  const TEACHER_COLOR = '#1a1a1a';

  // --- Code generation ---
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function generateCode() {
    let s = '';
    for (let i = 0; i < 6; i++) {
      s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return s;
  }

  // --- Module state ---
  const S = {
    app:    null,
    auth:   null,
    db:     null,
    user:   null,
    ready:  false,
    initPromise: null,
    presenceRef: null,   // ref to current user's participant entry (for onDisconnect)
  };

  function isReady() { return S.ready && !!window.SCRIBBO_FIREBASE_READY; }

  // --- Initialization ---
  function init() {
    if (S.initPromise) return S.initPromise;

    S.initPromise = new Promise(async (resolve, reject) => {
      if (!window.SCRIBBO_FIREBASE_READY) {
        console.warn('[Scribbo] Firebase not configured. Running in local-only mode. ' +
                     'See firebase-config.js for setup instructions.');
        resolve();
        return;
      }

      try {
        // SDK loaded via CDN script tags in HTML
        if (typeof firebase === 'undefined') {
          throw new Error('Firebase SDK not loaded. Check script tags in HTML.');
        }

        S.app  = firebase.initializeApp(window.SCRIBBO_FIREBASE_CONFIG);
        S.auth = firebase.auth();
        S.db   = firebase.database();

        // Sign in anonymously and wait for the user object
        const cred = await S.auth.signInAnonymously();
        S.user = cred.user;
        S.ready = true;
        resolve();
      } catch (err) {
        console.error('[Scribbo] Firebase init failed:', err);
        reject(err);
      }
    });

    return S.initPromise;
  }

  // --- Create a session (teacher) ---
  async function createSession() {
    if (!isReady()) {
      // Local fallback so the UI works without Firebase configured
      const code = generateCode();
      sessionStorage.setItem('scribbo:role', 'teacher');
      sessionStorage.setItem('scribbo:name', 'Teacher');
      return { code };
    }

    // Try a few times in the very unlikely case of collision
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      const metaRef = S.db.ref(`sessions/${code}/meta`);
      const snap = await metaRef.once('value');
      if (snap.exists()) continue;

      await metaRef.set({
        createdAt:  firebase.database.ServerValue.TIMESTAMP,
        teacherId:  S.user.uid,
        active:     true,
      });

      sessionStorage.setItem('scribbo:role', 'teacher');
      sessionStorage.setItem('scribbo:name', 'Teacher');
      return { code };
    }
    throw new Error('Could not generate a unique code. Try again.');
  }

  // --- Join a session (student) ---
  async function joinSession(code, name) {
    code = (code || '').toUpperCase().trim();
    name = (name || '').trim();

    if (code.length !== 6) throw new Error('Code should be 6 characters.');
    if (!name)             throw new Error('Please enter your name.');

    sessionStorage.setItem('scribbo:role', 'student');
    sessionStorage.setItem('scribbo:name', name);

    if (!isReady()) {
      // Local fallback
      return { code, color: STUDENT_COLORS[0], role: 'student', userId: 'local' };
    }

    const metaSnap = await S.db.ref(`sessions/${code}/meta`).once('value');
    if (!metaSnap.exists())          throw new Error("That code doesn't match an active session.");
    if (metaSnap.val().active === false) throw new Error('That session has ended.');

    return { code, role: 'student', userId: S.user.uid };
  }

  // --- Attach the current user as a participant on the board page ---
  async function attachToSession(code, role, name) {
    if (!isReady()) {
      // Local-only: just return a fake participant
      const color = role === 'teacher' ? TEACHER_COLOR : STUDENT_COLORS[0];
      return { userId: 'local', name: name || (role === 'teacher' ? 'Teacher' : 'You'), color, role };
    }

    code = code.toUpperCase();
    name = name || sessionStorage.getItem('scribbo:name') ||
                   (role === 'teacher' ? 'Teacher' : 'Student');

    // Verify the session exists and is active
    const metaSnap = await S.db.ref(`sessions/${code}/meta`).once('value');
    if (!metaSnap.exists())            throw new Error('Session not found.');
    if (metaSnap.val().active === false) throw new Error('Session has ended.');

    // Pick a color
    let color = TEACHER_COLOR;
    if (role !== 'teacher') {
      const partsSnap = await S.db.ref(`sessions/${code}/participants`).once('value');
      const taken = new Set();
      partsSnap.forEach(child => {
        if (child.val().role !== 'teacher') taken.add(child.val().color);
      });
      color = STUDENT_COLORS.find(c => !taken.has(c)) ||
              STUDENT_COLORS[partsSnap.numChildren() % STUDENT_COLORS.length];
    }

    const participant = {
      userId: S.user.uid,
      name,
      color,
      role,
      joinedAt: firebase.database.ServerValue.TIMESTAMP,
    };

    S.presenceRef = S.db.ref(`sessions/${code}/participants/${S.user.uid}`);
    await S.presenceRef.set(participant);
    // Auto-remove on disconnect (browser closed, network lost, etc.)
    S.presenceRef.onDisconnect().remove();

    return participant;
  }

  async function leaveSession(code) {
    if (!isReady() || !S.presenceRef) return;
    try {
      await S.presenceRef.onDisconnect().cancel();
      await S.presenceRef.remove();
    } catch (e) { /* swallow — page is unloading */ }
  }

  // --- Subscribe to participant list changes ---
  function onParticipants(code, cb) {
    if (!isReady()) {
      // Local: fire once with an empty list
      setTimeout(() => cb([]), 0);
      return () => {};
    }
    code = code.toUpperCase();
    const ref = S.db.ref(`sessions/${code}/participants`);
    const handler = (snap) => {
      const list = [];
      snap.forEach(child => list.push(child.val()));
      // Teacher first, then by join time
      list.sort((a, b) => {
        if (a.role !== b.role) return a.role === 'teacher' ? -1 : 1;
        return (a.joinedAt || 0) - (b.joinedAt || 0);
      });
      cb(list);
    };
    ref.on('value', handler);
    return () => ref.off('value', handler);
  }

  // --- End session (teacher) ---
  async function endSession(code) {
    if (!isReady()) return;
    code = code.toUpperCase();
    await S.db.ref(`sessions/${code}/meta/active`).set(false);
    // Optional: clean up the whole session tree
    await S.db.ref(`sessions/${code}`).remove();
  }

  // --- Stroke sync (Step 4) ---

  // Publish a completed stroke. Returns the assigned key.
  async function publishStroke(code, stroke) {
    if (!isReady()) return null;
    code = code.toUpperCase();
    const ref = S.db.ref(`sessions/${code}/strokes`).push();
    await ref.set(stroke);
    return ref.key;
  }

  // Publish/overwrite the current user's in-progress stroke.
  // One slot per user (keyed by uid), so updates are cheap.
  async function publishLiveStroke(code, stroke) {
    if (!isReady() || !S.user) return;
    code = code.toUpperCase();
    const ref = S.db.ref(`sessions/${code}/live/${S.user.uid}`);
    // Set onDisconnect cleanup so a half-stroke doesn't ghost forever
    ref.onDisconnect().remove();
    await ref.set(stroke);
  }

  // Remove the current user's live stroke (called on pointerup).
  async function clearLiveStroke(code) {
    if (!isReady() || !S.user) return;
    code = code.toUpperCase();
    try {
      await S.db.ref(`sessions/${code}/live/${S.user.uid}`).remove();
    } catch (e) {}
  }

  // Subscribe to completed strokes.
  // cb is called with { type: 'add', key, stroke } for each new stroke,
  // and { type: 'clear' } when the strokes node is wiped.
  function onStrokes(code, cb) {
    if (!isReady()) return () => {};
    code = code.toUpperCase();
    const ref = S.db.ref(`sessions/${code}/strokes`);

    const onAdd = (snap) => {
      cb({ type: 'add', key: snap.key, stroke: snap.val() });
    };
    const onValue = (snap) => {
      // If the entire strokes node disappears (cleared by teacher), tell the client
      if (!snap.exists()) cb({ type: 'clear' });
    };

    ref.on('child_added', onAdd);
    ref.on('value', onValue);
    return () => {
      ref.off('child_added', onAdd);
      ref.off('value', onValue);
    };
  }

  // Subscribe to live (in-progress) strokes from other users.
  // cb is called with { userId, stroke } when a live stroke updates,
  // and { userId, stroke: null } when it's removed.
  function onLiveStrokes(code, cb) {
    if (!isReady()) return () => {};
    code = code.toUpperCase();
    const ref = S.db.ref(`sessions/${code}/live`);

    const handle = (snap) => {
      cb({ userId: snap.key, stroke: snap.val() });
    };
    const handleRemoved = (snap) => {
      cb({ userId: snap.key, stroke: null });
    };

    ref.on('child_added', handle);
    ref.on('child_changed', handle);
    ref.on('child_removed', handleRemoved);
    return () => {
      ref.off('child_added', handle);
      ref.off('child_changed', handle);
      ref.off('child_removed', handleRemoved);
    };
  }

  // Clear all completed strokes (teacher only).
  async function clearStrokes(code) {
    if (!isReady()) return;
    code = code.toUpperCase();
    await S.db.ref(`sessions/${code}/strokes`).remove();
    await S.db.ref(`sessions/${code}/live`).remove();
  }

  // --- Connection state ---
  // Subscribe to Firebase's special .info/connected ref. cb gets true/false.
  function onConnection(cb) {
    if (!isReady()) { setTimeout(() => cb(true), 0); return () => {}; }
    const ref = S.db.ref('.info/connected');
    const handler = (snap) => cb(!!snap.val());
    ref.on('value', handler);
    return () => ref.off('value', handler);
  }

  // --- Session meta updates (e.g. teacher ended) ---
  function onMeta(code, cb) {
    if (!isReady()) return () => {};
    code = code.toUpperCase();
    const ref = S.db.ref(`sessions/${code}/meta`);
    const handler = (snap) => cb(snap.val());
    ref.on('value', handler);
    return () => ref.off('value', handler);
  }

  // --- Public surface ---
  window.Scribbo = {
    init,
    createSession,
    joinSession,
    attachToSession,
    leaveSession,
    onParticipants,
    endSession,
    isReady,
    // Stroke sync (Step 4)
    publishStroke,
    publishLiveStroke,
    clearLiveStroke,
    onStrokes,
    onLiveStrokes,
    clearStrokes,
    // Status (Step 5)
    onConnection,
    onMeta,
    // expose for board.js to use later in step 4
    _internal: {
      get db()   { return S.db; },
      get user() { return S.user; },
    },
  };
})();
