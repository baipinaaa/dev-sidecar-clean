/**
 * TLS ClientHello 分段发送（TCP Segmentation）
 *
 * 目的：GFW 的 DPI 需要读到足够多的 ClientHello 字节（尤其是 SNI 扩展）才能提取域名。
 * 把首个 ClientHello 在 TCP 层切成若干小段依次发送，DPI 侧无法跨段重组，就看不到 SNI，
 * 从而放行；而源站会在内核里重组出完整 TLS 记录，握手完全不受影响。
 *
 * 与「SNI 伪装」（把 SNI 改成 baidu.com）的本质区别：
 *   1. SNI 伪装会改字节 → CDN（Cloudflare 等）按错误的 SNI 选 zone → 直接 403；
 *      分段发送不改任何字节 → SNI 仍是真实域名 → CDN 正确路由。
 *   2. SNI 伪装必然导致证书域名不匹配 → 只能关闭上游证书校验；
 *      分段发送证书链完好 → 可以正常校验。
 *   3. 有些服务器/CDN 会因为「SNI 与实际站点不符」直接拒绝；
 *      分段发送对服务器完全透明。
 *
 * 实现参考：Hana-ame/ech-proxy 的 tcpFragmentConn
 *   （只拆 TCP 段，保持单条完整 TLS record 头；兼容 DDoS-Guard 这类拒绝多条细碎 TLS 记录的源站）
 *
 * 只在 CONNECT 隧道（纯字节转发）场景使用 —— MITM 场景下 ClientHello 是我们自己发起的，
 * 不经过这里。
 */

const { once } = require('events')

const TLS_RECORD_MIN = 5
const TLS_HANDSHAKE = 0x16
const TLS_MAJOR = 0x03
const DEFAULT_SEG_SIZE = 32
const DEFAULT_MAX_BYTES = 2048

/**
 * 判断一段字节是否是 TLS Handshake 记录（ClientHello 开头）
 * 只有这种情况才值得分段 —— HTTP 明文请求分段没有意义，还可能触发服务端异常。
 */
function isTlsClientHello (buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= TLS_RECORD_MIN &&
    buf[0] === TLS_HANDSHAKE &&
    buf[1] === TLS_MAJOR
  )
}

/**
 * hostname 通配匹配
 *   '*'            → 全部
 *   '*.example.com' → 仅子域
 *   '*example.com'  → 根域 + 所有子域
 *   'example.com'   → 精确
 */
function matchDomain (patterns, hostname) {
  if (!Array.isArray(patterns) || patterns.length === 0 || !hostname) {
    return false
  }
  const host = String(hostname).toLowerCase()
  for (const raw of patterns) {
    if (typeof raw !== 'string' || raw === '') {
      continue
    }
    const p = raw.trim().toLowerCase()
    if (p === '*' || p === '*.*') {
      return true
    }
    if (p.startsWith('*.')) {
      const suffix = p.slice(1) // '.example.com'
      if (host.endsWith(suffix)) {
        return true
      }
    } else if (p.startsWith('*')) {
      const suffix = p.slice(1) // 'example.com'
      if (host === suffix || host.endsWith('.' + suffix)) {
        return true
      }
    } else if (host === p) {
      return true
    }
  }
  return false
}

/**
 * 从配置里取出该 hostname 的分片参数，未启用返回 null
 * @param {object} serverConfig  server 段配置
 * @param {string} hostname      CONNECT 目标域名
 * @returns {{size:number, maxBytes:number}|null}
 */
function getFragmentOption (serverConfig, hostname) {
  if (!serverConfig || typeof serverConfig !== 'object') {
    return null
  }
  const cfg = serverConfig.tlsFragment
  if (!cfg || cfg.enabled !== true) {
    return null
  }
  const domains = cfg.domains
  // domains 为空数组时视为「不启用」，避免误伤全部站点
  if (!Array.isArray(domains) || domains.length === 0) {
    return null
  }
  if (!matchDomain(domains, hostname)) {
    return null
  }

  let size = parseInt(cfg.size, 10)
  if (!Number.isFinite(size) || size < 1) {
    size = DEFAULT_SEG_SIZE
  }
  // 段太小会产生大量系统调用；段太大则可能不足以打散 SNI
  size = Math.min(Math.max(size, 1), 256)

  let maxBytes = parseInt(cfg.maxBytes, 10)
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    maxBytes = DEFAULT_MAX_BYTES
  }

  return { size, maxBytes }
}

/**
 * 把 buf 按 size 切段依次写入 socket。
 *
 * 关键点：Node 的 net.Socket 会把同一个 tick 内的多次 write 合并成一次 writev，
 * 从而在内核里仍然是一个（或很少几个）TCP 段。所以每写完一段必须让出事件循环
 * （setImmediate），让上一次 write 真正 flush 出去。
 *
 * @param {import('net').Socket} socket
 * @param {Buffer} buf
 * @param {number} size     每段字节数
 * @param {number} maxBytes 最多对前多少字节分段（超出的部分一次性写完）
 */
async function writeInSegments (socket, buf, size, maxBytes) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return
  }
  const segSize = size > 0 ? size : DEFAULT_SEG_SIZE
  const limit = maxBytes > 0 ? Math.min(buf.length, maxBytes) : buf.length

  // 关闭 Nagle，否则内核会把小段攒起来合并
  if (typeof socket.setNoDelay === 'function') {
    socket.setNoDelay(true)
  }

  for (let off = 0; off < limit; off += segSize) {
    if (socket.destroyed || socket.writableEnded) {
      return
    }
    const end = Math.min(off + segSize, limit)
    const flushed = socket.write(buf.subarray(off, end))
    if (!flushed) {
      // 缓冲区满，等 drain（本身已经跨 tick，不需要再让出）
      await once(socket, 'drain')
    } else {
      // 让出事件循环，强制把刚才那段单独 flush 成一个 TCP 段
      await new Promise(resolve => setImmediate(resolve))
    }
  }

  // 剩余字节一次性写完
  if (limit < buf.length && !socket.destroyed && !socket.writableEnded) {
    socket.write(buf.subarray(limit))
  }
}

/**
 * 创建一个「首包分片」转发器，接管 CONNECT 隧道 客户端 → 上游 方向。
 *
 * 行为：
 *   - 首个数据块（可能由 head + 第一次 data 拼成）若是 TLS ClientHello，则分段发送
 *   - 之后的所有数据原样直通（零额外开销）
 *   - 非 TLS 首包直接直通，不分片
 *
 * @param {object} options
 * @param {import('net').Socket} options.source  客户端 socket
 * @param {import('net').Socket} options.target  上游 socket
 * @param {Buffer} [options.head]                CONNECT 之后已缓冲的字节
 * @param {number} options.size
 * @param {number} options.maxBytes
 * @param {function} [options.log]
 * @returns {{isFirst:boolean}} 状态对象（便于测试断言）
 */
function createFragmentForwarder ({ source, target, head, size, maxBytes, log = null }) {
  const state = { isFirst: true, fragmented: false, firstLen: 0 }

  let pending = head && head.length > 0 ? [head] : []

  const passThrough = () => {
    if (pending.length > 0) {
      for (const chunk of pending) {
        target.write(chunk)
      }
      pending = []
    }
    if (!source.readableEnded) {
      source.resume()
    }
  }

  const onData = (chunk) => {
    if (!state.isFirst) {
      if (!target.write(chunk)) {
        source.pause()
        target.once('drain', () => source.resume())
      }
      return
    }

    state.isFirst = false
    source.pause()

    const first = pending.length > 0 ? Buffer.concat([...pending, chunk]) : chunk
    pending = []
    state.firstLen = first.length

    if (!isTlsClientHello(first)) {
      // 不是 TLS 握手包，直接原样转发，切回直通模式
      target.write(first)
      source.resume()
      return
    }

    state.fragmented = true
    if (log) {
      log.debug(`[TLS分片] 首包 ${first.length}B 按 ${size}B 分段发送`)
    }

    writeInSegments(target, first, size, maxBytes)
      .then(() => {
        if (!source.destroyed && !source.readableEnded) {
          source.resume()
        }
      })
      .catch((e) => {
        if (log) {
          log.warn(`[TLS分片] 分段发送失败，后续直通: ${e.message}`)
        }
        if (!source.destroyed && !source.readableEnded) {
          source.resume()
        }
      })
  }

  source.on('data', onData)
  source.on('end', () => {
    if (pending.length > 0) {
      for (const chunk of pending) {
        target.write(chunk)
      }
      pending = []
    }
    target.end()
  })
  source.on('error', () => {
    try {
      target.destroy()
    } catch (e) {
      // ignore
    }
  })

  // 客户端迟迟不发数据时，head 也不能一直挂着
  const headTimer = setTimeout(() => {
    if (state.isFirst && pending.length > 0) {
      state.isFirst = false
      passThrough()
    }
  }, 2000)
  if (typeof headTimer.unref === 'function') {
    headTimer.unref()
  }
  source.once('close', () => clearTimeout(headTimer))

  return state
}

module.exports = {
  isTlsClientHello,
  matchDomain,
  getFragmentOption,
  writeInSegments,
  createFragmentForwarder,
  DEFAULT_SEG_SIZE,
  DEFAULT_MAX_BYTES,
}
