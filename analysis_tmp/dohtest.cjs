// 逐个测试 DoH 端点是否可用（查询 discord.com 的 A 记录）
const https = require('https')

const TARGET = 'discord.com'
const ENDPOINTS = [
  { name: 'alidns (国内)', host: 'dns.alidns.com', path: '/dns-query', sni: null },
  { name: 'doh.pub (国内)', host: 'doh.pub', path: '/dns-query', sni: null },
  { name: 'cf-ip 1.1.1.1', host: '1.1.1.1', path: '/dns-query', sni: null },
  { name: 'cf-DoH +sni=baidu.com', host: 'cloudflare-dns.com', path: '/dns-query', sni: 'baidu.com', hostHeader: 'cloudflare-dns.com' },
  { name: 'cf-DoH 无伪装', host: 'cloudflare-dns.com', path: '/dns-query', sni: null },
  { name: 'quad9', host: 'dns.quad9.net', path: '/dns-query', sni: null },
  { name: 'opendns', host: 'doh.opendns.com', path: '/dns-query', sni: null },
  { name: 'adguard', host: 'dns.adguard-dns.com', path: '/dns-query', sni: null },
  { name: 'controld', host: 'freedns.controld.com', path: '/p0', sni: null },
]

function buildQ (name, qtype) {
  const p = []
  const h = Buffer.alloc(12)
  h.writeUInt16BE(0, 0); h.writeUInt16BE(0x0100, 2); h.writeUInt16BE(1, 4); p.push(h)
  for (const l of name.split('.')) { const b = Buffer.from(l, 'ascii'); p.push(Buffer.from([b.length]), b) }
  p.push(Buffer.from([0]))
  const t = Buffer.alloc(4); t.writeUInt16BE(qtype, 0); t.writeUInt16BE(1, 2); p.push(t)
  return Buffer.concat(p)
}
function readName (buf, off) {
  const labels = []; let jumped = false; let next = off; let g = 0
  while (g++ < 200) {
    const len = buf[off]
    if (len === 0) { off += 1; if (!jumped) next = off; break }
    if ((len & 0xc0) === 0xc0) { const ptr = ((len & 0x3f) << 8) | buf[off + 1]; if (!jumped) next = off + 2; jumped = true; off = ptr; continue }
    labels.push(buf.slice(off + 1, off + 1 + len).toString('ascii')); off += 1 + len
    if (!jumped) next = off
  }
  return { name: labels.join('.'), next }
}
function parse (buf) {
  let off = 12
  const qd = buf.readUInt16BE(4)
  for (let i = 0; i < qd; i++) { const r = readName(buf, off); off = r.next + 4 }
  const an = buf.readUInt16BE(6)
  const out = []
  for (let i = 0; i < an; i++) {
    const r = readName(buf, off); off = r.next
    const type = buf.readUInt16BE(off); off += 8
    const rdlen = buf.readUInt16BE(off); off += 2
    if (type === 1 && rdlen === 4) out.push([...buf.slice(off, off + 4)].join('.'))
    off += rdlen
  }
  return out
}
function test (e) {
  return new Promise(resolve => {
    const body = buildQ(TARGET, 1)
    const opts = {
      host: e.host,
      port: 443,
      path: e.path,
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message', Accept: 'application/dns-message', 'Content-Length': body.length, Host: e.hostHeader || e.host },
      timeout: 8000,
      agent: false,
      rejectUnauthorized: false,
    }
    if (e.sni) opts.servername = e.sni
    const req = https.request(opts, res => {
      const ch = []
      res.on('data', d => ch.push(d))
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ status: res.statusCode })
        try { resolve({ status: 200, ips: parse(Buffer.concat(ch)) }) } catch (err) { resolve({ status: 200, err: err.message }) }
      })
    })
    req.on('error', err => resolve({ err: err.code || err.message }))
    req.on('timeout', () => { req.destroy(); resolve({ err: 'TIMEOUT' }) })
    req.write(body); req.end()
  })
}
;(async () => {
  for (const e of ENDPOINTS) {
    const r = await test(e)
    const tag = r.err ? r.err : (r.status === 200 ? `200  ${(r.ips || []).join(',') || '(无A)'}` : `HTTP ${r.status}`)
    console.log(`${e.name.padEnd(26)} ${tag}`)
  }
})()
