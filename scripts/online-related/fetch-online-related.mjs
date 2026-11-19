#!/usr/bin/env node
// 批量抓取内置库番号在在线站点的「相关影片」，落盘为持久 JSON 缓存。
//
// 依赖一台带 Cloudflare 通行态的 Chrome（脚本可自动拉起），通过 CDP 驱动。
// 用法：
//   node scripts/online-related/fetch-online-related.mjs --db <javboss.db> --out <json>
// 常用参数：
//   --limit 20        只抓前 N 部（默认全部）
//   --code ADN-778    只抓指定番号，逗号分隔
//   --interval 2500   每部之间的间隔毫秒数，调大可降频防风控
//   --refresh         忽略已有缓存重新抓取（默认断点续抓）
//   --headless        无头运行；这些站点的 Cloudflare 通常只接受已通过验证的有头窗口
//   --site missav --cdp http://127.0.0.1:9222 --proxy http://127.0.0.1:7897
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]

const SITES = {
  missav: {
    label: 'MissAV',
    pageUrl: (code, locale) => `https://missav.ws/${locale}/${code}`,
    extract: extractMissav,
  },
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out[key] = '1'
      continue
    }
    out[key] = next
    i += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const siteKey = args.site || 'missav'
const site = SITES[siteKey]
if (!site) {
  console.error(`unknown site: ${siteKey}`)
  process.exit(1)
}

const locale = args.locale || 'cn'
const interval = Number(args.interval || 2500)
const limit = Number(args.limit || 0)
const cdpBase = (args.cdp || 'http://127.0.0.1:9222').replace(/\/$/, '')
const dbPath = args.db || 'D:/Software/javboss/data/javboss.db'
const outPath = args.out || 'D:/Software/javboss/data/cache/jav-online-related.json'
const onlyCodes = args.code ? String(args.code).split(',').map((c) => c.trim().toUpperCase()).filter(Boolean) : null

function log(...parts) {
  console.log(new Date().toISOString().slice(11, 19), ...parts)
}

async function cdpAlive() {
  try {
    const res = await fetch(`${cdpBase}/json/version`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

async function ensureChrome() {
  if (await cdpAlive()) return
  const exe = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!exe) {
    console.error('未找到 Chrome/Edge，可执行文件路径都不存在')
    process.exit(1)
  }
  const profile = args.profile || path.join(process.cwd(), 'temp', 'chrome-online-related')
  const port = new URL(cdpBase).port || '9222'
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ]
  // Headless keeps the run invisible, but Cloudflare on these sites usually
  // only accepts a headful window that has already passed the challenge once.
  if (args.headless) chromeArgs.push('--headless=new', '--window-size=1400,1000')
  if (args.proxy) chromeArgs.push(`--proxy-server=${args.proxy}`)
  chromeArgs.push('about:blank')
  log(`启动浏览器: ${exe}${args.headless ? ' (headless)' : ''}`)
  spawn(exe, chromeArgs, { detached: true, stdio: 'ignore' }).unref()
  for (let i = 0; i < 40; i += 1) {
    await sleep(500)
    if (await cdpAlive()) return
  }
  console.error('浏览器调试端口未就绪')
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let seq = 0
    const pending = new Map()
    ws.onopen = () =>
      resolve({
        ws,
        send(method, params = {}, timeoutMs = 20000) {
          const id = (seq += 1)
          ws.send(JSON.stringify({ id, method, params }))
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id)
              rej(new Error(`${method} timeout`))
            }, timeoutMs)
            pending.set(id, {
              res: (v) => {
                clearTimeout(timer)
                res(v)
              },
              rej: (e) => {
                clearTimeout(timer)
                rej(e)
              },
            })
          })
        },
      })
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      const slot = msg.id && pending.get(msg.id)
      if (!slot) return
      pending.delete(msg.id)
      if (msg.error) slot.rej(new Error(JSON.stringify(msg.error)))
      else slot.res(msg.result)
    }
    ws.onerror = () => reject(new Error('CDP websocket error'))
    ws.onclose = () => reject(new Error('CDP websocket closed'))
  })
}

async function openTab() {
  const res = await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' })
  const target = await res.json()
  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  return { cdp, target }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'evaluate failed')
  }
  return result.result.value
}

// 页面模板先渲染空壳卡片，Alpine 再回填番号与标题，因此必须等到
// readyState=complete 且至少有一批卡片同时带上了番号与标题。
async function waitForCards(cdp, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  let last = { ready: 'init', cards: 0, withAlt: 0, withTitle: 0, body: '' }
  while (Date.now() < deadline) {
    const state = await evaluate(
      cdp,
      `(() => {
        const cards = [...document.querySelectorAll('div.thumbnail')];
        let withAlt = 0;
        let withTitle = 0;
        for (const card of cards) {
          const a = card.querySelector('a[alt]');
          if (a && (a.getAttribute('alt') || '').trim()) withAlt += 1;
          const anchors = [...card.querySelectorAll('a')];
          if (anchors.some((el) => /^[A-Za-z0-9]+-\\d/.test((el.textContent || '').trim()))) withTitle += 1;
        }
        const body = ((document.body && document.body.innerText) || '').slice(0, 400);
        return JSON.stringify({ ready: document.readyState, cards: cards.length, withAlt, withTitle, body });
      })()`
    )
    last = JSON.parse(state || '{}')
    if (last.ready === 'complete' && last.withAlt >= 3 && last.withTitle >= 3) return last
    // Cloudflare interstitial: stop early instead of hammering the site.
    if (/安全验证|Just a moment|Enable JavaScript and cookies|checking your browser|cf-browser-verification/i.test(last.body || '')) {
      return { ...last, blocked: true }
    }
    if (last.ready === 'complete' && /404|找不到|not found|Page not found/i.test(last.body || '')) {
      return last
    }
    await sleep(600)
  }
  return { ...last, timeout: true }
}

function extractMissav() {
  const cards = [...document.querySelectorAll('div.thumbnail')]
  // 同一个番号会同时出现在顶部横滑条与底部网格里，网格那份才带标题，
  // 因此按番号合并并保留信息最全的一条。
  const byAlt = new Map()
  for (const card of cards) {
    const anchor = card.querySelector('a[alt]')
    if (!anchor) continue
    const alt = (anchor.getAttribute('alt') || '').trim().toLowerCase()
    if (!alt) continue
    // 标题行形如 "ADN-765 丈夫认可的NTR..."，从渲染文本里取，避免依赖 x-text 绑定。
    const titleLine =
      ((card.innerText || '').split('\n') || [])
        .map((line) => line.trim())
        .find((line) => /^[A-Za-z0-9]+-\d/i.test(line)) || ''
    const durations = [...card.querySelectorAll('span')]
      .map((s) => (s.textContent || '').trim())
      .filter((t) => /^\d{1,2}(:\d{2}){2}$/.test(t))
    const img = card.querySelector('img[src^="http"]')
    const cover = img ? img.getAttribute('src') : ''
    const prev = byAlt.get(alt)
    if (prev) {
      if (!prev.title && titleLine) prev.title = titleLine
      if (!prev.duration && durations[0]) prev.duration = durations[0]
      if (!prev.cover && cover) prev.cover = cover
      continue
    }
    byAlt.set(alt, { alt, title: titleLine, duration: durations[0] || '', cover })
  }
  const rows = []
  for (const row of byAlt.values()) {
    if (!row.cover) row.cover = `https://fourhoi.com/${row.alt}/cover-t.jpg`
    rows.push(row)
  }
  return rows
}

async function fetchOne(cdp, code) {
  const url = site.pageUrl(code, locale)
  await cdp.send('Page.navigate', { url })
  const state = await waitForCards(cdp)
  if (state.blocked) {
    return { ok: false, blocked: true, reason: 'cloudflare challenge', body: (state.body || '').slice(0, 120) }
  }
  if (!state.cards) {
    return { ok: false, reason: `no cards (ready=${state.ready})`, body: (state.body || '').slice(0, 120) }
  }
  const raw = await evaluate(cdp, `(${site.extract.toString()})()`)
  const rows = Array.isArray(raw) ? raw : []
  const self = code.toLowerCase()
  const items = []
  const seen = new Set()
  for (const row of rows) {
    if (!row.alt) continue
    const normCode = row.alt
      .replace(/-(uncensored-leak|chinese-subtitle|english-subtitle)$/, '')
      .toUpperCase()
    if (!/^[A-Z]{2,8}-\d{2,5}(-\d)?$/.test(normCode)) continue
    if (normCode === self) continue
    if (seen.has(normCode)) continue
    seen.add(normCode)
    const titleText = (row.title || '').replace(/^[A-Za-z0-9-]+\s*/, '').trim()
    items.push({
      code: normCode,
      title: titleText,
      duration: row.duration || '',
      cover_url: row.cover || '',
    })
    if (items.length >= 12) break
  }
  return { ok: true, items }
}

function loadCodes() {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const rows = db
    .prepare("select code from jav where code is not null and code <> '' order by id")
    .all()
  db.close()
  const codes = rows.map((r) => String(r.code).trim().toUpperCase()).filter(Boolean)
  if (onlyCodes) return codes.filter((c) => onlyCodes.includes(c))
  return limit > 0 ? codes.slice(0, limit) : codes
}

async function readCache() {
  try {
    const raw = await fs.readFile(outPath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && parsed.entries ? parsed : { entries: {} }
  } catch {
    return { entries: {} }
  }
}

async function writeCache(cache) {
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  cache.updated_at = new Date().toISOString()
  cache.site = site.label
  const tmp = `${outPath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(cache, null, 1), 'utf8')
  await fs.rename(tmp, outPath)
}

async function main() {
  await ensureChrome()
  const codes = loadCodes()
  const cache = await readCache()
  log(`站点=${site.label} 目标=${codes.length} 已有=${Object.keys(cache.entries).length}`)
  const { cdp, target } = await openTab()
  let done = 0
  let failed = 0
  let blockedStreak = 0
  try {
    for (const code of codes) {
      if (cache.entries[code] && cache.entries[code].items && !args.refresh) {
        continue
      }
      done += 1
      try {
        const result = await fetchOne(cdp, code)
        if (!result.ok) {
          failed += 1
          log(`✗ ${code} ${result.reason} ${result.body || ''}`)
          if (result.blocked) {
            blockedStreak += 1
            if (blockedStreak >= 6) {
              log('连续 6 次被 Cloudflare 拦截，停止抓取；请手动在窗口里通过一次验证后重跑')
              break
            }
            const backoff = Math.min(120000, 20000 * blockedStreak)
            log(`检测到验证页，等待 ${Math.round(backoff / 1000)}s 后重试`)
            await sleep(backoff)
          } else {
            blockedStreak = 0
          }
        } else {
          blockedStreak = 0
          cache.entries[code] = {
            site: site.label,
            fetched_at: new Date().toISOString(),
            items: result.items,
          }
          log(`✓ ${code} ${result.items.length} 条`)
        }
      } catch (error) {
        failed += 1
        log(`✗ ${code} ${error.message}`)
      }
      if (done % 10 === 0) await writeCache(cache)
      await sleep(interval)
    }
  } finally {
    await writeCache(cache)
    try {
      await fetch(`${cdpBase}/json/close/${target.id}`)
    } catch {}
    cdp.ws.close()
  }
  log(`完成：抓取 ${done}，失败 ${failed}，缓存总数 ${Object.keys(cache.entries).length}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
