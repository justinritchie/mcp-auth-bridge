// MCP Auth Bridge - Popup Logic
// Dynamically renders site cards based on sites.json config

function timeAgo(ts) {
  if (!ts) return "Never";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  return days + "d ago";
}

function showMsg(el, text, type) {
  el.textContent = text;
  el.className = "message " + type;
}

// ─── Render Site Cards ──────────────────────────────────────────────────────

async function renderSites() {
  const container = document.getElementById("sites-container");

  // Get sites config and stored status from background
  const { sites } = await sendMsg({ type: "GET_SITES" });
  const { stored } = await sendMsg({ type: "GET_STATUS" });

  if (!sites || Object.keys(sites).length === 0) {
    container.innerHTML = '<div class="site-card"><div class="note">No sites configured. Check sites.json.</div></div>';
    return;
  }

  for (const [siteKey, site] of Object.entries(sites)) {
    const card = document.createElement("div");
    card.className = "site-card";
    card.id = `card-${siteKey}`;

    const color = site.color || "#6366f1";
    const lastCapture = stored[`${siteKey}_last_capture`];
    const dotClass = lastCapture ? "green" : "gray";
    const statusText = lastCapture ? "Saved" : "Not captured";
    const captureLabels = {
      cookies: "session cookies",
      bearer_intercept: "bearer + interceptor",
      firebase_idtoken: "Firebase ID token"
    };
    const captureLabel = captureLabels[site.capture_method] || site.capture_method;

    let statsHTML = "";
    if (site.capture_method === "cookies") {
      const count = stored[`${siteKey}_cookie_count`] || "--";
      statsHTML = `
        <div class="status-row">
          <span>Cookies</span>
          <span class="value ${lastCapture ? 'ok' : ''}">${lastCapture ? count : '--'}</span>
        </div>`;
    } else if (site.capture_method === "bearer_intercept" || site.capture_method === "firebase_idtoken") {
      const tokenLen = stored[`${siteKey}_token_length`] || "--";
      const tokenLabel = site.capture_method === "firebase_idtoken" ? "Firebase ID token" : "Bearer token";
      statsHTML = `
        <div class="status-row">
          <span>${tokenLabel}</span>
          <span class="value ${lastCapture ? 'ok' : ''}" id="stat-${siteKey}-token">${lastCapture ? tokenLen + ' chars' : '--'}</span>
        </div>`;
      // Show extra fields
      if (site.extra_fields) {
        for (const field of Object.keys(site.extra_fields)) {
          const hasField = stored[`${siteKey}_has_${field}`];
          statsHTML += `
            <div class="status-row">
              <span>${field}</span>
              <span class="value ${hasField ? 'ok' : 'warn'}" id="stat-${siteKey}-${field}">${hasField ? 'Captured' : 'Not found'}</span>
            </div>`;
        }
      }
    }

    card.innerHTML = `
      <div class="site-header">
        <span>
          <span class="site-name">${site.label}</span>
          <span class="capture-type">${captureLabel}</span>
        </span>
        <span class="status-badge">
          <span class="status-dot ${dotClass}" id="dot-${siteKey}"></span>
          <span id="status-${siteKey}">${statusText}</span>
        </span>
      </div>
      ${statsHTML}
      <div class="status-row">
        <span>Last saved</span>
        <span class="value" id="time-${siteKey}">${timeAgo(lastCapture)}</span>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="btn-save-${siteKey}" style="background:${color}">
          Save ${site.label}
        </button>
        <button class="btn btn-secondary" id="btn-copy-${siteKey}" style="color:${color};border-color:${color}" title="Copy captured credentials as JSON for diagnostics">Copy</button>
      </div>
      <div class="message" id="msg-${siteKey}"></div>
    `;

    container.appendChild(card);

    // Wire up save button
    document.getElementById(`btn-save-${siteKey}`).addEventListener("click", () => {
      handleSave(siteKey, site);
    });

    // Wire up copy button (diagnostic JSON copy for any site type)
    document.getElementById(`btn-copy-${siteKey}`).addEventListener("click", () => {
      handleCopy(siteKey, site);
    });

    // If this is a bearer_intercept or firebase_idtoken site, check live token on active tab
    if (site.capture_method === "bearer_intercept" || site.capture_method === "firebase_idtoken") {
      checkActiveTabForToken(siteKey, site);
    }
  }
}

// ─── Save Handler ───────────────────────────────────────────────────────────

async function handleSave(siteKey, site) {
  const btn = document.getElementById(`btn-save-${siteKey}`);
  const msgEl = document.getElementById(`msg-${siteKey}`);
  btn.disabled = true;
  btn.textContent = "Saving...";

  let tokenData = null;

  // For bearer intercept and firebase_idtoken sites, get live token from tab
  if (site.capture_method === "bearer_intercept" || site.capture_method === "firebase_idtoken") {
    tokenData = await getTokenFromTab(siteKey, site);
    if (!tokenData || !tokenData.at) {
      btn.disabled = false;
      btn.textContent = `Save ${site.label}`;
      const hint = site.capture_method === "firebase_idtoken"
        ? `Open ${site.label} in a tab and make sure you're logged in.`
        : `Browse ${site.label} first.`;
      showMsg(msgEl, `No token captured. ${hint}`, "error");
      return;
    }
  }

  // Detect domain from active tab for cookie sites
  let domain = null;
  if (site.capture_method === "cookies") {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) {
        const url = new URL(tab.url);
        domain = url.hostname;
      }
    } catch (e) {}
  }

  const message = {
    type: "SAVE_SITE",
    siteKey,
    domain,
    tokenData
  };

  chrome.runtime.sendMessage(message, (result) => {
    btn.disabled = false;
    btn.textContent = `Save ${site.label}`;

    if (result && result.success) {
      let successMsg;
      if (site.capture_method === "cookies") {
        successMsg = `Saved ${result.cookieCount} cookies`;
      } else {
        successMsg = `Saved token (${result.tokenLength} chars)`;
      }

      // Check for config warnings (pcexpress specific)
      if (result.nativeResponse && result.nativeResponse.config_warning) {
        showMsg(msgEl, successMsg + " to file, but config skipped: " + result.nativeResponse.config_warning, "error");
      } else {
        showMsg(msgEl, successMsg, "success");
      }

      document.getElementById(`dot-${siteKey}`).className = "status-dot green";
      document.getElementById(`status-${siteKey}`).textContent = "Saved";
      document.getElementById(`time-${siteKey}`).textContent = "Just now";

      if (site.capture_method === "cookies") {
        const countEl = document.querySelector(`#card-${siteKey} .status-row .value`);
        if (countEl) {
          countEl.textContent = result.cookieCount;
          countEl.className = "value ok";
        }
      }
    } else {
      const err = (result && result.error) || "Unknown error";
      if (err.includes("native") || err.includes("not found")) {
        showMsg(msgEl, "Native host not installed. Run install.sh first.", "error");
      } else {
        showMsg(msgEl, err, "error");
      }
    }
  });
}

// ─── Copy Handler ───────────────────────────────────────────────────────────

async function handleCopy(siteKey, site) {
  const btn = document.getElementById(`btn-copy-${siteKey}`);
  const msgEl = document.getElementById(`msg-${siteKey}`);

  let payload;

  if (site.capture_method === "bearer_intercept" || site.capture_method === "firebase_idtoken") {
    const tokenData = await getTokenFromTab(siteKey, site);
    if (!tokenData || !tokenData.at) {
      showMsg(msgEl, `No token on page. Open ${site.label} first.`, "error");
      return;
    }
    payload = { bearer_token: tokenData.at };
    if (tokenData.rt) payload.refresh_token = tokenData.rt;
    if (site.extra_fields) {
      for (const field of Object.keys(site.extra_fields)) {
        if (tokenData[field]) payload[field] = tokenData[field];
      }
    }
  } else {
    // Cookie sites: fetch live cookies from Chrome and copy as JSON
    try {
      const allCookies = [];
      for (const domain of site.domains) {
        const cookies = await chrome.cookies.getAll({ domain });
        allCookies.push(...cookies);
      }
      // Deduplicate by name
      const seen = new Set();
      const unique = allCookies.filter(c => {
        if (seen.has(c.name)) return false;
        seen.add(c.name);
        return true;
      });
      // Filter to configured cookies if specified
      let filtered = unique;
      if (site.cookies && site.cookies.length > 0) {
        filtered = unique.filter(c => site.cookies.includes(c.name));
      }
      if (filtered.length === 0) {
        showMsg(msgEl, `No cookies found. Browse ${site.label} first.`, "error");
        return;
      }
      payload = {};
      for (const c of filtered) {
        payload[c.name] = c.value.slice(0, 20) + "...";
      }
      payload._info = `${filtered.length} cookies from ${site.domains.join(", ")}`;
    } catch (e) {
      showMsg(msgEl, "Cookie read failed: " + (e.message || e), "error");
      return;
    }
  }

  const json = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    showMsg(msgEl, "Copied diagnostic JSON to clipboard", "success");
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = json;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showMsg(msgEl, "Copied diagnostic JSON to clipboard", "success");
    } catch (err) {
      showMsg(msgEl, "Clipboard copy failed: " + (e.message || e), "error");
    }
  }
}

// ─── Token Reading from Active Tab ──────────────────────────────────────────

async function getTokenFromTab(siteKey, site) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return null;

    // Check if tab URL matches this site
    const url = tab.url || "";
    const matchesSite = site.domains.some(d => url.includes(d));
    if (!matchesSite) return null;

    // firebase_idtoken sites: actively call getIdToken() and read window globals
    if (site.capture_method === "firebase_idtoken") {
      return await getFirebaseTokenFromTab(siteKey, site, tab.id);
    }

    // bearer_intercept sites: read passively-captured __MCP_TOKEN_DATA
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__MCP_TOKEN_DATA,
      world: "MAIN"
    });

    if (results && results[0] && results[0].result) {
      const d = results[0].result;
      if (d.at) {
        const tokenData = { at: d.at, rt: d.rt };
        // Include extra fields
        if (d.extra) {
          for (const [field, value] of Object.entries(d.extra)) {
            tokenData[field] = value;
          }
        }
        return tokenData;
      }
    }
  } catch (e) {}
  return null;
}

// ─── Firebase ID token capture (for Roll20 etc.) ────────────────────────────
//
// Roll20 and similar Firebase-backed sites authenticate via short-lived ID
// tokens minted via signInWithCustomToken. We can't catch them in fetch/XHR
// because the data flows over WebSocket. Instead, when the user clicks Save
// we run a small async script in the page's MAIN world that calls
// firebase.auth().currentUser.getIdToken() and reads relevant window globals.
async function getFirebaseTokenFromTab(siteKey, site, tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        try {
          if (typeof firebase === "undefined" || !firebase.auth) {
            return { error: "Firebase SDK not loaded on this page" };
          }
          const u = firebase.auth().currentUser;
          if (!u) return { error: "No Firebase user — are you logged in?" };
          const idToken = await u.getIdToken();
          // Pull Roll20-specific page globals (no-op for non-Roll20 sites)
          let dbUrl = null;
          try {
            if (typeof FIREBASE_ROOT !== "undefined" && FIREBASE_ROOT && FIREBASE_ROOT.toString) {
              dbUrl = FIREBASE_ROOT.toString().replace(/\/$/, "");
            }
          } catch (e) {}
          const campaign = typeof window.campaign_storage_path === "string"
            ? window.campaign_storage_path : null;
          const playerId = typeof window.d20_player_id === "string"
            ? window.d20_player_id : null;
          // Try to find a default character (one this player controls)
          let defaultCharId = null;
          try {
            if (window.Campaign && window.Campaign.characters && playerId) {
              const mine = window.Campaign.characters.models.filter(m => {
                const cb = (m.get && m.get("controlledby")) || "";
                return cb.includes(playerId);
              });
              if (mine.length > 0) defaultCharId = mine[0].id;
            }
          } catch (e) {}
          return {
            at: idToken,
            uid: u.uid,
            extra: {
              database_url: dbUrl,
              campaign_path: campaign,
              player_id: playerId,
              default_character_id: defaultCharId
            }
          };
        } catch (e) {
          return { error: String(e && e.message || e) };
        }
      }
    });

    if (results && results[0] && results[0].result) {
      const d = results[0].result;
      if (d.error) {
        console.warn("[MCP Auth Bridge] Firebase capture:", d.error);
        return null;
      }
      if (d.at) {
        const tokenData = { at: d.at, rt: null };
        if (d.extra) {
          for (const [field, value] of Object.entries(d.extra)) {
            if (value != null) tokenData[field] = value;
          }
        }
        return tokenData;
      }
    }
  } catch (e) {
    console.warn("[MCP Auth Bridge] executeScript failed:", e);
  }
  return null;
}

// ─── Check Active Tab for Live Token ────────────────────────────────────────

async function checkActiveTabForToken(siteKey, site) {
  const tokenData = await getTokenFromTab(siteKey, site);
  if (tokenData && tokenData.at) {
    document.getElementById(`dot-${siteKey}`).className = "status-dot yellow";
    document.getElementById(`status-${siteKey}`).textContent = "Ready to save";

    const tokenStatEl = document.getElementById(`stat-${siteKey}-token`);
    if (tokenStatEl) {
      tokenStatEl.textContent = tokenData.at.length + " chars";
      tokenStatEl.className = "value ok";
    }

    // Update extra field stats
    if (site.extra_fields) {
      for (const field of Object.keys(site.extra_fields)) {
        const el = document.getElementById(`stat-${siteKey}-${field}`);
        if (el && tokenData[field]) {
          el.textContent = String(tokenData[field]).slice(0, 12) + "...";
          el.className = "value ok";
        }
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sendMsg(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

// ─── Init ───────────────────────────────────────────────────────────────────

renderSites();

// Open sites.json config in a new tab
document.getElementById("open-config").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("sites.json") });
});
