const https = require('https')
const IPS = ['104.21.81.140', '172.67.189.160']
const HOST = 'wozhengtmrile.cc.cd'
const BODY = Buffer.from('\x00\x00\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x06discord\x03com\x00\x00\x41\x00\x01', 'latin1')
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
function post (ip, headers) {
  return new Promise(resolve => {
    const req = https.request({ host: ip, port: 443, path: '/doh-ech-test', method: 'POST', servername: HOST, rejectUnauthorized: false, headers: Object.assign({ Host: HOST, 'Content-Type': 'application/dns-message', Accept: 'application/dns-message', 'Content-Length': BODY.length }, headers), timeout: 10000, agent: false }, res => {
      const ch = []
      res.on('data', d => ch.push(d))
      res.on('end', () => resolve({ status: res.statusCode, len: Buffer.concat(ch).length, head: Buffer.concat(ch).slice(0, 80).toString('latin1').replace(/[^\x20-\x7e]/g, '.') }))
    })
    req.on('error', e => resolve({ err: e.code || e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ err: 'TIMEOUT' }) })
    req.write(BODY); req.end()
  })
}
;(async () => {
  const cases = [
    ['无 UA', {}],
    ['Chrome UA', { 'User-Agent': UA_CHROME }],
    ['curl UA', { 'User-Agent': 'curl/8.5.0' }],
    ['Chrome UA + Accept-Language', { 'User-Agent': UA_CHROME, 'Accept-Language': 'zh-CN,zh;q=0.9' }],
  ]
  for (const [name, h] of cases) {
    const out = []
    for (let i = 0; i < 6; i++) {
      const r = await post(IPS[i % 2], h)
      out.push(r.status ? `${r.status}(${r.len}B)` : r.err)
    }
    console.log(`${name.padEnd(28)} ${out.join(' ')}`)
  }
  console.log('\n--- 带 Chrome UA 的响应体前 80 字节 ---')
  const r = await post(IPS[0], { 'User-Agent': UA_CHROME })
  console.log(r.head || r.err)
})()
