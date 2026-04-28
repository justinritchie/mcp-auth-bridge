// MCP Auth Bridge - Background Service Worker
// Generic credential capture router driven by sites.json config

const NATIVE_HOST = "com.mcp.credentials";

// Sites config is loaded at startup and cached
let SITES = {};

// Load sites.json from the extension bundle
async function loadSitesConfig() {
  try {
    const url = chrome.runtime.getURL("sites.json");
    const resp = await fetch(url);
    const data = await resp.json();
    SITES = data.sites || {};
    console.log("[MCP Auth Bridge] Loaded config for sites:", Object.keys(SITES).join(", "));
  } catch (e) {
    console.error("[MCP Auth Bridge] Failed to load sites.json:", e);
  }
}

// Initialize on startup
loadSitesConfig();

// ─── Domain Matching ────────────────────────────────────────────────────────

function findSiteByDomain(hostname) {
  // Strip leading dot and www
  const bare = hostname.replace(/^\./, "").replace(/^www\./, "");
  for (const [key, site] of Object.entries(SITES)) {
    for (const d of site.domains) {
      const bareDomain = d.replace(/^www\./, "");
      if (bare === bareDomain || bare.endsWith("." + bareDomain)) {
        return { key, site };
      }
    }
  }
  return null;
}

// ─── Cookie Capture ─────────────────────────────────────────────────────────

async function captureCookies(siteKey, site, requestedDomain) {
  // Collect cookies from all configured domains for this site
  let allCookies = [];
  const seen = new Set();

  for (const domain of site.domains) {
    // Try with dot prefix and without
    for (const d of [domain, "." + domain, "www." + domain]) {
      try {
        const cookies = await chrome.cookies.getAll({ domain: d });
        for (const c of cookies) {
          const key = `${c.name}|${c.domain}`;
          if (seen.has(key)) continue;
          seen.add(key);
          allCookies.push(c);
        }
      } catch (e) {}
    }
  }

  if (allCookies.length === 0) {
    return { success: false, error: `No cookies found for ${site.label}. Are you logged in?` };
  }

  // If site specifies required cookies, check for them
  if (site.required_cookies && site.required_cookies.length > 0) {
    const hasRequired = site.required_cookies.every(pattern => {
      if (pattern.includes("*")) {
        const prefix = pattern.replace("*", "");
        return allCookies.some(c => c.name.startsWith(prefix));
      }
      return allCookies.some(c => c.name === pattern);
    });
    if (!hasRequired) {
      return {
        success: false,
        error: `Auth cookies missing for ${site.label}. Log in first.`,
        cookieCount: allCookies.length
      };
    }
  }

  // Filter to specific cookies if configured
  let cookiesToSend = allCookies;
  if (site.cookies && site.cookies.length > 0) {
    cookiesToSend = allCookies.filter(c => site.cookies.includes(c.name));
    if (cookiesToSend.length === 0) {
      return {
        success: false,
        error: `Required cookies (${site.cookies.join(", ")}) not found for ${site.label}. Are you logged in?`,
        cookieCount: allCookies.length
      };
    }
  }

  // Format based on output_format
  let payload;
  if (site.output_format === "cookie_editor") {
    // Full cookie objects (Cookie-Editor compatible)
    payload = {
      site: siteKey,
      output_format: site.output_format,
      output_path: site.output_path,
      cookies: cookiesToSend.map(c => ({
        domain: c.domain,
        expirationDate: c.expirationDate || null,
        hostOnly: c.hostOnly || false,
        httpOnly: c.httpOnly || false,
        name: c.name,
        path: c.path || "/",
        sameSite: c.sameSite === "unspecified" ? null : c.sameSite,
        secure: c.secure || false,
        session: c.session || false,
        storeId: c.storeId || null,
        value: c.value
      }))
    };
  } else {
    // cookie_jar: simple name->value map
    const cookieMap = {};
    for (const c of cookiesToSend) {
      cookieMap[c.name] = c.value;
    }
    payload = {
      site: siteKey,
      output_format: site.output_format || "cookie_jar",
      output_path: site.output_path,
      cookies: cookieMap,
      domain: site.domains[0]
    };
  }

  return new Promise(resolve => {
    sendToNativeHost(payload, response => {
      resolve({
        success: true,
        cookieCount: cookiesToSend.length,
        domain: site.domains[0],
        nativeResponse: response
      });
    });
  });
}

// ─── Bearer Token Handling ──────────────────────────────────────────────────

function handleBearerToken(siteKey, site, data) {
  return new Promise(resolve => {
    if (!data.at || !data.at.startsWith("eyJ")) {
      resolve({ success: false, error: "No valid bearer token received" });
      return;
    }

    const payload = {
      site: siteKey,
      output_format: site.output_format,
      output_path: site.output_path,
      access_token: data.at,
      refresh_token: data.rt || null,
      extra_fields: {},
      credential_type: site.credential_type || siteKey
    };

    // Include any extra fields (like cartId)
    if (site.extra_fields) {
      for (const [field, _config] of Object.entries(site.extra_fields)) {
        if (data[field] !== undefined) {
          payload.extra_fields[field] = data[field];
        }
      }
    }

    // Pass dotenv config if present
    if (site.dotenv_mapping) payload.dotenv_mapping = site.dotenv_mapping;
    if (site.dotenv_defaults) payload.dotenv_defaults = site.dotenv_defaults;
    if (site.credential_file) payload.credential_file = site.credential_file;

    sendToNativeHost(payload, response => {
      resolve({
        success: true,
        tokenLength: data.at.length,
        hasExtra: Object.keys(payload.extra_fields).length > 0,
        nativeResponse: response
      });
    });
  });
}

// ─── Native Messaging ───────────────────────────────────────────────────────

function sendToNativeHost(message, callback) {
  try {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, response => {
      if (chrome.runtime.lastError) {
        console.error("[MCP Auth Bridge] Native host error:", chrome.runtime.lastError.message);
        callback({ success: false, error: chrome.runtime.lastError.message });
      } else {
        callback(response || { success: true });
      }
    });
  } catch (e) {
    console.error("[MCP Auth Bridge] Native messaging exception:", e);
    callback({ success: false, error: e.message });
  }
}

// ─── Message Listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Generic save request from popup
  if (message.type === "SAVE_SITE") {
    const siteKey = message.siteKey;
    const site = SITES[siteKey];
    if (!site) {
      sendResponse({ success: false, error: `Unknown site: ${siteKey}` });
      return true;
    }

    if (site.capture_method === "cookies") {
      captureCookies(siteKey, site, message.domain).then(result => {
        // Store last capture info
        const storageData = {};
        storageData[`${siteKey}_last_capture`] = Date.now();
        storageData[`${siteKey}_cookie_count`] = result.cookieCount || 0;
        storageData[`${siteKey}_save_result`] = result;
        chrome.storage.local.set(storageData);
        sendResponse(result);
      });
      return true;
    }

    if (site.capture_method === "bearer_intercept" || site.capture_method === "firebase_idtoken") {
      // Both methods produce the same payload shape; route through handleBearerToken.
      if (message.tokenData) {
        handleBearerToken(siteKey, site, message.tokenData).then(result => {
          const storageData = {};
          storageData[`${siteKey}_last_capture`] = Date.now();
          storageData[`${siteKey}_token_length`] = message.tokenData.at ? message.tokenData.at.length : 0;
          storageData[`${siteKey}_save_result`] = result;
          // Store extra fields info
          if (site.extra_fields) {
            for (const field of Object.keys(site.extra_fields)) {
              storageData[`${siteKey}_has_${field}`] = !!message.tokenData[field];
            }
          }
          chrome.storage.local.set(storageData);
          sendResponse(result);
        });
      } else {
        const hint = site.capture_method === "firebase_idtoken"
          ? `Open ${site.label} in a tab and make sure you're logged in.`
          : `Browse ${site.label} first.`;
        sendResponse({ success: false, error: `No token data. ${hint}` });
      }
      return true;
    }

    sendResponse({ success: false, error: `Unknown capture method: ${site.capture_method}` });
    return true;
  }

  // Token relay from content script bridge
  if (message.type === "BEARER_TOKEN") {
    const siteKey = message.siteKey;
    const site = SITES[siteKey];
    if (!site) return;

    handleBearerToken(siteKey, site, message.data).then(result => {
      const storageData = {};
      storageData[`${siteKey}_last_capture`] = Date.now();
      storageData[`${siteKey}_token_length`] = message.data.at ? message.data.at.length : 0;
      storageData[`${siteKey}_save_result`] = result;
      if (site.extra_fields) {
        for (const field of Object.keys(site.extra_fields)) {
          storageData[`${siteKey}_has_${field}`] = !!message.data[field];
        }
      }
      chrome.storage.local.set(storageData);
      sendResponse(result);
    });
    return true;
  }

  // Get status for all sites
  if (message.type === "GET_STATUS") {
    chrome.storage.local.get(null, data => {
      sendResponse({ stored: data, sites: SITES });
    });
    return true;
  }

  // Get sites config
  if (message.type === "GET_SITES") {
    sendResponse({ sites: SITES });
    return true;
  }
});
