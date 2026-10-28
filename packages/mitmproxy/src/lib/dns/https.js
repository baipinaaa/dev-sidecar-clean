const { promisify } = require('node:util')
const http = require('node:http')
const https = require('node:https')
const { Buffer } = require('node:buffer')
const doh = require('dns-over-http')
const svcbUtil = require('./util.svcb')
const log = require('../../utils/util.log.server')
const BaseDNS = require('./base')
const HttpsAgent = require('../proxy/common/ProxyHttpsAgent')
const Agent = require('../proxy/common/ProxyHttpAgent')

const dohQueryAsync = promisify(doh.query)

/**
 * 【定制版新增】DoH 请求必须带 User-Agent。
 *
 * 实测：托管在 Cloudflare 上的 DoH 端点（cloudflare-dns.com、各类自建 Total-ECH 端点等）
 * 对没有 User-Agent 的请求一律返回 403（Cloudflare WAF 拦截空 UA），带任意 UA 即正常返回 200。
 * 而本客户端原先只发 content-type/accept/content-length，导致这类端点全部失效——
 * 这也是「ECH 已开启但完全不生效」的直接原因之一。
 */
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 【定制版新增】DoH 请求重试次数。
 * 实测目标 TLS 握手约 60%~70% 会被中间链路 RST（间歇性干扰），
 * 且 keepAlive 连接被 RST 后复用必定失败，因此失败后需换新连接重试。
 */
const DOH_MAX_ATTEMPTS = 4

function createAgent (dnsServer) {
  return new (dnsServer.startsWith('https:') ? HttpsAgent : Agent)({
    keepAlive: true,
    timeout: 4000,
  })
}

/**
 * 发送一个DoH请求，返回响应体
 */
function request (dnsServer, options, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(dnsServer)
    const transport = url.protocol === 'http:' ? http : https

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

    const req = transport.request(dnsServer, options, (res) => {
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

    if (body != null) {
      req.write(body)
    }
    req.end()
  })
}

module.exports = class DNSOverHTTPS extends BaseDNS {
  constructor (dnsName, cacheSize, preSetIpList, dnsServer, dnsFamily, dnsServerName) {
    super(dnsServer.replace(/\s+/, ''), dnsFamily, dnsName, 'HTTPS', cacheSize, preSetIpList)
    this.dnsServerName = dnsServerName
    this.agent = createAgent(this.dnsServer)
  }

  _requestOptions (extraHeaders, timeout, freshSocket) {
    // 请求参数
    const headers = { 'user-agent': DEFAULT_USER_AGENT, ...(extraHeaders || {}) }
    const options = {
      // freshSocket: 上一次尝试失败（连接被 RST）时不复用 keepAlive 连接，改用一次性新连接
      agent: freshSocket ? false : this.agent,
      timeout,
      headers,
    }
    if (this.dnsServerName) {
      // 设置SNI
      options.servername = this.dnsServerName
      options.rejectUnauthorized = false
    }
    if (this.dnsFamily === 6) {
      options.family = 6
    }
    return options
  }

  /**
   * 查询 HTTPS(65)/SVCB(64) 记录，用于获取 DNS 下发的 ECH 参数
   *
   * 优先使用 RFC 8484 的 wire format（POST + application/dns-message）；
   * 部分DoH服务不支持该格式（或只支持JSON接口），则回退到 JSON 接口
   */
  async _svcbQueryPromise (hostname, type = 'HTTPS') {
    const timeout = 5000
    let lastError = null
    for (let attempt = 0; attempt < DOH_MAX_ATTEMPTS; attempt++) {
      try {
        return await this._svcbQueryByWireFormat(hostname, type, timeout, attempt > 0)
      } catch (e) {
        lastError = e
        if (attempt < DOH_MAX_ATTEMPTS - 1) {
          log.debug(`[DNS-over-HTTPS '${this.dnsName}'] 第 ${attempt + 1} 次查询HTTPS记录失败，重试: ${hostname}, error: ${e.message}`)
        }
      }
    }
    log.debug(`[DNS-over-HTTPS '${this.dnsName}'] wire format 查询HTTPS记录失败，改用JSON接口: ${hostname}, error: ${lastError && lastError.message}`)
    return await this._svcbQueryByJson(hostname, type, timeout)
  }

  async _svcbQueryByWireFormat (hostname, type, timeout, freshSocket) {
    const body = svcbUtil.encodeQuery(hostname, { type: svcbUtil.typeCode(type) })
    const headers = {
      'content-type': 'application/dns-message',
      'accept': 'application/dns-message',
      'content-length': body.length,
    }

    const res = await request(this.dnsServer, this._requestOptions(headers, timeout, freshSocket), body)
    if (res.statusCode !== 200) {
      throw new Error(`DoH服务返回状态码 ${res.statusCode}`)
    }

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
      'accept': 'application/dns-json',
    }

    const res = await request(url.href, this._requestOptions(headers, timeout))
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

  _dnsQueryPromise (hostname, type = 'A') {
    // 请求参数
    const options = {
      url: this.dnsServer,
      agent: this.agent,
      // 【定制版新增】同 _requestOptions：不带 User-Agent 会被 Cloudflare 托管的 DoH 端点 403
      headers: { 'user-agent': DEFAULT_USER_AGENT },
    }
    if (this.dnsServerName) {
      // 设置SNI
      options.servername = this.dnsServerName
      options.rejectUnauthorized = false
    }
    if (this.dnsFamily === 6) {
      options.family = 6
    }

    // DNS查询参数
    const questions = [
      {
        type,
        name: hostname,
      },
    ]

    return dohQueryAsync(options, questions)
  }
}
