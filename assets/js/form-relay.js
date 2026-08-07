/**
 * Shared Turnstile + form-relay helpers for Release / Contact pages.
 * Posts to the Supabase form-relay Edge Function after Turnstile passes.
 */
(function (window, document) {
  "use strict";

  var RELAY_URL = "https://zdyxbtxordjpqvdqqmzz.supabase.co/functions/v1/form-relay";
  var SITEKEY = "0x4AAAAAAEJCy6RtIXvZYLnw";
  // Public anon key (safe in browser). Auth gate is Turnstile + TURNSTILE_SECRET server-side.
  var ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpkeXhidHhvcmRqcHF2ZHFxbXp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjQ4OTQsImV4cCI6MjA5OTgwMDg5NH0.tdegj6hdd_rqD0rKJr0vsHq-Zpkk6EwEla04UOtZld4";

  function getToken(form) {
    var input = form.querySelector('input[name="cf-turnstile-response"]');
    return input && input.value ? input.value.trim() : "";
  }

  function resetTurnstile(form) {
    try {
      if (!window.turnstile) return;
      var widget = form.querySelector(".cf-turnstile");
      if (!widget) {
        window.turnstile.reset();
        return;
      }
      var wid = widget.getAttribute("data-widget-id");
      if (wid) window.turnstile.reset(wid);
      else window.turnstile.reset();
    } catch (e) {}
  }

  function formToObject(form) {
    var data = {};
    var fd = new FormData(form);
    fd.forEach(function (value, key) {
      if (typeof value === "string") data[key] = value;
    });
    return data;
  }

  function postRelay(form) {
    var token = getToken(form);
    if (!token) {
      return Promise.reject(new Error("Complete the security check first."));
    }
    var payload = formToObject(form);
    payload["cf-turnstile-response"] = token;

    return fetch(RELAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: "Bearer " + ANON_KEY,
      },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok || body.error) {
          throw new Error(body.error || ("Request failed (" + res.status + ")"));
        }
        return body;
      });
    });
  }

  function bindHoldToRelay(btn, options) {
    options = options || {};
    var form = btn.closest("form");
    if (!form || !btn) return;

    var label = btn.querySelector(".btn-text");
    var idleText = label ? label.textContent : (options.idleText || "Submit");
    var successText = options.successText || "Sent";
    var minMs = options.minMs != null ? options.minMs : 0;
    var pageReadyAt = Date.now();
    var holdTimer = null;
    var honeypotSelector = options.honeypotSelector || null;

    form.addEventListener("submit", function (e) {
      e.preventDefault();
    });

    function isBlocked() {
      if (minMs && Date.now() - pageReadyAt < minMs) return true;
      if (honeypotSelector) {
        var hp = form.querySelector(honeypotSelector);
        if (hp && hp.value.trim() !== "") return true;
      }
      return false;
    }

    function startHold(e) {
      if (btn.classList.contains("is-confirmed") || btn.classList.contains("is-sending")) return;
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      if (e.type === "touchstart" && e.cancelable) e.preventDefault();
      if (isBlocked()) return;
      if (!getToken(form)) {
        if (label) label.textContent = "Security check required";
        setTimeout(function () {
          if (!btn.classList.contains("is-confirmed")) {
            if (label) label.textContent = idleText;
          }
        }, 1600);
        return;
      }

      btn.classList.add("is-holding");
      holdTimer = setTimeout(function () {
        if (isBlocked()) {
          btn.classList.remove("is-holding");
          return;
        }
        btn.classList.remove("is-holding");
        btn.classList.add("is-sending");
        btn.style.pointerEvents = "none";
        if (label) label.textContent = "Sending…";

        postRelay(form)
          .then(function () {
            btn.classList.remove("is-sending");
            btn.classList.add("is-confirmed");
            if (label) label.textContent = successText;
            setTimeout(function () {
              form.reset();
              resetTurnstile(form);
            }, 400);
            setTimeout(function () {
              btn.classList.remove("is-confirmed");
              if (label) label.textContent = idleText;
              btn.style.pointerEvents = "";
            }, 3500);
          })
          .catch(function (err) {
            btn.classList.remove("is-sending");
            if (label) label.textContent = err.message || "Try again";
            resetTurnstile(form);
            setTimeout(function () {
              if (label) label.textContent = idleText;
              btn.style.pointerEvents = "";
            }, 2500);
          });
      }, 1500);
    }

    function cancelHold() {
      if (btn.classList.contains("is-confirmed") || btn.classList.contains("is-sending")) return;
      clearTimeout(holdTimer);
      btn.classList.remove("is-holding");
    }

    btn.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    btn.addEventListener("mousedown", startHold);
    btn.addEventListener("mouseup", cancelHold);
    btn.addEventListener("mouseleave", cancelHold);
    btn.addEventListener("touchstart", startHold, { passive: false });
    btn.addEventListener("touchend", cancelHold);
    btn.addEventListener("touchcancel", cancelHold);
  }

  function autoBind() {
    document.querySelectorAll("[data-sando-relay]").forEach(function (btn) {
      bindHoldToRelay(btn, {
        successText: btn.getAttribute("data-success-text") || "Sent",
        idleText: (btn.querySelector(".btn-text") || {}).textContent,
        minMs: Number(btn.getAttribute("data-min-ms") || 0),
        honeypotSelector: btn.getAttribute("data-honeypot") || null,
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoBind);
  } else {
    autoBind();
  }

  window.SandoFormRelay = {
    RELAY_URL: RELAY_URL,
    SITEKEY: SITEKEY,
    getToken: getToken,
    resetTurnstile: resetTurnstile,
    postRelay: postRelay,
    bindHoldToRelay: bindHoldToRelay,
  };
})(window, document);
