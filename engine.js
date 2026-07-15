/* ============================================================
   hack//ops - "the desktop" engine
   One endless retro desktop. There is no document scroll: a
   fixed stage hosts a grid canvas plus a transformed world
   layer of DOM windows. The camera flies between stops; the
   header chips and scroll-to-fly drive the tour.
   Camera model: screen = center + R(rot) * s * (p - cam)
   ============================================================ */
(function () {
  'use strict';

  const world = document.getElementById('world');
  const gridCv = document.getElementById('grid');
  const gtx = gridCv.getContext('2d');
  const hud = document.getElementById('hud');
  const hint = document.getElementById('hint');
  const nav = document.getElementById('stops-nav');
  const stage = document.getElementById('stage');

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(pointer: coarse)').matches;

  /* ---------------- placed items ---------------- */
  const items = [...document.querySelectorAll('[data-x]')];
  items.forEach(el => {
    const x = +el.dataset.x, y = +el.dataset.y;
    const rot = +(el.dataset.rot || 0);
    const sc = +(el.dataset.scale || 1);
    el.style.position = 'absolute';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.transform =
      `translate(-50%,-50%) rotate(${rot}deg) scale(${sc})`;
  });

  /* ---------------- stops / tour ---------------- */
  const mkStop = el => ({
    el,
    id: el.dataset.stop,
    label: el.dataset.label || el.dataset.stop,
    x: +el.dataset.x,
    y: +el.dataset.y,
    vw: +(el.dataset.vw || 800),
    vh: +(el.dataset.vh || 600),
    bearing: (+(el.dataset.bearing || 0)) * Math.PI / 180,
    s: 1
  });
  const stopEls = [...document.querySelectorAll('[data-stop]')];
  // hidden stops exist in the world but not in the nav, tab order or tour
  const stops = stopEls.filter(el => !el.dataset.hidden).map(mkStop);
  const hiddenStops = stopEls.filter(el => el.dataset.hidden).map(mkStop);

  function landScale(st) {
    // a hidden or collapsed viewport reports 0x0; a zero scale would
    // poison the log-space damping with NaN forever, so clamp hard
    const s = Math.min(innerWidth / st.vw, innerHeight / st.vh) * 0.85;
    return (isFinite(s) && s > 0) ? s : 0.5;
  }
  function computeScales() {
    stops.forEach(st => { st.s = landScale(st); });
    hiddenStops.forEach(st => { st.s = landScale(st); });
  }

  /* ---------------- camera ---------------- */
  const cam = { x: 0, y: 0, s: 0.1, r: 0 };
  let u = 0;                 // tour position: stop k lives at u = k
  let targetU = 0;
  let tourMode = true;       // false after free pan/zoom until re-engaged
  let booted = false;

  function pathAt(uu) {
    uu = Math.max(0, Math.min(stops.length - 1, uu));
    const i = Math.min(Math.floor(uu), stops.length - 2);
    const A = stops[i], B = stops[Math.min(i + 1, stops.length - 1)];
    let t = uu - i;
    t = t * t * (3 - 2 * t); // ease within the leg
    const dist = Math.hypot(B.x - A.x, B.y - A.y);
    const la = Math.log(A.s), lb = Math.log(B.s);
    // long hops pull the camera out mid-flight, short hops do not
    const lm = Math.min(la, lb) - Math.log(1 + dist / 2600);
    const omt = 1 - t;
    const ls = omt * omt * la + 2 * omt * t * lm + t * t * lb;
    // shortest-angle bearing lerp
    let dr = B.bearing - A.bearing;
    while (dr > Math.PI) dr -= 2 * Math.PI;
    while (dr < -Math.PI) dr += 2 * Math.PI;
    return {
      x: A.x + (B.x - A.x) * t,
      y: A.y + (B.y - A.y) * t,
      s: Math.exp(ls),
      r: A.bearing + dr * t
    };
  }

  /* ---------------- render ---------------- */
  function applyCam() {
    world.style.transform =
      `rotate(${cam.r}rad) scale(${cam.s}) translate(${-cam.x}px,${-cam.y}px)`;
  }

  function drawGrid() {
    const dpr = devicePixelRatio || 1;
    const w = innerWidth, h = innerHeight;
    if (gridCv.width !== w * dpr || gridCv.height !== h * dpr) {
      gridCv.width = w * dpr; gridCv.height = h * dpr;
      gridCv.style.width = w + 'px'; gridCv.style.height = h + 'px';
    }
    gtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gtx.clearRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    const cos = Math.cos(cam.r), sin = Math.sin(cam.r);
    // world -> screen
    gtx.setTransform(
      dpr * cam.s * cos, dpr * cam.s * sin,
      -dpr * cam.s * sin, dpr * cam.s * cos,
      dpr * (cx - cam.s * (cos * cam.x - sin * cam.y)),
      dpr * (cy - cam.s * (sin * cam.x + cos * cam.y))
    );

    // visible world bbox from the four screen corners
    const inv = (px, py) => {
      const dx = px - cx, dy = py - cy;
      return [
        cam.x + (dx * cos + dy * sin) / cam.s,
        cam.y + (-dx * sin + dy * cos) / cam.s
      ];
    };
    const c1 = inv(0, 0), c2 = inv(w, 0), c3 = inv(0, h), c4 = inv(w, h);
    const x0 = Math.min(c1[0], c2[0], c3[0], c4[0]);
    const x1 = Math.max(c1[0], c2[0], c3[0], c4[0]);
    const y0 = Math.min(c1[1], c2[1], c3[1], c4[1]);
    const y1 = Math.max(c1[1], c2[1], c3[1], c4[1]);

    // pick a grid step that stays readable at any magnification
    let step = 64;
    while (step * cam.s < 26) step *= 2;
    while (step * cam.s > 120) step /= 2;

    const minor = getComputedStyle(document.body).getPropertyValue('--grid').trim() || '#ffe2f0';
    const major = getComputedStyle(document.body).getPropertyValue('--grid-2').trim() || '#ffcfe6';

    gtx.lineWidth = 1 / cam.s;
    for (let pass = 0; pass < 2; pass++) {
      const st = pass ? step * 8 : step;
      gtx.strokeStyle = pass ? major : minor;
      gtx.beginPath();
      for (let gx = Math.floor(x0 / st) * st; gx <= x1; gx += st) {
        gtx.moveTo(gx, y0); gtx.lineTo(gx, y1);
      }
      for (let gy = Math.floor(y0 / st) * st; gy <= y1; gy += st) {
        gtx.moveTo(x0, gy); gtx.lineTo(x1, gy);
      }
      gtx.stroke();
    }
    gtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---------------- HUD / nav ---------------- */
  function updateHud() {
    const pad = n => String(Math.round(Math.abs(n))).padStart(5, '0');
    hud.textContent =
      `X ${pad(cam.x)} · Y ${pad(cam.y)} · FIELD ${pad(innerWidth / cam.s)}`;
  }

  let chips = [];
  function buildNav() {
    nav.innerHTML = '';
    chips = stops.map((st, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = st.label;
      b.addEventListener('click', () => flyTo(i));
      nav.appendChild(b);
      return b;
    });
  }
  function updateNav() {
    const k = Math.round(Math.max(0, Math.min(stops.length - 1, u)));
    chips.forEach((c, i) => c.classList.toggle('on', tourMode && i === k));
  }

  /* ---------------- flight ---------------- */
  let flight = null; // off-tour flight, used for the hidden dive

  function flyTo(i) {
    dismissHint();
    flight = null;
    tourMode = true;
    targetU = i;
    if (reduceMotion) { u = i; const p = pathAt(u); Object.assign(cam, p); }
  }

  function startFlight(st) {
    dismissHint();
    tourMode = false;
    flight = {
      t: 0,
      A: { x: cam.x, y: cam.y, s: cam.s, r: cam.r },
      B: { x: st.x, y: st.y, s: st.s, r: st.bearing }
    };
    if (reduceMotion) { Object.assign(cam, flight.B); flight = null; }
  }

  window.hackops = { flyTo: id => {
    const i = stops.findIndex(s => s.id === id);
    if (i >= 0) { flyTo(i); return; }
    const h = hiddenStops.find(s => s.id === id);
    if (h) startFlight(h);
  }};

  function nextStop(dir) {
    const k = Math.round(Math.max(0, Math.min(stops.length - 1, targetU)));
    flyTo(Math.max(0, Math.min(stops.length - 1, k + dir)));
  }

  /* ---------------- input ---------------- */
  let hintGone = false;
  function dismissHint() {
    if (!hintGone) { hintGone = true; hint.classList.add('gone'); }
  }

  // wheel: tour progress; ctrl+wheel (pinch on trackpads): zoom at cursor
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    dismissHint();
    if (e.ctrlKey) {
      freeZoom(Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY);
      return;
    }
    flight = null;
    tourMode = true;
    targetU = Math.max(0, Math.min(stops.length - 1,
      targetU + e.deltaY * 0.0011));
  }, { passive: false });

  function freeZoom(f, px, py) {
    tourMode = false;
    flight = null;
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const cos = Math.cos(cam.r), sin = Math.sin(cam.r);
    const dx = px - cx, dy = py - cy;
    const wx = cam.x + (dx * cos + dy * sin) / cam.s;
    const wy = cam.y + (-dx * sin + dy * cos) / cam.s;
    const ns = Math.max(0.01, Math.min(160, cam.s * f));
    cam.x = wx - (dx * cos + dy * sin) / ns;
    cam.y = wy - (-dx * sin + dy * cos) / ns;
    cam.s = ns;
  }

  // drag pan / touch swipe
  let pDown = null, moved = false;
  const pts = new Map();
  let pinch0 = 0, pinchS0 = 1;

  stage.addEventListener('pointerdown', e => {
    if (e.target.closest('[data-interactive]')) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]);
      pinchS0 = cam.s;
    }
    pDown = { x: e.clientX, y: e.clientY, t: performance.now() };
    moved = false;
  });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch0 > 0) {
        tourMode = false;
        cam.s = Math.max(0.01, Math.min(160, pinchS0 * d / pinch0));
      }
      moved = true;
      return;
    }
    const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
    if (Math.abs(e.clientX - pDown.x) + Math.abs(e.clientY - pDown.y) > 6) moved = true;
    if (moved) {
      dismissHint();
      tourMode = false;
      flight = null;
      const cos = Math.cos(cam.r), sin = Math.sin(cam.r);
      cam.x -= (dx * cos + dy * sin) / cam.s;
      cam.y -= (-dx * sin + dy * cos) / cam.s;
    }
  });
  stage.addEventListener('pointerup', e => {
    pts.delete(e.pointerId);
    if (!pDown) return;
    const dt = performance.now() - pDown.t;
    const dx = e.clientX - pDown.x, dy = e.clientY - pDown.y;
    // quick vertical swipe on touch: advance the tour
    if (coarse && dt < 500 && Math.abs(dy) > 60 && Math.abs(dy) > Math.abs(dx)) {
      nextStop(dy < 0 ? 1 : -1);
    }
    pDown = null;
  });
  stage.addEventListener('pointercancel', e => pts.delete(e.pointerId));

  // double click zooms in, shift+double click zooms out
  stage.addEventListener('dblclick', e => {
    if (e.target.closest('[data-interactive]')) return;
    freeZoom(e.shiftKey ? 0.5 : 2, e.clientX, e.clientY);
  });

  addEventListener('keydown', e => {
    if (e.target.matches('input, textarea')) return;
    const panPx = 90;
    const pan = (dx, dy) => {
      tourMode = false; dismissHint();
      const cos = Math.cos(cam.r), sin = Math.sin(cam.r);
      cam.x += (dx * cos + dy * sin) / cam.s;
      cam.y += (-dx * sin + dy * cos) / cam.s;
    };
    switch (e.key) {
      case ' ': case 'PageDown': e.preventDefault(); nextStop(1); break;
      case 'PageUp': e.preventDefault(); nextStop(-1); break;
      case 'Home': e.preventDefault(); flyTo(0); break;
      case 'End': e.preventDefault(); flyTo(stops.length - 1); break;
      case 'ArrowLeft': pan(-panPx, 0); break;
      case 'ArrowRight': pan(panPx, 0); break;
      case 'ArrowUp': pan(0, -panPx); break;
      case 'ArrowDown': pan(0, panPx); break;
      case '+': case '=': freeZoom(1.4, innerWidth / 2, innerHeight / 2); break;
      case '-': freeZoom(1 / 1.4, innerWidth / 2, innerHeight / 2); break;
    }
  });

  // camera rail controls
  const zin = document.getElementById('zin');
  const zout = document.getElementById('zout');
  const lvl = document.getElementById('lvl');
  if (zin) zin.addEventListener('click', () => freeZoom(1.6, innerWidth / 2, innerHeight / 2));
  if (zout) zout.addEventListener('click', () => freeZoom(1 / 1.6, innerWidth / 2, innerHeight / 2));
  if (lvl) lvl.addEventListener('click', () => { cam.r = 0; });

  const nextbtn = document.getElementById('nextbtn');
  if (nextbtn) nextbtn.addEventListener('click', () => nextStop(1));

  // dark mode: html.dark switches the palette, the grid canvas picks
  // the new colors up on its next frame automatically
  const modebtn = document.getElementById('modebtn');
  const modelbl = document.getElementById('modelbl');
  function syncModeLabel() {
    if (modelbl) modelbl.textContent =
      document.documentElement.classList.contains('dark') ? 'white mode' : 'dark mode';
  }
  if (modebtn) {
    syncModeLabel();
    modebtn.addEventListener('click', () => {
      const dark = document.documentElement.classList.toggle('dark');
      try { localStorage.setItem('hackops-theme', dark ? 'dark' : 'light'); } catch (e) {}
      syncModeLabel();
    });
  }

  /* ---------------- hidden entrances to op//000 ----------------
     No chip, no tab stop, no tour leg. Ways in:
     1. free-zoom onto the microprint under the litany
     2. type the magic word anywhere
     3. worry the pyramid: five clicks on pyramid1.fbx within 3s */
  let typed = '';
  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    typed = (typed + e.key.toLowerCase()).slice(-8);
    if (typed.endsWith('slop')) { typed = ''; window.hackops.flyTo('op000'); }
  });

  const pyrWin = document.querySelector('.pyr-win');
  let pyrTaps = 0, pyrTapT = 0;
  if (pyrWin) pyrWin.addEventListener('click', () => {
    const now = performance.now();
    if (now - pyrTapT > 3000) pyrTaps = 0;
    pyrTapT = now;
    if (++pyrTaps >= 5) { pyrTaps = 0; window.hackops.flyTo('op000'); }
  });

  /* ---------------- pyramid1.fbx: ascii 3d viewer ----------------
     A software-rendered square pyramid: z-buffered triangle raster,
     flat lambert shading per face, depth fog, printed as a character
     ramp. Runs at half the camera framerate. */
  const asciiPre = document.getElementById('ascii-pyr');
  const AW = 62, AH = 32;
  const RAMP = ' .:-=+*#%@';
  const zbuf = new Float32Array(AW * AH);
  const cbuf = new Uint8Array(AW * AH);
  let asciiTick = 0;

  const PYR_V = [
    [0, -1.25, 0],                                  // apex
    [-1, 0.7, -1], [1, 0.7, -1], [1, 0.7, 1], [-1, 0.7, 1]
  ];
  const PYR_F = [
    [0, 2, 1], [0, 3, 2], [0, 4, 3], [0, 1, 4],     // sides
    [1, 2, 3], [1, 3, 4]                            // base
  ];
  const LIGHT = (() => {
    const l = [-0.45, -0.75, -0.5];
    const n = Math.hypot(l[0], l[1], l[2]);
    return [l[0] / n, l[1] / n, l[2] / n];
  })();

  function asciiFrame(now) {
    if (!asciiPre || (asciiTick++ & 1)) return;
    const ry = now * 0.0009;
    const rx = 0.42 + Math.sin(now * 0.00042) * 0.12;
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cx = Math.cos(rx), sx = Math.sin(rx);

    // rotate Y, then X, then push away from the camera
    const vs = PYR_V.map(v => {
      const x1 = v[0] * cy + v[2] * sy;
      const z1 = -v[0] * sy + v[2] * cy;
      const y2 = v[1] * cx - z1 * sx;
      const z2 = v[1] * sx + z1 * cx;
      return [x1, y2, z2 + 3.9];
    });
    // perspective to grid coords (chars are ~2x taller than wide)
    const F = 34;
    const pts = vs.map(v => [
      AW / 2 + (v[0] / v[2]) * F * 1.9,
      AH / 2 + (v[1] / v[2]) * F * 1.02,
      v[2]
    ]);

    zbuf.fill(1e9); cbuf.fill(0);

    for (const f of PYR_F) {
      const a = vs[f[0]], b = vs[f[1]], c = vs[f[2]];
      // face normal in view space, backface cull
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      // camera sits at the origin looking +z: visible faces point back
      const vx = (a[0] + b[0] + c[0]) / 3, vy = (a[1] + b[1] + c[1]) / 3, vz = (a[2] + b[2] + c[2]) / 3;
      if (nx * vx + ny * vy + nz * vz > 0) continue;
      const lum = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);

      const p0 = pts[f[0]], p1 = pts[f[1]], p2 = pts[f[2]];
      const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
      const maxX = Math.min(AW - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
      const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
      const maxY = Math.min(AH - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
      const d = (p1[1] - p2[1]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[1] - p2[1]);
      if (Math.abs(d) < 1e-6) continue;

      for (let gy = minY; gy <= maxY; gy++) {
        for (let gx = minX; gx <= maxX; gx++) {
          const w0 = ((p1[1] - p2[1]) * (gx - p2[0]) + (p2[0] - p1[0]) * (gy - p2[1])) / d;
          const w1 = ((p2[1] - p0[1]) * (gx - p2[0]) + (p0[0] - p2[0]) * (gy - p2[1])) / d;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * p0[2] + w1 * p1[2] + w2 * p2[2];
          const i = gy * AW + gx;
          if (z >= zbuf[i]) continue;
          zbuf[i] = z;
          // lambert + ambient, dimmed by depth so the far edge recedes
          const fog = Math.max(0.35, Math.min(1, 1.9 - z * 0.36));
          const bright = Math.min(1, (0.18 + lum * 0.92) * fog);
          cbuf[i] = 1 + Math.round(bright * (RAMP.length - 2));
        }
      }
    }

    let out = '';
    for (let gy = 0; gy < AH; gy++) {
      let row = '';
      for (let gx = 0; gx < AW; gx++) {
        const c = cbuf[gy * AW + gx];
        row += c === 0 ? ' ' : RAMP[c];
      }
      out += row + '\n';
    }
    asciiPre.textContent = out;
  }

  /* ---------------- main loop ---------------- */
  let last = performance.now();
  function rafLoop(now) { frame(now); requestAnimationFrame(rafLoop); }
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (tourMode) {
      // u chases targetU, camera rides the path
      const k = 1 - Math.exp(-dt * (reduceMotion ? 60 : 4.2));
      u += (targetU - u) * k;
      const p = pathAt(u);
      const ck = 1 - Math.exp(-dt * (reduceMotion ? 60 : 6));
      cam.x += (p.x - cam.x) * ck;
      cam.y += (p.y - cam.y) * ck;
      cam.s = Math.exp(Math.log(cam.s) + (Math.log(p.s) - Math.log(cam.s)) * ck);
      let dr = p.r - cam.r;
      while (dr > Math.PI) dr -= 2 * Math.PI;
      while (dr < -Math.PI) dr += 2 * Math.PI;
      cam.r += dr * ck;
    } else if (flight) {
      // off-tour dive: same camera grammar as a tour leg
      flight.t = Math.min(1, flight.t + dt / 2.4);
      const t = flight.t * flight.t * (3 - 2 * flight.t);
      const A = flight.A, B = flight.B;
      const dist = Math.hypot(B.x - A.x, B.y - A.y);
      const la = Math.log(A.s), lb = Math.log(B.s);
      const lm = Math.min(la, lb) - Math.log(1 + dist / 2600);
      const omt = 1 - t;
      cam.x = A.x + (B.x - A.x) * t;
      cam.y = A.y + (B.y - A.y) * t;
      cam.s = Math.exp(omt * omt * la + 2 * omt * t * lm + t * t * lb);
      let dr = B.r - A.r;
      while (dr > Math.PI) dr -= 2 * Math.PI;
      while (dr < -Math.PI) dr += 2 * Math.PI;
      cam.r = A.r + dr * t;
      if (flight.t >= 1) flight = null;
    }

    asciiFrame(now);

    // never let a NaN camera survive a frame: snap back onto the tour
    if (!isFinite(cam.s) || cam.s <= 0 || !isFinite(cam.x) || !isFinite(cam.y) || !isFinite(cam.r)) {
      Object.assign(cam, pathAt(u));
    }

    applyCam();
    drawGrid();
    updateHud();
    updateNav();
  }

  /* ---------------- boot ---------------- */
  function boot() {
    computeScales();
    buildNav();
    const p0 = pathAt(0);
    Object.assign(cam, p0);
    u = 0; targetU = 0;
    document.body.classList.add('booted');
    booted = true;
    if (coarse) hint.textContent = 'SWIPE TO FLY';
    // paint one frame synchronously: rAF is throttled to zero on hidden
    // tabs and the world must never appear un-placed
    applyCam(); drawGrid(); updateHud(); updateNav();
    requestAnimationFrame(rafLoop);
    // keep the tour advancing even when rAF starves (hidden panel)
    setInterval(() => {
      if (performance.now() - last > 250) frame(performance.now());
    }, 250);
  }

  addEventListener('resize', () => { computeScales(); });

  boot();
})();
