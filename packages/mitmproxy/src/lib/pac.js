const crypto = require('node:crypto')

/**
 * PAC（Proxy Auto-Config）生成器
 *
 * 目的：让系统代理从「固定代理 + 巨型排除列表」变成「按域名分流」——
 * 命中加速规则的域名走本地代理，其余流量直连，不再依赖 ProxyOverride 黑名单。
 *
 * 规则来源与拦截逻辑保持一致（与服务端实际行为同源）：
 *   PROXY : server.intercepts / server.preSetIpList / server.dns.mapping / server.ech.domains
 *   DIRECT: proxy.excludeIpList / server.whiteList / 本地与内网地址
 *
 * 注意：PAC 由 Windows 的 JScript 引擎执行，只能使用 ES3 语法
 * （var / function / new RegExp / indexOf），不能出现箭头函数、let/const、
 * 命名捕获组 (?<name>)、(?<=) 等现代语法，否则整个脚本解析失败（WinHTTP 12166）。
 */

// 本地与内网地址，永远直连（PAC 自身的地址也在其中，避免自环）
const ALWAYS_DIRECT = [
  'localhost',
  '*.localhost',
  '127.*.*.*',
  '10.*.*.*',
  '172.16.*.*',
  '172.17.*.*',
  '172.18.*.*',
  '172.19.*.*',
  '172.20.*.*',
  '172.21.*.*',
  '172.22.*.*',
  '172.23.*.*',
  '172.24.*.*',
  '172.25.*.*',
  '172.26.*.*',
  '172.27.*.*',
  '172.28.*.*',
  '172.29.*.*',
  '172.30.*.*',
  '172.31.*.*',
  '192.168.*.*',
  '[::1]',
  '::1',
]

/**
 * 把配置里的匹配串转换成 PAC 可用的正则源码。
 *
 * 与 utils/util.match.js 的 domainRegexply 保持同样的语义：
 *   - 以 ^ 开头的视为调用方自己写的正则，原样使用
 *   - 含 * 的按通配符处理（* -> .*）
 *   - 其余按精确域名处理
 *
 * 同时把 JScript 不支持的正则语法降级，避免整份 PAC 解析失败。
 */
function toPacRegex (pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return null
  }
  let source
  if (pattern[0] === '^') {
    source = pattern
  } else if (pattern.indexOf('*') >= 0 || pattern.indexOf('?') >= 0) {
    let source0 = pattern
    let prefix = ''
    // `*.example.com` 必须同时覆盖根域 `example.com`：
    // 浏览器打开 https://example.com/ 时不会命中 `^.*\.example\.com$`，
    // 于是被 PAC 判成 DIRECT 直连 —— 对于被墙的站点就等于直接打不开。
    if (source0.startsWith('*.')) {
      prefix = '(.+\\.)?'
      source0 = source0.slice(2)
    }
    source = '^' + prefix + source0
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.') + '$'
  } else {
    source = '^' + pattern.replace(/\./g, '\\.') + '$'
  }
  // JScript 不支持命名捕获组 (?<name>) 与后行断言 (?<= / (?<!)：
  // 前者降级为普通分组，后者降级为等长占位（语义会变，但至少能编译，
  // 总比整份 PAC 解析失败导致系统代理全挂要好）。
  source = source.replace(/\(\?<[=!]/g, '(?:')
  source = source.replace(/\(\?</g, '(?:')
  return source
}

function addPatterns (target, patterns) {
  if (patterns == null) {
    return
  }
  const keys = Array.isArray(patterns) ? patterns : Object.keys(patterns)
  for (const key of keys) {
    // 值为 false/null 的规则表示显式关闭（服务分组里被关掉的项），不参与匹配
    if (!Array.isArray(patterns)) {
      const value = patterns[key]
      if (value === false || value == null) {
        continue
      }
    }
    const regex = toPacRegex(key)
    if (regex != null) {
      target.push(regex)
    }
  }
}

/**
 * 收集「应该走代理」的匹配串
 *
 * 这些就是「服务分组」页面里启用的服务，加上 ECH 域名：
 *   intercepts / preSetIpList / dns.mapping / dns.ech.domains / dns.nat64.domains
 * 其余域名一律不经过系统代理（PAC 默认 DIRECT），这样本机防火墙规则才能生效。
 */
function collectProxyRules (config) {
  const rules = []
  addPatterns(rules, config.intercepts)
  addPatterns(rules, config.preSetIpList)
  if (config.dns) {
    addPatterns(rules, config.dns.mapping)
    // ECH 需要本地终结 TLS，域名必须走代理；配置在 dns.ech.domains 下
    if (config.dns.ech) {
      addPatterns(rules, config.dns.ech.domains)
    }
    if (config.dns.nat64) {
      addPatterns(rules, config.dns.nat64.domains)
    }
  }
  // 兼容旧结构（早期版本把 ech 放在顶层）
  if (config.ech) {
    addPatterns(rules, config.ech.domains)
  }
  return rules
}

/**
 * 收集「必须直连」的匹配串（优先级高于代理规则）
 */
function collectDirectRules (config) {
  const rules = []
  if (config.proxy) {
    addPatterns(rules, config.proxy.excludeIpList)
  }
  addPatterns(rules, config.whiteList)
  return rules
}

/**
 * 生成本地代理地址
 */
function resolveProxyAddress (config) {
  const host = config.host && config.host !== '0.0.0.0' ? config.host : '127.0.0.1'
  const port = ~~config.port
  if (!port) {
    return null
  }
  return `${host}:${port}`
}

function toJsArray (lines) {
  if (lines.length === 0) {
    return '[]'
  }
  return '[\n    ' + lines.map(s => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',\n    ') + '\n  ]'
}

/**
 * 生成 PAC 脚本正文
 *
 * @param {object} config running.json 里的运行期配置（即 server 配置）
 * @returns {{ content: string, hash: string, proxy: string, proxyCount: number, directCount: number }|null}
 */
function generatePac (config) {
  if (config == null) {
    return null
  }
  const proxy = resolveProxyAddress(config)
  if (proxy == null) {
    return null
  }

  const proxyRules = collectProxyRules(config)
  const directRules = collectDirectRules(config)
  // 本地地址放最前面，确保 PAC 自身与内网请求不会被绕回代理
  const directAll = []
  addPatterns(directAll, ALWAYS_DIRECT)
  for (const item of directRules) {
    if (directAll.indexOf(item) < 0) {
      directAll.push(item)
    }
  }

  const content = `// DevSidecar PAC —— 自动生成，请勿手工修改
// 规则来源：intercepts / preSetIpList / dns.mapping / ech.domains（走代理）
//           excludeIpList / whiteList / 内网地址（直连）
var PROXY = 'PROXY ${proxy}; DIRECT'

var DIRECT_RAW = ${toJsArray(directAll)}

var PROXY_RAW = ${toJsArray(proxyRules)}

var DIRECT_RULES = []
var PROXY_RULES = []

;(function () {
  var i
  for (i = 0; i < DIRECT_RAW.length; i++) {
    try { DIRECT_RULES.push(new RegExp(DIRECT_RAW[i], 'i')) } catch (e) {}
  }
  for (i = 0; i < PROXY_RAW.length; i++) {
    try { PROXY_RULES.push(new RegExp(PROXY_RAW[i], 'i')) } catch (e) {}
  }
})()

function matchAny (rules, host) {
  for (var i = 0; i < rules.length; i++) {
    if (rules[i].test(host)) {
      return true
    }
  }
  return false
}

function FindProxyForURL (url, host) {
  if (host == null || host.length === 0) {
    return 'DIRECT'
  }
  if (matchAny(DIRECT_RULES, host)) {
    return 'DIRECT'
  }
  if (matchAny(PROXY_RULES, host)) {
    return PROXY
  }
  return 'DIRECT'
}
`

  const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 8)
  return {
    content,
    hash,
    proxy,
    proxyCount: proxyRules.length,
    directCount: directAll.length,
  }
}

/**
 * 生成本地 PAC 服务地址（带内容指纹，避免 WinHTTP 按 URL 缓存旧脚本）
 */
function buildPacUrl (config, pacInfo) {
  const host = config.host && config.host !== '0.0.0.0' ? config.host : '127.0.0.1'
  const port = ~~config.port
  if (!port) {
    return null
  }
  const hash = pacInfo != null && pacInfo.hash ? pacInfo.hash : Date.now()
  return `http://${host}:${port}/pac.js?v=${hash}`
}

/**
 * 生成 PAC 请求处理器：代理端口的普通 HTTP 请求先经过它，命中 /pac.js 时直接回 PAC 正文。
 *
 * 兼容两种形态：
 *   - 相对路径  GET /pac.js?v=xxx      （系统/浏览器直连代理端口拉取）
 *   - 绝对 URI  GET http://127.0.0.1:31181/pac.js?v=xxx（经代理链路请求自身）
 *
 * @param {{content: string, hash?: string}|null} pacInfo
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean}
 */
function createPacHandler (pacInfo) {
  const content = pacInfo != null && typeof pacInfo.content === 'string' ? pacInfo.content : null
  const hash = pacInfo != null ? pacInfo.hash : null
  if (content == null) {
    return () => false
  }
  const length = Buffer.byteLength(content)
  return (req, res) => {
    const url = req.url || ''
    if (url.indexOf('/pac.js') < 0) {
      return false
    }
    const pathOnly = url.replace(/^https?:\/\/[^/]+/i, '').split('?')[0]
    if (pathOnly !== '/pac.js') {
      return false
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ns-proxy-autoconfig',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Content-Length': length,
      'X-Pac-Hash': hash || '',
    })
    res.end(content)
    return true
  }
}

module.exports = {
  generatePac,
  buildPacUrl,
  createPacHandler,
  toPacRegex,
  collectProxyRules,
  collectDirectRules,
}
