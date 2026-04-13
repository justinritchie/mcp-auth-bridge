# MCP Auth Bridge

Give your LLM access to your accounts. One click in Chrome, and your MCP servers can shop, browse, and manage services on your behalf.

Most useful sites don't have APIs. They have login sessions. MCP Auth Bridge is a Chrome extension that captures your session credentials (cookies, bearer tokens) and writes them to disk so MCP servers can pick them up. Log into a site in Chrome, click Save, and your AI can use that session to search products, manage wishlists, place grocery orders, and more.

## Why This Exists

MCP servers are great at automating tasks, but they hit a wall the moment a site requires authentication. You can't just paste a session cookie into a config file; most auth cookies are httpOnly (invisible to JavaScript) and bearer tokens rotate constantly.

This started with a specific problem: getting Amazon's httpOnly auth cookies into an MCP server so Claude could search and shop. A Chrome extension can read those cookies where bookmarklets and scripts can't. That approach worked well enough that it made sense to generalize it. Now adding a new site is just a JSON entry.

## What It's Been Used For

| Site | What the MCP server does | Auth method |
|------|--------------------------|-------------|
| [PC Express](https://github.com/justinritchie/pcexpress-mcp-server) | Grocery shopping at Real Canadian Superstore. Search products, add to cart, reorder past purchases. | Bearer token + cart ID from API calls |
| [Deku Deals](https://github.com/justinritchie/dekudeals-mcp-server) | Nintendo eShop deal tracking. Search games, check prices, manage wishlists, find sales. | Session cookie |
| [Amazon](https://github.com/rigwild/mcp-server-amazon) | Product search, order history, wishlist management on Amazon.ca. | httpOnly auth cookies |

The pattern works for any site where you log in through a browser. If the site uses cookies or bearer tokens (which is nearly all of them), you can add it.

## How It Works

You define sites in `sites.json`. Each entry specifies the domain, what kind of credentials to capture, and where to write them. Two capture methods:

**Cookies** grab session cookies via Chrome's `cookies` API, which can read httpOnly cookies that regular JavaScript can't touch. This is the simpler path and works for most sites.

**Bearer intercept** patches `fetch()` and `XMLHttpRequest` on the page to capture OAuth tokens from API calls as they happen. More involved, but necessary for sites like PC Express where the token isn't in a cookie.

When you click Save, the extension sends credentials to a native messaging host (a small Python script) that writes them to `~/.mcp-credentials/` in the right format. MCP servers read that file fresh on each call. No restarts, no config file juggling.

## Setup

### 1. Load the Extension

Open `chrome://extensions`, enable Developer mode, click Load unpacked, and select this folder. Note the Extension ID.

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
4. Your MCP server picks up the fresh credentials on its next call

That's it. No terminal commands, no manual token copying, no restarting Claude Desktop.

## Adding a New Site

For cookie-based sites, add an entry to `sites.json` and reload the extension. No code changes.

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

For bearer intercept sites, you'll also need to add content script matches in `manifest.json` and URL patterns in `content-scripts/token-interceptor.js`.

## Output Formats

**cookie_jar** is a simple JSON object with cookie names and values, a domain, and a timestamp. Good for most MCP servers.

**cookie_editor** writes the full cookie array in the format the Cookie-Editor browser extension uses. Useful when the MCP server needs all cookie metadata (expiration, httpOnly flags, etc.).

**dotenv** writes a `.env` file with configurable variable mapping, plus an optional JSON credential file for servers that want live-reload without parsing dotenv.

## File Structure

```
mcp-auth-bridge/
  sites.json                     Site config (the only file you edit to add sites)
  manifest.json                  Chrome extension manifest (Manifest V3)
  background.js                  Service worker that routes by site config
  popup.html + popup.js          One-click UI with a card per configured site
  content-scripts/
    token-interceptor.js         Patches fetch/XHR to capture bearer tokens
    bridge.js                    Relays tokens from page context to extension
  native-host/
    credential_host.py           Writes credentials to disk in the right format
    com.mcp.credentials.json     Native host manifest template
  install.sh                     One-time setup for the native messaging host
```
