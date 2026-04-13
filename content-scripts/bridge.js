// MCP Auth Bridge - Bridge Script
// Runs in ISOLATED world on bearer_intercept sites
// Relays token data from MAIN world (token-interceptor.js) to the background worker

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== "__MCP_AUTH_BRIDGE_TOKEN") return;

  // Forward to background service worker
  chrome.runtime.sendMessage(
    { type: "BEARER_TOKEN", siteKey: event.data.data.siteKey, data: event.data.data },
    (response) => {
      if (chrome.runtime.lastError) {
        console.log("[MCP Auth Bridge] Error:", chrome.runtime.lastError.message);
        return;
      }
      if (response && response.success) {
        console.log("[MCP Auth Bridge] Token saved for", event.data.data.siteKey);
      }
    }
  );
});
