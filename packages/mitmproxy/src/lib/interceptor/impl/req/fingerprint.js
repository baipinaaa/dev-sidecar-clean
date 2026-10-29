/**
 * TLS 指纹伪装拦截器（增量方案，默认零影响）
 *
 * 背景：dev-sidecar 的上游请求走 Node 原生 `http/https.request`，TLS 握手用的是
 * Node 自带的 OpenSSL，ClientHello 指纹（JA3/JA4）与任何真实浏览器都不同。部分站点
 * 会按指纹直接 RST（实测 pixiv 等被墙站点上，curl、node 均被 RST，而浏览器能过）。
 *
 * 本拦截器引入 wreq-js（Rust + BoringSSL，进程内 native，无子进程）作为可选的传输层，
 * 把 ClientHello 伪装成指定浏览器。只有在规则里显式写了 `fingerprint` 时才接管，
 * 未配置的域名完全不受影响。
 *
 * 配置示例（packages/core/src/config/index.js 的 server.intercepts 里）：
 *   'pixiv.net': { '.*': { fingerprint: 'chrome_149' } }
 * 可选字段：
 *   - fingerprint: 浏览器档位名，见 wreq-js 的 getProfiles()（chrome_100 ~ chrome_149、
 *                  firefox_* / safari_* / edge_* / opera_* / okhttp_* 等 133 个）
 *   - fingerprintOs: 伪装的操作系统（windows / macos / linux / android / ios），
 *                    不填则跟随档位默认值
 *   - fingerprintTimeout: 上游超时毫秒数，默认 30000
 *
 * 注意：
 *   - 本拦截器会**接管整个请求**，因此与 sni / unVerifySsl / ech / proxy 等改写
 *     rOptions 的规则同时配置时，只有 fingerprint 生效（其余拦截器改的 rOptions
 *     不会被 wreq 使用）。需要 SNI 伪装时请改用 fingerprint 本身。
 *   - 走 wreq 的请求不经过 dev-sidecar 的 DNS 模块（wreq 内部自己解析域名），
 *     所以 dns.mapping / preSetIpList 对它们无效。
 */
module.exports = {
  name: 'fingerprint',
  // 比 sni(123) / unVerifySsl(124) / proxy(121) 都早，先标记「本次请求交给 wreq」
  priority: 118,
  requestIntercept (context, interceptOpt, req, res, ssl, next) {
    const { rOptions, log } = context

    const browser = typeof interceptOpt.fingerprint === 'string'
      ? interceptOpt.fingerprint.trim()
      : ''

    if (!browser) {
      log.warn(`fingerprint intercept: 配置了 fingerprint 但值为空，已跳过: ${rOptions.hostname}`)
      return true
    }

    context.fingerprint = {
      browser,
      os: typeof interceptOpt.fingerprintOs === 'string' && interceptOpt.fingerprintOs.trim()
        ? interceptOpt.fingerprintOs.trim()
        : undefined,
      timeout: Number.isFinite(interceptOpt.fingerprintTimeout) && interceptOpt.fingerprintTimeout > 0
        ? interceptOpt.fingerprintTimeout
        : undefined,
    }

    res.setHeader('DS-Interceptor', `fingerprint: ${browser}`)
    log.info(`fingerprint intercept: 上游请求改用 ${browser} 指纹: ${rOptions.hostname}${rOptions.path}`)
    return true
  },
  is (interceptOpt) {
    return interceptOpt.fingerprint != null && interceptOpt.fingerprint !== false
  },
}
