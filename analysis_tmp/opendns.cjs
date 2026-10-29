// 验证 doh.opendns.com：A 记录是否准确 + 是否支持 HTTPS(65) 与 ECH 参数
const https = require('https')

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
  while (g++ < 300) {
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
    const rd = buf.slice(off, off + rdlen)
    let val = null
    if (type === 1 && rdlen === 4) val = [...rd].join('.')
    if (type === 5) val = readName(buf, off).name
    if (type === 65 || type === 64) val = svcbKeys(rd)
    out.push({ type, val }); off += rdlen
  }
  return out
}
function svcbKeys (rdata) {
  let o = 2
  let target = ''
  const labels = []
  while (o < rdata.length && rdata[o] !== 0) { const n = rdata[o]; labels.push(rdata.slice(o + 1, o + 1 + n).toString()); o += 1 + n }
  target = labels.join('.')
  o += 1
  const keys = []
  while (o + 4 <= rdata.length) {
    const k = rdata.readUInt16BE(o); const len = rdata.readUInt16BE(o + 2)
    keys.push({ key: k, len }); o += 4 + len
  }
  return { target, keys }
}
function query (name, qtype) {
  return new Promise(resolve => {
    const body = buildQ(name, qtype)
    const req = https.request({
      host: 'doh.opendns.com',
      port: 443,
      path: '/dns-query',
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message', Accept: 'application/dns-message', 'Content-Length': body.length },
      timeout: 8000,
      agent: false,
      rejectUnauthorized: false,
    }, res => {
      const ch = []
      res.on('data', d => ch.push(d))
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ status: res.statusCode })
        try { resolve({ status: 200, out: parse(Buffer.concat(ch)) }) } catch (e) { resolve({ status: 200, err: e.message }) }
      })
    })
    req.on('error', e => resolve({ err: e.code || e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ err: 'TIMEOUT' }) })
    req.write(body); req.end()
  })
}
;(async () => {
  console.log('--- A 记录（判断是否被污染）---')
  for (const d of ['linux.do', 'steamcommunity.com', 'github.com', 'discord.com', 'unpkg.com']) {
    const r = await query(d, 1)
    if (r.err) { console.log(`${d.padEnd(22)} ${r.err}`); continue }
    const ips = (r.out || []).filter(x => x.type === 1).map(x => x.val)
    console.log(`${d.padEnd(22)} ${ips.join(', ') || '(无)'}`)
  }
  console.log('\n--- HTTPS(65) 记录 + ECH ---')
  for (const d of ['discord.com', 'unpkg.com', 'linux.do', 'steamcommunity.com', 'cloudflare.com']) {
    const r = await query(d, 65)
    if (r.err) { console.log(`${d.padEnd(22)} ${r.err}`); continue }
    const h = (r.out || []).filter(x => x.type === 65)
    if (!h.length) { console.log(`${d.padEnd(22)} 无 HTTPS 记录`); continue }
    const sv = h[0].val
    const ech = sv.keys.find(k => k.key === 5)
    console.log(`${d.padEnd(22)} target=${sv.target || '.'} keys=[${sv.keys.map(k => k.key).join(',')}] ECH=${ech ? ech.len + 'B' : '无'}`)
  }
})()
