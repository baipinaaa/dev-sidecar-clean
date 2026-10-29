const tls = require('tls')
const https = require('https')
const IPS = ['104.21.81.140', '172.67.189.160']
const HOST = 'wozhengtmrile.cc.cd'
function hs (ip, alpn) {
  return new Promise(resolve => {
    let done = false
    const fin = r => { if (done) return; done = true; try { s.destroy() } catch (e) {}; resolve(r) }
    const s = tls.connect({ host: ip, port: 443, servername: HOST, rejectUnauthorized: false, ALPNProtocols: alpn }, () => fin({ ok: true, alpn: s.alpnProtocol }))
    s.setTimeout(6000); s.once('timeout', () => fin({ err: 'TIMEOUT' })); s.once('error', e => fin({ err: e.code || e.message }))
  })
}
function full (ip) {
  return new Promise(resolve => {
    const body = Buffer.from('\x00\x00\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x06discord\x03com\x00\x00\x41\x00\x01', 'latin1')
    const req = https.request({ host: ip, port: 443, path: '/doh-ech-test', method: 'POST', servername: HOST, rejectUnauthorized: false, headers: { 'Content-Type': 'application/dns-message', Accept: 'application/dns-message', Host: HOST, 'Content-Length': body.length }, timeout: 10000, agent: false }, res => {
      const ch = []; res.on('data', d => ch.push(d)); res.on('end', () => resolve({ status: res.statusCode, len: Buffer.concat(ch).length }))
    })
    req.on('error', e => resolve({ err: e.code || e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ err: 'TIMEOUT' }) })
    req.write(body); req.end()
  })
}
;(async () => {
  for (const alpn of [['http/1.1'], ['h2', 'http/1.1']]) {
    let ok = 0
    for (let i = 0; i < 10; i++) {
      const r = await hs(IPS[i % 2], alpn)
      if (r.ok) ok++
    }
    console.log(`ALPN=[${alpn.join(',')}]  握手成功 ${ok}/10`)
  }
  let ok = 0
  const detail = []
  for (let i = 0; i < 10; i++) {
    const r = await full(IPS[i % 2])
    if (r.status) { ok++; detail.push(`HTTP ${r.status}`) } else detail.push(r.err)
  }
  console.log(`\n完整 DoH POST 成功 ${ok}/10 : ${detail.join(' | ')}`)
})()
