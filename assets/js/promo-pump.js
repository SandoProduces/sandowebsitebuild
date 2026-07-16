/* =============================================================
   PROMO PUMP - Satirical "tap as fast as you can" game
   Vanilla JS, no framework. Phase 1 = playable + local best.
   Phase 2 = optional Supabase global leaderboard (see PP_CONFIG).
   ============================================================= */
(function () {
    "use strict";

    /* ---------------------------------------------------------
       CONFIG
       - ROUND_SECONDS: length of a round
       - MAX_TPS: plausibility cap used for anti-cheat + tiers
       - SUPABASE: fill in url + anonKey to enable global leaderboard.
         Leave url empty to run in local-only mode (localStorage).
       --------------------------------------------------------- */
    var PP_CONFIG = {
        ROUND_SECONDS: 15,
        MAX_TPS: 15,
        LOCAL_BEST_KEY: "promoPumpBest",
        // Round bed music (already faded in the file). Served from sandowebsiteassets.
        // jsDelivr raw CDN is more reliable in-browser than github.com/blob links.
        MUSIC_URL: "https://cdn.jsdelivr.net/gh/SandoProduces/sandowebsiteassets@main/PromoPumpAudio.mp3",
        // Track is ~-6 LUFS — keep bed quiet so tap blips stay clear.
        MUSIC_VOLUME: 0.2,
        SUPABASE: {
            url: "https://zdyxbtxordjpqvdqqmzz.supabase.co",
            anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpkeXhidHhvcmRqcHF2ZHFxbXp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjQ4OTQsImV4cCI6MjA5OTgwMDg5NH0.tdegj6hdd_rqD0rKJr0vsHq-Zpkk6EwEla04UOtZld4",
            table: "promo_pump_scores",
            // Optional hardening: deploy the submit-score Edge Function and put
            // its URL here. If set, scores are submitted via the function
            // (server-side validation + rate limit) instead of a direct insert.
            functionUrl: "https://zdyxbtxordjpqvdqqmzz.supabase.co/functions/v1/submit-score"
        }
    };

    var MAX_SCORE = PP_CONFIG.ROUND_SECONDS * PP_CONFIG.MAX_TPS;

    /* ---------------------------------------------------------
       STATE
       --------------------------------------------------------- */
    var state = "idle"; // idle | countdown | playing | results
    var score = 0;
    var roundStart = 0;
    var remaining = PP_CONFIG.ROUND_SECONDS;
    var timerId = null;
    var rafId = null;
    var tapTimes = [];        // timestamps for CPS calc
    var lastSubmitAt = 0;     // anti double-submit
    var muted = false;
    var audioCtx = null;
    var music = null;

    /* ---------------------------------------------------------
       DOM
       --------------------------------------------------------- */
    var el = {};
    function $(id) { return document.getElementById(id); }

    function cacheDom() {
        el.game        = $("ppGame");
        el.scoreVal    = $("ppScore");
        el.timerVal    = $("ppTimer");
        el.bestVal     = $("ppBest");
        el.phoneTimer  = $("ppPhoneTimer");
        el.hype        = $("ppHype");
        el.arm         = $("ppArm");
        el.forearm     = $("ppForearm");
        el.head        = $("ppHead");
        el.intro       = $("ppIntro");
        el.countdown   = $("ppCountdown");
        el.countNum    = $("ppCountNum");
        el.results     = $("ppResults");
        el.resultScore = $("ppResultScore");
        el.resultTier  = $("ppResultTier");
        el.resultStat  = $("ppResultStat");
        el.startBtn    = $("ppStartBtn");
        el.againBtn    = $("ppAgainBtn");
        el.shareBtn    = $("ppShareBtn");
        el.nameEntry   = $("ppNameEntry");
        el.nameInput   = $("ppNameInput");
        el.leaderboard = $("ppLeaderboard");
        el.lbList      = $("ppLbList");
        el.muteBtn     = $("ppMuteBtn");
        el.viewLbBtn   = $("ppViewLbBtn");
        el.lbView      = $("ppLbView");
        el.lbViewList  = $("ppLbViewList");
        el.lbPlayBtn   = $("ppLbPlayBtn");
        el.lbBackBtn   = $("ppLbBackBtn");
    }

    /* ---------------------------------------------------------
       AUDIO - WebAudio tap blips + HTMLAudio bed music.
       Only unlocked after a user gesture (mobile autoplay rules).
       --------------------------------------------------------- */
    function ensureAudio() {
        if (!audioCtx) {
            try {
                var Ctx = window.AudioContext || window.webkitAudioContext;
                if (Ctx) audioCtx = new Ctx();
            } catch (e) { audioCtx = null; }
        }
        if (audioCtx && audioCtx.state === "suspended") {
            try { audioCtx.resume(); } catch (e) {}
        }
        ensureMusic();
    }

    function ensureMusic() {
        if (music || !PP_CONFIG.MUSIC_URL) return;
        try {
            music = new Audio(PP_CONFIG.MUSIC_URL);
            music.preload = "auto";
            music.loop = false; // fades are already in the file; one play per round
            music.volume = PP_CONFIG.MUSIC_VOLUME;
        } catch (e) { music = null; }
    }

    function startMusic() {
        if (muted || !PP_CONFIG.MUSIC_URL) return;
        ensureMusic();
        if (!music) return;
        try {
            music.pause();
            music.currentTime = 0;
            music.volume = PP_CONFIG.MUSIC_VOLUME;
            var p = music.play();
            if (p && typeof p.catch === "function") p.catch(function () { /* autoplay blocked */ });
        } catch (e) { /* no-op */ }
    }

    function stopMusic() {
        if (!music) return;
        try {
            music.pause();
            music.currentTime = 0;
        } catch (e) { /* no-op */ }
    }

    function pauseMusic() {
        if (!music) return;
        try { music.pause(); } catch (e) { /* no-op */ }
    }

    function resumeMusic() {
        if (muted || !music || state !== "playing") return;
        try {
            music.volume = PP_CONFIG.MUSIC_VOLUME;
            var p = music.play();
            if (p && typeof p.catch === "function") p.catch(function () {});
        } catch (e) { /* no-op */ }
    }

    function blip() {
        if (muted || !audioCtx) return;
        var t = audioCtx.currentTime;
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        var cps = currentCps();
        osc.type = "square";
        osc.frequency.setValueAtTime(320 + Math.min(cps, 12) * 40, t);
        // Peak a touch above the ducked bed so taps cut through -6 LUFS music
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.2, t + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.1);
    }

    /* ---------------------------------------------------------
       HELPERS
       --------------------------------------------------------- */
    function setState(next) {
        state = next;
        el.game.classList.remove("state-idle", "state-countdown", "state-playing", "state-results");
        el.game.classList.add("state-" + next);
    }

    function currentCps() {
        var now = performance.now();
        // taps in the last second
        var count = 0;
        for (var i = tapTimes.length - 1; i >= 0; i--) {
            if (now - tapTimes[i] <= 1000) count++;
            else break;
        }
        return count;
    }

    function updateTier() {
        var cps = currentCps();
        el.game.classList.remove("tier-idle", "tier-medium", "tier-frantic");
        if (cps >= 8) el.game.classList.add("tier-frantic");
        else if (cps >= 4) el.game.classList.add("tier-medium");
        else el.game.classList.add("tier-idle");
    }

    function getBest() {
        var v = parseInt(localStorage.getItem(PP_CONFIG.LOCAL_BEST_KEY), 10);
        return isNaN(v) ? 0 : v;
    }
    function setBest(v) {
        try { localStorage.setItem(PP_CONFIG.LOCAL_BEST_KEY, String(v)); } catch (e) {}
    }

    // Ratings are taps/sec based so round length changes stay fair.
    // Tuned so a casual mash (~7 tps / ~100 @ 15s) sits mid-table;
    // top tier needs a proper frantic effort.
    function tierFor(s) {
        var tps = s / PP_CONFIG.ROUND_SECONDS;
        if (tps >= 11) return "Main Character Energy"; // ~165 @ 15s
        if (tps >= 8)  return "Promo Approved";          // ~120 @ 15s
        if (tps >= 5.5) return "Story Views: 12";        // ~83 @ 15s
        return "Shadowbanned";
    }

    var HYPE = ["ENGAGEMENT RISING", "LABEL A&R WATCHING", "GOING VIRAL", "WAVE HARDER", "THE ALGORITHM LOVES IT"];

    function showHype() {
        var word = HYPE[Math.floor(Math.random() * HYPE.length)];
        el.hype.textContent = word;
        el.hype.classList.remove("show");
        void el.hype.offsetWidth; // restart animation
        el.hype.classList.add("show");
    }

    function floatPlusOne(x, y) {
        var f = document.createElement("div");
        f.className = "pp-float";
        f.textContent = "+1";
        f.style.left = x + "px";
        f.style.top = y + "px";
        el.game.appendChild(f);
        setTimeout(function () { f.remove(); }, 650);
    }

    /* ---------------------------------------------------------
       ARM PUMP
       --------------------------------------------------------- */
    var pumpAnims = [];
    var canWebAnim = typeof Element !== "undefined" && !!Element.prototype.animate;

    function playPump(node, frames, opts) {
        if (!node) return;
        try {
            var a = node.animate(frames, opts);
            pumpAnims.push(a);
        } catch (e) { /* no-op */ }
    }

    // One arm, one full pump on EVERY tap. Uses the Web Animations API so each
    // tap cancels the previous pump and snaps quickly to the peak (offset 0.22)
    // before easing back - so even rapid mashing shows a clear pump each time.
    function pumpArm() {
        var g = el.game.classList;
        var dur = g.contains("tier-frantic") ? 130 : g.contains("tier-medium") ? 150 : 175;
        var ease = "cubic-bezier(0.2, 0.85, 0.25, 1)";

        if (canWebAnim) {
            // cancel any in-flight pump so the new one always plays from the start
            for (var i = 0; i < pumpAnims.length; i++) {
                try { pumpAnims[i].cancel(); } catch (e) {}
            }
            pumpAnims = [];

            // Fist punch UP: from the loaded rest pose the shoulder swings the
            // arm up while the elbow unfolds, throwing the fist up past his head,
            // then it drops back to rest. Big rotations because the arm both
            // rotates AND extends (see the view-box pivots in the CSS).
            playPump(el.arm, [
                { transform: "rotate(0deg)" },
                { transform: "rotate(135deg)", offset: 0.25 },
                { transform: "rotate(122deg)", offset: 0.55 },
                { transform: "rotate(0deg)" }
            ], { duration: dur, easing: ease });

            playPump(el.forearm, [
                { transform: "rotate(0deg)" },
                { transform: "rotate(-141deg)", offset: 0.25 },
                { transform: "rotate(-128deg)", offset: 0.55 },
                { transform: "rotate(0deg)" }
            ], { duration: dur, easing: ease });

            playPump(el.head, [
                { transform: "translateY(0) rotate(0deg)" },
                { transform: "translateY(-2px) rotate(-0.5deg)", offset: 0.3 },
                { transform: "translateY(0) rotate(0deg)" }
            ], { duration: dur + 40, easing: "ease-out" });
            return;
        }

        // Fallback: class retrigger for very old browsers
        if (el.arm) {
            el.arm.classList.remove("pump");
            void el.arm.offsetWidth;
            el.arm.classList.add("pump");
        }
    }

    /* ---------------------------------------------------------
       GAME FLOW
       --------------------------------------------------------- */
    function beginCountdown() {
        if (state === "countdown" || state === "playing") return;
        ensureAudio();
        setState("countdown");
        el.intro.hidden = true;
        el.results.hidden = true;
        if (el.lbView) el.lbView.hidden = true;
        el.countdown.hidden = false;

        var n = 3;
        var showNum = function () {
            el.countNum.textContent = n > 0 ? String(n) : "GO";
            el.countNum.classList.remove("pp-count");
            void el.countNum.offsetWidth;
            el.countNum.classList.add("pp-count");
            blip();
        };
        showNum();
        var iv = setInterval(function () {
            n--;
            if (n < 0) {
                clearInterval(iv);
                el.countdown.hidden = true;
                startPlaying();
                return;
            }
            showNum();
        }, 900);
    }

    function startPlaying() {
        setState("playing");
        score = 0;
        tapTimes = [];
        inputMode = null;
        lastAcceptedTap = 0;
        remaining = PP_CONFIG.ROUND_SECONDS;
        el.scoreVal.textContent = "0";
        updateTimerDisplay();
        roundStart = performance.now();
        startMusic();

        timerId = setInterval(tick, 100);
    }

    function tick() {
        var elapsed = (performance.now() - roundStart) / 1000;
        remaining = Math.max(0, PP_CONFIG.ROUND_SECONDS - elapsed);
        updateTimerDisplay();
        updateTier();
        if (remaining <= 0) endRound();
    }

    function updateTimerDisplay() {
        var shown = remaining.toFixed(1);
        el.timerVal.textContent = shown;
        if (el.phoneTimer) el.phoneTimer.textContent = "0:" + String(Math.ceil(remaining)).padStart(2, "0");
        el.timerVal.classList.toggle("low", remaining <= 3);
    }

    function registerTap(clientX, clientY) {
        if (state !== "playing") return;
        score++;
        tapTimes.push(performance.now());
        el.scoreVal.textContent = String(score);
        pumpArm();
        blip();
        updateTier();
        if (score % 10 === 0) showHype();
        if (typeof clientX === "number") floatPlusOne(clientX, clientY);
        if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
    }

    // After a frantic round, leftover taps would smash Go Again — lock
    // result actions until the player has time to stop.
    var RESULTS_COOLDOWN_MS = 1200;
    var resultsReadyAt = 0;
    var resultsUnlockTimer = null;

    function resultsReady() {
        return performance.now() >= resultsReadyAt;
    }

    function endRound() {
        clearInterval(timerId);
        timerId = null;
        stopMusic();
        // Stop counting immediately so leftover taps don't add score
        setState("results");
        el.game.classList.remove("tier-medium", "tier-frantic");

        var tps = (score / PP_CONFIG.ROUND_SECONDS);
        var best = getBest();
        var isBest = score > best;
        if (isBest) setBest(score);

        el.resultScore.textContent = String(score);
        el.resultTier.textContent = tierFor(score);
        el.resultStat.textContent =
            tps.toFixed(1) + " taps/sec  \u00b7  best " + Math.max(best, score) +
            (isBest ? "  \u00b7  NEW BEST!" : "");
        el.bestVal.textContent = "BEST " + Math.max(best, score);

        // TikTok pixel event (site already loads ttq)
        if (window.ttq && typeof window.ttq.track === "function") {
            try { window.ttq.track("CompletePromoPump", { value: score, taps_per_second: +tps.toFixed(2) }); } catch (e) {}
        }

        // Show score right away, but keep buttons inert through the cooldown
        resultsReadyAt = performance.now() + RESULTS_COOLDOWN_MS;
        el.results.classList.add("cooling");
        el.results.hidden = false;
        if (resultsUnlockTimer) clearTimeout(resultsUnlockTimer);
        resultsUnlockTimer = setTimeout(function () {
            el.results.classList.remove("cooling");
            resultsUnlockTimer = null;
        }, RESULTS_COOLDOWN_MS);

        // Leaderboard: only if configured
        if (leaderboardEnabled()) {
            el.nameEntry.hidden = false;
            el.leaderboard.hidden = false;
            el.nameInput.value = "";
            loadLeaderboard(null);
        } else {
            el.nameEntry.hidden = true;
            el.leaderboard.hidden = true;
        }
    }

    /* ---------------------------------------------------------
       LEADERBOARD (Supabase REST via fetch, no SDK needed)
       --------------------------------------------------------- */
    function leaderboardEnabled() {
        return !!(PP_CONFIG.SUPABASE.url && PP_CONFIG.SUPABASE.anonKey);
    }

    function sbHeaders() {
        return {
            "apikey": PP_CONFIG.SUPABASE.anonKey,
            "Authorization": "Bearer " + PP_CONFIG.SUPABASE.anonKey,
            "Content-Type": "application/json"
        };
    }

    function sbUrl(path) {
        return PP_CONFIG.SUPABASE.url.replace(/\/$/, "") + "/rest/v1/" + path;
    }

    function loadLeaderboard(highlightName, listEl) {
        if (!leaderboardEnabled()) return;
        var target = listEl || el.lbList;
        if (!target) return;
        target.innerHTML = '<div class="pp-lb-empty">Loading top pumpers...</div>';
        var url = sbUrl(PP_CONFIG.SUPABASE.table +
            "?select=player_name,score&order=score.desc&limit=25");
        fetch(url, { headers: sbHeaders() })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
            .then(function (rows) { renderLeaderboard(rows, highlightName, target); })
            .catch(function () {
                target.innerHTML = '<div class="pp-lb-error">Leaderboard unavailable right now.</div>';
            });
    }

    function renderLeaderboard(rows, highlightName, listEl) {
        var target = listEl || el.lbList;
        if (!target) return;
        if (!rows || !rows.length) {
            target.innerHTML = '<div class="pp-lb-empty">Be the first to post a score.</div>';
            return;
        }
        var html = "";
        var highlighted = false;
        for (var i = 0; i < rows.length; i++) {
            var me = (!highlighted && highlightName && rows[i].player_name === highlightName && rows[i].score === score);
            if (me) highlighted = true;
            html +=
                '<div class="pp-lb-row' + (me ? " me" : "") + '">' +
                '<span class="pp-lb-rank">' + (i + 1) + '</span>' +
                '<span class="pp-lb-name">' + escapeHtml(rows[i].player_name) + '</span>' +
                '<span class="pp-lb-score">' + rows[i].score + '</span>' +
                '</div>';
        }
        target.innerHTML = html;
    }

    function openLeaderboardView() {
        if (!leaderboardEnabled()) return;
        el.intro.hidden = true;
        el.results.hidden = true;
        el.lbView.hidden = false;
        loadLeaderboard(null, el.lbViewList);
    }

    function closeLeaderboardView() {
        if (el.lbView) el.lbView.hidden = true;
        el.intro.hidden = false;
        setState("idle");
    }

    function submitScore() {
        if (!leaderboardEnabled()) return;
        var name = (el.nameInput.value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
        if (name.length < 1) { el.nameInput.focus(); return; }

        // Client-side anti-cheat guards (server should also enforce)
        var now = Date.now();
        if (now - lastSubmitAt < 5000) return;
        if (score < 0 || score > MAX_SCORE) return;
        lastSubmitAt = now;

        el.nameEntry.hidden = true;
        var payload = {
            player_name: name,
            score: score,
            taps_per_second: +(score / PP_CONFIG.ROUND_SECONDS).toFixed(2)
        };

        var request;
        if (PP_CONFIG.SUPABASE.functionUrl) {
            // Hardened path: Edge Function validates + rate limits server-side.
            request = fetch(PP_CONFIG.SUPABASE.functionUrl, {
                method: "POST",
                headers: sbHeaders(),
                body: JSON.stringify(payload)
            });
        } else {
            // Default path: direct insert (RLS CHECK constraints enforce limits).
            request = fetch(sbUrl(PP_CONFIG.SUPABASE.table), {
                method: "POST",
                headers: Object.assign(sbHeaders(), { "Prefer": "return=minimal" }),
                body: JSON.stringify(payload)
            });
        }

        request
            .then(function (r) { if (!r.ok) return Promise.reject(r.status); })
            .then(function () { loadLeaderboard(name); })
            .catch(function () {
                el.lbList.innerHTML = '<div class="pp-lb-error">Could not submit score. Try again later.</div>';
            });
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    /* ---------------------------------------------------------
       SHARE
       --------------------------------------------------------- */
    function flashShareBtn(label) {
        if (!el.shareBtn) return;
        var old = el.shareBtn.textContent;
        el.shareBtn.textContent = label;
        setTimeout(function () { el.shareBtn.textContent = old; }, 1600);
    }

    function copyShareText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text).then(function () {
                flashShareBtn("COPIED!");
            });
        }
        // Fallback for localhost / older browsers (clipboard API needs HTTPS)
        return new Promise(function (resolve, reject) {
            try {
                var ta = document.createElement("textarea");
                ta.value = text;
                ta.setAttribute("readonly", "");
                ta.style.position = "fixed";
                ta.style.left = "-9999px";
                document.body.appendChild(ta);
                ta.select();
                var ok = document.execCommand("copy");
                document.body.removeChild(ta);
                if (ok) { flashShareBtn("COPIED!"); resolve(); }
                else reject();
            } catch (e) { reject(e); }
        });
    }

    function shareScore() {
        var text = "I scored " + score + " on Sando's Promo Pump (" +
            tierFor(score) + "). Think you can wave harder?";
        var url = "https://www.sandoproduces.com/promo-pump.html";
        // On local preview, still share the live URL so people get a real link
        if (/sandoproduces\.com$/i.test(location.hostname)) {
            url = location.href.split("#")[0];
        }
        var full = text + " " + url;

        // Mobile share sheet when available; otherwise copy to clipboard
        if (navigator.share && (navigator.userAgent.match(/Android|iPhone|iPad|iPod/i) || !window.matchMedia("(pointer: fine)").matches)) {
            navigator.share({ title: "Sando - Promo Pump", text: text, url: url })
                .catch(function () { copyShareText(full).catch(function () { flashShareBtn("COPY FAILED"); }); });
            return;
        }
        copyShareText(full).catch(function () { flashShareBtn("COPY FAILED"); });
    }

    /* ---------------------------------------------------------
       INPUT
       --------------------------------------------------------- */
    // Mobile browsers often fire a compatibility mouse pointerdown after a
    // touch. Lock to the first pointer type of the round + a short debounce
    // so each physical tap only scores once.
    var inputMode = null;      // "touch" | "mouse" | "pen"
    var lastAcceptedTap = 0;
    var MIN_TAP_GAP_MS = 30;   // hard cap ~33 taps/sec — above real mash, kills double-fire

    function onPointerDown(e) {
        // Ignore taps on interactive controls (buttons, input, links, scrollable boards)
        var t = e.target;
        if (t.closest(".pp-btn") || t.closest(".pp-mini-btn") ||
            t.closest("input") || t.closest(".pp-leaderboard") ||
            t.closest(".pp-lb-scroll") || t.closest(".pp-lb-view") ||
            t.closest("nav") || t.closest(".sidebar-nav")) {
            return;
        }
        if (state === "idle") { e.preventDefault(); beginCountdown(); return; }
        if (state === "playing") {
            e.preventDefault();
            // Ignore non-primary pointers (multi-touch extras)
            if (e.isPrimary === false) return;

            var pt = e.pointerType || "mouse";
            if (!inputMode) inputMode = pt;
            // After a touch tap, browsers synthesize a mouse event — drop it
            if (inputMode === "touch" && pt === "mouse") return;

            var now = performance.now();
            if (now - lastAcceptedTap < MIN_TAP_GAP_MS) return;
            lastAcceptedTap = now;

            registerTap(e.clientX, e.clientY);
        }
    }

    function toggleMute() {
        muted = !muted;
        el.muteBtn.textContent = muted ? "SOUND: OFF" : "SOUND: ON";
        if (muted) {
            pauseMusic();
        } else {
            ensureAudio();
            // Resume bed from where it left off if still in a round
            if (state === "playing") resumeMusic();
        }
    }

    /* ---------------------------------------------------------
       INIT
       --------------------------------------------------------- */
    // Keep layout inside the *visible* mobile viewport (browser chrome
    // top/bottom bars). 100vh is too tall on iOS/Android until you scroll.
    function syncAppHeight() {
        var h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        document.documentElement.style.setProperty("--app-height", Math.round(h) + "px");
    }

    function init() {
        cacheDom();
        if (!el.game) return;
        syncAppHeight();
        window.addEventListener("resize", syncAppHeight);
        window.addEventListener("orientationchange", syncAppHeight);
        if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", syncAppHeight);
            window.visualViewport.addEventListener("scroll", syncAppHeight);
        }
        setState("idle");
        el.bestVal.textContent = "BEST " + getBest();

        // Low-latency pointer input on the whole stage
        el.game.addEventListener("pointerdown", onPointerDown, { passive: false });

        el.startBtn.addEventListener("click", function (e) { e.preventDefault(); beginCountdown(); });
        if (el.viewLbBtn) {
            if (leaderboardEnabled()) el.viewLbBtn.hidden = false;
            el.viewLbBtn.addEventListener("click", function (e) {
                e.preventDefault();
                openLeaderboardView();
            });
        }
        if (el.lbBackBtn) {
            el.lbBackBtn.addEventListener("click", function (e) {
                e.preventDefault();
                closeLeaderboardView();
            });
        }
        if (el.lbPlayBtn) {
            el.lbPlayBtn.addEventListener("click", function (e) {
                e.preventDefault();
                if (el.lbView) el.lbView.hidden = true;
                beginCountdown();
            });
        }
        el.againBtn.addEventListener("click", function (e) {
            e.preventDefault();
            if (!resultsReady()) return;
            el.results.hidden = true;
            el.results.classList.remove("cooling");
            el.intro.hidden = false;
            setState("idle");
        });
        el.shareBtn.addEventListener("click", function (e) {
            e.preventDefault();
            if (!resultsReady()) return;
            shareScore();
        });
        el.muteBtn.addEventListener("click", function (e) { e.preventDefault(); toggleMute(); });

        // Name entry -> submit on Enter or on input completion
        el.nameInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter") {
                e.preventDefault();
                if (!resultsReady()) return;
                submitScore();
            }
        });
        var submitBtn = $("ppSubmitBtn");
        if (submitBtn) submitBtn.addEventListener("click", function (e) {
            e.preventDefault();
            if (!resultsReady()) return;
            submitScore();
        });

        // Prevent context menu / long-press selection during frantic tapping
        el.game.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
