# MCP Auth Bridge

Config-driven Chrome extension that captures credentials (cookies, bearer tokens) for MCP servers. Add a new site by editing `sites.json` — no code changes needed for cookie-based sites.

## Background

This started as a hardcoded credential capture extension built for [mcp-server-amazon](https://github.com/justinritchie/mcp-server-amazon) — that project needed a way to grab Amazon's httpOnly auth cookies, which regular JavaScript can't access. The Chrome extension approach worked so well that it made sense to generalize it into a config-driven tool that any MCP server can use.

MCP Auth Bridge has been tested with three sites covering both capture methods:

- **Amazon** (cookies, cookie_editor format) — the original use case that inspired this project
- **PC Express** (bearer_intercept) — OAuth bearer token + cart ID capture from Loblaws grocery API calls
- **Deku Deals** (cookies, cookie_jar format) — session cookie capture for Nintendo eShop deal tracking

## How It Works

The extension reads `sites.json` to discover which sites to monitor. Two capture methods are supported:

- **cookies** — Uses `chrome.cookies.getAll()` to read cookies (including httpOnly) for configured domains. No content scripts needed.
- **bearer_intercept** — Injects content scripts that patch `fetch()` and `XMLHttpRequest` to capture Authorization headers from API calls.

Captured credentials are sent to a native messaging host (Python script) that writes them to disk in the configured format. MCP servers read the credential files at runtime — no Claude Desktop restarts needed.

## Configured Sites

| Site | Method | Output | MCP Server |
|------|--------|--------|------------|
| Deku Deals | cookies | `~/.mcp-credentials/dekudeals.json` | [dekudeals-mcp-server](https://github.com/justinritchie/dekudeals-mcp-server) |
| PC Express | bearer_intercept | `~/.mcp-credentials/pcexpress.json` + `.env` | [pcexpress-mcp-server](https://github.com/justinritchie/pcexpress-mcp-server) |
| Amazon | cookies | `~/mcp-server-amazon/amazonCookies.json` | [mcp-server-amazon](https://github.com/justinritchie/mcp-server-amazon) |

## Setup

### 1. Load the Extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this `mcp-auth-bridge/` folder
4. Note the **Extension ID**

### 2. Install the Native Host

```bash
chmod +x install.sh
./install.sh <your-extension-id>
```

### 3. Restart Chrome

Close and reopen Chrome so it picks up the native messaging registration.

## Usage

1. Browse to a configured site and log in
2. Click the MCP Auth Bridge extension icon
3. Click **Save** for the site you want
4. Credentials are written to the configured output path
5. The MCP server picks up fresh credentials on its next call — no restart needed

## Adding a New Site

Edit `sites.json` and add an entry. For cookie-based sites, that's all you need — reload the extension and it works. For bearer intercept sites, you'll also need to add content script matches in `manifest.json` and URL patterns in `content-scripts/token-interceptor.js`.

### Cookie site example:

```json
{
  "mysite": {
    "label": "My Site",
    "domains": ["mysite.com"],
    "capture_method": "cookies",
    "cookies": ["session_id"],
    "output_path": "~/.mcp-credentials/mysite.json",
    "output_format": "cookie_jar"
  }
}
```

## Output Formats

- **cookie_jar**: `{"cookies": {"name": "value"}, "domain": "...", "captured_at": "..."}`
- **cookie_editor**: Full cookie array compatible with the Cookie-Editor browser extension
- **dotenv**: `.env` file with configurable variable mapping (+ optional JSON credential file for live reload)

## File Structure

```
mcp-auth-bridge/
  manifest.json                  Extension manifest (Manifest V3)
  background.js                  Service worker — generic credential router
  sites.json                     THE CONFIG — defines all sites declaratively
  popup.html + popup.js          Dynamic UI — renders a card per site
  content-scripts/
    token-interceptor.js         Bearer token interceptor (MAIN world)
    bridge.js                    Token relay to background (ISOLATED world)
  native-host/
    credential_host.py           Generic credential writer
    com.mcp.credentials.json     Native host manifest template
  install.sh                     One-time native host installer
  icons/                         Extension icons
```
