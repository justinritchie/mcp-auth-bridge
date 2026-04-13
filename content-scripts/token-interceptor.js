// MCP Auth Bridge - Token Interceptor Content Script
// Runs in MAIN world on bearer_intercept sites
// Generalized from pcx_content.js — intercepts fetch/XHR to capture bearer tokens
//
// Configuration is passed via the site config in sites.json.
// This script reads its config from a data attribute on its own script tag,
// or falls back to detecting the current domain and matching against known patterns.

(function () {
  "use strict";

  // ─── Discover which site we're on ─────────────────────────────────────────
  // The background worker injects site config via window.__MCP_AUTH_BRIDGE_CONFIG
  // but since we run at document_start in MAIN world, we may need to self-detect.

  const hostname = window.location.hostname;

  // Data store — accessible via window.__MCP_TOKEN_DATA for the popup to read
  const D = {
    siteKey: null,
    at: null,
    rt: null,
    extra: {},
    calls: 0,
    capturedAt: null
  };

  // Site detection: match hostname to known bearer_intercept patterns
  // This is populated from sites.json at build time, but we hardcode
  // the patterns here since content scripts can't dynamically load config.
  const SITE_PATTERNS = {
    pcexpress: {
      domains: ["pcexpress.ca", "realcanadiansuperstore.ca"],
      token_url_patterns: ["pcexpress.ca"],
      oauth_url_patterns: ["oauth2", "update-token"],
      extra_fields: {
        cartId: { source: "localStorage", key: "lcl-cart-id-banner" }
      }
    }
  };

  // Find which site this page belongs to
  for (const [key, config] of Object.entries(SITE_PATTERNS)) {
    for (const domain of config.domains) {
      if (hostname === domain || hostname.endsWith("." + domain)) {
        D.siteKey = key;
        break;
      }
    }
    if (D.siteKey) break;
  }

  if (!D.siteKey) {
    // Not a configured bearer_intercept site — bail
    return;
  }

  const siteConfig = SITE_PATTERNS[D.siteKey];

  // Try to grab extra fields from localStorage
  if (siteConfig.extra_fields) {
    for (const [field, config] of Object.entries(siteConfig.extra_fields)) {
      if (config.source === "localStorage") {
        try {
          D.extra[field] = localStorage.getItem(config.key);
        } catch (e) {}
      }
    }
  }

  // Expose data for the extension popup to read via executeScript
  window.__MCP_TOKEN_DATA = D;

  // ─── Helper: check if URL matches token patterns ────────────────────────

  function matchesTokenUrl(url) {
    return siteConfig.token_url_patterns.some(p => url.indexOf(p) > -1);
  }

  function matchesOAuthUrl(url) {
    return siteConfig.oauth_url_patterns.some(p => url.indexOf(p) > -1);
  }

  // ─── Helper: check authorization header ─────────────────────────────────

  function checkAuth(authHeader, url) {
    if (!url || !matchesTokenUrl(url)) return;
    D.calls++;

    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      const token = authHeader.substring(7).trim();
      if (token.startsWith("eyJ")) {
        D.at = token;
        D.capturedAt = Date.now();
        window.__MCP_TOKEN_DATA = D;
        notifyCapture();
      }
    }
  }

  // ─── Helper: check response body for tokens ─────────────────────────────

  function checkBody(data) {
    try {
      if (data && data.refresh_token) {
        D.rt = data.refresh_token;
        window.__MCP_TOKEN_DATA = D;
      }
      if (data && data.access_token && !D.at) {
        D.at = data.access_token;
        D.capturedAt = Date.now();
        window.__MCP_TOKEN_DATA = D;
        notifyCapture();
      }
    } catch (e) {}
  }

  // ─── Notify extension of capture ────────────────────────────────────────

  function notifyCapture() {
    const payload = {
      siteKey: D.siteKey,
      at: D.at,
      rt: D.rt
    };
    // Include extra fields
    for (const [field, value] of Object.entries(D.extra)) {
      payload[field] = value;
    }
    window.postMessage({
      type: "__MCP_AUTH_BRIDGE_TOKEN",
      data: payload
    }, "*");
  }

  // ─── Patch fetch ────────────────────────────────────────────────────────

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url ? input.url : "");

    if (init && init.headers && matchesTokenUrl(url)) {
      let auth = null;
      if (typeof init.headers.get === "function") {
        auth = init.headers.get("authorization");
      } else if (init.headers) {
        auth = init.headers["Authorization"] || init.headers["authorization"];
      }
      if (auth) checkAuth(auth, url);
    }

    return origFetch.apply(this, arguments).then(function (response) {
      try {
        const rUrl = response.url || "";
        if (matchesOAuthUrl(rUrl)) {
          response.clone().json().then(checkBody).catch(function () {});
        }
      } catch (e) {}
      return response;
    });
  };

  // ─── Patch XMLHttpRequest ───────────────────────────────────────────────

  let xhrUrl = "";
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    xhrUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name.toLowerCase() === "authorization") {
      checkAuth(value, xhrUrl);
    }
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    xhr.addEventListener("load", function () {
      try {
        const u = xhr.responseURL || "";
        if (matchesOAuthUrl(u)) {
          checkBody(JSON.parse(xhr.responseText));
        }
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  // ─── Visual indicator ───────────────────────────────────────────────────

  function showIndicator() {
    const dot = document.createElement("div");
    dot.id = "__mcp-auth-bridge-indicator";
    dot.style.cssText =
      "position:fixed;bottom:12px;left:12px;width:12px;height:12px;" +
      "border-radius:50%;background:#555;z-index:999999;cursor:pointer;" +
      "transition:background 0.3s;box-shadow:0 1px 4px rgba(0,0,0,0.3)";
    dot.title = "MCP Auth Bridge: waiting for token...";
    document.body.appendChild(dot);

    const check = setInterval(() => {
      if (D.at) {
        dot.style.background = "#4ade80";
        dot.title = "MCP Auth Bridge: token captured (" + D.at.length + " chars)";
        clearInterval(check);
      }
    }, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", showIndicator);
  } else {
    showIndicator();
  }
})();
