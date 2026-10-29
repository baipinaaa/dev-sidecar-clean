// 对 16 个未知域名，打印实际握手结果以区分「非CF」「被墙」
const tls = require('tls')
const LIST = 'itch.io mega.io mega.nz mod.io artstation.com discord.gg discordapp.net fandom.com hsguru.com imgur.com pinterest.com pinterest.jp twitch.tv vercel.app'.split(/\s+/)
const CF_IPS = ['104.21.81.140', '172.67.189.160', '104.16.132.229']

function certOf (ip, sni) {
  return new Promise(resolve => {
    let settled = false
    const done = r => { if (settled) return; settled = true; try { s.destroy() } catch (e) {}; resolve(r) }
    const s = tls.connect({ host: ip, port: 443, servername: sni, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => {
      const c = s.getPeerCertificate(false)
      done({ cn: (c.subject && c.subject.CN) || '', san: c.subjectaltname || '' })
    })
    s.setTimeout(6000)
    s.once('timeout', () => done({ err: 'TIMEOUT' }))
    s.once('error', e => done({ err: e.code || e.message }))
  })
}
const match = (san, host) => san.split(',').map(x => x.trim().replace(/^DNS:/, '')).some(n => n === host || (n.startsWith('*.') && host.endsWith(n.slice(1))))
;(async () => {
  for (const d of LIST) {
    const results = []
    for (const ip of CF_IPS) {
      const r = await certOf(ip, d)
      if (r.err) results.push(`${ip}:${r.err}`)
      else results.push(`${ip}:cert=${r.cn}${match(r.san, d) ? '(MATCH)' : ''}`)
    }
    console.log(`${d.padEnd(20)} ${results.join('  ')}`)
  }
})()
