// 对 NS 判不了的域名，用 A 记录判断是否落在 Cloudflare 网段
const https = require('https')

const UNKNOWN = 'itch.io mega.io mega.nz mod.io artstation.com discord.gg discordapp.com discordapp.net fandom.com hsguru.com imgur.com pinterest.com pinterest.info pinterest.jp twitch.tv vercel.app'.split(/\s+/)

const CFV4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.159.0.0/16', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22']
const toN = ip => ip.split('.').reduce((a, o) => (a << 8 >>> 0) + Number(o), 0) >>> 0
function inRange (ip, cidr) {
  const [net, bits] = cidr.split('/')
  const mask = (0xFFFFFFFF << (32 - Number(bits))) >>> 0
  return (toN(ip) & mask) === (toN(net) & mask)
}
const isCF = ip => CFV4.some(c => inRange(ip, c))

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
  const labels = []; let jumped = false; let next = off; let guard = 0
  while (guard++ < 200) {
    const len = buf[off]
    if (len === 0) { off += 1; if (!jumped) next = off; break }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[off + 1]
      if (!jumped) next = off + 2
      jumped = true; off = ptr; continue
    }
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
    let val = null
    if (type === 1 && rdlen === 4) val = [...buf.slice(off, off + 4)].join('.')
    if (type === 5) val = readName(buf, off).name
    out.push({ type, val }); off += rdlen
  }
  return out
}
function doh (host, name, qtype) {
  return new Promise(resolve => {
    const body = buildQ(name, qtype)
    const req = https.request({
      host,
      port: 443,
      path: '/dns-query',
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message', Accept: 'application/dns-message', 'Content-Length': body.length },
      timeout: 8000,
      agent: false,
    }, res => {
      const ch = []
      res.on('data', d => ch.push(d))
      res.on('end', () => { try { resolve({ status: res.statusCode, out: parse(Buffer.concat(ch)) }) } catch (e) { resolve({ err: e.message }) } })
    })
    req.on('error', e => resolve({ err: e.code || e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ err: 'TIMEOUT' }) })
    req.write(body); req.end()
  })
}
async function resolve4 (d, depth = 0) {
  for (const host of ['dns.alidns.com', 'doh.pub']) {
    const r = await doh(host, d, 1)
    if (r.err || !r.out) continue
    const as = r.out.filter(x => x.type === 1).map(x => x.val)
    if (as.length) return as
    const cn = r.out.filter(x => x.type === 5).map(x => x.val)[0]
    if (cn && depth < 4) {
      const sub = await resolve4(cn, depth + 1)
      if (sub.length) return sub
    }
  }
  return []
}
;(async () => {
  const cf = []; const other = []
  for (const d of UNKNOWN) {
    const ips = await resolve4(d)
    if (!ips.length) { console.log(`${d.padEnd(24)} 无A记录`); continue }
    const cfIps = ips.filter(isCF)
    const tag = cfIps.length ? 'CLOUDFLARE' : 'other'
    if (cfIps.length) cf.push(d); else other.push(d)
    console.log(`${d.padEnd(24)} ${tag.padEnd(11)} ${ips.slice(0, 3).join(', ')}`)
  }
  console.log(`\nCloudflare: ${cf.join(' ') || '(无)'}`)
  console.log(`非 CF:      ${other.join(' ') || '(无)'}`)
})()
