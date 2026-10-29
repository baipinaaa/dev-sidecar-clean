// 无 DNS 判据：用 Cloudflare anycast IP 试 TLS，看证书 SAN 是否匹配该域名
// CF 只对自己托管的 zone 出示对应证书
const tls = require('tls')

const LIST = `itch.io mega.io mega.nz mod.io artstation.com discord.gg discordapp.com discordapp.net
fandom.com hsguru.com imgur.com pinterest.com pinterest.info pinterest.jp twitch.tv vercel.app
battlemetrics.com blockbench.net cloudflarestorage.com discord.com hcaptcha.com modcdn.io nexusmods.com
parsec.app parsecusercontent.com steamdb.info unpkg.com
github.com steamcommunity.com store.steampowered.com sparkle.steampowered.com`.split(/\s+/).filter(Boolean)

const CF_IPS = ['104.21.81.140', '172.67.189.160']

function certOf (ip, sni) {
  return new Promise(resolve => {
    let settled = false
    const done = r => { if (settled) return; settled = true; try { s.destroy() } catch (e) {}; resolve(r) }
    const s = tls.connect({ host: ip, port: 443, servername: sni, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => {
      const c = s.getPeerCertificate(false)
      done({ cn: c.subject && c.subject.CN, san: c.subjectaltname || '', issuer: (c.issuer && (c.issuer.CN || c.issuer.O)) || '' })
    })
    s.setTimeout(6000)
    s.once('timeout', () => done({ err: 'TIMEOUT' }))
    s.once('error', e => done({ err: e.code || e.message }))
  })
}
function sanMatches (san, host) {
  if (!san) return false
  const list = san.split(',').map(x => x.trim().replace(/^DNS:/, '')).filter(Boolean)
  return list.some(n => n === host || (n.startsWith('*.') && host.endsWith(n.slice(1))))
}
;(async () => {
  const cf = []; const notCf = []; const err = []
  for (const d of LIST) {
    let hit = null
    for (const ip of CF_IPS) {
      const r = await certOf(ip, d)
      if (r.err) continue
      if (sanMatches(r.san, d)) { hit = r; break }
    }
    if (hit) { cf.push(d); console.log(`${d.padEnd(26)} CLOUDFLARE   cert=${hit.cn}  issuer=${hit.issuer}`) } else if (err.length >= 0 && !hit) { notCf.push(d); console.log(`${d.padEnd(26)} 非CF / 无证书`) }
  }
  console.log(`\n=== Cloudflare 托管 ${cf.length} 个 ===\n${cf.join(' ')}`)
  console.log(`\n=== 非 Cloudflare ${notCf.length} 个 ===\n${notCf.join(' ')}`)
})()
