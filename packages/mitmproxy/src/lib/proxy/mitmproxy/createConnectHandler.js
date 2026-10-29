const net = require('node:net')
const URL = require('node:url')
const jsonApi = require('../../../json')
const log = require('../../../utils/util.log.server')
const DnsUtil = require('../../dns')
const dnsLookup = require('./dnsLookup')
const trafficMonitor = require('../../traffic/TrafficMonitor')
const tlsFragmentUtil = require('../common/tls-fragment')

// 假 TLS 服务器的接入地址（DS 进程内部回环）。
// 注意与「绑定IP」(config.server.host) 区分：后者是代理端口 31181 的监听地址，
// 决定外部谁能连代理；这里是 DS 自己转发 CONNECT 到本地假服务器用的，必须是 loopback。
const localIP = '127.0.0.1'

function isSslConnect (sslConnectInterceptors, req, cltSocket, head) {
  for (const intercept of sslConnectInterceptors) {
    const ret = intercept(req, cltSocket, head)
    log.debug('当前拦截器返回结果：', ret, `, url: ${req.url}, intercept:`, intercept)
    if (ret == null) {
      continue
    }
    return !(ret === false || ret === 'false')
  }
  return false
}

// create connectHandler function
module.exports = function createConnectHandler (sslConnectInterceptor, middlewares, fakeServerCenter, dnsConfig, compatibleConfig, tlsFragment = null) {
  // return
  const sslConnectInterceptors = []
  sslConnectInterceptors.push(sslConnectInterceptor)
  for (const middleware of middlewares) {
    if (middleware.sslConnectInterceptor) {
      sslConnectInterceptors.push(middleware.sslConnectInterceptor)
    }
  }

  return function connectHandler (req, cltSocket, head, ssl) {
    const url = `${ssl ? 'https' : 'http'}://${req.url}`
    // eslint-disable-next-line node/no-deprecated-api
    let { hostname, port } = URL.parse(url)
    port = Number.parseInt(port)

    if (isSslConnect(sslConnectInterceptors, req, cltSocket, head)) {
      // 需要拦截，代替目标服务器，让客户端连接DS在本地启动的代理服务
      // 先关联真实客户端 socket，后续 MITM 请求按客户端端口归属进程
      trafficMonitor.attachConnect(req, cltSocket)
      fakeServerCenter.getServerPromise(hostname, port, ssl, compatibleConfig).then((serverObj) => {
        log.info(`----- fakeServer connect: ${localIP}:${serverObj.port} ➜ ${req.url} -----`)
        const proxySocket = connect(req, cltSocket, head, localIP, serverObj.port, null, false, hostname, null)
        if (proxySocket) {
          const bindInternalMap = () => {
            if (proxySocket.localPort && cltSocket.remotePort) {
              trafficMonitor.mapInternalToClient(proxySocket.localPort, cltSocket.remotePort)
            }
          }
          if (proxySocket.connecting) {
            proxySocket.once('connect', bindInternalMap)
          } else {
            bindInternalMap()
          }
        }
      }, (e) => {
        log.error(`----- fakeServer getServerPromise error: ${hostname}:${port}, error:`, e)
        trafficMonitor.markConnectError(hostname)
      }).catch((e) => {
        log.error(`----- fakeServer getServerPromise error: ${hostname}:${port}, error:`, e)
        trafficMonitor.markConnectError(hostname)
      })
    } else {
      // 【本版本定制】同上：默认不打印完整 headers，只打印 header 名
      if (process.env.DEV_SIDECAR_LOG_DETAIL === 'true') {
        log.info(`不拦截请求，直连目标服务器: ${hostname}:${port}, headers:`, jsonApi.stringify2(req.headers))
      } else {
        log.info(`不拦截请求，直连目标服务器: ${hostname}:${port}, headers:`, Object.keys(req.headers || {}).join(','))
      }
      trafficMonitor.attachConnect(req, cltSocket)
      connect(req, cltSocket, head, hostname, port, dnsConfig, true, null, tlsFragment)
    }
  }
}

function connect (req, cltSocket, head, hostname, port, dnsConfig = null, isDirect = false, target = null, tlsFragment = null) {
  // tunneling https
  // log.info('connect:', hostname, port)
  const start = Date.now()
  const isDnsIntercept = {}
  let hostport = `${hostname}:${port}`

  // 用于记录日志
  const connectInfo = isDirect ? hostport : `fakeServer: ${hostport}, target: ${target}`

  try {
    // 客户端的连接事件监听
    cltSocket.on('timeout', () => {
      log.error(`cltSocket timeout: ${connectInfo}`)
    })
    cltSocket.on('error', (e) => {
      log.error(`cltSocket error:   ${connectInfo}, errorMsg: ${e.message}`)
    })
    // 开发过程中，如有需要可以将此参数临时改为true，打印所有事件的日志
    const printDebugLog = process.env.NODE_ENV === 'development' && false
    if (printDebugLog) {
      cltSocket.on('close', (hadError) => {
        log.debug('【cltSocket close】', hadError)
      })
      cltSocket.on('connect', () => {
        log.debug('【cltSocket connect】')
      })
      cltSocket.on('connectionAttempt', (ip, port, family) => {
        log.debug(`【cltSocket connectionAttempt】${ip}:${port}: ${connectInfo}, family:`, family)
      })
      cltSocket.on('connectionAttemptFailed', (ip, port, family) => {
        log.debug(`【cltSocket connectionAttemptFailed】${ip}:${port}: ${connectInfo}, family:`, family)
      })
      cltSocket.on('connectionAttemptTimeout', (ip, port, family) => {
        log.debug(`【cltSocket connectionAttemptTimeout】${ip}:${port}: ${connectInfo}, family:`, family)
      })
      cltSocket.on('data', (_data) => {
        log.debug(`【cltSocket data】${connectInfo}`)
      })
      cltSocket.on('drain', () => {
        log.debug(`【cltSocket drain】${connectInfo}`)
      })
      cltSocket.on('end', () => {
        log.debug(`【cltSocket end】${connectInfo}`)
      })
      // cltSocket.on('lookup', (err, address, family, host) => {
      // })
      cltSocket.on('ready', () => {
        log.debug(`【cltSocket ready】${connectInfo}`)
      })
    }

    // ---------------------------------------------------------------------------------------------------

    const options = {
      port,
      host: hostname,
      connectTimeout: 10000,
      // 【定制版】Happy Eyeballs（RFC 8305）：同一域名有多个地址时并行拨号，
      // 250ms 阶梓起下一个，先连通者胜；坏 IP 不再拖到 connect 超时。
      // 配合 dnsLookup.js 的 all 模式回传全部候选地址生效（Node 20+）。
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
    }
    if (dnsConfig && dnsConfig.dnsMap) {
      const dnsAndFamily = DnsUtil.getDNSAndFamily(dnsConfig, hostname)
      if (dnsAndFamily) {
        options.lookup = dnsLookup.createLookupFunc(null, dnsAndFamily, 'connect', hostport, port, isDnsIntercept)
        if (dnsAndFamily.family === 6) {
          options.family = 6
          hostport += '(IPv6)'
        }
      }
    }

    // 【定制版】并行拨号（autoSelectFamily）下，Node 会逐个尝试多个地址并回报每个地址的成败。
    // 按「实际尝试失败的地址」计数，避免一次失败把整个域名的首选地址拉黑。
    let perAttemptReported = false
    const countAttemptFailure = (ip, reason) => {
      if (!isDnsIntercept || !isDnsIntercept.dns || ip == null || ip === hostname) {
        return
      }
      perAttemptReported = true
      isDnsIntercept.dns.count(hostname, ip, true)
      log.error(`记录ip失败次数（并行拨号）: hostname: ${hostname}, ip: ${ip}, reason: ${reason}, dns: ${isDnsIntercept.dns.dnsName}`)
    }

    // 代理连接事件监听
    const proxySocket = net.connect(options, () => {
      if (!isDirect) {
        log.info(`Proxy connect start: ${hostport}`)
      } else {
        log.debug('Direct connect start:', hostport)
      }

      cltSocket.write('HTTP/1.1 200 Connection Established\r\n'
        + 'Proxy-agent: dev-sidecar\r\n'
        + '\r\n')
      proxySocket.pipe(cltSocket)

      // 【本版本定制】TLS ClientHello 分段发送，绕过按 SNI 做 DPI 的封锁。
      // 只对 server.tlsFragment.domains 里声明的域名生效；不命中时走原生 pipe，零额外开销。
      // 作用域仅限 CONNECT 纯隧道（MITM 场景下 ClientHello 由 DS 自己发起，不经过这里）。
      const fragOpt = tlsFragment ? tlsFragmentUtil.getFragmentOption({ tlsFragment }, hostname) : null
      if (fragOpt) {
        log.debug(`[TLS分片] 命中 ${hostname}，首包按 ${fragOpt.size}B 分段`)
        tlsFragmentUtil.createFragmentForwarder({
          source: cltSocket,
          target: proxySocket,
          head,
          size: fragOpt.size,
          maxBytes: fragOpt.maxBytes,
          log,
        })
      } else {
        proxySocket.write(head)
        cltSocket.pipe(proxySocket)
      }
    })
    proxySocket.on('connectionAttemptFailed', (ip) => countAttemptFailure(ip, 'connectionAttemptFailed'))
    proxySocket.on('connectionAttemptTimeout', (ip) => countAttemptFailure(ip, 'connectionAttemptTimeout'))
    proxySocket.on('timeout', () => {
      const cost = Date.now() - start
      const errorMsg = `${isDirect ? '直连' : '代理连接'}超时: ${hostport}, cost: ${cost} ms`
      log.error(errorMsg)

      cltSocket.write('HTTP/1.1 408 Proxy connect timeout\r\n'
        + 'Proxy-agent: dev-sidecar\r\n'
        + '\r\n')
      cltSocket.end()
      cltSocket.destroy()

      if (!perAttemptReported && isDnsIntercept && isDnsIntercept.dns && isDnsIntercept.ip !== isDnsIntercept.hostname) {
        const { dns, ip, hostname } = isDnsIntercept
        dns.count(hostname, ip, true)
        log.error(`记录ip失败次数，用于优选ip！ hostname: ${hostname}, ip: ${ip}, reason: ${errorMsg}, dns: ${dns.dnsName}`)
      }
    })
    proxySocket.on('error', (e) => {
      // 连接失败，可能被GFW拦截，或者服务端拥挤
      const cost = Date.now() - start
      const errorMsg = `${isDirect ? '直连' : '代理连接'}失败: ${hostport}, cost: ${cost} ms, errorMsg: ${e.message}`
      log.error(`${errorMsg}\r\n`, e)

      cltSocket.write(`HTTP/1.1 400 Proxy connect error: ${e.message}\r\n`
        + 'Proxy-agent: dev-sidecar\r\n'
        + '\r\n')
      cltSocket.end()
      cltSocket.destroy()

      if (!perAttemptReported && isDnsIntercept && isDnsIntercept.dns && isDnsIntercept.ip !== isDnsIntercept.hostname) {
        const { dns, ip, hostname } = isDnsIntercept
        dns.count(hostname, ip, true)
        log.error(`记录ip失败次数，用于优选ip！ hostname: ${hostname}, ip: ${ip}, reason: ${errorMsg}, dns: ${dns.dnsName}`)
      }
    })

    if (printDebugLog) {
      proxySocket.on('close', (hadError) => {
        log.debug('【proxySocket close】', hadError)
      })
      proxySocket.on('connect', () => {
        log.debug('【proxySocket connect】')
      })
      proxySocket.on('connectionAttempt', (ip, port, family) => {
        log.debug(`【proxySocket connectionAttempt】${ip}:${port}, family:`, family)
      })
      proxySocket.on('connectionAttemptFailed', (ip, port, family) => {
        log.debug(`【proxySocket connectionAttemptFailed】${ip}:${port}, family:`, family)
      })
      proxySocket.on('connectionAttemptTimeout', (ip, port, family) => {
        log.debug(`【proxySocket connectionAttemptTimeout】${ip}:${port}, family:`, family)
      })
      proxySocket.on('data', (_data) => {
        log.debug('【proxySocket data】')
      })
      proxySocket.on('drain', () => {
        log.debug('【proxySocket drain】')
      })
      proxySocket.on('end', () => {
        log.debug('【proxySocket end】')
      })
      // proxySocket.on('lookup', (err, address, family, host) => {
      // })
      proxySocket.on('ready', () => {
        log.debug('【proxySocket ready】')
      })
    }

    return proxySocket
  } catch (e) {
    log.error(`${isDirect ? '直连' : '代理连接'}错误: ${hostport}, error:`, e)
  }
}
