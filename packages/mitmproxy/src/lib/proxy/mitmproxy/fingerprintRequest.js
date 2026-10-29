/**
 * TLS 指纹伪装的传输层实现（wreq-js / Rust + BoringSSL）
 *
 * 由 `createRequestHandler.js` 在 `context.fingerprint` 存在时调用，
 * 用 wreq-js 的 `fetch()` 代替 Node 原生 `http/https.request`，
 * 再把 WHATWG `Response` 包装回 dev-sidecar 主流程期望的「类 IncomingMessage」。
 *
 * 之所以包装：主流程后续要用到 proxyRes 的 `statusCode` / `headers` /
 * `on('error')` / `resume()` / 作为 Readable 被 `pipeline()` 消费，
 * 以及把 proxyReq 传给 response 拦截器（需要 `on()` / `destroy()`）。
 */
const { Readable } = require('stream')

// RFC 7230 hop-by-hop 头：不能透传给上游，也不能逐字回给客户端
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

let wreqCache
let wreqLoadError

/**
 * 懒加载 wreq-js：未安装时只在真正用到 fingerprint 规则时才报错，
 * 不会影响 dev-sidecar 的启动与其它功能。
 */
function loadWreq () {
  if (wreqCache) {
    return wreqCache
  }
  if (wreqLoadError) {
    throw wreqLoadError
  }
  try {
    // eslint-disable-next-line global-require
    wreqCache = require('wreq-js')
    return wreqCache
  } catch (e) {
    wreqLoadError = new Error(
      `未安装 wreq-js（TLS 指纹伪装依赖），请执行 pnpm install 后重试；原始错误：${e.message}`,
    )
    wreqLoadError.cause = e
    throw wreqLoadError
  }
}

/** 简单的事件桩：主流程会把 proxyReq 传给 response 拦截器，那里可能调用 on/destroy */
function createProxyReqStub (onAbort) {
  const listeners = new Map()
  return {
    socket: null,
    destroyed: false,
    on (event, fn) {
      if (!listeners.has(event)) {
        listeners.set(event, [])
      }
      listeners.get(event).push(fn)
      return this
    },
    once (event, fn) {
      return this.on(event, fn)
    },
    removeListener (event, fn) {
      const arr = listeners.get(event)
      if (arr) {
        const index = arr.indexOf(fn)
        if (index >= 0) {
          arr.splice(index, 1)
        }
      }
      return this
    },
    setTimeout () {
      return this
    },
    write () {
      return true
    },
    end () {
      return this
    },
    destroy () {
      if (this.destroyed) {
        return this
      }
      this.destroyed = true
      onAbort && onAbort()
      return this
    },
  }
}

/** 把 rOptions.headers 转成可交给 wreq 的普通对象 */
function buildHeaders (rOptions) {
  const out = {}
  const src = rOptions.headers || {}
  for (const key of Object.keys(src)) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower)) {
      continue
    }
    const value = src[key]
    if (value === undefined || value === null) {
      continue
    }
    out[lower] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  // 上游必须看到真实域名（否则虚拟主机选错站点）
  if (rOptions.hostname) {
    out.host = rOptions.port && !isDefaultPort(rOptions.protocol, rOptions.port)
      ? `${rOptions.hostname}:${rOptions.port}`
      : rOptions.hostname
  }
  return out
}

function isDefaultPort (protocol, port) {
  const p = Number(port)
  return (protocol === 'https:' && p === 443) || (protocol === 'http:' && p === 80)
}

/**
 * 用 dev-sidecar 自己的 DNS（rOptions.lookup）解析目标域名，把结果交给 wreq 的 `resolve`。
 *
 * 这一步很关键：wreq 自己用系统 DNS，而系统 DNS 在国内对很多站点是被污染的。
 * 把 DS 已有的解析结果（doH / preSetIpList / ECH 专用 DNS）透传过去，
 * 才能保证「fingerprint 伪装」与「DS 的 DNS 优选」两者兼得。
 *
 * 解析失败时返回 null，由 wreq 自己解析（不因这个环节失败而破坏请求）。
 */
function resolveHostViaDs (rOptions, log) {
  const lookup = rOptions.lookup
  if (typeof lookup !== 'function' || !rOptions.hostname) {
    return Promise.resolve(null)
  }
  // 已经是 IP 的不用再解析
  if (require('node:net').isIP(rOptions.hostname)) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let settled = false
    const done = (ip) => {
      if (!settled) {
        settled = true
        resolve(ip)
      }
    }
    try {
      lookup(rOptions.hostname, { family: rOptions.family || 0, all: false }, (err, address) => {
        if (err) {
          log.warn(`fingerprint: DS DNS 解析失败，回退 wreq 自带解析: ${rOptions.hostname}, error: ${err.message}`)
          done(null)
          return
        }
        const ip = Array.isArray(address) ? address[0] && address[0].address : address
        done(ip || null)
      })
    } catch (e) {
      log.warn(`fingerprint: DS DNS 解析抛错，回退 wreq 自带解析: ${rOptions.hostname}, error: ${e.message}`)
      done(null)
    }
  })
}

/** 把 WHATWG Response 包装成主流程可用对象 */
function wrapResponse (response) {
  const proxyRes = Readable.fromWeb(response.body)
  proxyRes.statusCode = response.status
  proxyRes.statusMessage = response.statusText || ''
  proxyRes.httpVersion = '1.1'

  const headers = {}
  for (const [key, value] of response.headers) {
    headers[key] = value
  }
  // set-cookie 在 WHATWG Headers 里被合并成一条逗号串，必须单独取回多值
  if (typeof response.headers.getSetCookie === 'function') {
    const cookies = response.headers.getSetCookie()
    if (cookies && cookies.length > 0) {
      headers['set-cookie'] = cookies
    }
  }
  proxyRes.headers = headers
  return proxyRes
}

/**
 * 用 wreq-js 发起上游请求
 *
 * @returns {Promise<{proxyRes: import('stream').Readable, proxyReq: object}>}
 */
async function fingerprintRequest (context, req, res) {
  const { rOptions, log, fingerprint } = context
  const wreq = loadWreq()

  const port = rOptions.port || (rOptions.protocol === 'https:' ? 443 : 80)
  const url = `${rOptions.protocol}//${rOptions.hostname}:${port}${rOptions.path}`
  const method = String(rOptions.method || 'GET').toUpperCase()

  // 客户端中途断开时取消上游，避免连接悬挂
  const abort = new AbortController()
  let aborted = false
  const abortUpstream = () => {
    if (!aborted) {
      aborted = true
      try {
        abort.abort()
      } catch { /* ignore */ }
    }
  }
  res.on('close', () => {
    if (!res.writableEnded) {
      abortUpstream()
    }
  })

  const proxyReq = createProxyReqStub(abortUpstream)

  // 请求体：优先用主流程已缓冲的 body（可重试），否则把原始流交给 wreq
  let body
  if (context.retryBody != null) {
    body = context.retryBody
  } else if (method !== 'GET' && method !== 'HEAD') {
    const contentLength = Number.parseInt(req.headers['content-length'], 10)
    if (Number.isFinite(contentLength) && contentLength === 0) {
      body = undefined
    } else if (req.readableEnded) {
      // 流已读完却没有缓冲（超大体）：无法重放，直接报错比发空体更安全
      throw Object.assign(
        new Error(`请求体未被缓冲且已读取完毕，无法用指纹传输发送: ${url}`),
        { status: 411 },
      )
    } else {
      body = Readable.toWeb(req)
    }
  }

  const init = {
    method,
    headers: buildHeaders(rOptions),
    // 代理必须自己把 3xx 交回客户端，不能跟随重定向
    redirect: 'manual',
    // 响应体保持原始压缩字节，Content-Encoding 原样透传（这是「代理转发」的正确姿势）
    compress: false,
    signal: abort.signal,
    browser: fingerprint.browser,
  }
  if (body !== undefined) {
    init.body = body
    // 流式 body 必须声明 half duplex
    init.duplex = 'half'
  }
  if (fingerprint.os) {
    init.os = fingerprint.os
  }
  if (fingerprint.timeout) {
    init.timeout = fingerprint.timeout
  }

  // 把 dev-sidecar 自己的 DNS 结果透传给 wreq，避免被系统 DNS 污染影响
  const resolvedIp = await resolveHostViaDs(rOptions, log)
  if (resolvedIp) {
    init.resolve = { [rOptions.hostname]: resolvedIp }
    res.setHeader('DS-Fingerprint-IP', resolvedIp)
    log.info(`fingerprint: 使用 DS 解析结果 ${rOptions.hostname} ➜ ${resolvedIp}`)
  }

  const start = Date.now()
  let response
  try {
    response = await wreq.fetch(url, init)
  } catch (e) {
    // 网络类错误标记可重试，交给主流程的 retry 机制
    const retryable = !aborted
    const err = new Error(`指纹传输失败【${fingerprint.browser}】${e.code || ''} ${e.message}`.trim())
    err.cause = e
    err.code = e.code
    err.retryable = retryable
    throw err
  }

  const cost = Date.now() - start
  const proxyRes = wrapResponse(response)
  log.info(
    `指纹传输返回: 【${proxyRes.statusCode}】${rOptions.method} ${url}, `
    + `fingerprint: ${fingerprint.browser}, cost: ${cost} ms`,
  )

  return { proxyRes, proxyReq }
}

module.exports = {
  fingerprintRequest,
  // 导出给单元测试/诊断使用
  buildHeaders,
  wrapResponse,
  HOP_BY_HOP,
}
