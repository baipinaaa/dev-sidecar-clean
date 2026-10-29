// 对 16 个 NS 判不了的域名，换多个 DoH 源查 NS
const https = require('https')

const LIST = 'itch.io mega.io mega.nz mod.io artstation.com discord.gg discordapp.com discordapp.net fandom.com hsguru.com imgur.com pinterest.com pinterest.info pinterest.jp twitch.tv vercel.app'.split(/\s+/)
const RESOLVERS = [
  { host: 'doh.pub', path: '/dns-query' },
  { host: 'dns.alidns.com', path: '/dns-query' },
  { host: 'doh.360.cn', path: '/dns-query' },
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
    if (type === 2) val = readName(buf, off).name
    out.push({ type, val }); off += rdlen
  }
  return out
}
function doh (r, name, qtype) {
  return new Promise(resolve => {
    const body = buildQ(name, qtype)
    const req = https.request({
      host: r.host,
      port: 443,
      path: r.path,
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message', Accept: 'application/dns-message', 'Content-Length': body.length, Host: r.host },
      timeout: 8000,
      agent: false,
    }, res => {
      const ch = []
      res.on('data', d => ch.push(d))
      res.on('end', () => { try { resolve(parse(Buffer.concat(ch))) } catch (e) { resolve([]) } })
    })
    req.on('error', () => resolve([]))
    req.on('timeout', () => { req.destroy(); resolve([]) })
    req.write(body); req.end()
  })
}
;(async () => {
  for (const d of LIST) {
    let ns = []
    let via = ''
    for (const r of RESOLVERS) {
      const out = await doh(r, d, 2)
      ns = (out || []).filter(x => x.type === 2).map(x => x.val)
      if (ns.length) { via = r.host; break }
    }
    const tag = ns.length ? (ns.some(n => n.includes('cloudflare')) ? 'CLOUDFLARE' : 'other') : '未知'
    console.log(`${d.padEnd(22)} ${tag.padEnd(11)} ${ns.slice(0, 2).join(', ') || '-'}${via ? '  via ' + via : ''}`)
  }
})()
