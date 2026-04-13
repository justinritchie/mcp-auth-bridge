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

    let statsHTML = "";
    if (site.capture_method === "cookies") {
      const count = stored[`${siteKey}_cookie_count`] || "--";
      statsHTML = `
        <div class="status-row">
          <span>Cookies</span>
          <span class="value ${lastCapture ? 'ok' : ''}">${lastCapture ? count : '--'}</span>
        </div>`;
    } else if (site.capture_method === "bearer_intercept") {
      const tokenLen = stored[`${siteKey}_token_length`] || "--";
      statsHTML = `
        <div class="status-row">
          <span>Bearer token</span>
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
          <span class="capture-type">${site.capture_method === 'cookies' ? 'cookies' : 'bearer'}</span>
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
        ${site.capture_method === 'bearer_intercept' ? `<button class="btn btn-secondary" id="btn-copy-${siteKey}" style="color:${color};border-color:${color}">Copy</button>` : ''}
      </div>
      <div class="message" id="msg-${siteKey}"></div>
    `;

    container.appendChild(card);

    // Wire up save button
    document.getElementById(`btn-save-${siteKey}`).addEventListener("click", () => {
      handleSave(siteKey, site);
    });

    // Wire up copy button (only exists for bearer_intercept sites)
    const copyBtn = document.getElementById(`btn-copy-${siteKey}`);
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        handleCopy(siteKey, site);
      });
    }

    // If this is a bearer_intercept site, check for live token data on active tab
    if (site.capture_method === "bearer_intercept") {
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

  // For bearer intercept sites, get live token from tab
  if (site.capture_method === "bearer_intercept") {
    tokenData = await getTokenFromTab(siteKey, site);
    if (!tokenData || !tokenData.at) {
      btn.disabled = false;
      btn.textContent = `Save ${site.label}`;
      showMsg(msgEl, `No token captured. Browse ${site.label} first.`, "error");
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

  if (site.capture_method === "bearer_intercept") {
    const tokenData = await getTokenFromTab(siteKey, site);
    if (!tokenData || !tokenData.at) {
      showMsg(msgEl, `No token captured. Browse ${site.label} first.`, "error");
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
    // For cookie sites, show a message that copy isn't as useful
    showMsg(msgEl, "Use Save to write cookies to disk. Copy isn't needed for cookie sites.", "error");
    return;
  }

  const json = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    showMsg(msgEl, "Copied JSON to clipboard", "success");
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = json;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showMsg(msgEl, "Copied JSON to clipboard", "success");
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
