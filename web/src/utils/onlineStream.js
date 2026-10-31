import { isJavBossExtensionReady, requestExtension } from '@/utils/javdb'
import { zh } from '@/utils/i18n'

const RESOLVE_TIMEOUT_MS = 45000
const FETCH_TIMEOUT_MS = 30000
const USERSCRIPT_BRIDGE_KEY = '__JAVBOSS_ONLINE_BRIDGE__'

export { isJavBossExtensionReady }

// A Tampermonkey userscript can expose the same resolve/fetch bridge on the
// page window, so online playback works without installing the extension.
export function getOnlineUserscriptBridge() {
  if (typeof window === 'undefined') return null
  const bridge = window[USERSCRIPT_BRIDGE_KEY]
  if (!bridge || bridge.version !== 1) return null
  return typeof bridge.resolve === 'function' && typeof bridge.fetchResource === 'function'
    ? bridge
    : null
}

export function isOnlineStreamUserscriptReady() {
  return Boolean(getOnlineUserscriptBridge())
}

export function isOnlineStreamBridgeReady() {
  return isJavBossExtensionReady() || isOnlineStreamUserscriptReady()
}

function describeBridgeError(error) {
  if (error?.code === 'EXTENSION_UNAVAILABLE') {
    return new Error(
      zh(
        'JavBoss 助手扩展未安装或未启用，无法解析在线片源',
        'The JavBoss extension is unavailable, so the online stream cannot be resolved'
      )
    )
  }
  if (error?.code === 'EXTENSION_TIMEOUT') {
    return new Error(
      zh('在线片源解析超时，请稍后重试', 'The online stream request timed out, please try again')
    )
  }
  return error
}

async function requestOnline(requestType, payload, responseType, timeout) {
  try {
    return await requestExtension(requestType, payload, { responseType, timeout })
  } catch (error) {
    throw describeBridgeError(error)
  }
}

export async function resolveOnlineStreamViaExtension(code) {
  const message = await requestOnline(
    'JAVBOSS_ONLINE_RESOLVE',
    { code },
    'JAVBOSS_ONLINE_RESOLVE_RESULT',
    RESOLVE_TIMEOUT_MS
  )
  if (!message.ok || !message.source?.stream_url) {
    throw new Error(message.error || zh('未找到可用的在线片源', 'No online stream was found'))
  }
  return message.source
}

export async function resolveOnlineStreamViaUserscript(code) {
  const bridge = getOnlineUserscriptBridge()
  if (!bridge) {
    throw new Error(
      zh(
        '未检测到 JavBoss 在线片源脚本，请先在 Tampermonkey 中安装并启用',
        'The JavBoss online stream userscript is not available; install and enable it first'
      )
    )
  }
  const source = await bridge.resolve(code)
  if (!source?.stream_url) {
    throw new Error(zh('未找到可用的在线片源', 'No online stream was found'))
  }
  return source
}

// Online streams come from sites that block cross-origin reads, so every
// playlist and segment request is relayed through the extension or userscript.
export async function fetchOnlineResource(
  url,
  { responseType = 'text', timeout = FETCH_TIMEOUT_MS, referer = '' } = {}
) {
  if (isJavBossExtensionReady()) {
    const message = await requestOnline(
      'JAVBOSS_ONLINE_FETCH',
      { url, responseType },
      'JAVBOSS_ONLINE_FETCH_RESULT',
      timeout
    )
    if (!message.ok) {
      throw new Error(message.error || zh('在线片源请求失败', 'The online stream request failed'))
    }
    return responseType === 'arrayBuffer' ? message.data : message.text
  }

  const bridge = getOnlineUserscriptBridge()
  if (bridge) {
    const headers = referer ? { Referer: referer } : {}
    let result
    try {
      result = await bridge.fetchResource(url, responseType, headers)
    } catch (error) {
      throw new Error(
        String(error?.message || '') || zh('在线片源请求失败', 'The online stream request failed')
      )
    }
    if (!result?.ok) {
      throw new Error(result?.error || zh('在线片源请求失败', 'The online stream request failed'))
    }
    return responseType === 'arrayBuffer' ? result.data : result.text
  }

  throw new Error(
    zh(
      '未检测到 JavBoss 助手扩展或在线片源脚本，无法请求在线片源',
      'Neither the JavBoss extension nor the online stream userscript is available'
    )
  )
}
