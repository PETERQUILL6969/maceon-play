/* Maceon Presence 1.0-beta (FireRed)
 * Carregado pela página /online/. Mostra os outros jogadores que estão no mesmo mapa.
 * Para esconder a caixinha de diagnóstico, abra a página com ?hud=0 */
(() => {
  "use strict";
  if (window.MaceonPresence) return;

  const GAME = "firered";
  const SEND_MS = 200, HEARTBEAT_MS = 5000, STALE_MS = 20000;
  const TILE = 16, SCAN_MAX = 64 * 1048576;
  const cal = { cx: 112, cy: 69 };
  const showHud = !/[?&]hud=0/.test(location.search);

  function start(db) {
    let id = null;
    try { id = sessionStorage.getItem("maceonTabId"); } catch (e) {}
    if (!id) {
      id = "t" + Math.random().toString(36).slice(2, 10);
      try { sessionStorage.setItem("maceonTabId", id); } catch (e) {}
    }
    const colors = ["#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6", "#e67e22", "#1abc9c", "#ff6fa5"];
    const color = colors[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length];
    const getName = () => {
      let n = "";
      try { n = localStorage.getItem("maceonPlayerName") || ""; } catch (e) {}
      return (n || "J" + id.slice(1, 4)).slice(0, 12);
    };

    let serverOffset = 0;
    db.ref(".info/serverTimeOffset").on("value", s => { serverOffset = s.val() || 0; });

    const heap = () => {
      const e = window.EJS_emulator;
      return (e && e.gameManager && e.gameManager.Module && e.gameManager.Module.HEAPU8) || null;
    };
    const u16 = (h, a) => h[a] | (h[a + 1] << 8);

    /* assinatura da ficha do jogador (validada no seu FireRed): localId 255, movimento "jogador",
       sem tipo de treinador, ficha ativa, flags isPlayer e trackedByCamera */
    function isPlayerAt(h, p) {
      if (p < 16 || p + 16 >= h.length) return false;
      if (h[p - 8] !== 255 || h[p - 10] !== 11 || h[p - 9] !== 0) return false;
      if (!(h[p - 16] & 1) || !(h[p - 14] & 1) || !(h[p - 15] & 0x80)) return false;
      const x = u16(h, p), y = u16(h, p + 2);
      return x >= 7 && x <= 600 && y >= 7 && y <= 600;
    }

    function scan(h) {
      const end = Math.min(h.length, SCAN_MAX) - 16, out = [];
      for (let q = 0; q < end; q += 2) {
        if (h[q] !== 255) continue;
        const p = q + 8;
        if (isPlayerAt(h, p)) out.push({ p, x: u16(h, p), y: u16(h, p + 2), good: 0, bad: 0 });
      }
      return out;
    }

    let lockP = null, cands = null, lastScan = 0, badReads = 0, status = "iniciando", alive = true;
    let me = null, curKey = null, myRef = null, listenRef = null, others = {};
    let lastSent = 0, lastBeat = 0, lastSig = "";
    const els = {};

    const layer = document.createElement("div");
    layer.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:99999";
    document.body.appendChild(layer);
    let hud = null;
    if (showHud) {
      hud = document.createElement("div");
      hud.style.cssText = "position:fixed;left:6px;top:6px;z-index:99999;background:rgba(0,0,0,.75);color:#fff;font:11px Arial;padding:4px 7px;border-radius:7px;pointer-events:none;max-width:70vw";
      document.body.appendChild(hud);
    }

    function lock(h, p, how) {
      lockP = p;
      try { localStorage.setItem("maceonPlayerAddr", String(p)); } catch (e) {}
      console.log("Presence: jogador encontrado", JSON.stringify({ como: how, endereco: p, x: u16(h, p), y: u16(h, p + 2) }));
    }

    function setMap(k) {
      if (listenRef) listenRef.off();
      if (myRef) myRef.remove();
      others = {};
      lastSig = "";
      const base = db.ref("presence/" + GAME + "/" + k);
      myRef = base.child(id);
      myRef.onDisconnect().remove();
      listenRef = base;
      base.on("value", s => { const v = s.val() || {}; delete v[id]; others = v; },
        err => console.error("Presence: erro lendo (regras do Firebase?)", err.code));
      curKey = k;
    }

    function findPlayer(h) {
      const now = Date.now();
      if (cands === null) {
        let cached = NaN;
        try { cached = parseInt(localStorage.getItem("maceonPlayerAddr") || "", 10); } catch (e) {}
        if (cached && isPlayerAt(h, cached)) return lock(h, cached, "endereco guardado");
      }
      if (cands === null || (cands.length === 0 && now - lastScan > 3000)) {
        status = "procurando o jogador (a tela pode travar um instante)...";
        cands = scan(h); lastScan = now;
        console.log("Presence: candidatos =", cands.length);
        if (cands.length === 1) lock(h, cands[0].p, "assinatura unica");
        return;
      }
      if (cands.length === 0) { status = "jogador não encontrado (já está no mapa do jogo?)"; return; }
      status = "ande 2 passos para eu identificar o personagem";
      for (const c of cands) {
        if (c.bad > 1) continue;
        const x = u16(h, c.p), y = u16(h, c.p + 2);
        if (x === c.x && y === c.y) continue;
        const dx = x - c.x, dy = y - c.y, b = h[c.p + 8], lo = b & 15, hi = b >> 4;
        let w = 0;
        if (dy === 0 && Math.abs(dx) === 1) w = dx > 0 ? 4 : 3;
        else if (dx === 0 && Math.abs(dy) === 1) w = dy > 0 ? 1 : 2;
        if (w && (lo === w || hi === w)) c.good++; else c.bad++;
        c.x = x; c.y = y;
        if (c.good >= 2 && c.bad === 0) return lock(h, c.p, "assinatura + 2 passos");
      }
    }

    function tick() {
      if (!alive) return;
      const h = heap();
      if (!h) { status = "aguardando o jogo iniciar"; return; }
      if (document.hidden) return;
      if (lockP === null) return findPlayer(h);

      const x = u16(h, lockP), y = u16(h, lockP + 2);
      const m = h[lockP - 7], g = h[lockP - 6];
      if (!isPlayerAt(h, lockP) || g > 80) {
        status = "leitura inválida";
        if (++badReads > 150) {
          lockP = null; cands = null; badReads = 0; me = null;
          try { localStorage.removeItem("maceonPlayerAddr"); } catch (e) {}
        }
        return;
      }
      badReads = 0;
      me = { k: g + "_" + m, x, y };
      status = "OK";
      const now = Date.now(), sig = me.k + "|" + x + "," + y;
      if (me.k !== curKey) setMap(me.k);
      if (sig !== lastSig && now - lastSent >= SEND_MS) {
        myRef.set({ n: getName(), c: color, x, y, t: firebase.database.ServerValue.TIMESTAMP })
          .catch(err => console.error("Presence: erro gravando (regras do Firebase?)", err.code));
        lastSent = now; lastBeat = now; lastSig = sig;
      } else if (lastSig !== "" && now - lastBeat >= HEARTBEAT_MS) {
        myRef.update({ t: firebase.database.ServerValue.TIMESTAMP }).catch(() => {});
        lastBeat = now;
      }
    }

    function render() {
      if (!alive) return;
      requestAnimationFrame(render);
      const nowS = Date.now() + serverOffset;
      const ids = Object.keys(others).filter(k => !others[k].t || nowS - others[k].t < STALE_MS);
      if (hud) hud.textContent = "Presence | " + status + (me ? " | mapa " + me.k + " x=" + me.x + " y=" + me.y +
        " | outros aqui: " + ids.length : "");
      const cv = document.querySelector("#game canvas");
      if (!cv || !me || document.hidden) return;
      const r = cv.getBoundingClientRect(), ar = cv.width / cv.height;
      const dw = Math.min(r.width, r.height * ar), dh = dw / ar;
      const ox = r.left + (r.width - dw) / 2, oy = r.top + (r.height - dh) / 2;
      const s = dw / 240, sz = TILE * s;
      for (const k of Object.keys(els)) if (!ids.includes(k)) { els[k].remove(); delete els[k]; }
      for (const k of ids) {
        const o = others[k];
        const px = cal.cx + (o.x - me.x) * TILE, py = cal.cy + (o.y - me.y) * TILE;
        let el = els[k];
        if (!el) {
          el = els[k] = document.createElement("div");
          el.innerHTML = '<div style="position:absolute;left:50%;bottom:100%;transform:translateX(-50%);white-space:nowrap;font:bold 11px Arial;color:#fff;text-shadow:0 0 3px #000,0 0 3px #000"></div>';
          layer.appendChild(el);
        }
        el.style.cssText = "position:fixed;border:2px solid #fff;border-radius:4px;opacity:.85;box-sizing:border-box;background:" + (o.c || "#f00") +
          ";left:" + (ox + px * s) + "px;top:" + (oy + py * s) + "px;width:" + sz + "px;height:" + sz + "px;display:" +
          (px < -TILE || px > 240 || py < -TILE || py > 160 ? "none" : "block");
        el.firstChild.textContent = o.n || "?";
      }
    }

    const t = setInterval(() => { try { tick(); } catch (e) { console.error("Presence:", e); } }, 50);
    requestAnimationFrame(render);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && myRef) { myRef.remove(); lastSig = ""; }
    });
    window.addEventListener("beforeunload", () => { if (myRef) myRef.remove(); });

    window.MaceonPresence = {
      cal,
      recalibrar() {
        lockP = null; cands = null; me = null; lastSig = "";
        try { localStorage.removeItem("maceonPlayerAddr"); } catch (e) {}
      },
      stop() {
        alive = false; clearInterval(t);
        if (listenRef) listenRef.off();
        if (myRef) myRef.remove();
        layer.remove(); if (hud) hud.remove();
        delete window.MaceonPresence;
      }
    };
    console.log("Presence 1.0-beta ligado. id:", id);
  }

  let tries = 0;
  const wait = setInterval(() => {
    const db = typeof onlineDatabase !== "undefined" ? onlineDatabase : null;
    if (db) { clearInterval(wait); start(db); }
    else if (++tries > 40) { clearInterval(wait); console.error("Presence: Firebase (onlineDatabase) não encontrado."); }
  }, 500);
})();
