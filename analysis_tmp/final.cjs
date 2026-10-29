const tls = require('tls')
const https = require('https')
function hs (ip, sni) {
  return new Promise(resolve => {
    let s2 = false
    const done = r => { if (s2) return; s2 = true; try { s.destroy() } catch (e) {}; resolve(r) }
    const s = tls.connect({ host: ip, port: 443, servername: sni, rejectUnauthorized: false }, () => done({ ok: true, cn: s.getPeerCertificate().subject.CN }))
    s.setTimeout(6000); s.once('timeout', () => done({ err: 'TIMEOUT' })); s.once('error', e => done({ err: e.code }))
  })
}
;(async () => {
  console.log('--- 你的端点 TLS 握手（3 次）---')
  for (let i = 0; i < 3; i++) {
    const r = await hs('104.21.81.140', 'wozhengtmrile.cc.cd')
    console.log(`  第${i + 1}次: ${r.ok ? '握手成功 cn=' + r.cn : r.err}`)
    await new Promise(r => setTimeout(r, 800))
  }
  console.log('--- alidns 对 linux.do 的 A 记录（是否被污染）---')
  const body = (() => {
    const p = []; const h = Buffer.alloc(12)
    h.writeUInt16BE(0, 0); h.writeUInt16BE(0x0100, 2); h.writeUInt16BE(1, 4); p.push(h)
    for (const l of 'linux.do'.split('.')) { const b = Buffer.from(l); p.push(Buffer.from([b.length]), b) }
    p.push(Buffer.from([0])); const t = Buffer.alloc(4); t.writeUInt16BE(1, 0); t.writeUInt16BE(1, 2); p.push(t)
    return Buffer.concat(p)
  })()
  await new Promise(resolve => {
    const req = https.request({ host: 'dns.alidns.com', port: 443, path: '/dns-query', method: 'POST', headers: { 'Content-Type': 'application/dns-message', Accept: 'application/dns-message', 'Content-Length': body.length }, agent: false, timeout: 8000 }, res => {
      const ch = []; res.on('data', d => ch.push(d))
      res.on('end', () => {
        const buf = Buffer.concat(ch)
        let off = 12; const qd = buf.readUInt16BE(4)
        const rn = o => { const l = []; while (buf[o] !== 0) { const n = buf[o]; l.push(buf.slice(o + 1, o + 1 + n).toString()); o += 1 + n } return o + 1 }
        for (let i = 0; i < qd; i++) off = rn(off) + 4
        const an = buf.readUInt16BE(6); const ips = []
        for (let i = 0; i < an; i++) { off = rn(off); const ty = buf.readUInt16BE(off); off += 8; const rl = buf.readUInt16BE(off); off += 2; if (ty === 1 && rl === 4) ips.push([...buf.slice(off, off + 4)].join('.')); off += rl }
        console.log('  ' + (ips.join(', ') || '(无)'))
        resolve()
      })
    })
    req.on('error', () => { console.log('  查询失败'); resolve() })
    req.write(body); req.end()
  })
})()
