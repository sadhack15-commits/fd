#!/usr/bin/env node
'use strict';
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { exec, spawn } = require('child_process');

// ── Platform detection ────────────────────────────────────────────────────────
const IS_WIN   = process.platform === 'win32';
const IS_MAC   = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const OS_NAME  = IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux/Ubuntu';

function findChromePath() {
  if (IS_WIN) {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    ];
    return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
  }
  if (IS_MAC) {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      .find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
  }
  const { execSync } = require('child_process');
  for (const cmd of ['which google-chrome', 'which chromium-browser', 'which chromium', 'which google-chrome-stable']) {
    try { return execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); } catch {}
  }
  return null;
}

function getPuppeteerArgs() {
  const base = ['--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-zygote', '--disable-extensions', '--disable-background-networking', '--disable-default-apps', '--mute-audio', '--no-default-browser-check'];
  if (IS_LINUX) base.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-accelerated-2d-canvas', '--disable-web-security', '--font-render-hinting=none');
  return base;
}

// ── Screenshot output dir ─────────────────────────────────────────────────────
const SCREENSHOT_DIR = path.resolve(process.cwd(), 'screenshots');
function ensureScreenshotDir() {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// ── Cloudflare Tunnel ──────────────────────────────────────────────────────────
const CF_TOKEN = process.env.CF_TUNNEL_TOKEN || 'eyJhIjoiNzEyODRlNzU4NDM5MDIyYzljOGQzZjE0ZTM5NTRmZTQiLCJ0IjoiMWVhNTJlNTItMjU2ZC00N2Y1LTg2NGMtYjIwNzYyYTdkZTE0IiwicyI6Ik56WmhZMlprTWpjdE4yUmhNQzAwTTJRM0xXRmlNRE10T1RJMk5HWmhNR000TW1RMSJ9';

async function installCloudflared() {
  return new Promise(resolve => {
    exec('which cloudflared', (err, stdout) => {
      if (!err && stdout.trim()) { console.log('\x1b[32m✓ cloudflared đã cài sẵn\x1b[0m'); return resolve(true); }
      console.log('\x1b[33m⏳ Cài cloudflared...\x1b[0m');
      const installCmd = IS_WIN
        ? 'winget install Cloudflare.cloudflared'
        : IS_MAC
        ? 'brew install cloudflared'
        : `curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb && dpkg -i /tmp/cloudflared.deb 2>/dev/null || (curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared)`;
      exec(installCmd, { timeout: 120000 }, (err2) => {
        if (err2) { console.error('\x1b[31m✗ Không cài được cloudflared:', err2.message, '\x1b[0m'); return resolve(false); }
        console.log('\x1b[32m✓ Đã cài cloudflared\x1b[0m');
        resolve(true);
      });
    });
  });
}

let _cfProcess = null;
let _cfUrl = null;
async function startCloudflareTunnel(port) {
  if (!CF_TOKEN) { console.log('\x1b[90m  (Cloudflare tunnel: không có token)\x1b[0m'); return null; }
  const ok = await installCloudflared();
  if (!ok) return null;
  return new Promise(resolve => {
    console.log('\x1b[33m🌐 Khởi động Cloudflare Tunnel...\x1b[0m');
    _cfProcess = spawn('cloudflared', ['tunnel', 'run', '--token', CF_TOKEN], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    let resolved = false;
    const tryResolve = (url) => { if (!resolved) { resolved = true; _cfUrl = url; resolve(url); } };
    const parseUrl = (line) => {
      const m = line.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/i)
             || line.match(/https:\/\/[^\s]+\.cfargotunnel\.com/i)
             || line.match(/INF \|[^|]*\| (https:\/\/[^\s|]+)/i);
      return m ? (m[1] || m[0]) : null;
    };
    _cfProcess.stdout.on('data', d => { const line = d.toString(); const u = parseUrl(line); if (u) tryResolve(u); });
    _cfProcess.stderr.on('data', d => { const line = d.toString(); const u = parseUrl(line); if (u) tryResolve(u); });
    _cfProcess.on('error', () => { if (!resolved) resolve(null); });
    _cfProcess.on('exit', () => { if (!resolved) resolve(null); });
    setTimeout(() => { if (!resolved) { console.log('\x1b[33m  [CF] Timeout — tiếp tục không có public URL\x1b[0m'); resolve(null); } }, 30000);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ── MULTI-SOURCE SEARCH ENGINE ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const CUSTOM_SEARCH_API = process.env.SEARCH_API_BASE || '';
const BRAVE_API_KEY     = process.env.BRAVE_API_KEY   || '';
const JINA_API_KEY      = process.env.JINA_API_KEY    || '';

const SEARXNG_INSTANCES = [
  'https://searx.be',
  'https://search.sapti.me',
  'https://searxng.site',
  'https://search.privacyguides.net',
  'https://sx.catgirl.cloud',
];

function httpGet(url, headers = {}, timeout = 12000) {
  return new Promise(resolve => {
    try {
      const urlObj = new URL(url);
      const lib = urlObj.protocol === 'https:' ? https : http;
      let data = '';
      const req = lib.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Accept': 'application/json,text/html,*/*;q=0.9',
          'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
          ...headers,
        }
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          try {
            const loc = res.headers.location.startsWith('http')
              ? res.headers.location
              : new URL(res.headers.location, url).href;
            return resolve(httpGet(loc, headers, timeout));
          } catch { return resolve({ ok: false, status: res.statusCode, body: '', error: 'bad redirect' }); }
        }
        res.on('data', c => { data += c; if (data.length > 600000) res.destroy(); });
        res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, body: data }));
        res.on('error', e => resolve({ ok: false, status: 0, body: '', error: e.message }));
      });
      req.on('error', e => resolve({ ok: false, status: 0, body: '', error: e.message }));
      req.setTimeout(timeout, () => { req.destroy(); resolve({ ok: false, status: 0, body: '', error: 'timeout' }); });
    } catch (e) { resolve({ ok: false, status: 0, body: '', error: e.message }); }
  });
}

async function searchDuckDuckGo(query, lang = 'vi', count = 8) {
  const kl = lang === 'vi' ? 'vn-vi' : 'us-en';
  const q  = encodeURIComponent(query);
  const res = await httpGet(`https://html.duckduckgo.com/html/?q=${q}&kl=${kl}`);
  if (!res.ok) return [];
  const results = [];
  const blockRe = /<div class="result[^"]*"[\s\S]*?<\/div>\s*<\/div>/g;
  const titleRe = /<a class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/;
  const snipRe  = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;
  let m;
  while ((m = blockRe.exec(res.body)) && results.length < count) {
    const block = m[0];
    const t = titleRe.exec(block);
    const s = snipRe.exec(block);
    if (t) results.push({ source: 'duckduckgo', title: t[2].replace(/<[^>]+>/g, '').trim(), url: t[1], snippet: s ? s[1].replace(/<[^>]+>/g, '').trim() : '' });
  }
  if (!results.length) {
    const tRe = /<a class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const sRe = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const titles = []; const snips = [];
    while ((m = tRe.exec(res.body)) && titles.length < count + 2) titles.push({ url: m[1], title: m[2].replace(/<[^>]+>/g, '').trim() });
    while ((m = sRe.exec(res.body))  && snips.length  < count + 2) snips.push(m[1].replace(/<[^>]+>/g, '').trim());
    for (let i = 0; i < Math.min(titles.length, count); i++)
      results.push({ source: 'duckduckgo', title: titles[i].title, url: titles[i].url, snippet: snips[i] || '' });
  }
  return results;
}

async function searchDuckDuckGoJSON(query, count = 5) {
  const q   = encodeURIComponent(query);
  const res = await httpGet(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`);
  if (!res.ok) return [];
  try {
    const j = JSON.parse(res.body);
    const out = [];
    if (j.AbstractText) out.push({ source: 'ddg-instant', title: j.Heading || 'DuckDuckGo Instant', url: j.AbstractURL || '', snippet: j.AbstractText.slice(0, 400) });
    (j.RelatedTopics || []).slice(0, count - 1).forEach(t => { if (t.Text && t.FirstURL) out.push({ source: 'ddg-related', title: t.Text.slice(0, 100), url: t.FirstURL, snippet: t.Text.slice(0, 300) }); });
    (j.Results || []).slice(0, 3).forEach(t => { if (t.Text && t.FirstURL) out.push({ source: 'ddg-result', title: t.Text.slice(0, 100), url: t.FirstURL, snippet: t.Text.slice(0, 300) }); });
    return out;
  } catch { return []; }
}

async function searchWikipedia(query, lang = 'vi', count = 4) {
  const q   = encodeURIComponent(query);
  const res = await httpGet(`https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${q}&limit=${count}&namespace=0&format=json`);
  if (!res.ok) return [];
  try {
    const [, titles, snippets, urls] = JSON.parse(res.body);
    return titles.map((title, i) => ({ source: 'wikipedia', title, url: urls[i] || '', snippet: snippets[i] || '' }));
  } catch { return []; }
}

async function getWikipediaSummary(query, lang = 'vi') {
  const fetchSummary = async (l, q) => {
    const res = await httpGet(`https://${l}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`);
    if (!res.ok) return null;
    try {
      const j = JSON.parse(res.body);
      if (j.extract) return { source: 'wikipedia-summary', title: j.title || q, url: j.content_urls?.desktop?.page || '', snippet: j.extract.slice(0, 600) };
    } catch {}
    return null;
  };
  const r = await fetchSummary(lang, query);
  if (r) return [r];
  if (lang !== 'en') { const r2 = await fetchSummary('en', query); if (r2) return [r2]; }
  return [];
}

async function searchJina(query, count = 5) {
  const q       = encodeURIComponent(query);
  const headers = { 'Accept': 'application/json', 'X-Retain-Images': 'none' };
  if (JINA_API_KEY) headers['Authorization'] = `Bearer ${JINA_API_KEY}`;
  const res = await httpGet(`https://s.jina.ai/?q=${q}`, headers, 15000);
  if (!res.ok) return [];
  try {
    const j = JSON.parse(res.body);
    const items = j.data || j.results || [];
    return items.slice(0, count).map(item => ({ source: 'jina-search', title: item.title || '', url: item.url || '', snippet: (item.description || item.content || '').slice(0, 400) }));
  } catch {
    const lines = res.body.split('\n');
    const results = [];
    let cur = null;
    for (const line of lines) {
      const titleMatch = line.match(/^#{1,3}\s+\d+\.\s+(.+)/);
      const urlMatch   = line.match(/^URL:\s*(https?:\/\/\S+)/i);
      const descMatch  = line.match(/^(?:Description|Content):\s*(.+)/i);
      if (titleMatch) { if (cur) results.push(cur); cur = { source: 'jina-search', title: titleMatch[1].trim(), url: '', snippet: '' }; }
      else if (urlMatch  && cur) cur.url     = urlMatch[1];
      else if (descMatch && cur) cur.snippet = descMatch[1].slice(0, 400);
    }
    if (cur) results.push(cur);
    return results.slice(0, count);
  }
}

async function jinaRead(url) {
  const headers = { 'Accept': 'application/json', 'X-Retain-Images': 'none', 'X-Timeout': '10' };
  if (JINA_API_KEY) headers['Authorization'] = `Bearer ${JINA_API_KEY}`;
  const res = await httpGet(`https://r.jina.ai/${encodeURIComponent(url)}`, headers, 15000);
  if (!res.ok) return null;
  try {
    const j = JSON.parse(res.body);
    return { title: j.data?.title || '', content: (j.data?.content || '').slice(0, 8000), url };
  } catch {
    return { title: '', content: res.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000), url };
  }
}

async function searchSearXNG(query, count = 8) {
  const q = encodeURIComponent(query);
  for (const base of SEARXNG_INSTANCES) {
    const res = await httpGet(`${base}/search?q=${q}&format=json&categories=general&language=auto&engines=google,bing,duckduckgo,wikipedia`, { 'Accept': 'application/json' }, 10000);
    if (res.ok && res.body) {
      try {
        const j = JSON.parse(res.body);
        const items = (j.results || []).slice(0, count).map(r => ({ source: 'searxng', title: r.title || '', url: r.url || '', snippet: r.content || '' }));
        if (items.length) return items;
      } catch {}
    }
  }
  return [];
}

async function searchBing(query, count = 8) {
  const q   = encodeURIComponent(query);
  const res = await httpGet(`https://www.bing.com/search?q=${q}&count=${count}&setlang=vi`, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
  });
  if (!res.ok) return [];
  const results = [];
  const blockRe = /<li[^>]*class="[^"]*b_algo[^"]*"[\s\S]*?<\/li>/g;
  const titleRe = /<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/;
  const snipRe  = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/;
  let m;
  while ((m = blockRe.exec(res.body)) && results.length < count) {
    const block = m[0];
    const t = titleRe.exec(block);
    const s = snipRe.exec(block);
    if (t && t[1].startsWith('http') && !t[1].includes('bing.com'))
      results.push({ source: 'bing', title: t[2].replace(/<[^>]+>/g, '').trim(), url: t[1], snippet: s ? s[1].replace(/<[^>]+>/g, '').trim() : '' });
  }
  return results;
}

async function searchBrave(query, count = 8) {
  if (!BRAVE_API_KEY) return [];
  const q   = encodeURIComponent(query);
  const res = await httpGet(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=${count}`, { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': BRAVE_API_KEY });
  if (!res.ok) return [];
  try {
    const j = JSON.parse(res.body);
    return (j.web?.results || []).slice(0, count).map(r => ({ source: 'brave', title: r.title || '', url: r.url || '', snippet: r.description || '' }));
  } catch { return []; }
}

async function searchCustomAPI(query, count = 8) {
  if (!CUSTOM_SEARCH_API) return [];
  const q   = encodeURIComponent(query);
  const res = await httpGet(`${CUSTOM_SEARCH_API}/${q}/${count}`, {}, 12000);
  if (!res.ok) return [];
  try {
    let data = JSON.parse(res.body);
    if (!Array.isArray(data)) data = data.results || data.items || data.data || [];
    return data.slice(0, count).map(item => ({ source: 'custom-api', title: item.title || item.name || item.heading || '', url: item.url || item.link || item.href || '', snippet: item.snippet || item.description || item.body || item.text || '' }));
  } catch { return []; }
}

async function multiSearch(query, opts = {}) {
  const { lang = 'vi', count = 8, sources = ['duckduckgo', 'ddg-json', 'wikipedia', 'jina', 'searxng', 'bing', 'brave', 'custom'] } = opts;
  const tasks = [];
  if (sources.includes('duckduckgo')) tasks.push(searchDuckDuckGo(query, lang, count).catch(() => []));
  if (sources.includes('ddg-json'))   tasks.push(searchDuckDuckGoJSON(query, 5).catch(() => []));
  if (sources.includes('wikipedia')) {
    const wl = lang === 'vi' ? 'vi' : 'en';
    tasks.push(searchWikipedia(query, wl, 4).catch(() => []));
    tasks.push(getWikipediaSummary(query, wl).catch(() => []));
  }
  if (sources.includes('jina'))    tasks.push(searchJina(query, count).catch(() => []));
  if (sources.includes('searxng')) tasks.push(searchSearXNG(query, count).catch(() => []));
  if (sources.includes('bing'))    tasks.push(searchBing(query, count).catch(() => []));
  if (sources.includes('brave'))   tasks.push(searchBrave(query, count).catch(() => []));
  if (sources.includes('custom'))  tasks.push(searchCustomAPI(query, count).catch(() => []));
  const allRaw = await Promise.all(tasks);
  let all = allRaw.flat();
  const seen = new Map();
  for (const r of all) {
    const key = (r.url || '').split('?')[0].replace(/\/$/, '').toLowerCase();
    if (!key || key.length < 8) continue;
    const existing = seen.get(key);
    if (!existing || (existing.snippet || '').length < (r.snippet || '').length) seen.set(key, r);
  }
  return [...seen.values()].slice(0, count * 3);
}

// ── Browser (Puppeteer) singleton ─────────────────────────────────────────────
let _browser = null, _page = null, _consoleLogs = [], _networkLog = [];

async function getBrowser() {
  if (_browser) return _browser;
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch {
    console.log('\x1b[33m⏳ Cài puppeteer...\x1b[0m');
    await new Promise((res, rej) => exec('npm install puppeteer --prefix ' + __dirname, e => e ? rej(e) : res()));
    puppeteer = require('puppeteer');
  }
  const launchOpts = { headless: 'new', args: getPuppeteerArgs() };
  const systemChrome = findChromePath();
  if (systemChrome) { launchOpts.executablePath = systemChrome; console.log(`\x1b[90m  🌐 Chrome: ${systemChrome}\x1b[0m`); }
  _browser = await puppeteer.launch(launchOpts);
  return _browser;
}

async function getPage() {
  const browser = await getBrowser();
  if (!_page || _page.isClosed()) {
    _page = await browser.newPage();
    _consoleLogs = []; _networkLog = [];
    _page.on('console', msg => { _consoleLogs.push({ level: msg.type(), text: msg.text(), time: Date.now() }); if (_consoleLogs.length > 500) _consoleLogs.shift(); });
    _page.on('request', req => { _networkLog.push({ type: 'request', method: req.method(), url: req.url(), time: Date.now() }); if (_networkLog.length > 200) _networkLog.shift(); });
    _page.on('response', res => { _networkLog.push({ type: 'response', status: res.status(), url: res.url(), time: Date.now() }); });
  }
  return _page;
}

// ══════════════════════════════════════════════════════════════════════════════
// ── HTTP Server ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || '3399');

function startServer(port) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, `http://localhost:${port}`);

    // ── GET /api/info ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        name:    'MiMo MCP Server',
        version: '5.0',
        platform: process.platform,
        os:      OS_NAME,
        cfUrl:   _cfUrl || null,
        endpoints: {
          search:     'GET /api/search/{query}/{count}?lang=vi&sources=duckduckgo,jina,wikipedia',
          read_url:   'GET /api/read?url=https://...&jina=1&browser=0',
          wikipedia:  'GET /api/wikipedia?q=...&lang=vi&full=0',
          browser: {
            navigate:      'POST /api/browser/navigate',
            screenshot:    'POST /api/browser/screenshot',
            screenshot_get:'GET  /api/browser/screenshot/{filename}',
            eval:          'POST /api/browser/eval',
            resize:        'POST /api/browser/resize',
            emulate:       'POST /api/browser/emulate',
            console:       'GET  /api/browser/console?limit=50&clear=0',
            network:       'GET  /api/browser/network?limit=50&filter=&clear=0',
            accessibility: 'POST /api/browser/accessibility',
            close:         'POST /api/browser/close',
          },
          image: {
            list:   'GET  /api/screenshots',
            get:    'GET  /api/screenshots/{filename}',
            delete: 'DELETE /api/screenshots/{filename}',
          },
        },
        searchSources: ['duckduckgo', 'ddg-json', 'wikipedia', 'jina', 'searxng', 'bing', 'brave', 'custom'],
        jinaKeySet:    !!JINA_API_KEY,
        braveKeySet:   !!BRAVE_API_KEY,
        customApiSet:  !!CUSTOM_SEARCH_API,
      }));
    }

    // ── GET /api/search/{query}/{count} ───────────────────────────────────────
    const searchMatch = url.pathname.match(/^\/api\/search\/([^/]+)(?:\/(\d+))?$/);
    if (req.method === 'GET' && searchMatch) {
      const query   = decodeURIComponent(searchMatch[1]);
      const count   = parseInt(searchMatch[2] || '10');
      const lang    = url.searchParams.get('lang')    || 'vi';
      const srcStr  = url.searchParams.get('sources');
      const sources = srcStr ? srcStr.split(',').map(s => s.trim()) : undefined;
      try {
        const results = await multiSearch(query, { lang, count, sources });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ query, count: results.length, sources: [...new Set(results.map(r => r.source))], results }));
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
    }

    // ── GET /api/read — read any URL ──────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/read') {
      const targetUrl    = url.searchParams.get('url');
      const forceJina    = url.searchParams.get('jina')    === '1';
      const forceBrowser = url.searchParams.get('browser') === '1';
      if (!targetUrl) { res.writeHead(400); return res.end(JSON.stringify({ error: 'url param required' })); }

      let result = null;

      // 1. Jina Reader
      if (!forceBrowser || forceJina) {
        const r = await jinaRead(targetUrl).catch(() => null);
        if (r && r.content && r.content.length > 100) {
          result = { ok: true, title: r.title, content: r.content, via: 'jina-reader' };
        }
      }

      // 2. Direct HTTP
      if (!result && !forceBrowser) {
        const r = await httpGet(targetUrl, {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
        }, 12000);
        if (r.ok) {
          let out = r.body
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ').trim().slice(0, 10000);
          if (out.length > 200) result = { ok: true, content: out, via: 'http' };
        }
      }

      // 3. Puppeteer browser
      if (!result) {
        try {
          const page = await getPage();
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          const out = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ').trim().slice(0, 10000);
          result = { ok: true, content: out, via: 'browser' };
        } catch (e) { result = { ok: false, content: `Error: ${e.message}`, via: 'browser' }; }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ url: targetUrl, ...result }));
    }

    // ── GET /api/wikipedia ────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/wikipedia') {
      const query = url.searchParams.get('q') || '';
      const lang  = url.searchParams.get('lang') || 'vi';
      const full  = url.searchParams.get('full') === '1';
      const wl    = lang === 'vi' ? 'vi' : 'en';
      if (!query) { res.writeHead(400); return res.end(JSON.stringify({ error: 'q param required' })); }
      try {
        if (full) {
          const q   = encodeURIComponent(query);
          const r   = await httpGet(`https://${wl}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=false&explaintext=true&titles=${q}&format=json&redirects=1`);
          if (r.ok) {
            const j = JSON.parse(r.body);
            const pages = Object.values(j.query?.pages || {});
            if (pages[0]?.extract) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ query, lang, title: pages[0].title, extract: pages[0].extract.slice(0, 8000) }));
            }
          }
        }
        const [search, summary] = await Promise.all([searchWikipedia(query, wl, 5), getWikipediaSummary(query, wl)]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ query, lang, results: [...summary, ...search] }));
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── BROWSER CONTROL ENDPOINTS ─────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    // ── POST /api/browser/navigate ────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/browser/navigate') {
      let body = ''; req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { url: targetUrl, waitUntil = 'domcontentloaded', timeout = 15000 } = JSON.parse(body);
          if (!targetUrl) { res.writeHead(400); return res.end(JSON.stringify({ error: 'url required' })); }
          const page = await getPage();
          await page.goto(targetUrl, { waitUntil, timeout });
          const title = await page.title();
          const currentUrl = page.url();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, url: currentUrl, title }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
      }); return;
    }

    // ── POST /api/browser/screenshot ──────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/browser/screenshot') {
      let body = ''; req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          ensureScreenshotDir();
          const { filename: fname, selector, fullPage = false, format = 'png', quality = 80 } = body ? JSON.parse(body) : {};
          const ext      = format === 'jpeg' ? 'jpg' : 'png';
          const filename = fname || `screenshot_${Date.now()}.${ext}`;
          const savePath = path.join(SCREENSHOT_DIR, path.basename(filename));
          const page     = await getPage();
          const opts     = { path: savePath, fullPage, type: format === 'jpeg' ? 'jpeg' : 'png' };
          if (format === 'jpeg') opts.quality = quality;
          if (selector) {
            const el = await page.$(selector);
            if (!el) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: `Selector not found: ${selector}` })); }
            await el.screenshot(opts);
          } else {
            await page.screenshot(opts);
          }
          const stat    = fs.statSync(savePath);
          const b64     = fs.readFileSync(savePath).toString('base64');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok:       true,
            filename: path.basename(savePath),
            path:     `/api/screenshots/${path.basename(savePath)}`,
            size:     stat.size,
            base64:   `data:image/${format === 'jpeg' ? 'jpeg' : 'png'};base64,${b64}`,
            url:      page.url(),
          }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
      }); return;
    }

    // ── POST /api/browser/eval ────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/browser/eval') {
      let body = ''; req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { expression, timeout = 10000 } = JSON.parse(body);
          if (!expression) { res.writeHead(400); return res.end(JSON.stringify({ error: 'expression required' })); }
          const page   = await getPage();
          const result = await Promise.race([
            page.evaluate(new Function(`return (async () => { ${expression} })()`)).catch(() => page.evaluate(expression)),
            new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), timeout)),
          ]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
      }); return;
    }

    // ── POST /api/browser/resize ──────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/browser/resize') {
      let body = ''; req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { width, height } = JSON.parse(body);
          const page = await getPage();
          await page.setViewport({ width, height });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, width, height }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
      }); return;
    }

    // ── POST /api/browser/emulate ─────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/browser/emulate') {
      let body = ''; req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { device, width, height, mobile = false } = JSON.parse(body);
          const page = await getPage();
          const DEVICES = {
            'iPhone 14':  { w: 390, h: 844,  m: true, dpr: 3,     ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)' },
            'iPad':       { w: 768, h: 1024, m: true, dpr: 2,     ua: 'Mozilla/5.0 (iPad; CPU OS 16_0)' },
            'Pixel 7':    { w: 412, h: 915,  m: true, dpr: 2.625, ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7)' },
            'Galaxy S23': { w: 360, h: 780,  m: true, dpr: 3,     ua: 'Mozilla/5.0 (Linux; Android 13; SM-S911B)' },
            'reset':      { w: 1280, h: 800, m: false, dpr: 1,    ua: '' },
          };
          if (device && DEVICES[device]) {
            const d = DEVICES[device];
            await page.setViewport({ width: d.w, height: d.h, isMobile: d.m, hasTouch: d.m, deviceScaleFactor: d.dpr });
            if (d.ua) await page.setUserAgent(d.ua);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, device, width: d.w, height: d.h }));
          }
          if (width && height) {
            await page.setViewport({ width, height, isMobile: mobile });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, device: 'custom', width, height }));
          }
          res.writeHead(400);
          res.end(JSON.stringify({ error: `device options: ${Object.keys(DEVICES).join(', ')} or provide width+height` }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
      }); return;
    }

    // ── GET /api/browser/console ──────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/browser/console') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const clear = url.searchParams.get('clear') === '1';
      const logs  = _consoleLogs.slice(-limit);
      if (clear) _consoleLogs.length = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ count: logs.length, logs }));
    }

    // ── GET /api/browser/network ──────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/browser/network') {
      const limit  = parseInt(url.searchParams.get('limit')  || '50');
      const filter = url.searchParams.get('filter') || '';
      const clear  = url.searchParams.get('clear')  === '1';
      let logs     = [..._networkLog];
      if (filter) logs = logs.filter(l => l.url.includes(filter));
      logs = logs.slice(-limit);
      if (clear) _networkLog.length = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ count: logs.length, logs }));
    }

    // ── POST /api/browser/accessibility ──────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/browser/accessibility') {
      let body = ''; req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { selector, depth = 5 } = body ? JSON.parse(body) : {};
          const page = await getPage();
          let snap;
          if (selector) {
            const el = await page.$(selector);
            if (!el) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: `Not found: ${selector}` })); }
            snap = await page.accessibility.snapshot({ root: el, interestingOnly: true });
          } else {
            snap = await page.accessibility.snapshot({ interestingOnly: true });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, tree: snap }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
      }); return;
    }

    // ── POST /api/browser/close ───────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/browser/close') {
      try {
        if (_browser) { await _browser.close(); _browser = null; _page = null; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Browser closed' }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── IMAGE / SCREENSHOT ENDPOINTS ─────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    // ── GET /api/screenshots — list all screenshots ───────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/screenshots') {
      ensureScreenshotDir();
      try {
        const files = fs.readdirSync(SCREENSHOT_DIR)
          .filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
          .map(f => {
            const fp   = path.join(SCREENSHOT_DIR, f);
            const stat = fs.statSync(fp);
            return { filename: f, size: stat.size, mtime: stat.mtimeMs, url: `/api/screenshots/${f}` };
          })
          .sort((a, b) => b.mtime - a.mtime);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ count: files.length, files }));
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
    }

    // ── GET /api/screenshots/{filename} — serve image ────────────────────────
    const imgMatch = url.pathname.match(/^\/api\/screenshots\/([^/]+)$/);
    if (req.method === 'GET' && imgMatch) {
      const filename = path.basename(imgMatch[1]);
      const filepath = path.join(SCREENSHOT_DIR, filename);
      if (!fs.existsSync(filepath)) { res.writeHead(404); return res.end(JSON.stringify({ error: 'Not found' })); }
      const ext  = path.extname(filename).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      return res.end(fs.readFileSync(filepath));
    }

    // ── DELETE /api/screenshots/{filename} ───────────────────────────────────
    if (req.method === 'DELETE' && imgMatch) {
      const filename = path.basename(imgMatch[1]);
      const filepath = path.join(SCREENSHOT_DIR, filename);
      try {
        if (!fs.existsSync(filepath)) { res.writeHead(404); return res.end(JSON.stringify({ error: 'Not found' })); }
        fs.unlinkSync(filepath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, deleted: filename }));
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
    }

    // ── POST /api/screenshots/upload — upload image for MCP use ──────────────
    if (req.method === 'POST' && url.pathname === '/api/screenshots/upload') {
      ensureScreenshotDir();
      const chunks = [];
      req.on('data', d => chunks.push(d));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          // Accepts { filename, base64, data_url }
          let buf = null;
          if (body.base64)   buf = Buffer.from(body.base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
          else if (body.data_url) buf = Buffer.from(body.data_url.replace(/^data:[^;]+;base64,/, ''), 'base64');
          if (!buf) { res.writeHead(400); return res.end(JSON.stringify({ error: 'base64 or data_url required' })); }
          const filename = body.filename || `upload_${Date.now()}.png`;
          const savePath = path.join(SCREENSHOT_DIR, path.basename(filename));
          fs.writeFileSync(savePath, buf);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, filename: path.basename(savePath), url: `/api/screenshots/${path.basename(savePath)}`, size: buf.length }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      }); return;
    }

    // ── 404 ───────────────────────────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', hint: 'GET /api/info for endpoint list' }));
  });

  server.listen(port, async () => {
    console.log(`\x1b[32m✓ MiMo MCP Server → \x1b[4mhttp://localhost:${port}\x1b[0m`);
    console.log(`\x1b[90m  OS: ${OS_NAME}\x1b[0m`);
    console.log();
    console.log('\x1b[36m  MCP Endpoints:\x1b[0m');
    console.log(`\x1b[90m    GET  /api/info\x1b[0m`);
    console.log(`\x1b[90m    GET  /api/search/{query}/{count}?lang=vi&sources=...\x1b[0m`);
    console.log(`\x1b[90m    GET  /api/read?url=https://...&jina=1\x1b[0m`);
    console.log(`\x1b[90m    GET  /api/wikipedia?q=...&lang=vi&full=0\x1b[0m`);
    console.log('\x1b[36m  Browser Control:\x1b[0m');
    console.log(`\x1b[90m    POST /api/browser/navigate   { url }\x1b[0m`);
    console.log(`\x1b[90m    POST /api/browser/screenshot { filename, selector, fullPage, format }\x1b[0m`);
    console.log(`\x1b[90m    POST /api/browser/eval       { expression }\x1b[0m`);
    console.log(`\x1b[90m    POST /api/browser/resize     { width, height }\x1b[0m`);
    console.log(`\x1b[90m    POST /api/browser/emulate    { device } (iPhone 14, iPad, Pixel 7, Galaxy S23)\x1b[0m`);
    console.log(`\x1b[90m    GET  /api/browser/console    ?limit=50&clear=0\x1b[0m`);
    console.log(`\x1b[90m    GET  /api/browser/network    ?limit=50&filter=&clear=0\x1b[0m`);
    console.log(`\x1b[90m    POST /api/browser/accessibility { selector, depth }\x1b[0m`);
    console.log(`\x1b[90m    POST /api/browser/close\x1b[0m`);
    console.log('\x1b[36m  Image / Screenshot:\x1b[0m');
    console.log(`\x1b[90m    GET    /api/screenshots\x1b[0m`);
    console.log(`\x1b[90m    GET    /api/screenshots/{filename}\x1b[0m`);
    console.log(`\x1b[90m    DELETE /api/screenshots/{filename}\x1b[0m`);
    console.log(`\x1b[90m    POST   /api/screenshots/upload { filename, base64 }\x1b[0m`);
    if (JINA_API_KEY)      console.log(`\x1b[32m  ✓ Jina API key set\x1b[0m`);
    else                   console.log(`\x1b[33m  ⚠ Jina: free 3rpm — set JINA_API_KEY for more\x1b[0m`);
    if (BRAVE_API_KEY)     console.log(`\x1b[32m  ✓ Brave Search API key set\x1b[0m`);
    if (CUSTOM_SEARCH_API) console.log(`\x1b[32m  ✓ Custom Search API: ${CUSTOM_SEARCH_API}\x1b[0m`);
    console.log();

    startCloudflareTunnel(port).then(cfUrl => {
      if (cfUrl) console.log(`\x1b[35m🌐 Cloudflare Tunnel: \x1b[4m${cfUrl}\x1b[0m\n`);
      else       console.log(`\x1b[90m  (Cloudflare tunnel không khả dụng)\x1b[0m\n`);
    });
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\x1b[35m\n  ╔╦╗╦╔╦╗╔═╗  ╔╔╗╔╔═╗╔═╗  \x1b[0m');
  console.log('\x1b[35m  ║║║║║║║║ ║  ║║║║║    ╠═╝  \x1b[0m');
  console.log('\x1b[35m  ╩ ╩╩╩ ╩╚═╝  ╝╚╝╚╚═╝╩    v5.0 MCP\x1b[0m');
  console.log('\x1b[90m  Browser Control + Search + Screenshot\x1b[0m\n');
  ensureScreenshotDir();
  startServer(PORT);
})();
