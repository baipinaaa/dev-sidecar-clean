// 用 dns.alidns.com 的 DoH 查 NS，判断域名是否 Cloudflare 托管
const https = require('https')

const DOMAINS = `hf.co itch.io mega.io mega.nz mod.io scdn.co ubi.com arkoselabs.com artstation.com
battlemetrics.com blockbench.net cloudflarestorage.com discord.com discord.gg discordapp.com discordapp.net
docker.io dropboxusercontent.com epicgames.com fandom.com gamespot.com hcaptcha.com hsguru.com imgur.com
jtvnw.net minecraft.net minecraftservices.com modcdn.io mojang.com nexus-cdn.com nexusmods.com nocookie.net
opencritic.com p76prod.systems parsec.app parsecusercontent.com pinimg.com pinterest.com pinterest.info
pinterest.jp pinterest.kr pixeldrain.com queniujq.cn recaptcha.net spotify.com eccdnx.com steam-chat.com
steamdb.info steamusercontent.com ttvnw.net twitch.tv twitchcdn.net unpkg.com vercel.app vercel.com
xda-developers.com xdaforums.com yandex.com yandex.net yandex.ru steampowered.com akamaized.net akamaihd.net
githubassets.com`.split(/\s+/).filter(Boolean)

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
function doh (name, qtype) {
  return new Promise(resolve => {
    const body = buildQ(name, qtype)
    const req = https.request({
      host: 'dns.alidns.com',
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
async function nsOf (d) {
  const r = await doh(d, 2)
  if (r.err) return { err: r.err }
  const ns = (r.out || []).filter(x => x.type === 2).map(x => x.val)
  if (ns.length) return { ns }
  const parts = d.split('.')
  if (parts.length > 2) {
    const parent = parts.slice(-2).join('.')
    const r2 = await doh(parent, 2)
    return { ns: ((r2.out || []).filter(x => x.type === 2).map(x => x.val)), via: parent }
  }
  return { ns: [] }
}
;(async () => {
  const probe = await nsOf('github.com')
  if (probe.err) { console.log('DNS 通道不可用:', probe.err); process.exit(1) }
  const cf = []; const other = []; const bad = []
  for (const d of DOMAINS) {
    const r = await nsOf(d)
    if (r.err) { bad.push(`${d}(${r.err})`); continue }
    if (!r.ns.length) { bad.push(d); continue }
    if (r.ns.some(n => n.includes('cloudflare'))) cf.push(d)
    else other.push(d)
  }
  console.log(`=== Cloudflare 托管 ${cf.length} 个（sni:'baidu.com' 会导致 403）===`)
  console.log(cf.join(' '))
  console.log(`\n=== 非 Cloudflare ${other.length} 个 ===`)
  console.log(other.join(' '))
  console.log(`\n=== 判不了 ${bad.length} 个 ===`)
  console.log(bad.join(' '))
})()
