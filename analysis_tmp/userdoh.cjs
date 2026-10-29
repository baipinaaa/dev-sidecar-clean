// 测用户自建 ECH DoH 端点：可靠性 + 是否返回 HTTPS(65)/ECH
const https = require('https')

const HOST = 'wozhengtmrile.cc.cd'
const PATH = '/doh-ech-test'

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
function svcbKeys (rdata) {
  let o = 2; const labels = []
  while (o < rdata.length && rdata[o] !== 0) { const n = rdata[o]; labels.push(rdata.slice(o + 1, o + 1 + n).toString()); o += 1 + n }
  o += 1
  const keys = []
  while (o + 4 <= rdata.length) { const k = rdata.readUInt16BE(o); const len = rdata.readUInt16BE(o + 2); keys.push({ key: k, len }); o += 4 + len }
  return { target: labels.join('.'), keys }
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
    if (type === 65 || type === 64) val = svcbKeys(rd)
    out.push({ type, val }); off += rdlen
  }
  return out
}
function query (name, qtype) {
  return new Promise(resolve => {
    const body = buildQ(name, qtype)
    const t0 = Date.now()
    const req = https.request({
      host: HOST,
      port: 443,
      path: PATH,
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message', Accept: 'application/dns-message', 'Content-Length': body.length, Host: HOST },
      timeout: 10000,
      agent: false,
      rejectUnauthorized: false,
    }, res => {
      const ch = []
      res.on('data', d => ch.push(d))
      res.on('end', () => {
        const ms = Date.now() - t0
        if (res.statusCode !== 200) return resolve({ status: res.statusCode, ms })
        try { resolve({ status: 200, ms, out: parse(Buffer.concat(ch)) }) } catch (e) { resolve({ status: 200, ms, err: e.message }) }
      })
    })
    req.on('error', e => resolve({ err: e.code || e.message, ms: Date.now() - t0 }))
    req.on('timeout', () => { req.destroy(); resolve({ err: 'TIMEOUT', ms: Date.now() - t0 }) })
    req.write(body); req.end()
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const cases = [
    ['discord.com', 65], ['discord.com', 65], ['linux.do', 65],
    ['unpkg.com', 65], ['steamcommunity.com', 65], ['hcaptcha.com', 65],
    ['discord.com', 1], ['linux.do', 1],
  ]
  let ok = 0; let total = 0
  for (const [name, type] of cases) {
    total++
    const r = await query(name, type)
    if (r.err) { console.log(`${name.padEnd(20)} type=${type}  ${r.err}  (${r.ms}ms)`); await sleep(1200); continue }
    if (r.status !== 200) { console.log(`${name.padEnd(20)} type=${type}  HTTP ${r.status}  (${r.ms}ms)`); await sleep(1200); continue }
    ok++
    const recs = (r.out || []).filter(x => x.type === type)
    let detail = ''
    if (type === 65 && recs.length) {
      const sv = recs[0].val
      const ech = sv.keys.find(k => k.key === 5)
      detail = `target=${sv.target || '.'} keys=[${sv.keys.map(k => k.key).join(',')}] ECH=${ech ? ech.len + 'B' : '无'}`
    } else if (type === 1) {
      detail = recs.map(x => x.val).join(', ')
    }
    console.log(`${name.padEnd(20)} type=${type}  200 ${detail}  (${r.ms}ms)`)
    await sleep(1200)
  }
  console.log(`\n成功 ${ok}/${total}`)
})()
