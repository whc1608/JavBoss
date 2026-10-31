// ==UserScript==
// @name         JavBoss 在线片源助手
// @namespace    https://github.com/whc1608/JavBoss
// @version      1.1.0
// @description  为 JavBoss 页面解析并播放在线片源，无需安装浏览器扩展
// @updateURL    http://localhost:8655/javboss-online.user.js
// @downloadURL  http://localhost:8655/javboss-online.user.js
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @match        https://localhost/*
// @match        https://127.0.0.1/*
// @connect      missav123.com
// @connect      123av.com
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict'

  const BRIDGE_VERSION = 1
  const ONLINE_CACHE_TTL = 10 * 60 * 1000
  const REQUEST_TIMEOUT = 30000
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

  function gmRequest(url, responseType) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: REQUEST_TIMEOUT,
        responseType,
        anonymous: false,
        headers: {
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        onload: resolve,
        onerror: () => reject(new Error('Failed to fetch')),
        ontimeout: () => reject(new Error('请求超时')),
        onabort: () => reject(new Error('请求已取消')),
      })
    })
  }

  async function fetchText(url) {
    const response = await gmRequest(url, 'text')
    const text = String(response.responseText || '')
    if (isChallengePage(text)) throw new Error('challenge')
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`)
    return text
  }

  const resolveCache = new Map()

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
      {
        provider: '123AV',
        pageURL: `https://123av.com/cn/v/${slug}`,
        parse: parse123avDocument,
      },
      {
        provider: '123AV',
        pageURL: `https://123av.com/cn/v/${slug}-uncensored-leaked`,
        parse: parse123avDocument,
      },
    ]
  }

  async function resolveOnlineStream(code) {
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
        if (!url) continue
        const source = {
          provider: attempt.provider,
          page_url: attempt.pageURL,
          stream_url: url,
          stream_type: streamTypeOf(url),
        }
        resolveCache.set(key, { source, expiresAt: Date.now() + ONLINE_CACHE_TTL })
        return source
      } catch (error) {
        const message = String(error?.message || error || '')
        if (message === 'challenge') {
          challenged = true
          challengeURL = attempt.pageURL
          continue
        }
        errors.push(message)
      }
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

  async function fetchResource(url, responseType) {
    const target = validHttpURL(url)
    if (!target) return { ok: false, error: '无效的视频流地址' }
    const type = responseType === 'arrayBuffer' ? 'arraybuffer' : 'text'
    const response = await gmRequest(target, type)
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

  pageWindow.__JAVBOSS_ONLINE_BRIDGE__ = {
    version: BRIDGE_VERSION,
    resolve: (code) => resolveOnlineStream(code),
    fetchResource: (url, responseType) => fetchResource(url, responseType),
  }
})()
