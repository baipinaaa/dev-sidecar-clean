const http2 = require('node:http2')
const http = require('node:http')
const https = require('node:https')
const { Buffer } = require('node:buffer')
const svcbUtil = require('./util.svcb')
const log = require('../../utils/util.log.server')
const BaseDNS = require('./base')
const HttpsAgent = require('../proxy/common/ProxyHttpsAgent')
const Agent = require('../proxy/common/ProxyHttpAgent')

/**
 * ============================================================================
 * DoH 客户端实现，逐项对齐 Chromium 的 net/dns/dns_http_attempt.cc
 * ============================================================================
 *
 * 参照 Chromium 的实现维度（net/dns/dns_http_attempt.cc）：
 *
 *   1. 传输层     URLRequest → HttpNetworkTransaction，ALPN 协商 h2
 *                 → 本实现优先使用 node:http2，失败回退 HTTP/1.1
 *
 *   2. 请求方式   支持 GET( ?dns=<base64url>，OMIT_PADDING ) 与 POST
 *                 → 本实现按 GET/POST 轮换尝试
 *
 *   3. 请求头     只有 4 个：
 *                   Accept:           application/dns-message
 *                   Accept-Language:  *
 *                   User-Agent:       Chrome
 *                   Accept-Encoding:  identity
 *                 POST 额外加 Content-Type / Content-Length
 *
 *   4. 系统代理   LOAD_BYPASS_PROXY —— DoH 查询永远直连，不走代理
 *                 → 本实现直连优先，仅在直连全部失败后兜底走本地代理
 *
 *   5. 连接池     GetDohIsolationInfo() —— 独立隔离分区，不与网页共享连接
 *                 → 本实现每个 DNSOverHTTPS 实例独占自己的 h2 会话池与 agent
 *
 *   6. 失败处理   连接被 RST 后必须换新连接重试（不能复用死连接）
 *                 → 本实现失败即销毁该 origin 的 h2 会话，重试用新连接
 *
 *   7. 证书校验   Chromium 正常校验；仅在用户显式配置了 SNI 伪装时无法校验
 *                 （SNI 与证书域名不一致，必然校验失败）
 *
 *   8. Bootstrap  SecureDnsPolicy::kBootstrap —— DoH 服务器域名解析单独处理
 *                 → 本实现直连失败时兜底走本地代理，避免「DoH 服务器自己被污染」死锁
 * ============================================================================
 */

// ---- Chromium 的固定请求头（net/dns/dns_http_attempt.cc:116-122）----
const DOH_USER_AGENT = 'Chrome'
const DOH_ACCEPT_LANGUAGE = '*'
const DOH_ACCEPT_ENCODING = 'identity'

const DOH_CONTENT_TYPE = 'application/dns-message'
/**
 * 整套策略（h2 GET / h2 POST / h1 GET / h1 POST）重复轮数。
 * 实测 RST 是间歇性干扰，单轮成功率约 60%~90%，第二轮可把成功率拉到接近 100%。
 */
const DOH_MAX_ROUNDS = 2
const H2_IDLE_TIMEOUT = 30000

/** DNS 类型码 */
const TYPE_A = 1
const TYPE_AAAA = 28

function createAgent (dnsServer) {
  return new (dnsServer.startsWith('https:') ? HttpsAgent : Agent)({
    keepAlive: true,
    timeout: 4000,
  })
}

/** base64url 编码（RFC 4648 §5，去掉尾部 = 填充，对齐 base::Base64UrlEncodePolicy::OMIT_PADDING） */
function base64UrlEncode (buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** IPv4 rdata → 点分字符串 */
function formatIPv4 (buf) {
  return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`
}

/** IPv6 rdata → 压缩形式字符串（RFC 5952） */
function formatIPv6 (buf) {
  const parts = []
  for (let i = 0; i < 16; i += 2) {
    parts.push(buf.readUInt16BE(i).toString(16))
  }
  let bestStart = -1
  let bestLen = 0
  let curStart = -1
  let curLen = 0
  for (let i = 0; i < 8; i++) {
    if (parts[i] === '0') {
      if (curStart < 0) {
        curStart = i
        curLen = 1
      } else {
        curLen++
      }
    } else {
      if (curLen > bestLen) {
        bestStart = curStart
        bestLen = curLen
      }
      curStart = -1
      curLen = 0
    }
  }
  if (curLen > bestLen) {
    bestStart = curStart
    bestLen = curLen
  }
  if (bestLen < 2) {
    return parts.join(':')
  }
  return `${parts.slice(0, bestStart).join(':')}::${parts.slice(bestStart + bestLen).join(':')}`
}

module.exports = class DNSOverHTTPS extends BaseDNS {
  constructor (dnsName, cacheSize, preSetIpList, dnsServer, dnsFamily, dnsServerName) {
    super(dnsServer.replace(/\s+/, ''), dnsFamily, dnsName, 'HTTPS', cacheSize, preSetIpList)
    this.dnsServerName = dnsServerName
    this.agent = createAgent(this.dnsServer)

    this.dnsServerUrl = new URL(this.dnsServer)
    /** origin → http2.ClientHttp2Session（本实例独占，不与网页共享） */
    this.h2Sessions = new Map()
  }

  // ---------------------------------------------------------------------------
  // HTTP/2 会话管理
  // ---------------------------------------------------------------------------

  _h2Key () {
    return `${this.dnsServerUrl.origin}|family=${this.dnsFamily || 0}`
  }

  /**
   * 复用或新建 h2 会话。
   * 会话被 RST / GOAWAY / 出错时立即从池中移除，下次自动新建。
   */
  _getH2Session () {
    const key = this._h2Key()
    let session = this.h2Sessions.get(key)
    if (session && !session.closed && !session.destroyed) {
      return session
    }

    const options = {
      // 对齐 Chromium：DoH 请求强制直连，不经任何代理，因此这里也让 http2 走默认直连
      ALPNProtocols: ['h2'],
      // Chromium 对 DoH 服务器做正常的证书校验；只有用户显式配了 SNI 伪装时才无法校验
      rejectUnauthorized: !this.dnsServerName,
      timeout: H2_IDLE_TIMEOUT,
    }
    if (this.dnsServerName) {
      options.servername = this.dnsServerName
    }
    if (this.dnsFamily === 6) {
      options.family = 6
    }

    try {
      session = http2.connect(this.dnsServerUrl.origin, options)
    } catch (e) {
      log.debug(`[DNS-over-HTTPS '${this.dnsName}'] 建立HTTP/2会话失败: ${e.message}`)
      return null
    }

    const drop = (reason) => {
      if (this.h2Sessions.get(key) === session) {
        this.h2Sessions.delete(key)
      }
      if (reason) {
        log.debug(`[DNS-over-HTTPS '${this.dnsName}'] 销毁HTTP/2会话: ${reason}`)
      }
    }

    session.on('error', e => drop(e.message))
    session.on('close', () => drop())
    session.on('goaway', () => drop('goaway'))
    session.on('timeout', () => {
      drop('空闲超时')
      session.close()
    })
    // 不要因为一个挂起的 h2 会话阻断进程退出
    if (typeof session.unref === 'function') {
      session.unref()
    }

    this.h2Sessions.set(key, session)
    return session
  }

  _destroyH2 (reason) {
    const key = this._h2Key()
    const session = this.h2Sessions.get(key)
    this.h2Sessions.delete(key)
    if (session && !session.destroyed) {
      try {
        session.destroy()
      } catch (e) {
        // ignore
      }
    }
    if (reason) {
      log.debug(`[DNS-over-HTTPS '${this.dnsName}'] 主动销毁HTTP/2会话: ${reason}`)
    }
  }

  // ---------------------------------------------------------------------------
  // 底层传输：h2 / h1
  // ---------------------------------------------------------------------------

  /**
   * 通过 HTTP/2 发送一个请求
   * @param {boolean} useGet true=GET(?dns=base64url)，false=POST
   */
  _sendH2 (method, path, body, timeout) {
    return new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      const finish = (err, value) => {
        if (settled) {
          return
        }
        settled = true
        if (timer) {
          clearTimeout(timer)
        }
        if (err) {
          reject(err)
        } else {
          resolve(value)
        }
      }

      const session = this._getH2Session()
      if (session == null) {
        return finish(new Error('HTTP/2 会话不可用'))
      }

      timer = setTimeout(() => {
        this._destroyH2('请求超时')
        finish(new Error('DNS查询超时'))
      }, timeout)

      // 对齐 Chromium 的 4 个固定请求头
      const headers = {
        ':method': method,
        ':path': path,
        accept: DOH_CONTENT_TYPE,
        'accept-language': DOH_ACCEPT_LANGUAGE,
        'user-agent': DOH_USER_AGENT,
        'accept-encoding': DOH_ACCEPT_ENCODING,
      }
      if (method === 'POST') {
        headers['content-type'] = DOH_CONTENT_TYPE
        headers['content-length'] = String(body.length)
      }

      let req
      try {
        req = session.request(headers)
      } catch (e) {
        this._destroyH2('发起请求异常')
        return finish(e)
      }

      const chunks = []
      let statusCode = 0
      let resHeaders = {}

      req.on('response', (h) => {
        statusCode = Number(h[':status'])
        resHeaders = h
      })
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const out = {
          statusCode,
          headers: resHeaders,
          body: Buffer.concat(chunks),
        }
        // 记录本次成功使用，刷新空闲计时
        if (typeof session.setTimeout === 'function' && !session.closed) {
          session.setTimeout(H2_IDLE_TIMEOUT)
        }
        finish(null, out)
      })
      req.on('aborted', () => {
        this._destroyH2('请求被中止')
        finish(new Error('请求被中止'))
      })
      req.on('error', (e) => {
        this._destroyH2(`流错误: ${e.message}`)
        finish(e)
      })

      if (method === 'POST' && body != null) {
        req.write(body)
      }
      req.end()
    })
  }

  /**
   * 通过 HTTP/1.1 发送一个请求（h2 不可用时的回退）
   * @param {boolean} useProxy true=走本地代理（Bootstrap 兜底），false=直连
   */
  _sendH1 (method, path, body, timeout, useProxy) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.dnsServer)
      url.pathname = path.split('?')[0]
      url.search = path.includes('?') ? `?${path.split('?')[1]}` : ''

      const transport = url.protocol === 'http:' ? http : https

      const headers = {
        accept: DOH_CONTENT_TYPE,
        'accept-language': DOH_ACCEPT_LANGUAGE,
        'user-agent': DOH_USER_AGENT,
        'accept-encoding': DOH_ACCEPT_ENCODING,
      }
      if (method === 'POST') {
        headers['content-type'] = DOH_CONTENT_TYPE
        headers['content-length'] = String(body.length)
      }

      const options = {
        method,
        headers,
        // 直连时用一次性连接（对齐「不复用死连接」策略）；兜底时走本地代理 agent
        agent: useProxy ? this.agent : false,
        timeout,
      }
      if (this.dnsServerName) {
        options.servername = this.dnsServerName
        options.rejectUnauthorized = false
      }
      if (this.dnsFamily === 6) {
        options.family = 6
      }

      let isOver = false
      const finish = (err, value) => {
        if (isOver) {
          return
        }
        isOver = true
        if (err) {
          reject(err)
        } else {
          resolve(value)
        }
      }

      const req = transport.request(url.href, options, (res) => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          finish(null, {
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
        res.on('error', finish)
      })

      req.on('error', finish)
      req.on('timeout', () => {
        req.destroy(new Error('DNS查询超时'))
      })

      if (method === 'POST' && body != null) {
        req.write(body)
      }
      req.end()
    })
  }

  /**
   * 统一的 wire format 请求入口。
   *
   * 尝试顺序（对齐 Chromium 的直连优先 + GET/POST 双支持 + 换新连接重试）：
   *   1. h2 + GET  + 直连
   *   2. h2 + POST + 直连
   *   3. h1 + GET  + 直连（新连接）
   *   4. h1 + POST + 代理（Bootstrap 兜底：DoH 服务器域名本身被污染时）
   *
   * 整套策略会跑 DOH_MAX_ROUNDS 轮（实测 RST 是间歇性的，单轮成功率约 60%~90%），
   * 每轮失败都会销毁 h2 会话，保证下一轮使用全新连接。
   */
  async _wireFormatRequest (body, timeout) {
    const path = this.dnsServerUrl.pathname || '/'
    const getPath = `${path}?dns=${base64UrlEncode(body)}`

    const strategies = [
      { name: 'h2 GET 直连', proto: 'h2', method: 'GET', path: getPath, useProxy: false },
      { name: 'h2 POST 直连', proto: 'h2', method: 'POST', path, useProxy: false },
      { name: 'h1 GET 直连', proto: 'h1', method: 'GET', path: getPath, useProxy: false },
      { name: 'h1 POST 代理', proto: 'h1', method: 'POST', path, useProxy: true },
    ]

    // 总时间预算：避免所有策略都卡超时堆积成几十秒等待
    const deadline = Date.now() + Math.max(timeout * DOH_MAX_ROUNDS, 12000)

    let lastError = null
    for (let round = 0; round < DOH_MAX_ROUNDS; round++) {
      for (let i = 0; i < strategies.length; i++) {
        if (Date.now() >= deadline) {
          break
        }
        const s = strategies[i]
        try {
          const res = s.proto === 'h2'
            ? await this._sendH2(s.method, s.path, body, timeout)
            : await this._sendH1(s.method, s.path, body, timeout, s.useProxy)

          if (res.statusCode !== 200) {
            throw new Error(`DoH服务返回状态码 ${res.statusCode}`)
          }
          // 某些服务（如自建 Worker）不支持 GET，会返回一段普通文本而不是 DNS 报文。
          // 这里做一次格式校验，不合法就继续尝试下一种策略（通常是 POST）。
          const ct = String(res.headers['content-type'] || '')
          const bodyOk = ct.includes('dns-message') || ct.includes('json') ||
            (res.body && res.body.length >= 12)
          if (!bodyOk) {
            throw new Error(`DoH服务返回了非DNS内容(${ct || '无content-type'}, ${res.body ? res.body.length : 0}B)`)
          }
          return res
        } catch (e) {
          lastError = e
          // 失败后立刻丢弃连接，确保下一策略是全新连接
          if (s.proto === 'h2') {
            this._destroyH2(`策略[${s.name}]失败`)
          }
          if (!(i === strategies.length - 1 && round === DOH_MAX_ROUNDS - 1)) {
            log.debug(`[DNS-over-HTTPS '${this.dnsName}'] 策略[${s.name}]失败(第${round + 1}轮)，尝试下一种: ${e.message}`)
          }
        }
      }
      if (Date.now() >= deadline) {
        break
      }
    }
    throw lastError || new Error('DoH 请求失败')
  }

  // ---------------------------------------------------------------------------
  // 记录解码
  // ---------------------------------------------------------------------------

  /**
   * 为 A / AAAA 记录补上点分/冒号分形式的 IP 字符串，
   * 上层（base.js:447）依赖 `answers[].type` 是 'A' / 'AAAA' 且 `answers[].data` 是 IP 字符串。
   *
   * 注意：util.svcb 的 typeName() 不认 A/AAAA，会返回 '1' / '28'，必须在此纠正。
   */
  _fillAddressData (response) {
    for (const record of response.answers || []) {
      if (record.typeCode === TYPE_A) {
        record.type = 'A'
        if (record.data == null && record.raw && record.raw.length === 4) {
          record.data = formatIPv4(record.raw)
        }
      } else if (record.typeCode === TYPE_AAAA) {
        record.type = 'AAAA'
        if (record.data == null && record.raw && record.raw.length === 16) {
          record.data = formatIPv6(record.raw)
        }
      }
    }
    return response
  }

  // ---------------------------------------------------------------------------
  // HTTPS(65) / SVCB(64) 查询（用于取 ECH 参数）
  // ---------------------------------------------------------------------------

  /**
   * 查询 HTTPS(65)/SVCB(64) 记录，用于获取 DNS 下发的 ECH 参数
   *
   * 优先使用 RFC 8484 的 wire format；部分 DoH 服务不支持该格式（或只支持 JSON 接口），
   * 则回退到 JSON 接口
   */
  async _svcbQueryPromise (hostname, type = 'HTTPS') {
    const timeout = 5000
    let wireError = null
    try {
      return await this._svcbQueryByWireFormat(hostname, type, timeout)
    } catch (e) {
      wireError = e
      log.debug(`[DNS-over-HTTPS '${this.dnsName}'] wire format 查询HTTPS记录失败，改用JSON接口: ${hostname}, error: ${e.message}`)
    }
    try {
      return await this._svcbQueryByJson(hostname, type, timeout)
    } catch (e) {
      // JSON 接口也不可用时，抛出更有参考价值的 wire format 错误
      throw wireError || e
    }
  }

  async _svcbQueryByWireFormat (hostname, type, timeout) {
    const body = svcbUtil.encodeQuery(hostname, { type: svcbUtil.typeCode(type) })
    const res = await this._wireFormatRequest(body, timeout)

    const contentType = String(res.headers['content-type'] || '')
    if (contentType.includes('json')) {
      return this._parseJsonResponse(hostname, res.body)
    }

    const response = svcbUtil.parseResponse(res.body)
    if (response.truncated) {
      throw new Error('DNS响应被截断(TC)')
    }
    return response
  }

  async _svcbQueryByJson (hostname, type, timeout) {
    const url = new URL(this.dnsServer)
    url.searchParams.set('name', hostname)
    url.searchParams.set('type', type === 'SVCB' ? 'SVCB' : 'HTTPS')

    const headers = {
      accept: 'application/dns-json',
    }

    const res = await this._sendH1('GET', `${url.pathname}${url.search}`, null, timeout, false)
    if (res.statusCode !== 200) {
      throw new Error(`DoH服务返回状态码 ${res.statusCode}`)
    }
    return this._parseJsonResponse(hostname, res.body)
  }

  /**
   * 解析 DoH 的 JSON 接口返回内容（RFC 8427），把展示格式的 data 转换成与 wire format 一致的结构
   */
  _parseJsonResponse (hostname, body) {
    let json
    try {
      json = JSON.parse(body.toString('utf8'))
    } catch (e) {
      throw new Error(`DoH服务返回的内容不是合法的JSON: ${e.message}`)
    }

    if (json.Status != null && Number(json.Status) !== 0) {
      throw new Error(`DoH服务返回错误状态: ${json.Status}`)
    }

    const answers = []
    for (const answer of json.Answer || []) {
      if (answer.type === TYPE_A || answer.type === TYPE_AAAA) {
        answers.push({
          name: answer.name,
          type: svcbUtil.typeName(answer.type),
          typeCode: answer.type,
          ttl: answer.TTL,
          data: answer.data,
        })
        continue
      }
      if (answer.type !== svcbUtil.TYPE_HTTPS && answer.type !== svcbUtil.TYPE_SVCB) {
        continue
      }
      const data = svcbUtil.parsePresentation(answer.data)
      answers.push({
        name: answer.name,
        type: svcbUtil.typeName(answer.type),
        typeCode: answer.type,
        ttl: answer.TTL,
        data,
      })
    }

    return {
      rcode: 0,
      truncated: json.TC === true,
      questions: [{ name: hostname, type: 'HTTPS' }],
      answers,
    }
  }

  // ---------------------------------------------------------------------------
  // A / AAAA 查询
  // ---------------------------------------------------------------------------

  /**
   * 查询 A / AAAA 记录。
   *
   * 返回值结构需与上层 `packages/mitmproxy/src/lib/dns/base.js:447` 兼容：
   *   response.answers.filter(item => item.type === 'A').map(item => item.data)
   */
  async _dnsQueryPromise (hostname, type = 'A') {
    const timeout = 5000

    let wireError = null
    try {
      const body = svcbUtil.encodeQuery(hostname, { type: type === 'AAAA' ? TYPE_AAAA : TYPE_A })
      const res = await this._wireFormatRequest(body, timeout)

      const contentType = String(res.headers['content-type'] || '')
      if (contentType.includes('json')) {
        return this._parseJsonResponse(hostname, res.body)
      }

      const response = svcbUtil.parseResponse(res.body)
      if (response.truncated) {
        throw new Error('DNS响应被截断(TC)')
      }
      if (response.rcode !== 0) {
        throw new Error(`DoH服务返回错误码 ${response.rcode}`)
      }
      return this._fillAddressData(response)
    } catch (e) {
      wireError = e
      log.debug(`[DNS-over-HTTPS '${this.dnsName}'] wire format 查询${type}记录失败，改用JSON接口: ${hostname}, error: ${e.message}`)
    }

    // wire format 全部策略失败 → JSON 接口兜底
    const url = new URL(this.dnsServer)
    url.searchParams.set('name', hostname)
    url.searchParams.set('type', type)
    try {
      const res = await this._sendH1('GET', `${url.pathname}${url.search}`, null, timeout, true)
      if (res.statusCode !== 200) {
        throw new Error(`DoH服务返回状态码 ${res.statusCode}`)
      }
      return this._parseJsonResponse(hostname, res.body)
    } catch (e) {
      throw wireError || e
    }
  }
}
