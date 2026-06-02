#!/usr/bin/env node
'use strict';
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { exec, spawn } = require('child_process');
const readline = require('readline');

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
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium']
      .find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
  }
  const { execSync } = require('child_process');
  for (const cmd of ['which google-chrome','which chromium-browser','which chromium','which google-chrome-stable']) {
    try { return execSync(cmd,{stdio:['pipe','pipe','pipe']}).toString().trim(); } catch {}
  }
  return null;
}

function getPuppeteerArgs() {
  const base = ['--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--disable-extensions','--disable-background-networking','--disable-default-apps','--mute-audio','--no-default-browser-check'];
  if (IS_LINUX) base.push('--no-sandbox','--disable-setuid-sandbox','--disable-accelerated-2d-canvas','--disable-web-security','--font-render-hinting=none');
  return base;
}

// ── Workspace ──────────────────────────────────────────────────────────────────
const WORKSPACE_NAME = 'workspace';
const WORKSPACE_PATH = path.resolve(process.cwd(), WORKSPACE_NAME);
function ensureWorkspace() {
  if (!fs.existsSync(WORKSPACE_PATH)) { fs.mkdirSync(WORKSPACE_PATH,{recursive:true}); console.log(`\x1b[33m📁 Workspace: ${WORKSPACE_PATH}\x1b[0m`); }
  else { console.log(`\x1b[90m📁 Workspace: ${WORKSPACE_PATH}\x1b[0m`); }
}
function safeResolvePath(inputPath, base) {
  const safeBase = base ? (path.isAbsolute(base) ? base : path.resolve(WORKSPACE_PATH,base)) : WORKSPACE_PATH;
  const effectiveBase = safeBase.startsWith(WORKSPACE_PATH) ? safeBase : WORKSPACE_PATH;
  const resolved = path.resolve(effectiveBase, inputPath || '.');
  if (!resolved.startsWith(WORKSPACE_PATH + path.sep) && resolved !== WORKSPACE_PATH) return WORKSPACE_PATH;
  return resolved;
}

// ── Token / Key rotation ───────────────────────────────────────────────────────
function loadAllKeys() {
  const keys = [];
  for (let i = 1; i <= 100; i++) { const k = process.env[`GITLAWB_KEY_${i}`]; if (k && k.startsWith('ogw_')) keys.push(k); }
  if (process.env.OPENGATEWAY_TOKEN) keys.push(process.env.OPENGATEWAY_TOKEN);
  return [...new Set(keys)];
}
const _allKeys = loadAllKeys();
let _keyIndex = 0;
const _exhaustedKeys = new Set();
function getCurrentKey() {
  for (let i = 0; i < _allKeys.length; i++) { const idx = (_keyIndex+i)%_allKeys.length; if (!_exhaustedKeys.has(_allKeys[idx])) return _allKeys[idx]; }
  return _allKeys[_keyIndex % _allKeys.length];
}
function rotateKey(exhaustedKey) {
  if (exhaustedKey) { _exhaustedKeys.add(exhaustedKey); console.log(`\x1b[33m  🔄 Key hết credits: ...${exhaustedKey.slice(-8)}\x1b[0m`); }
  _keyIndex = (_keyIndex+1) % _allKeys.length;
}
async function askToken() {
  if (_allKeys.length > 0) { console.log(`\x1b[32m🔑 Loaded ${_allKeys.length} API keys\x1b[0m`); return getCurrentKey(); }
  const rl = readline.createInterface({input:process.stdin,output:process.stdout});
  return new Promise(r => rl.question('\x1b[36m🔑 Gitlawb Opengateway token (ogw_live_...): \x1b[0m', t => { rl.close(); r(t.trim()); }));
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
    _cfProcess = spawn('cloudflared', ['tunnel','run','--token', CF_TOKEN], {
      stdio: ['ignore','pipe','pipe'],
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
    _cfProcess.stdout.on('data', d => { const line=d.toString(); const u=parseUrl(line); if(u) tryResolve(u); });
    _cfProcess.stderr.on('data', d => { const line=d.toString(); const u=parseUrl(line); if(u) tryResolve(u); });
    _cfProcess.on('error', () => { if (!resolved) resolve(null); });
    _cfProcess.on('exit', () => { if (!resolved) resolve(null); });
    setTimeout(() => { if (!resolved) { console.log('\x1b[33m  [CF] Timeout — tiếp tục không có public URL\x1b[0m'); resolve(null); } }, 30000);
  });
}

// ── AI Provider configs ────────────────────────────────────────────────────────
const PROVIDERS = {
  'mimo-v2.5-pro':      { label:'MiMo V2.5 Pro',       hostname:'opengateway.gitlawb.com', path:'/v1/chat/completions', model:'mimo-v2.5-pro',                          badge:'🧠' },
  'gpt-4o':             { label:'GPT-4o',               hostname:'opengateway.gitlawb.com', path:'/v1/chat/completions', model:'gpt-4o',                                 badge:'🟢' },
  'gpt-4o-mini':        { label:'GPT-4o Mini',          hostname:'opengateway.gitlawb.com', path:'/v1/chat/completions', model:'gpt-4o-mini',                            badge:'🟩' },
  'gemini-2.0-flash':   { label:'Gemini 2.0 Flash',     hostname:'opengateway.gitlawb.com', path:'/v1/chat/completions', model:'gemini-2.0-flash',                       badge:'💎' },
  'gemini-1.5-pro':     { label:'Gemini 1.5 Pro',       hostname:'opengateway.gitlawb.com', path:'/v1/chat/completions', model:'gemini-1.5-pro',                         badge:'💠' },
  'deepseek-chat':      { label:'DeepSeek V3',          hostname:'opengateway.gitlawb.com', path:'/v1/chat/completions', model:'deepseek-chat',                          badge:'🔵' },
  'deepseek-reasoner':  { label:'DeepSeek R1',          hostname:'opengateway.gitlawb.com', path:'/v1/chat/completions', model:'deepseek-reasoner',                      badge:'🔮' },
  'claude-3-7-sonnet':  { label:'Claude 3.7 Sonnet',    hostname:'opengateway.gitlawb.com', path:'/v1/chat/completions', model:'claude-3-7-sonnet-20250219',              badge:'🟣' },
  'claude-3-5-haiku':   { label:'Claude 3.5 Haiku',     hostname:'opengateway.gitlawb.com', path:'/v1/chat/completions', model:'claude-3-5-haiku-20241022',              badge:'🪻' },
  'llama-3.3-70b':      { label:'Llama 3.3 70B',        hostname:'opengateway.gitlawb.com', path:'/v1/chat/completions', model:'meta-llama/llama-3.3-70b-instruct',      badge:'🦙' },
  'qwen-2.5-72b':       { label:'Qwen 2.5 72B',         hostname:'opengateway.gitlawb.com', path:'/v1/chat/completions', model:'qwen/qwen-2.5-72b-instruct',             badge:'🐉' },
  'mistral-large':      { label:'Mistral Large',        hostname:'opengateway.gitlawb.com', path:'/v1/chat/completions', model:'mistral-large-latest',                   badge:'🌪️' },
};

// ── Browser (Puppeteer) singleton ──────────────────────────────────────────────
let _browser = null, _page = null, _consoleLogs = [], _networkLog = [];
async function getBrowser() {
  if (_browser) return _browser;
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch {
    console.log('\x1b[33m⏳ Cài puppeteer...\x1b[0m');
    await new Promise((res,rej) => exec('npm install puppeteer --prefix '+__dirname, e => e?rej(e):res()));
    puppeteer = require('puppeteer');
  }
  const launchOpts = { headless:'new', args:getPuppeteerArgs() };
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
    _page.on('console', msg => { _consoleLogs.push({level:msg.type(),text:msg.text(),time:Date.now()}); if(_consoleLogs.length>500) _consoleLogs.shift(); });
    _page.on('request', req => { _networkLog.push({type:'request',method:req.method(),url:req.url(),time:Date.now()}); if(_networkLog.length>200) _networkLog.shift(); });
    _page.on('response', res => { _networkLog.push({type:'response',status:res.status(),url:res.url(),time:Date.now()}); });
  }
  return _page;
}

// ══════════════════════════════════════════════════════════════════════════════
// ── MULTI-SOURCE SEARCH ENGINE (v4.0) ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// Env vars
const CUSTOM_SEARCH_API = process.env.SEARCH_API_BASE || ''; // https://yourdomain/api/search
const BRAVE_API_KEY     = process.env.BRAVE_API_KEY   || '';
const JINA_API_KEY      = process.env.JINA_API_KEY    || ''; // optional — free without key but rate-limited

// SearXNG public instances with JSON enabled
const SEARXNG_INSTANCES = [
  'https://searx.be',
  'https://search.sapti.me',
  'https://searxng.site',
  'https://search.privacyguides.net',
  'https://sx.catgirl.cloud',
];

// ── Core HTTP helper ──────────────────────────────────────────────────────────
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
          } catch { return resolve({ ok:false, status:res.statusCode, body:'', error:'bad redirect' }); }
        }
        res.on('data', c => { data += c; if (data.length > 600000) res.destroy(); });
        res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, body: data }));
        res.on('error', e => resolve({ ok:false, status:0, body:'', error: e.message }));
      });
      req.on('error', e => resolve({ ok:false, status:0, body:'', error: e.message }));
      req.setTimeout(timeout, () => { req.destroy(); resolve({ ok:false, status:0, body:'', error:'timeout' }); });
    } catch (e) { resolve({ ok:false, status:0, body:'', error: e.message }); }
  });
}

// ── 1. DuckDuckGo HTML scrape ─────────────────────────────────────────────────
async function searchDuckDuckGo(query, lang = 'vi', count = 8) {
  const kl = lang === 'vi' ? 'vn-vi' : 'us-en';
  const q  = encodeURIComponent(query);
  const res = await httpGet(`https://html.duckduckgo.com/html/?q=${q}&kl=${kl}`);
  if (!res.ok) return [];
  const results = [];
  // Extract result links + snippets
  const blockRe = /<div class="result[^"]*"[\s\S]*?<\/div>\s*<\/div>/g;
  const titleRe  = /<a class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/;
  const snipRe   = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;
  let m;
  while ((m = blockRe.exec(res.body)) && results.length < count) {
    const block = m[0];
    const t = titleRe.exec(block);
    const s = snipRe.exec(block);
    if (t) results.push({
      source: 'duckduckgo',
      title:   t[2].replace(/<[^>]+>/g,'').trim(),
      url:     t[1],
      snippet: s ? s[1].replace(/<[^>]+>/g,'').trim() : '',
    });
  }
  // Fallback regex if block parsing fails
  if (!results.length) {
    const tRe = /<a class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const sRe = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const titles = []; const snips = [];
    while ((m = tRe.exec(res.body)) && titles.length < count+2) titles.push({url:m[1],title:m[2].replace(/<[^>]+>/g,'').trim()});
    while ((m = sRe.exec(res.body))  && snips.length  < count+2) snips.push(m[1].replace(/<[^>]+>/g,'').trim());
    for (let i=0; i<Math.min(titles.length,count); i++)
      results.push({ source:'duckduckgo', title:titles[i].title, url:titles[i].url, snippet:snips[i]||'' });
  }
  return results;
}

// ── 2. DuckDuckGo Instant Answers JSON ───────────────────────────────────────
async function searchDuckDuckGoJSON(query, count = 5) {
  const q   = encodeURIComponent(query);
  const res = await httpGet(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`);
  if (!res.ok) return [];
  try {
    const j = JSON.parse(res.body);
    const out = [];
    if (j.AbstractText) out.push({ source:'ddg-instant', title:j.Heading||'DuckDuckGo Instant', url:j.AbstractURL||'', snippet:j.AbstractText.slice(0,400) });
    (j.RelatedTopics||[]).slice(0,count-1).forEach(t => {
      if (t.Text && t.FirstURL) out.push({ source:'ddg-related', title:t.Text.slice(0,100), url:t.FirstURL, snippet:t.Text.slice(0,300) });
    });
    (j.Results||[]).slice(0,3).forEach(t => {
      if (t.Text && t.FirstURL) out.push({ source:'ddg-result', title:t.Text.slice(0,100), url:t.FirstURL, snippet:t.Text.slice(0,300) });
    });
    return out;
  } catch { return []; }
}

// ── 3. Wikipedia Search API ───────────────────────────────────────────────────
async function searchWikipedia(query, lang = 'vi', count = 4) {
  const q   = encodeURIComponent(query);
  const res = await httpGet(`https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${q}&limit=${count}&namespace=0&format=json`);
  if (!res.ok) return [];
  try {
    const [, titles, snippets, urls] = JSON.parse(res.body);
    return titles.map((title,i) => ({ source:'wikipedia', title, url:urls[i]||'', snippet:snippets[i]||'' }));
  } catch { return []; }
}

// ── 4. Wikipedia REST Summary ─────────────────────────────────────────────────
async function getWikipediaSummary(query, lang = 'vi') {
  const fetchSummary = async (l, q) => {
    const res = await httpGet(`https://${l}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`);
    if (!res.ok) return null;
    try {
      const j = JSON.parse(res.body);
      if (j.extract) return { source:'wikipedia-summary', title:j.title||q, url:j.content_urls?.desktop?.page||'', snippet:j.extract.slice(0,600) };
    } catch {}
    return null;
  };
  const r = await fetchSummary(lang, query);
  if (r) return [r];
  if (lang !== 'en') {
    const r2 = await fetchSummary('en', query);
    if (r2) return [r2];
  }
  return [];
}

// ── 5. Jina AI Search (s.jina.ai) — FREE, no key needed ──────────────────────
// Returns clean LLM-friendly markdown of top-5 web results
async function searchJina(query, count = 5) {
  const q       = encodeURIComponent(query);
  const headers = { 'Accept': 'application/json', 'X-Retain-Images': 'none' };
  if (JINA_API_KEY) headers['Authorization'] = `Bearer ${JINA_API_KEY}`;
  // JSON format
  headers['Accept'] = 'application/json';
  const res = await httpGet(`https://s.jina.ai/?q=${q}`, headers, 15000);
  if (!res.ok) return [];
  try {
    const j = JSON.parse(res.body);
    const items = j.data || j.results || [];
    return items.slice(0, count).map(item => ({
      source:  'jina-search',
      title:   item.title || '',
      url:     item.url   || '',
      snippet: (item.description || item.content || '').slice(0, 400),
    }));
  } catch {
    // Fallback: parse markdown response
    const lines = res.body.split('\n');
    const results = [];
    let cur = null;
    for (const line of lines) {
      const titleMatch = line.match(/^#{1,3}\s+\d+\.\s+(.+)/);
      const urlMatch   = line.match(/^URL:\s*(https?:\/\/\S+)/i);
      const descMatch  = line.match(/^(?:Description|Content):\s*(.+)/i);
      if (titleMatch) { if (cur) results.push(cur); cur = { source:'jina-search', title:titleMatch[1].trim(), url:'', snippet:'' }; }
      else if (urlMatch   && cur) cur.url     = urlMatch[1];
      else if (descMatch  && cur) cur.snippet = descMatch[1].slice(0,400);
    }
    if (cur) results.push(cur);
    return results.slice(0, count);
  }
}

// ── 6. Jina AI Reader (r.jina.ai) — read any URL as clean text ───────────────
// Used internally for fetching page content
async function jinaRead(url) {
  const headers = { 'Accept': 'application/json', 'X-Retain-Images': 'none', 'X-Timeout': '10' };
  if (JINA_API_KEY) headers['Authorization'] = `Bearer ${JINA_API_KEY}`;
  const res = await httpGet(`https://r.jina.ai/${encodeURIComponent(url)}`, headers, 15000);
  if (!res.ok) return null;
  try {
    const j = JSON.parse(res.body);
    return { title: j.data?.title||'', content: (j.data?.content||'').slice(0,8000), url };
  } catch {
    return { title:'', content: res.body.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,8000), url };
  }
}

// ── 7. SearXNG (public instances, JSON format) ────────────────────────────────
async function searchSearXNG(query, count = 8) {
  const q = encodeURIComponent(query);
  for (const base of SEARXNG_INSTANCES) {
    const res = await httpGet(
      `${base}/search?q=${q}&format=json&categories=general&language=auto&engines=google,bing,duckduckgo,wikipedia`,
      { 'Accept': 'application/json' },
      10000,
    );
    if (res.ok && res.body) {
      try {
        const j = JSON.parse(res.body);
        const items = (j.results||[]).slice(0, count).map(r => ({
          source:  'searxng',
          title:   r.title   || '',
          url:     r.url     || '',
          snippet: r.content || '',
        }));
        if (items.length) return items;
      } catch {}
    }
  }
  return [];
}

// ── 8. Bing Web Search (HTML scrape) ─────────────────────────────────────────
async function searchBing(query, count = 8) {
  const q   = encodeURIComponent(query);
  const res = await httpGet(`https://www.bing.com/search?q=${q}&count=${count}&setlang=vi`, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
  });
  if (!res.ok) return [];
  const results = [];
  const blockRe  = /<li[^>]*class="[^"]*b_algo[^"]*"[\s\S]*?<\/li>/g;
  const titleRe  = /<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/;
  const snipRe   = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/;
  let m;
  while ((m = blockRe.exec(res.body)) && results.length < count) {
    const block = m[0];
    const t = titleRe.exec(block);
    const s = snipRe.exec(block);
    if (t && t[1].startsWith('http') && !t[1].includes('bing.com')) {
      results.push({
        source:  'bing',
        title:   t[2].replace(/<[^>]+>/g,'').trim(),
        url:     t[1],
        snippet: s ? s[1].replace(/<[^>]+>/g,'').trim() : '',
      });
    }
  }
  return results;
}

// ── 9. Brave Search API (requires BRAVE_API_KEY) ──────────────────────────────
async function searchBrave(query, count = 8) {
  if (!BRAVE_API_KEY) return [];
  const q   = encodeURIComponent(query);
  const res = await httpGet(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=${count}`, {
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip',
    'X-Subscription-Token': BRAVE_API_KEY,
  });
  if (!res.ok) return [];
  try {
    const j = JSON.parse(res.body);
    return (j.web?.results||[]).slice(0,count).map(r => ({
      source: 'brave', title:r.title||'', url:r.url||'', snippet:r.description||'',
    }));
  } catch { return []; }
}

// ── 10. Custom Search API: {base}/{encodedQuery}/{count} ──────────────────────
async function searchCustomAPI(query, count = 8) {
  if (!CUSTOM_SEARCH_API) return [];
  const q   = encodeURIComponent(query);
  const res = await httpGet(`${CUSTOM_SEARCH_API}/${q}/${count}`, {}, 12000);
  if (!res.ok) return [];
  try {
    let data = JSON.parse(res.body);
    if (!Array.isArray(data)) data = data.results || data.items || data.data || [];
    return data.slice(0,count).map(item => ({
      source:  'custom-api',
      title:   item.title   || item.name    || item.heading || '',
      url:     item.url     || item.link    || item.href    || '',
      snippet: item.snippet || item.description || item.body || item.text || '',
    }));
  } catch { return []; }
}

// ── 11. Google via Puppeteer Browser (fallback) ───────────────────────────────
async function searchViaBrowser(query, count = 8) {
  try {
    const page = await getPage();
    await page.goto(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=vn-vi`,
      { waitUntil:'domcontentloaded', timeout:15000 },
    );
    const html = await page.content();
    const results = [];
    const tRe = /<a class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = tRe.exec(html)) && results.length < count)
      results.push({ source:'browser-ddg', title:m[2].replace(/<[^>]+>/g,'').trim(), url:m[1], snippet:'' });
    return results;
  } catch { return []; }
}

// ── MULTI-SOURCE AGGREGATOR ───────────────────────────────────────────────────
/**
 * Sources available:
 *   duckduckgo  — DDG HTML scrape
 *   ddg-json    — DDG Instant Answers JSON
 *   wikipedia   — Wikipedia OpenSearch + REST Summary
 *   jina        — s.jina.ai (free, no key, LLM-optimised results)
 *   searxng     — Public SearXNG instances (aggregates Google+Bing+DDG+Wiki)
 *   bing        — Bing HTML scrape
 *   brave       — Brave Search API (needs BRAVE_API_KEY)
 *   custom      — Custom API: SEARCH_API_BASE/{query}/{count}
 *   browser     — Puppeteer browser fallback (DDG)
 */
async function multiSearch(query, opts = {}) {
  const {
    lang    = 'vi',
    count   = 8,
    sources = ['duckduckgo','ddg-json','wikipedia','jina','searxng','bing','brave','custom'],
  } = opts;

  const tasks = [];
  if (sources.includes('duckduckgo')) tasks.push(searchDuckDuckGo(query, lang, count).catch(()=>[]));
  if (sources.includes('ddg-json'))   tasks.push(searchDuckDuckGoJSON(query, 5).catch(()=>[]));
  if (sources.includes('wikipedia')) {
    const wl = lang === 'vi' ? 'vi' : 'en';
    tasks.push(searchWikipedia(query, wl, 4).catch(()=>[]));
    tasks.push(getWikipediaSummary(query, wl).catch(()=>[]));
  }
  if (sources.includes('jina'))       tasks.push(searchJina(query, count).catch(()=>[]));
  if (sources.includes('searxng'))    tasks.push(searchSearXNG(query, count).catch(()=>[]));
  if (sources.includes('bing'))       tasks.push(searchBing(query, count).catch(()=>[]));
  if (sources.includes('brave'))      tasks.push(searchBrave(query, count).catch(()=>[]));
  if (sources.includes('custom'))     tasks.push(searchCustomAPI(query, count).catch(()=>[]));

  const allRaw = await Promise.all(tasks);
  let all = allRaw.flat();

  // Browser fallback if nothing found
  if (!all.length && sources.includes('browser')) {
    all = await searchViaBrowser(query, count);
  } else if (all.length < 3 && sources.includes('browser')) {
    const extra = await searchViaBrowser(query, count).catch(()=>[]);
    all = [...all, ...extra];
  }

  // Deduplicate by normalised URL
  const seen = new Map();
  for (const r of all) {
    const key = (r.url||'').split('?')[0].replace(/\/$/, '').toLowerCase();
    if (!key || key.length < 8) continue;
    const existing = seen.get(key);
    if (!existing || (existing.snippet||'').length < (r.snippet||'').length) {
      seen.set(key, r);
    }
  }

  return [...seen.values()].slice(0, count * 3);
}

// ── Format search results for AI context ─────────────────────────────────────
function formatSearchResults(query, results) {
  if (!results.length) return `❌ Không tìm thấy kết quả cho "${query}"`;
  const lines = results.map((r,i) =>
    `${i+1}. [${r.source.toUpperCase()}] ${r.title}\n   URL: ${r.url}\n   ${(r.snippet||'').slice(0,300)}`
  );
  const srcSet = [...new Set(results.map(r => r.source))];
  return `🔍 Kết quả tìm kiếm "${query}" (${results.length} kết quả từ: ${srcSet.join(', ')}):\n\n${lines.join('\n\n')}`;
}

// ── Tools definition ───────────────────────────────────────────────────────────
const TOOLS = [
  // File system
  { type:'function', function:{ name:'run_command',  description:'Chạy lệnh shell bất kỳ. Dùng sudo khi cần. cwd có thể là đường dẫn tuyệt đối.',  parameters:{ type:'object', properties:{ command:{type:'string'}, cwd:{type:'string'}, timeout:{type:'number'} }, required:['command'] } } },
  { type:'function', function:{ name:'write_file',   description:'Tạo/ghi file trong workspace.',                                                    parameters:{ type:'object', properties:{ path:{type:'string'}, content:{type:'string'} }, required:['path','content'] } } },
  { type:'function', function:{ name:'read_file',    description:'Đọc file trong workspace.',                                                        parameters:{ type:'object', properties:{ path:{type:'string'} }, required:['path'] } } },
  { type:'function', function:{ name:'list_dir',     description:'Liệt kê file/thư mục.',                                                           parameters:{ type:'object', properties:{ path:{type:'string'} }, required:[] } } },
  { type:'function', function:{ name:'delete_file',  description:'Xóa file/thư mục.',                                                               parameters:{ type:'object', properties:{ path:{type:'string'} }, required:['path'] } } },

  // ── Search tools ──
  {
    type:'function', function:{
      name: 'web_search',
      description: `Tìm kiếm web từ NHIỀU nguồn song song. Nguồn có sẵn:
- duckduckgo : DDG HTML (không cần key)
- ddg-json   : DDG Instant Answers JSON (không cần key)
- wikipedia  : Wikipedia OpenSearch + REST Summary (không cần key)
- jina       : s.jina.ai — LLM-friendly results (không cần key, rate-limit 3rpm tự do)
- searxng    : SearXNG public — tổng hợp Google+Bing+DDG+Wiki (không cần key)
- bing       : Bing HTML scrape (không cần key)
- brave      : Brave Search API (cần BRAVE_API_KEY)
- custom     : Custom API từ SEARCH_API_BASE/{query}/{count}
- browser    : Puppeteer DDG fallback (dùng khi tất cả thất bại)
Mặc định dùng: duckduckgo, ddg-json, wikipedia, jina, searxng, bing, brave, custom.`,
      parameters:{ type:'object', properties:{
        query:   { type:'string',              description:'Từ khóa tìm kiếm' },
        lang:    { type:'string',              description:'vi hoặc en', enum:['vi','en'] },
        count:   { type:'number',              description:'Số kết quả mong muốn (mặc định 8)' },
        sources: { type:'array', items:{type:'string'}, description:'Danh sách nguồn muốn dùng. Mặc định tất cả.' },
      }, required:['query'] },
    },
  },
  {
    type:'function', function:{
      name: 'read_url',
      description: `Đọc/lấy nội dung một URL. Tự động thử theo thứ tự:
1. Jina Reader (r.jina.ai) — clean markdown, bypass JS render
2. HTTP trực tiếp với headers trình duyệt
3. Puppeteer browser — cho trang cần JS/login
Trả về text sạch, tối đa 10000 ký tự.`,
      parameters:{ type:'object', properties:{
        url:          { type:'string',  description:'URL cần đọc' },
        extract:      { type:'string',  enum:['text','html'], description:'Dạng output (mặc định: text)' },
        force_browser:{ type:'boolean', description:'Bắt buộc dùng Puppeteer browser' },
        force_jina:   { type:'boolean', description:'Bắt buộc dùng Jina Reader' },
      }, required:['url'] },
    },
  },
  {
    type:'function', function:{
      name: 'search_wikipedia',
      description: 'Tìm kiếm Wikipedia chi tiết. Trả về summary + search results. Tốt cho kiến thức, định nghĩa, lịch sử.',
      parameters:{ type:'object', properties:{
        query:{ type:'string' },
        lang: { type:'string', description:'vi hoặc en', enum:['vi','en'] },
        full: { type:'boolean', description:'Lấy full article (8000 ký tự)' },
      }, required:['query'] },
    },
  },

  // Browser tools
  { type:'function', function:{ name:'browser_navigate',      description:'Điều hướng browser đến URL.',                  parameters:{ type:'object', properties:{ url:{type:'string'}, timeout:{type:'number'} }, required:['url'] } } },
  { type:'function', function:{ name:'browser_screenshot',    description:'Chụp màn hình trang web.',                     parameters:{ type:'object', properties:{ filename:{type:'string'}, selector:{type:'string'}, fullPage:{type:'boolean'} }, required:[] } } },
  { type:'function', function:{ name:'browser_eval',          description:'Chạy JavaScript trong trang web.',              parameters:{ type:'object', properties:{ expression:{type:'string'}, timeout:{type:'number'} }, required:['expression'] } } },
  { type:'function', function:{ name:'browser_resize',        description:'Đổi kích thước viewport.',                     parameters:{ type:'object', properties:{ width:{type:'number'}, height:{type:'number'} }, required:['width','height'] } } },
  { type:'function', function:{ name:'browser_console_logs',  description:'Lấy console logs.',                            parameters:{ type:'object', properties:{ limit:{type:'number'}, clear:{type:'boolean'} }, required:[] } } },
  { type:'function', function:{ name:'browser_network',       description:'Xem network requests.',                        parameters:{ type:'object', properties:{ limit:{type:'number'}, filter:{type:'string'}, clear:{type:'boolean'} }, required:[] } } },
  { type:'function', function:{ name:'browser_emulate',       description:'Giả lập thiết bị mobile.',                     parameters:{ type:'object', properties:{ device:{type:'string'}, width:{type:'number'}, height:{type:'number'}, mobile:{type:'boolean'} }, required:[] } } },
  { type:'function', function:{ name:'browser_accessibility', description:'Lấy accessibility tree của trang.',            parameters:{ type:'object', properties:{ selector:{type:'string'}, depth:{type:'number'} }, required:[] } } },
];

// ── Browser screencast state ───────────────────────────────────────────────────
let _screencastActive = false, _screencastFrames = [], _screencastSession = null, _screencastFilename = 'screencast.mp4';

// ── Tool executor ──────────────────────────────────────────────────────────────
async function executeTool(name, args) {

  if (name === 'run_command') {
    return new Promise(resolve => {
      let safeCwd = WORKSPACE_PATH;
      if (args.cwd) safeCwd = path.isAbsolute(args.cwd) ? args.cwd : safeResolvePath(args.cwd, WORKSPACE_PATH);
      let cmd = args.command;
      if (/apt(-get)?\s/.test(cmd) && !cmd.includes('DEBIAN_FRONTEND')) cmd = 'DEBIAN_FRONTEND=noninteractive ' + cmd;
      const timeout = args.timeout || 300000;
      const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
      exec(cmd, { cwd:safeCwd, timeout, maxBuffer:1024*1024*4, env }, (err, stdout, stderr) => {
        if (err && (stderr||'').match(/Permission denied|EACCES|Operation not permitted/) && !cmd.trimStart().startsWith('sudo')) {
          exec('sudo '+cmd, { cwd:safeCwd, timeout, maxBuffer:1024*1024*4, env }, (err2,stdout2,stderr2) => {
            resolve({ ok:!err2, stdout:stdout2||'', stderr:stderr2||'', error:err2?err2.message:null, output:((stdout2||'')+(stderr2?'\n[stderr]\n'+stderr2:'')).trim()||'(no output)', note:'Auto sudo' });
          });
          return;
        }
        resolve({ ok:!err, stdout:stdout||'', stderr:stderr||'', error:err?err.message:null, output:((stdout||'')+(stderr?'\n[stderr]\n'+stderr:'')).trim()||'(no output)' });
      });
    });
  }

  if (name === 'write_file') {
    try { const abs=safeResolvePath(args.path); fs.mkdirSync(path.dirname(abs),{recursive:true}); fs.writeFileSync(abs,args.content,'utf8'); return { ok:true, path:abs, output:`✓ Đã ghi: ${abs}` }; }
    catch (e) { return { ok:false, error:e.message, output:`❌ ${e.message}` }; }
  }
  if (name === 'read_file') {
    try { const abs=safeResolvePath(args.path); const content=fs.readFileSync(abs,'utf8'); return { ok:true, content, output:content }; }
    catch (e) { return { ok:false, error:e.message, output:`❌ ${e.message}` }; }
  }
  if (name === 'list_dir') {
    try { const abs=safeResolvePath(args.path||'.'); const items=fs.readdirSync(abs,{withFileTypes:true}); return { ok:true, output:items.map(i=>(i.isDirectory()?'📁 ':'📄 ')+i.name).join('\n')||'(empty)' }; }
    catch (e) { return { ok:false, error:e.message, output:`❌ ${e.message}` }; }
  }
  if (name === 'delete_file') {
    try { const abs=safeResolvePath(args.path); if(abs===WORKSPACE_PATH) return {ok:false,output:'❌ Không xóa workspace gốc'}; fs.rmSync(abs,{recursive:true,force:true}); return { ok:true, output:`✓ Đã xóa: ${path.relative(WORKSPACE_PATH,abs)}` }; }
    catch (e) { return { ok:false, error:e.message, output:`❌ ${e.message}` }; }
  }

  // ── web_search ────────────────────────────────────────────────────────────
  if (name === 'web_search') {
    const lang    = args.lang    || 'vi';
    const count   = args.count   || 8;
    const sources = args.sources || undefined;
    const results = await multiSearch(args.query, { lang, count, sources });
    return { ok: results.length > 0, output: formatSearchResults(args.query, results) };
  }

  // ── read_url ──────────────────────────────────────────────────────────────
  if (name === 'read_url') {
    const SOCIAL = ['facebook.com','instagram.com','twitter.com','x.com','linkedin.com'];
    let useBrowser = args.force_browser || false;
    try { useBrowser = useBrowser || SOCIAL.some(d => new URL(args.url).hostname.includes(d)); } catch {}

    // 1. Jina Reader (best quality, bypasses JS)
    if (!useBrowser || args.force_jina) {
      const r = await jinaRead(args.url);
      if (r && r.content && r.content.length > 100) {
        return { ok:true, title:r.title, output: r.content, via:'jina-reader' };
      }
    }

    // 2. Direct HTTP
    if (!useBrowser) {
      const res = await httpGet(args.url, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
      }, 12000);
      if (res.ok) {
        let out = res.body;
        if (args.extract !== 'html') {
          out = out
            .replace(/<script[\s\S]*?<\/script>/gi,'')
            .replace(/<style[\s\S]*?<\/style>/gi,'')
            .replace(/<[^>]+>/g,' ')
            .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
            .replace(/\s+/g,' ').trim().slice(0,10000);
        }
        if (out.length > 200) return { ok:true, output:out, via:'http' };
      }
    }

    // 3. Puppeteer browser (last resort / forced)
    try {
      const page = await getPage();
      await page.goto(args.url, { waitUntil:'domcontentloaded', timeout:20000 });
      let out = args.extract === 'html'
        ? await page.content()
        : (await page.evaluate(() => document.body?.innerText||'')).replace(/\s+/g,' ').trim().slice(0,10000);
      return { ok:true, output:out, via:'browser' };
    } catch(e) { return { ok:false, output:`❌ Browser: ${e.message}` }; }
  }

  // ── search_wikipedia ──────────────────────────────────────────────────────
  if (name === 'search_wikipedia') {
    const lang   = args.lang || 'vi';
    const wl     = lang === 'vi' ? 'vi' : 'en';

    if (args.full) {
      const q   = encodeURIComponent(args.query);
      const res = await httpGet(`https://${wl}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=false&explaintext=true&titles=${q}&format=json&redirects=1`);
      if (res.ok) {
        try {
          const j     = JSON.parse(res.body);
          const pages = Object.values(j.query?.pages||{});
          if (pages[0]?.extract) return { ok:true, output:`📖 Wikipedia: ${pages[0].title}\n\n${pages[0].extract.slice(0,8000)}` };
        } catch {}
      }
    }

    const [search, summary] = await Promise.all([
      searchWikipedia(args.query, wl, 5),
      getWikipediaSummary(args.query, wl),
    ]);
    const all = [...summary, ...search];
    if (!all.length) return { ok:false, output:`❌ Không tìm thấy Wikipedia: "${args.query}"` };
    const lines = all.map((r,i) => `${i+1}. [${r.source}] ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`);
    return { ok:true, output:`📖 Wikipedia "${args.query}":\n\n${lines.join('\n\n')}` };
  }

  // ── browser tools ─────────────────────────────────────────────────────────
  if (name === 'browser_navigate') {
    try { const page=await getPage(); await page.goto(args.url,{waitUntil:'domcontentloaded',timeout:args.timeout||15000}); return { ok:true, output:`✓ ${page.url()}\n   Tiêu đề: ${await page.title()}` }; }
    catch(e) { return { ok:false, output:`❌ ${e.message}` }; }
  }
  if (name === 'browser_screenshot') {
    try {
      const page=await getPage();
      const filename=args.filename||`screenshot_${Date.now()}.png`;
      const savePath=safeResolvePath(filename);
      const opts={ path:savePath, fullPage:args.fullPage||false };
      if (args.selector) { const el=await page.$(args.selector); if(!el) return {ok:false,output:`❌ Không tìm thấy: ${args.selector}`}; await el.screenshot(opts); }
      else await page.screenshot(opts);
      return { ok:true, output:`✓ Screenshot: workspace/${path.relative(WORKSPACE_PATH,savePath)}\n   URL: ${page.url()}` };
    } catch(e) { return { ok:false, output:`❌ ${e.message}` }; }
  }
  if (name === 'browser_eval') {
    try {
      const page=await getPage();
      const result=await page.evaluate(new Function(`return (async () => { ${args.expression} })()`)).catch(async()=>page.evaluate(args.expression));
      const out=result===undefined?'(undefined)':JSON.stringify(result,null,2);
      return { ok:true, output:out.length>5000?out.slice(0,5000)+'\n...(truncated)':out };
    } catch(e) { return { ok:false, output:`❌ ${e.message}` }; }
  }
  if (name === 'browser_resize') {
    try { const page=await getPage(); await page.setViewport({width:args.width,height:args.height}); return { ok:true, output:`✓ Viewport: ${args.width}x${args.height}` }; }
    catch(e) { return { ok:false, output:`❌ ${e.message}` }; }
  }
  if (name === 'browser_console_logs') {
    const limit=args.limit||50; const logs=_consoleLogs.slice(-limit); if(args.clear) _consoleLogs.length=0;
    return { ok:true, output:logs.length?logs.map(l=>`[${l.level.toUpperCase()}] ${l.text}`).join('\n'):'(không có log)' };
  }
  if (name === 'browser_network') {
    let logs=[..._networkLog]; if(args.filter) logs=logs.filter(l=>l.url.includes(args.filter)); logs=logs.slice(-(args.limit||50)); if(args.clear) _networkLog.length=0;
    return { ok:true, output:logs.length?logs.map(l=>l.type==='request'?`→ ${l.method} ${l.url}`:`← ${l.status} ${l.url}`).join('\n'):'(không có network log)' };
  }
  if (name === 'browser_emulate') {
    try {
      const page=await getPage();
      if(args.device==='reset') { await page.emulate({viewport:{width:1280,height:800,isMobile:false},userAgent:''}); return {ok:true,output:'✓ Reset desktop'}; }
      const DEVICES={
        'iPhone 14':  {w:390, h:844,  m:true, dpr:3,     ua:'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)'},
        'iPad':       {w:768, h:1024, m:true, dpr:2,     ua:'Mozilla/5.0 (iPad; CPU OS 16_0)'},
        'Pixel 7':    {w:412, h:915,  m:true, dpr:2.625, ua:'Mozilla/5.0 (Linux; Android 13; Pixel 7)'},
        'Galaxy S23': {w:360, h:780,  m:true, dpr:3,     ua:'Mozilla/5.0 (Linux; Android 13; SM-S911B)'},
      };
      const d=args.device?DEVICES[args.device]:null;
      if(d) { await page.setViewport({width:d.w,height:d.h,isMobile:d.m,hasTouch:true,deviceScaleFactor:d.dpr}); await page.setUserAgent(d.ua); return {ok:true,output:`✓ ${args.device} (${d.w}x${d.h})`}; }
      if(args.width&&args.height) { await page.setViewport({width:args.width,height:args.height,isMobile:args.mobile||false}); return {ok:true,output:`✓ Custom ${args.width}x${args.height}`}; }
      return {ok:false,output:`❌ Chọn: ${Object.keys(DEVICES).join(', ')} hoặc cung cấp width/height`};
    } catch(e) { return {ok:false,output:`❌ ${e.message}`}; }
  }
  if (name === 'browser_accessibility') {
    try {
      const page=await getPage();
      let snap;
      if(args.selector){const el=await page.$(args.selector);if(!el)return{ok:false,output:`❌ Không tìm thấy: ${args.selector}`};snap=await page.accessibility.snapshot({root:el,interestingOnly:true});}
      else{snap=await page.accessibility.snapshot({interestingOnly:true});}
      function fmt(n,d=0){if(!n)return'';if(d>=(args.depth||5))return'  '.repeat(d)+'...';let l=`${'  '.repeat(d)}[${n.role}]`;if(n.name)l+=` "${n.name}"`;if(n.value!==undefined)l+=` = ${n.value}`;const ch=(n.children||[]).map(c=>fmt(c,d+1)).join('\n');return ch?`${l}\n${ch}`:l;}
      return {ok:true,output:fmt(snap).slice(0,6000)||'(empty)'};
    } catch(e){return{ok:false,output:`❌ ${e.message}`};}
  }

  return { ok:false, output:`Unknown tool: ${name}` };
}

// ── AI API call ────────────────────────────────────────────────────────────────
const RETRY_DELAYS = [5000,15000,30000,60000,120000];

function callAIWithKey(keyToken, messages, modelKey, onEvent) {
  const provider = PROVIDERS[modelKey] || PROVIDERS['mimo-v2.5-pro'];
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model:provider.model, messages, tools:TOOLS, tool_choice:'auto', stream:true, max_tokens:65536 });
    const options = { hostname:provider.hostname, path:provider.path, method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${keyToken}`, 'Content-Length':Buffer.byteLength(body) } };
    const req = https.request(options, res => {
      if (res.statusCode >= 500 || res.statusCode === 429) { res.resume(); return reject(Object.assign(new Error(`HTTP ${res.statusCode}`),{statusCode:res.statusCode})); }
      let buffer='', fullText='', toolCalls={}, finishReason=null, rawChunks='';
      res.on('data', chunk => {
        const str=chunk.toString(); rawChunks+=str; buffer+=str;
        const lines=buffer.split('\n'); buffer=lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw=line.slice(6).trim(); if(raw==='[DONE]') continue;
          let parsed; try { parsed=JSON.parse(raw); } catch { continue; }
          if (parsed.error?.code==='insufficient_credits') { res.destroy(); return reject(Object.assign(new Error('insufficient_credits'),{code:'insufficient_credits',token:keyToken})); }
          const delta=parsed.choices?.[0]?.delta;
          finishReason=parsed.choices?.[0]?.finish_reason||finishReason;
          if (delta?.content) { fullText+=delta.content; onEvent({type:'text',delta:delta.content}); }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx=tc.index??0; if(!toolCalls[idx]) toolCalls[idx]={id:tc.id||idx,name:'',args:''};
              if(tc.id) toolCalls[idx].id=tc.id; if(tc.function?.name) toolCalls[idx].name+=tc.function.name; if(tc.function?.arguments) toolCalls[idx].args+=tc.function.arguments;
            }
          }
        }
      });
      res.on('end', () => {
        if (rawChunks.includes('insufficient_credits')) return reject(Object.assign(new Error('insufficient_credits'),{code:'insufficient_credits',token:keyToken}));
        resolve({ text:fullText, toolCalls:Object.values(toolCalls), finishReason });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body); req.end();
  });
}

async function callAI(token, messages, modelKey, onEvent) {
  const useRotation = _allKeys.length > 1;
  let retryCount = 0;
  while (retryCount <= 5) {
    const activeKey = useRotation ? getCurrentKey() : token;
    try { return await callAIWithKey(activeKey, messages, modelKey, onEvent); }
    catch (err) {
      if (err.code === 'insufficient_credits' || err.message === 'insufficient_credits') { rotateKey(activeKey); onEvent({type:'key_rotate',remaining:_allKeys.length-_exhaustedKeys.size}); continue; }
      if (retryCount < 5) {
        const delay = RETRY_DELAYS[retryCount]||120000;
        onEvent({type:'retry',attempt:retryCount+1,maxRetries:5,delaySeconds:delay/1000,error:err.message});
        await new Promise(r=>setTimeout(r,delay)); retryCount++; continue;
      }
      throw err;
    }
  }
  throw new Error('Đã hết retry và key');
}

// ── Dangerous command guard ────────────────────────────────────────────────────
const DANGEROUS_PATTERNS = [
  {re:/rm\s+-rf?\s+[^/\s]*\//,label:'Xóa đệ quy đường dẫn tuyệt đối'},
  {re:/rm\s+-rf?\s+\*/,       label:'Xóa đệ quy wildcard'},
  {re:/rm\s+-rf?\s+\//,       label:'Xóa thư mục gốc'},
  {re:/>>\s*\/etc\//,         label:'Ghi vào /etc/'},
  {re:/dd\s+if=/,             label:'dd ghi đĩa'},
  {re:/mkfs/,                 label:'Format phân vùng'},
  {re:/shutdown|reboot|halt|poweroff/, label:'Tắt/khởi động lại'},
  {re:/curl.+\|\s*(ba)?sh/,  label:'Pipe URL vào shell'},
  {re:/wget.+\|\s*(ba)?sh/,  label:'Pipe wget vào shell'},
  {re:/systemctl\s+(stop|disable|mask)\s+/, label:'Dừng/tắt service hệ thống'},
  {re:/crontab\s+-r/,        label:'Xóa crontab'},
  {re:/iptables\s+-F/,       label:'Xóa firewall rules'},
  {re:/passwd\s+root/,       label:'Đổi password root'},
];
function isDangerous(cmd) { for (const p of DANGEROUS_PATTERNS) { if(p.re.test(cmd)) return p.label; } return null; }

const _confirmQueue = new Map();
let _confirmCounter = 0;
function waitForConfirm(id) {
  return new Promise((resolve, reject) => {
    _confirmQueue.set(id,{resolve,reject});
    setTimeout(()=>{ if(_confirmQueue.has(id)){_confirmQueue.delete(id);reject(new Error('Confirm timeout'));} },300000);
  });
}

// ── Agent loop ─────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Bạn là MiMo AI — AI agent mạnh mẽ chạy trên Linux/Ubuntu với đầy đủ khả năng:
• Tìm kiếm web từ NHIỀU nguồn song song (DuckDuckGo, Wikipedia, Jina AI, SearXNG, Bing, Brave, Custom API, Browser fallback)
• Đọc nội dung bất kỳ URL qua Jina Reader → HTTP → Puppeteer (tự động theo thứ tự tốt nhất)
• Điều khiển browser đầy đủ (Puppeteer)
• Chạy lệnh shell, đọc/ghi file
• Cloudflare Tunnel tích hợp (public URL tự động)

## NGUYÊN TẮC:
1. KHÔNG BAO GIỜ dừng giữa chừng — dùng tools cho đến khi hoàn thành 100%
2. Tự quyết định — không hỏi user những gì bạn tự làm được
3. Xử lý lỗi tự động — thử cách khác nếu gặp lỗi, không bỏ cuộc
4. Luôn tóm tắt kết quả sau khi dùng tool

## SEARCH STRATEGY:
- Câu hỏi kiến thức chung     → web_search (duckduckgo + jina + searxng) + search_wikipedia
- Tin tức/thời sự              → web_search (sources: duckduckgo, bing, searxng, jina)
- Nghiên cứu chuyên sâu        → web_search (tất cả sources) + read_url để đọc các trang quan trọng
- Trang bị block/JS-heavy      → read_url với force_jina: true, hoặc force_browser: true
- Muốn nhiều nguồn nhất        → web_search không chỉ định sources (dùng mặc định tất cả)

## READ STRATEGY:
- read_url tự động thử: Jina Reader → HTTP → Browser
- Dùng force_jina: true cho trang JS-heavy
- Dùng force_browser: true cho mạng xã hội / trang cần login

Luôn trả lời tiếng Việt trừ khi user dùng ngôn ngữ khác.`;

async function runAgent(token, userMessages, modelKey, onEvent) {
  const sysAsUser = { role:'user', content:SYSTEM_PROMPT };
  const sysAck    = { role:'assistant', content:'Đã hiểu. Sẵn sàng hỗ trợ với đầy đủ search sources.' };
  const messages  = userMessages[0]?.role==='system' ? [...userMessages] : [sysAsUser, sysAck, ...userMessages];

  let iterations = 0;
  let toolWasCalledLastRound = false;

  while (iterations++ < 50) {
    const result = await callAI(token, messages, modelKey, onEvent);
    const assistantMsg = { role:'assistant', content:result.text||'' };
    if (result.toolCalls.length > 0) assistantMsg.tool_calls = result.toolCalls.map(tc=>({ id:String(tc.id), type:'function', function:{name:tc.name,arguments:tc.args} }));
    messages.push(assistantMsg);

    if (!result.toolCalls.length) {
      if (toolWasCalledLastRound && (!result.text||result.text.trim()==='')) {
        messages.push({ role:'user', content:'Dựa trên kết quả tool vừa rồi, hãy trả lời đầy đủ cho user.' });
        const finalResult = await callAI(token, messages, modelKey, onEvent);
        messages.push({ role:'assistant', content:finalResult.text||'(không có phản hồi)' });
      }
      break;
    }

    toolWasCalledLastRound = true;

    for (const tc of result.toolCalls) {
      let args = {}; try { args=JSON.parse(tc.args); } catch {}
      if (tc.name === 'run_command' && args.command) {
        const danger = isDangerous(args.command);
        if (danger) {
          const confirmId = ++_confirmCounter;
          onEvent({ type:'confirm_required', confirmId, command:args.command, reason:danger });
          let approved = false; try { approved = await waitForConfirm(confirmId); } catch {}
          if (!approved) {
            const msg = `⛔ User từ chối lệnh nguy hiểm: ${args.command} (${danger})`;
            onEvent({ type:'tool_start', name:tc.name, args }); onEvent({ type:'tool_end', name:tc.name, result:{ok:false,output:msg} });
            messages.push({ role:'tool', tool_call_id:String(tc.id), content:msg }); continue;
          }
        }
      }
      onEvent({ type:'tool_start', name:tc.name, args });
      const toolResult = await executeTool(tc.name, args);
      onEvent({ type:'tool_end', name:tc.name, result:toolResult });
      messages.push({ role:'tool', tool_call_id:String(tc.id), content:typeof toolResult.output==='string'?toolResult.output:JSON.stringify(toolResult) });
    }
  }
  return messages;
}

// ── HTTP Server ────────────────────────────────────────────────────────────────
function startServer(token, port) {
  const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.ico':'image/x-icon' };

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
    if (req.method==='OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, `http://localhost:${port}`);

    // ── POST /api/chat ──
    if (req.method==='POST' && url.pathname==='/api/chat') {
      let body=''; req.on('data',d=>body+=d);
      req.on('end', async () => {
        const { messages, model } = JSON.parse(body);
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
        const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        try { await runAgent(token, messages, model||'mimo-v2.5-pro', send); send({type:'done'}); }
        catch(e) { send({type:'error',message:e.message}); }
        res.end();
      }); return;
    }

    // ── POST /api/confirm ──
    if (req.method==='POST' && url.pathname==='/api/confirm') {
      let body=''; req.on('data',d=>body+=d);
      req.on('end',()=>{
        try {
          const {confirmId,approved}=JSON.parse(body);
          const pending=_confirmQueue.get(confirmId);
          if(pending){_confirmQueue.delete(confirmId);pending.resolve(!!approved);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));}
          else{res.writeHead(404);res.end(JSON.stringify({ok:false,error:'Not found'}));}
        }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}
      }); return;
    }

    // ── POST /api/terminal ──
    if (req.method==='POST' && url.pathname==='/api/terminal') {
      let body=''; req.on('data',d=>body+=d);
      req.on('end', async () => {
        const {command,cwd}=JSON.parse(body);
        const safeCwd=cwd?(path.isAbsolute(cwd)?cwd:safeResolvePath(cwd)):WORKSPACE_PATH;
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
        const send=obj=>res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const env={...process.env,DEBIAN_FRONTEND:'noninteractive'};
        const child=spawn(IS_WIN?'cmd':'sh',IS_WIN?['/c',command]:['-c',command],{cwd:safeCwd,env});
        child.stdout.on('data',d=>send({type:'stdout',text:d.toString()}));
        child.stderr.on('data',d=>send({type:'stderr',text:d.toString()}));
        child.on('close',code=>{send({type:'exit',code});res.end();});
        child.on('error',e=>{send({type:'error',text:e.message});res.end();});
      }); return;
    }

    // ── GET /api/files ──
    if (req.method==='GET' && url.pathname==='/api/files') {
      try {
        const abs=safeResolvePath(url.searchParams.get('path')||'.');
        const items=fs.readdirSync(abs,{withFileTypes:true});
        const textExts=['.txt','.md','.json','.js','.ts','.py','.html','.css','.sh','.yaml','.yml','.toml','.env','.xml','.csv','.log','.jsx','.tsx','.vue','.rs','.go','.java','.cpp','.c','.h'];
        const files=items.filter(i=>!i.isDirectory()).map(i=>{const fp=path.join(abs,i.name);const ext=path.extname(i.name).toLowerCase();const stat=fs.statSync(fp);return{name:i.name,path:path.relative(WORKSPACE_PATH,fp),size:stat.size,isText:textExts.includes(ext)||!ext,mtime:stat.mtimeMs};});
        const dirs=items.filter(i=>i.isDirectory()).map(i=>({name:i.name,path:path.relative(WORKSPACE_PATH,path.join(abs,i.name)),isDir:true}));
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({files,dirs,cwd:path.relative(WORKSPACE_PATH,abs)||'.'}));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));} return;
    }

    // ── GET /api/file ──
    if (req.method==='GET' && url.pathname==='/api/file') {
      try{const abs=safeResolvePath(url.searchParams.get('path')||'');const content=fs.readFileSync(abs,'utf8');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({content,path:url.searchParams.get('path')}));}
      catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));} return;
    }

    // ── PUT /api/file ──
    if (req.method==='PUT' && url.pathname==='/api/file') {
      let body=''; req.on('data',d=>body+=d);
      req.on('end',()=>{
        try {
          const {path:fpath,content}=JSON.parse(body);
          const abs=safeResolvePath(fpath);
          const imageExts=['.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico'];
          if(imageExts.includes(path.extname(fpath).toLowerCase())){res.writeHead(403);res.end(JSON.stringify({error:'Không sửa file ảnh'}));return;}
          fs.mkdirSync(path.dirname(abs),{recursive:true});
          fs.writeFileSync(abs,content,'utf8');
          res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,path:fpath}));
        }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
      }); return;
    }

    // ── GET /api/models ──
    if (req.method==='GET' && url.pathname==='/api/models') {
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(Object.entries(PROVIDERS).map(([id,p])=>({id,label:p.label,badge:p.badge})))); return;
    }

    // ── GET /api/workspace ──
    if (req.method==='GET' && url.pathname==='/api/workspace') {
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({
        workspace: WORKSPACE_PATH,
        platform:  process.platform,
        os:        OS_NAME,
        cfUrl:     _cfUrl || null,
        searchSources: ['duckduckgo','ddg-json','wikipedia','jina','searxng','bing','brave','custom','browser'],
        jinaKeySet: !!JINA_API_KEY,
        braveKeySet: !!BRAVE_API_KEY,
        customApiSet: !!CUSTOM_SEARCH_API,
      })); return;
    }

    // ── GET /api/search/:query/:count — MCP Search endpoint ──────────────────
    // Usage: GET /api/search/nodejs%20tutorial/10?lang=vi&sources=duckduckgo,jina,wikipedia
    const searchMatch = url.pathname.match(/^\/api\/search\/([^/]+)(?:\/(\d+))?$/);
    if (req.method==='GET' && searchMatch) {
      const query   = decodeURIComponent(searchMatch[1]);
      const count   = parseInt(searchMatch[2]||'10');
      const lang    = url.searchParams.get('lang')    || 'vi';
      const srcStr  = url.searchParams.get('sources');
      const sources = srcStr ? srcStr.split(',').map(s=>s.trim()) : undefined;
      try {
        const results = await multiSearch(query, { lang, count, sources });
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({
          query,
          count:   results.length,
          sources: [...new Set(results.map(r=>r.source))],
          results,
        }));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }
      return;
    }

    // ── GET /api/read — MCP Read URL endpoint ─────────────────────────────────
    // Usage: GET /api/read?url=https://example.com&jina=1
    if (req.method==='GET' && url.pathname==='/api/read') {
      const targetUrl  = url.searchParams.get('url');
      const forceJina  = url.searchParams.get('jina')    === '1';
      const forceBrowser = url.searchParams.get('browser') === '1';
      if (!targetUrl) { res.writeHead(400); res.end(JSON.stringify({error:'url param required'})); return; }
      try {
        const result = await executeTool('read_url', { url:targetUrl, force_jina:forceJina, force_browser:forceBrowser });
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ url:targetUrl, ok:result.ok, content:result.output, via:result.via||'http' }));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }
      return;
    }

    // ── Static files ──
    let fp = path.join(__dirname,'public', url.pathname==='/'?'index.html':url.pathname);
    if (fs.existsSync(fp)) {
      res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'text/plain'});
      return res.end(fs.readFileSync(fp));
    }
    res.writeHead(404); res.end('Not found');
  });

  server.listen(port, async () => {
    console.log(`\x1b[32m✓ MiMo AI → \x1b[4mhttp://localhost:${port}\x1b[0m`);
    console.log(`\x1b[90m  OS: ${OS_NAME} | Workspace: ${WORKSPACE_PATH}\x1b[0m`);
    console.log(`\x1b[90m  Models: ${Object.keys(PROVIDERS).join(', ')}\x1b[0m`);
    console.log(`\x1b[90m  Search: DuckDuckGo + DDG-JSON + Wikipedia + Jina AI + SearXNG + Bing + Brave + Custom + Browser\x1b[0m`);
    console.log(`\x1b[90m  Endpoints:\x1b[0m`);
    console.log(`\x1b[90m    GET  /api/search/{query}/{count}?lang=vi&sources=duckduckgo,jina\x1b[0m`);
    console.log(`\x1b[90m    GET  /api/read?url=https://...&jina=1&browser=0\x1b[0m`);
    if (JINA_API_KEY)      console.log(`\x1b[32m  ✓ Jina API key set (higher rate limits)\x1b[0m`);
    else                   console.log(`\x1b[33m  ⚠ Jina: no key (free, 3rpm limit) — set JINA_API_KEY for more\x1b[0m`);
    if (BRAVE_API_KEY)     console.log(`\x1b[32m  ✓ Brave Search API key set\x1b[0m`);
    if (CUSTOM_SEARCH_API) console.log(`\x1b[32m  ✓ Custom Search API: ${CUSTOM_SEARCH_API}\x1b[0m`);
    console.log();

    // Auto Cloudflare tunnel
    startCloudflareTunnel(port).then(cfUrl => {
      if (cfUrl) console.log(`\x1b[35m🌐 Cloudflare Tunnel: \x1b[4m${cfUrl}\x1b[0m\n`);
      else       console.log(`\x1b[90m  (Cloudflare tunnel không khả dụng — dùng localhost)\x1b[0m\n`);
    });

    const openCmd = IS_WIN?`start http://localhost:${port}`:IS_MAC?`open http://localhost:${port}`:`xdg-open http://localhost:${port} 2>/dev/null`;
    try { exec(openCmd); } catch {}
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT||'3399');
(async () => {
  console.log('\x1b[35m\n  ╔╦╗╦╔╦╗╔═╗  ╔═╗╦  \x1b[0m');
  console.log('\x1b[35m  ║║║║║║║║ ║  ╠═╣║  \x1b[0m');
  console.log('\x1b[35m  ╩ ╩╩╩ ╩╚═╝  ╩ ╩╩═╝  v4.0\x1b[0m');
  console.log('\x1b[90m  DDG + DDG-JSON + Wikipedia + Jina AI + SearXNG + Bing + Brave + Custom + Browser\x1b[0m\n');
  ensureWorkspace();
  const token = await askToken();
  if (!token) { console.error('❌ Cần token!'); process.exit(1); }
  startServer(token, PORT);
})();
