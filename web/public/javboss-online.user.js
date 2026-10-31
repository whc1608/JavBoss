// ==UserScript==
// @name         JavBoss 在线片源助手
// @namespace    https://github.com/whc1608/JavBoss
// @version      1.3.2
// @description  为 JavBoss 页面解析并播放在线片源，无需安装浏览器扩展
// @updateURL    http://localhost:8655/javboss-online.user.js
// @downloadURL  http://localhost:8655/javboss-online.user.js
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @match        https://localhost/*
// @match        https://127.0.0.1/*
// @match        https://missav123.com/*
// @match        https://www.missav123.com/*
// @match        https://123av.com/*
// @connect      missav123.com
// @connect      123av.com
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict'

  const BRIDGE_VERSION = 1
  const ONLINE_CACHE_TTL = 10 * 60 * 1000
  const REQUEST_TIMEOUT = 30000
  const TAB_REQUEST_KEY = 'javbossOnlineTabRequest'
  const TAB_RESPONSE_KEY = 'javbossOnlineTabResponse'
  const TAB_REQUEST_TTL = 5 * 60 * 1000
  const MISSING_PERMISSION =
    '在线片源脚本无法访问视频站点，请在 Tampermonkey 中允许该脚本连接 missav123.com 与 123av.com'

  function challengeError(url) {
    const target = String(url || '').trim()
    return target
      ? `在线片源站点要求浏览器验证，请先在浏览器中打开 ${target} 完成验证后重试`
      : '在线片源站点要求浏览器验证，请先在浏览器中打开对应站点完成验证后重试'
  }

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window

  function normalizeCode(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[_ ]+/g, '-')
  }

  function unpackPacker(source) {
    const match = String(source || '').match(
      /\}\('((?:\\.|[^'\\])*)',\s*(\d+),\s*(\d+),\s*'((?:\\.|[^'\\])*)'\.split\('\|'\)/
    )
    if (!match) return String(source || '')
    const radix = Number(match[2])
    const count = Number(match[3])
    if (!(radix >= 2 && radix <= 36) || count > 500) return String(source || '')
    const words = match[4].split('|')
    let unpacked = match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    for (let index = count - 1; index >= 0; index -= 1) {
      if (!words[index]) continue
      unpacked = unpacked.replace(new RegExp(`\\b${index.toString(radix)}\\b`, 'g'), words[index])
    }
    return unpacked
  }

  function isChallengePage(text) {
    return /cf-mitigated|Just a moment|Checking your browser|Enable JavaScript and cookies/i.test(
      String(text || '').slice(0, 4000)
    )
  }

  function streamTypeOf(url) {
    return /\.m3u8(?:[?#]|$)/i.test(String(url || '')) ? 'hls' : 'direct'
  }

  function parseMissavDocument(html, code) {
    const source = String(html || '')
    if (!/<video[^>]*class="[^"]*\bplayer\b/i.test(source)) return null
    const scripts = [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(
      (match) => match[1]
    )
    const playerScript = scripts.find(
      (script) =>
        /document\.querySelector\(['"]video\.player['"]\)/i.test(script) &&
        /dvd_id:\s*['"]/i.test(script)
    )
    if (!playerScript) return null
    const dvdID = playerScript.match(/dvd_id:\s*['"]([^'"]+)['"]/i)?.[1]
    if (dvdID && dvdID.toLowerCase() !== code) return null

    const unpacked = unpackPacker(playerScript)
    const sources = {}
    for (const match of unpacked.matchAll(
      /\b(source|source1280|source842)\s*=\s*['"](https:\/\/[^'"]+)['"]/gi
    )) {
      sources[match[1].toLowerCase()] = match[2]
    }
    const url = sources.source1280 || sources.source842 || sources.source
    return url || null
  }

  function parse123avDocument(html) {
    const match = String(html || '').match(/player\(JSON\.parse\('([\s\S]*?)'\)/i)
    if (!match) return ''
    const raw = match[1]
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\')
      .replace(/\\'/g, "'")
    let list
    try {
      list = JSON.parse(raw)
    } catch {
      return ''
    }
    if (!Array.isArray(list)) return ''
    const urls = list
      .map((entry) => String(entry?.url || entry?.src || entry?.file || '').trim())
      .filter((url) => /^https?:\/\//i.test(url))
    return (
      urls.find((url) => /\.m3u8(?:[?#]|$)/i.test(url)) ||
      urls.find((url) => /\.(?:mp4|m4v|mov)(?:[?#]|$)/i.test(url)) ||
      urls[0] ||
      ''
    )
  }

  function resolveURL(value, base) {
    try {
      const parsed = new URL(String(value || '').trim(), base || undefined)
      return /^https?:$/i.test(parsed.protocol) ? parsed.href : ''
    } catch {
      return ''
    }
  }

  function gmRequest(url, responseType, extraHeaders = {}) {
    // Match the reference userscript's request options: it never sets
    // anonymous/withCredentials and only sends an Accept header.
    const headers = {
      Accept: responseType === 'text' ? 'text/html' : '*/*',
      ...extraHeaders,
    }
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: REQUEST_TIMEOUT,
        responseType,
        headers,
        onload: resolve,
        onerror: () => reject(new Error('Failed to fetch')),
        ontimeout: () => reject(new Error('请求超时')),
        onabort: () => reject(new Error('请求已取消')),
      })
    })
  }

  async function fetchText(url, headers = {}) {
    const response = await gmRequest(url, 'text', headers)
    const text = String(response.responseText || '')
    if (isChallengePage(text)) throw new Error('challenge')
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`)
    return text
  }

  function get123avSlug(code) {
    const raw = String(code || '').trim().toLowerCase()
    if (!raw) return ''
    const fc2 = raw.match(/^(?:fc2[-_ ]*(?:ppv[-_ ]*)?)?(\d{6,9})$/)
    if (fc2) return `fc2-ppv-${fc2[1]}`
    const dated = raw.match(/^(\d{6})[_-](\d{2,3})$/)
    if (dated) {
      const prefix =
        dated[2].length === 2 ? '10musume' : dated[2] === '100' ? 'pacopacomama' : ''
      if (prefix) return `${prefix}-${dated[1]}-${dated[2]}`
    }
    const caribbean = raw.match(/^(\d{6}-\d{3})$/)
    if (caribbean) return `caribbeancom-${caribbean[1]}`
    return raw.replace(/[_\s]+/g, '-')
  }

  function detailCandidates123(code) {
    const slug = get123avSlug(code)
    if (!slug) return []
    const url = `https://123av.com/cn/v/${slug}`
    const eligible =
      slug === String(code || '').trim().toLowerCase() &&
      /^[a-z]{2,10}-\d{2,5}$/.test(slug) &&
      !slug.startsWith('heyzo-')
    if (!eligible) return [url]
    const leaked = url.replace(/\/v\/[^/]+\/?$/i, `/v/${slug}-uncensored-leaked`)
    return leaked === url ? [url] : [leaked, url]
  }

  function decodePlayerEntries(value, base) {
    const match = String(value || '').match(/player\(JSON\.parse\('([\s\S]*?)'\)/i)
    if (!match) return []
    const raw = match[1]
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\')
      .replace(/\\'/g, "'")
    let list
    try {
      list = JSON.parse(raw)
    } catch {
      return []
    }
    if (!Array.isArray(list)) return []
    return list.flatMap((entry, index) => {
      const url = resolveURL(entry?.url || entry?.src || entry?.file, base)
      return url ? [{ url, number: entry?.number ?? entry?.episode ?? index + 1 }] : []
    })
  }

  function mediaFromText(text, base) {
    const source = String(text || '')
    const parsed = parse123avDocument(source)
    const parsedURL = resolveURL(parsed, base)
    if (parsedURL) {
      return { url: parsedURL, type: /\.m3u8(?:[?#]|$)/i.test(parsedURL) ? 'hls' : 'direct' }
    }
    const matches = source.match(/https?:\/\/[^\s"'<>`\\]+\.(?:m3u8|mp4|webm)(?:\?[^\s"'<>`\\]*)?/gi) || []
    const hls = matches.find((url) => /\.m3u8(?:[?#]|$)/i.test(url))
    if (hls) return { url: resolveURL(hls, base) || hls, type: 'hls' }
    const video = matches.find((url) => /\.(?:mp4|webm)(?:[?#]|$)/i.test(url))
    if (video) return { url: resolveURL(video, base) || video, type: 'direct' }
    return null
  }

  async function resolve123av(code) {
    const pageHeaders = {
      Referer: 'https://123av.com/',
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    }
    for (const detail of detailCandidates123(code)) {
      let response
      try {
        response = await gmRequest(detail, 'text', pageHeaders)
      } catch (error) {
        if (String(error?.message || '') === 'Failed to fetch') throw error
        continue
      }
      const text = String(response.responseText || '')
      const ok = response.status >= 200 && response.status < 300
      if (!ok || isChallengePage(text)) {
        trace(`123AV ${detail}: HTTP ${response.status}${isChallengePage(text) ? '（Cloudflare 验证）' : ''}`)
        continue
      }
      const document = new DOMParser().parseFromString(text, 'text/html')
      const xData =
        document.querySelector('.watch__main[x-data], .watch__main')?.getAttribute('x-data') || ''
      const entries = decodePlayerEntries(xData, detail)
      trace(`123AV ${detail}: x-data 播放条目 ${entries.length}`)
      const player = entries.find((entry) => String(entry.number) === '1') || entries[0]
      if (!player?.url) continue
      let playerResponse
      try {
        playerResponse = await gmRequest(player.url, 'text', {
          Referer: detail,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        })
      } catch (error) {
        trace(`123AV player ${player.url}: ${String(error?.message || error || '')}`)
        continue
      }
      const playerText = String(playerResponse.responseText || '')
      const playerOk = playerResponse.status >= 200 && playerResponse.status < 300
      if (!playerOk || isChallengePage(playerText)) {
        trace(
          `123AV player ${player.url}: HTTP ${playerResponse.status}${isChallengePage(playerText) ? '（Cloudflare 验证）' : ''}`
        )
        continue
      }
      const media = mediaFromText(playerText, player.url) || mediaFromText(text, detail)
      if (media) {
        trace(`123AV player ${player.url}: 解析到 ${media.type}`)
        return {
          provider: '123AV',
          page_url: detail,
          stream_url: media.url,
          stream_type: media.type,
          referer: detail,
          kind: 'stream',
        }
      }
      trace(`123AV player ${player.url}: 未解析到媒体地址，改用 iframe 播放`)
      return {
        provider: '123AV',
        page_url: detail,
        iframe_url: player.url,
        stream_type: 'iframe',
        referer: detail,
        kind: 'stream',
      }
    }
    return null
  }

  const resolveCache = new Map()
  let debugTrace = []

  function trace(message) {
    debugTrace.push(String(message || ''))
  }

  function resolveAttempts(code) {
    const slug = normalizeCode(code)
    if (!slug) return []
    return [
      {
        provider: 'MissAV',
        pageURL: `https://missav123.com/cn/${slug}`,
        parse: (html) => parseMissavDocument(html, slug),
      },
      {
        provider: 'MissAV',
        pageURL: `https://missav123.com/cn/${slug}-chinese-subtitle`,
        parse: (html) => parseMissavDocument(html, slug),
      },
    ]
  }

  async function resolveOnlineStream(code) {
    debugTrace = []
    const key = normalizeCode(code)
    const cached = resolveCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.source

    let challenged = false
    let challengeURL = ''
    const errors = []
    for (const attempt of resolveAttempts(code)) {
      try {
        const html = await fetchText(attempt.pageURL)
        const url = attempt.parse(html)
        if (!url) {
          trace(`${attempt.provider} ${attempt.pageURL}: 页面已加载但未解析到播放地址`)
          continue
        }
        const source = {
          provider: attempt.provider,
          page_url: attempt.pageURL,
          stream_url: url,
          stream_type: streamTypeOf(url),
          referer: attempt.pageURL,
          kind: 'stream',
        }
        trace(`${attempt.provider} ${attempt.pageURL}: 解析成功`)
        resolveCache.set(key, { source, expiresAt: Date.now() + ONLINE_CACHE_TTL })
        return source
      } catch (error) {
        const message = String(error?.message || error || '')
        if (message === 'challenge') {
          challenged = true
          // Keep the canonical page as the verification hint; later variants
          // such as -chinese-subtitle are only fallbacks.
          if (!challengeURL) challengeURL = attempt.pageURL
          trace(`${attempt.provider} ${attempt.pageURL}: Cloudflare 验证拦截`)
          continue
        }
        trace(`${attempt.provider} ${attempt.pageURL}: ${message}`)
        errors.push(message)
      }
    }

    // 123AV keeps the full player behind a detail page, so follow the same
    // detail -> player page chain the JAV 老司机 userscript uses.
    try {
      const source = await resolve123av(code)
      if (source) {
        resolveCache.set(key, { source, expiresAt: Date.now() + ONLINE_CACHE_TTL })
        return source
      }
    } catch (error) {
      const message = String(error?.message || error || '')
      if (message === 'Failed to fetch') throw new Error(MISSING_PERMISSION)
      errors.push(message)
    }

    // Script requests are challenged, so fall back to a provider tab that
    // loads with the real browser session and reports the stream back.
    try {
      const source = await resolveViaTab(code)
      if (source) {
        trace('标签页提取: 成功')
        resolveCache.set(key, { source, expiresAt: Date.now() + ONLINE_CACHE_TTL })
        return source
      }
      trace('标签页提取: 未获取到片源')
    } catch (error) {
      trace(`标签页提取: ${String(error?.message || error || '')}`)
    }

    if (challenged) throw new Error(challengeError(challengeURL))
    if (errors.some((message) => message === 'Failed to fetch')) throw new Error(MISSING_PERMISSION)
    throw new Error('未找到可用的在线片源')
  }

  function validHttpURL(value) {
    try {
      const parsed = new URL(String(value || ''))
      return /^https?:$/.test(parsed.protocol) ? parsed.href : ''
    } catch {
      return ''
    }
  }

  // hls.js 会检查分片数据类型，尽量返回页面同源 ArrayBuffer，避免跨运行环境带来的类型问题。
  function toPageArrayBuffer(buffer) {
    try {
      const source = new Uint8Array(buffer)
      const target = new pageWindow.Uint8Array(source.length)
      target.set(source)
      return target.buffer
    } catch {
      return buffer
    }
  }

  function isProviderHost() {
    return /missav123\.com$/i.test(location.hostname) || /123av\.com$/i.test(location.hostname)
  }

  function providerSlug() {
    const parts = location.pathname.split('/').filter(Boolean)
    const last = String(parts[parts.length - 1] || '').toLowerCase()
    return last.replace(/-chinese-subtitle$/i, '').replace(/-uncensored-leaked$/i, '')
  }

  function providerPageChallenged() {
    const html = String(document.documentElement?.innerHTML || '')
    return (
      isChallengePage(html) || /Just a moment|Checking your browser/i.test(document.title || '')
    )
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function extractProviderSource(pageURL) {
    const slug = providerSlug()
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (providerPageChallenged()) return { challenged: true }
      const html = String(document.documentElement?.innerHTML || '')
      if (/missav123\.com$/i.test(location.hostname)) {
        const url = parseMissavDocument(html, slug)
        if (url) {
          return {
            source: {
              provider: 'MissAV',
              page_url: pageURL,
              stream_url: url,
              stream_type: streamTypeOf(url),
              referer: pageURL,
              kind: 'stream',
            },
          }
        }
      } else {
        const xData =
          document.querySelector('.watch__main[x-data], .watch__main')?.getAttribute('x-data') ||
          ''
        const entries = decodePlayerEntries(xData, pageURL)
        const player = entries.find((entry) => String(entry.number) === '1') || entries[0]
        if (player?.url) {
          let media = null
          try {
            const response = await gmRequest(player.url, 'text', {
              Referer: pageURL,
              Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            })
            if (response.status >= 200 && response.status < 300) {
              media = mediaFromText(String(response.responseText || ''), player.url)
            }
          } catch {
            media = null
          }
          if (media) {
            return {
              source: {
                provider: '123AV',
                page_url: pageURL,
                stream_url: media.url,
                stream_type: media.type,
                referer: pageURL,
                kind: 'stream',
              },
            }
          }
          return {
            source: {
              provider: '123AV',
              page_url: pageURL,
              iframe_url: player.url,
              stream_type: 'iframe',
              referer: pageURL,
              kind: 'stream',
            },
          }
        }
      }
      await wait(500)
    }
    return { source: null }
  }

  // Provider tabs load the page with the browser session, which is the only
  // way past Cloudflare when script requests are challenged.
  async function handleProviderTabRequest() {
    if (!isProviderHost() || typeof GM_getValue !== 'function') return
    const request = GM_getValue(TAB_REQUEST_KEY, null)
    if (!request?.id || Date.now() - Number(request.at || 0) > TAB_REQUEST_TTL) return
    const slug = providerSlug()
    if (!slug || slug !== normalizeCode(request.code)) return
    if (providerPageChallenged()) return
    const outcome = await extractProviderSource(location.href)
    if (outcome?.challenged) return
    const source = outcome?.source || null
    GM_setValue(TAB_RESPONSE_KEY, {
      id: request.id,
      source,
      error: source ? '' : '未找到可用的在线片源',
      at: Date.now(),
    })
  }

  function resolveViaTab(code) {
    const slug = normalizeCode(code)
    if (!slug) return Promise.resolve(null)
    const requestId = `jb-${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      GM_setValue(TAB_REQUEST_KEY, { id: requestId, code, at: Date.now() })
    } catch {
      return Promise.resolve(null)
    }
    let tab = null
    try {
      tab = GM_openInTab(`https://missav123.com/cn/${slug}`, {
        active: true,
        insert: true,
        setParent: true,
      })
    } catch {
      tab = null
    }
    return new Promise((resolve, reject) => {
      let settled = false
      let listenerId = null
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          if (typeof GM_removeValueChangeListener === 'function' && listenerId) {
            GM_removeValueChangeListener(listenerId)
          }
        } catch {
          // ignore listener cleanup failures
        }
        try {
          tab?.close?.()
        } catch {
          // ignore tab cleanup failures
        }
        fn(value)
      }
      const timer = setTimeout(
        () => finish(reject, new Error('片源标签页等待超时，请重试')),
        120000
      )
      try {
        listenerId = GM_addValueChangeListener(TAB_RESPONSE_KEY, (_name, _old, value) => {
          if (!value || value.id !== requestId) return
          if (value.error) finish(reject, new Error(value.error))
          else finish(resolve, value.source || null)
        })
      } catch {
        finish(reject, new Error('无法监听片源标签页'))
      }
    })
  }

  async function fetchResource(url, responseType, headers = {}) {
    const target = validHttpURL(url)
    if (!target) return { ok: false, error: '无效的视频流地址' }
    const type = responseType === 'arrayBuffer' ? 'arraybuffer' : 'text'
    const response = await gmRequest(target, type, headers)
    const ok = response.status >= 200 && response.status < 300
    const result = { ok, status: response.status }
    if (!ok) {
      result.error = `HTTP ${response.status}`
      return result
    }
    if (type === 'arraybuffer') {
      result.data = toPageArrayBuffer(response.response)
    } else {
      const text = String(response.responseText || '')
      if (isChallengePage(text)) {
        return { ok: false, status: response.status, error: challengeError(target) }
      }
      result.text = text
    }
    return result
  }

  if (isProviderHost()) {
    // Provider tabs only answer pending extraction requests from JavBoss.
    handleProviderTabRequest().catch(() => {})
  } else {
    pageWindow.__JAVBOSS_ONLINE_BRIDGE__ = {
      version: BRIDGE_VERSION,
      resolve: (code) => resolveOnlineStream(code),
      fetchResource: (url, responseType, headers) => fetchResource(url, responseType, headers),
      debug: async (code) => {
        try {
          const source = await resolveOnlineStream(code)
          return { source, trace: debugTrace }
        } catch (error) {
          return { error: String(error?.message || error || ''), trace: debugTrace }
        }
      },
    }
  }
})()
