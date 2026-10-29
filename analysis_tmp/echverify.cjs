const https = require('https')
const IPS = ['104.21.81.140', '172.67.189.160']
const HOST = 'wozhengtmrile.cc.cd'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function buildQ (name, qtype) {
  const p = []
  const h = Buffer.alloc(12)
  h.writeUInt16BE(0, 0); h.writeUInt16BE(0x0100, 2); h.writeUInt16BE(1, 4); p.push(h)
  for (const l of name.split('.')) { const b = Buffer.from(l); p.push(Buffer.from([b.length]), b) }
  p.push(Buffer.from([0]))
  const t = Buffer.alloc(4); t.writeUInt16BE(qtype, 0); t.writeUInt16BE(1, 2); p.push(t)
  return Buffer.concat(p)
}
function readName (buf, off) {
  const labels = []; let jumped = false; let next = off; let g = 0
  while (g++ < 300) {
    const len = buf[off]
    if (len === 0) { off += 1; if (!jumped) next = off; break }
    if ((len & 0xc0) === 0xc0) { const ptr = ((len & 0x3f) << 8) | buf[off + 1]; if (!jumped) next = off + 2; jumped = true; off = ptr; continue }
    labels.push(buf.slice(off + 1, off + 1 + len).toString()); off += 1 + len
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
    const rd = buf.slice(off, off + rdlen)
    let val = null
    if (type === 1 && rdlen === 4) val = [...rd].join('.')
    if (type === 28) val = 'AAAA'
    if (type === 65 || type === 64) {
      let o = 2; const labels = []
      while (o < rd.length && rd[o] !== 0) { const n = rd[o]; labels.push(rd.slice(o + 1, o + 1 + n).toString()); o += 1 + n }
      o += 1
      const keys = []
      while (o + 4 <= rd.length) { const k = rd.readUInt16BE(o); const len = rd.readUInt16BE(o + 2); keys.push({ key: k, len }); o += 4 + len }
      val = { target: labels.join('.'), keys }
    }
    out.push({ type, val }); off += rdlen
  }
  return out
}
function fetchWithRetry (name, qtype, tries = 12) {
  const body = buildQ(name, qtype)
  return new Promise(resolve => {
    let attempt = 0
    const go = () => {
      attempt++
      const req = https.request({ host: IPS[attempt % 2], port: 443, path: '/doh-ech-test', method: 'POST', servername: HOST, rejectUnauthorized: false, headers: { Host: HOST, 'User-Agent': UA, 'Content-Type': 'application/dns-message', Accept: 'application/dns-message', 'Content-Length': body.length }, timeout: 8000, agent: false }, res => {
        const ch = []
        res.on('data', d => ch.push(d))
        res.on('end', () => {
          if (res.statusCode === 200) { try { resolve(parse(Buffer.concat(ch))) } catch (e) { resolve([]) } } else if (attempt < tries) go(); else resolve(null)
        })
      })
      req.on('error', () => { if (attempt < tries) go(); else resolve(null) })
      req.on('timeout', () => { req.destroy(); if (attempt < tries) go(); else resolve(null) })
      req.write(body); req.end()
    }
    go()
  })
}
;(async () => {
  console.log('域名                    A记录 / HTTPS记录(ECH)')
  for (const d of ['discord.com', 'unpkg.com', 'hcaptcha.com', 'linux.do', 'steamcommunity.com', 'cloudflare.com']) {
    const a = await fetchWithRetry(d, 1)
    const h = await fetchWithRetry(d, 65)
    const ips = (a || []).filter(x => x.type === 1).map(x => x.val)
    const rec = (h || []).filter(x => x.type === 65)
    let hs = '无 HTTPS 记录'
    if (rec.length) {
      const sv = rec[0].val
      const ech = sv.keys.find(k => k.key === 5)
      hs = `target=${sv.target || '.'} keys=[${sv.keys.map(k => k.key).join(',')}] ECH=${ech ? ech.len + 'B' : '无'}`
    }
    console.log(`${d.padEnd(22)} ${ips.join(',') || '(无A)'}  |  ${hs}`)
  }
})()
