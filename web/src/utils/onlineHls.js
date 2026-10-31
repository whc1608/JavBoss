import Hls from 'hls.js'
import { fetchOnlineResource } from '@/utils/onlineStream'
import { zh } from '@/utils/i18n'

function createLoadStats() {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    trequest: 0,
    tfirst: 0,
    tload: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  }
}

// hls.js loader that satisfies its request contract while routing every
// playlist and segment fetch through the JavBoss extension bridge.
class ExtensionStreamLoader {
  constructor() {
    this.stats = createLoadStats()
    this.generation = 0
    this.referer = ''
  }

  load(context, _config, callbacks) {
    const generation = (this.generation += 1)
    const responseType = context.responseType === 'arraybuffer' ? 'arrayBuffer' : 'text'
    const start = performance.now()
    this.stats.loading.start = start
    this.stats.trequest = start

    fetchOnlineResource(context.url, { responseType, referer: this.referer })
      .then((data) => {
        if (generation !== this.generation) return
        const end = performance.now()
        const size =
          typeof data === 'string' ? data.length : Number(data?.byteLength ?? data?.length ?? 0)
        this.stats.loading.first = end
        this.stats.loading.end = end
        this.stats.tfirst = end
        this.stats.tload = end
        this.stats.loaded = size
        this.stats.total = size
        this.stats.chunkCount = 1
        callbacks.onSuccess({ url: context.url, data }, this.stats, context, null)
      })
      .catch((error) => {
        if (generation !== this.generation) return
        callbacks.onError(
          {
            code: Hls.ErrorTypes.NETWORK_ERROR,
            text: String(error?.message || 'networkError'),
          },
          context,
          null,
          this.stats
        )
      })
  }

  abort() {
    this.generation += 1
  }

  destroy() {
    this.generation += 1
  }

  getResponseHeader() {
    return null
  }
}

export function canPlayOnlineHls() {
  return Hls.isSupported()
}

function createExtensionLoader(referer) {
  return class extends ExtensionStreamLoader {
    constructor(config) {
      super(config)
      this.referer = referer || ''
    }
  }
}

export function startOnlineHlsPlayback(player, source, { onError, referer = '' } = {}) {
  if (!canPlayOnlineHls()) {
    onError?.(
      new Error(
        zh(
          '当前浏览器不支持在线片源的网页播放',
          'This browser cannot play the online stream in the web player'
        )
      )
    )
    return () => {}
  }
  const tech = player.tech({ IWillNotUseThisInPlugins: true })
  const element = tech?.el?.()
  if (!element) {
    onError?.(new Error(zh('播放器初始化失败', 'Failed to initialize the player')))
    return () => {}
  }

  let recoveredNetworkError = false
  let recoveredMediaError = false
  const Loader = createExtensionLoader(referer)
  const hls = new Hls({
    loader: Loader,
    pLoader: Loader,
    fLoader: Loader,
    // A blob worker can be blocked by page CSPs; the relay is already async.
    enableWorker: false,
    lowLatencyMode: false,
    backBufferLength: 90,
  })

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    player.play()?.catch(() => {})
  })
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data?.fatal) return
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !recoveredNetworkError) {
      recoveredNetworkError = true
      hls.startLoad()
      return
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMediaError) {
      recoveredMediaError = true
      hls.recoverMediaError()
      return
    }
    const detail = String(data.details || data.type || '')
    onError?.(
      new Error(
        zh(
          `在线片源加载失败${detail ? `（${detail}）` : ''}`,
          `Failed to load the online stream${detail ? ` (${detail})` : ''}`
        )
      )
    )
  })

  hls.loadSource(source.src)
  hls.attachMedia(element)

  return () => {
    hls.destroy()
  }
}
