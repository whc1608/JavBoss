(() => {
  const BRIDGE_VERSION = 1;
  const SESSION_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
  const ONLINE_RESOLVE = "JAVBOSS_ONLINE_RESOLVE";
  const ONLINE_RESOLVE_RESULT = "JAVBOSS_ONLINE_RESOLVE_RESULT";
  const ONLINE_FETCH = "JAVBOSS_ONLINE_FETCH";
  const ONLINE_FETCH_RESULT = "JAVBOSS_ONLINE_FETCH_RESULT";
  const ONLINE_CACHE_TTL = 10 * 60 * 1000;
  const MISSING_EXTENSION_PERMISSION =
    "扩展缺少在线片源访问权限，请在 JavBoss 助手弹窗中启用「在线片源播放」";
  const CHALLENGE_ERROR =
    "在线片源站点要求浏览器验证，请先在浏览器中打开对应站点完成验证后重试";
  let parentOrigin = "";
  let sessionId = "";

  function validSessionID(value) {
    const candidate = String(value || "");
    return SESSION_PATTERN.test(candidate) ? candidate : "";
  }

  function trustedJavBossOrigin(value) {
    let parsed;
    try {
      parsed = new URL(String(value || ""));
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return false;

    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host.endsWith(".local") ||
      host === "host.docker.internal" ||
      !host.includes(".") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.")
    ) {
      return true;
    }
    const octets = host.split(".").map((part) => Number.parseInt(part, 10));
    return (
      octets.length === 4 &&
      octets.every(
        (part) => Number.isInteger(part) && part >= 0 && part <= 255,
      ) &&
      ((octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127))
    );
  }

  function postToParent(message) {
    if (!parentOrigin || window.parent === window) return;
    window.parent.postMessage(
      { ...message, version: BRIDGE_VERSION, sessionId },
      parentOrigin,
    );
  }

  function normalizeCode(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[_ ]+/g, "-");
  }

  function unpackPacker(source) {
    const match = String(source || "").match(
      /\}\('((?:\\.|[^'\\])*)',\s*(\d+),\s*(\d+),\s*'((?:\\.|[^'\\])*)'\.split\('\|'\)/,
    );
    if (!match) return String(source || "");
    const radix = Number(match[2]);
    const count = Number(match[3]);
    if (!(radix >= 2 && radix <= 36) || count > 500) return String(source || "");
    const words = match[4].split("|");
    let unpacked = match[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    for (let index = count - 1; index >= 0; index -= 1) {
      if (!words[index]) continue;
      unpacked = unpacked.replace(
        new RegExp(`\\b${index.toString(radix)}\\b`, "g"),
        words[index],
      );
    }
    return unpacked;
  }

  function isChallengePage(text) {
    return /cf-mitigated|Just a moment|Checking your browser|Enable JavaScript and cookies/i.test(
      String(text || "").slice(0, 4000),
    );
  }

  function streamTypeOf(url) {
    return /\.m3u8(?:[?#]|$)/i.test(String(url || "")) ? "hls" : "direct";
  }

  function parseMissavDocument(html, code) {
    const source = String(html || "");
    if (!/<video[^>]*class="[^"]*\bplayer\b/i.test(source)) return null;
    const scripts = [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(
      (match) => match[1],
    );
    const playerScript = scripts.find(
      (script) =>
        /document\.querySelector\(['"]video\.player['"]\)/i.test(script) &&
        /dvd_id:\s*['"]/i.test(script),
    );
    if (!playerScript) return null;
    const dvdID = playerScript.match(/dvd_id:\s*['"]([^'"]+)['"]/i)?.[1];
    if (dvdID && dvdID.toLowerCase() !== code) return null;

    const unpacked = unpackPacker(playerScript);
    const sources = {};
    for (const match of unpacked.matchAll(
      /\b(source|source1280|source842)\s*=\s*['"](https:\/\/[^'"]+)['"]/gi,
    )) {
      sources[match[1].toLowerCase()] = match[2];
    }
    const url = sources.source1280 || sources.source842 || sources.source;
    return url ? url : null;
  }

  function parse123avDocument(html) {
    const match = String(html || "").match(/player\(JSON\.parse\('([\s\S]*?)'\)/i);
    if (!match) return "";
    const raw = match[1]
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\\//g, "/")
      .replace(/\\\\/g, "\\")
      .replace(/\\'/g, "'");
    let list;
    try {
      list = JSON.parse(raw);
    } catch {
      return "";
    }
    if (!Array.isArray(list)) return "";
    const urls = list
      .map((entry) => String(entry?.url || entry?.src || entry?.file || "").trim())
      .filter((url) => /^https?:\/\//i.test(url));
    return (
      urls.find((url) => /\.m3u8(?:[?#]|$)/i.test(url)) ||
      urls.find((url) => /\.(?:mp4|m4v|mov)(?:[?#]|$)/i.test(url)) ||
      urls[0] ||
      ""
    );
  }

  async function fetchText(url) {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
    });
    const text = await response.text();
    if (isChallengePage(text)) throw new Error("challenge");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return text;
  }

  const onlineCache = new Map();

  function resolveAttempts(code) {
    const slug = normalizeCode(code);
    if (!slug) return [];
    return [
      {
        provider: "MissAV",
        pageURL: `https://missav123.com/cn/${slug}`,
        parse: (html) => parseMissavDocument(html, slug),
      },
      {
        provider: "MissAV",
        pageURL: `https://missav123.com/cn/${slug}-chinese-subtitle`,
        parse: (html) => parseMissavDocument(html, slug),
      },
      {
        provider: "123AV",
        pageURL: `https://123av.com/cn/v/${slug}`,
        parse: parse123avDocument,
      },
      {
        provider: "123AV",
        pageURL: `https://123av.com/cn/v/${slug}-uncensored-leaked`,
        parse: parse123avDocument,
      },
    ];
  }

  async function resolveOnlineStream(code) {
    const key = normalizeCode(code);
    const cached = onlineCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.source;

    let challenged = false;
    const errors = [];
    for (const attempt of resolveAttempts(code)) {
      try {
        const html = await fetchText(attempt.pageURL);
        const url = attempt.parse(html);
        if (!url) continue;
        const source = {
          provider: attempt.provider,
          page_url: attempt.pageURL,
          stream_url: url,
          stream_type: streamTypeOf(url),
        };
        onlineCache.set(key, { source, expiresAt: Date.now() + ONLINE_CACHE_TTL });
        return source;
      } catch (error) {
        const message = String(error?.message || error || "");
        if (message === "challenge") {
          challenged = true;
          continue;
        }
        errors.push(message);
      }
    }
    if (challenged) throw new Error(CHALLENGE_ERROR);
    if (errors.some((message) => message === "Failed to fetch")) {
      throw new Error(MISSING_EXTENSION_PERMISSION);
    }
    throw new Error("未找到可用的在线片源");
  }

  function validHttpURL(value) {
    try {
      const parsed = new URL(String(value || ""));
      return /^https?:$/.test(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }

  async function proxyFetchRequest(request) {
    const url = validHttpURL(request?.url);
    if (!url) return { ok: false, error: "invalid stream url" };
    const responseType = request?.responseType === "arrayBuffer" ? "arrayBuffer" : "text";
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
    });
    const result = {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("Content-Type") || "",
    };
    if (!response.ok) {
      result.error = `HTTP ${response.status}`;
      return result;
    }
    if (responseType === "arrayBuffer") {
      result.data = await response.arrayBuffer();
    } else {
      const text = await response.text();
      if (isChallengePage(text)) {
        return { ok: false, status: response.status, error: CHALLENGE_ERROR };
      }
      result.text = text;
    }
    return result;
  }

  async function handleOnlineMessage(message) {
    const requestId = String(message?.requestId || "");
    if (message?.type === ONLINE_RESOLVE) {
      try {
        const source = await resolveOnlineStream(String(message.code || ""));
        postToParent({ type: ONLINE_RESOLVE_RESULT, requestId, ok: true, source });
      } catch (error) {
        postToParent({
          type: ONLINE_RESOLVE_RESULT,
          requestId,
          ok: false,
          error: String(error?.message || error || "resolve failed"),
        });
      }
      return;
    }
    try {
      const result = await proxyFetchRequest(message);
      postToParent({ type: ONLINE_FETCH_RESULT, requestId, ...result });
    } catch (error) {
      postToParent({
        type: ONLINE_FETCH_RESULT,
        requestId,
        ok: false,
        error: String(error?.message || error || "fetch failed"),
      });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (message?.type === "JAVBOSS_EXTENSION_CONNECT") {
      const requestedSessionId = validSessionID(message.sessionId);
      if (!requestedSessionId || !trustedJavBossOrigin(event.origin)) return;
      parentOrigin = event.origin;
      sessionId = requestedSessionId;
      postToParent({ type: "JAVBOSS_EXTENSION_READY" });
      return;
    }
    if (
      parentOrigin &&
      event.origin === parentOrigin &&
      validSessionID(message?.sessionId) === sessionId &&
      (message?.type === ONLINE_RESOLVE || message?.type === ONLINE_FETCH)
    ) {
      handleOnlineMessage(message);
      return;
    }
    const openMessageTypes = new Set([
      "JAVBOSS_SCRAPE_OPEN",
      "JAVBOSS_JAVDB_OPEN",
    ]);
    if (
      !parentOrigin ||
      event.origin !== parentOrigin ||
      !openMessageTypes.has(message?.type) ||
      validSessionID(message.sessionId) !== sessionId
    ) {
      return;
    }

    const runtimeMessage =
      message.type === "JAVBOSS_JAVDB_OPEN"
        ? {
            type: "JAVBOSS_JAVDB_OPEN_ASSIST",
            sessionId,
            url: String(message.url || ""),
            fallbackUrl: String(message.fallbackUrl || ""),
            request: message.request,
          }
        : {
            type: "JAVBOSS_SCRAPE_OPEN_RELAY",
            sessionId,
            url: String(message.url || ""),
          };
    const statusType =
      message.type === "JAVBOSS_JAVDB_OPEN"
        ? "JAVBOSS_JAVDB_OPEN_STATUS"
        : "JAVBOSS_SCRAPE_OPEN_STATUS";
    chrome.runtime
      .sendMessage(runtimeMessage)
      .then((response) => {
        postToParent({
          type: statusType,
          ok: Boolean(response?.ok),
          error: String(response?.error || ""),
        });
      })
      .catch((error) => {
        postToParent({
          type: statusType,
          ok: false,
          error: String(error?.message || error || "extension error"),
        });
      });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (
      message?.type !== "JAVBOSS_SCRAPE_BRIDGE_METADATA" ||
      validSessionID(message.sessionId) !== sessionId
    ) {
      return;
    }
    postToParent({
      type: "JAVBOSS_SCRAPE_METADATA",
      payload: message.payload,
    });
    sendResponse({ ok: true });
    return false;
  });
})();
