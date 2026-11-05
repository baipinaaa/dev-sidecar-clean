const http = require('node:http')

/**
 * 探测代理服务的 /pac.js 是否已就绪。
 * PAC 由代理服务自身提供，端口没起来时写入系统代理会让全网无法上网，
 * 所以开启前必须先确认能拿到脚本。
 */
function probePacEndpoint (ip, port, timeout = 800) {
  return new Promise((resolve) => {
    const req = http.request({ host: ip, port, method: 'HEAD', path: '/pac.js', timeout }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}

async function waitPacReady (ip, port, totalMs = 3000) {
  const deadline = Date.now() + totalMs
  while (Date.now() < deadline) {
    if (await probePacEndpoint(ip, port)) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return false
}

const ProxyPlugin = function (context) {
  const { config, event, shell, log, status } = context
  const api = {
    async start () {
      return api.setProxy()
    },

    async close () {
      return api.unsetProxy()
    },

    async restart () {
      await api.close()
      await api.start()
    },

    async setProxy () {
      const ip = '127.0.0.1'
      const port = config.get().server.port
      const proxyConfig = config.get().proxy || {}
      const setEnv = proxyConfig.setEnv ?? false
      const setCaBundle = proxyConfig.setCaBundle ?? false
      await shell.setSystemProxy({ ip, port, setEnv, setCaBundle })
      log.info(`开启系统代理成功：${ip}:${port}`)
      event.fire('status', { key: 'proxy.enabled', value: true })
      // 固定代理会接管系统代理（并清掉 AutoConfigURL），PAC 开关随之失效
      if (status.proxy && status.proxy.pacEnabled) {
        event.fire('status', { key: 'proxy.pacEnabled', value: false })
      }
      return { ip, port }
    },

    /**
     * 开启 PAC 自动分流。
     *
     * 与固定代理互斥：系统里同一时刻只能有一种生效方式，而 @starknt/sysproxy 的
     * manual 模式会主动清空 AutoConfigURL，所以这里先关掉固定代理再写 PAC。
     */
    async startPac () {
      const ip = '127.0.0.1'
      const port = config.get().server.port
      if (!port) {
        throw new Error('代理服务尚未启动，无法生成 PAC 地址')
      }
      const ready = await waitPacReady(ip, port)
      if (!ready) {
        // 写了 AutoConfigURL 但拉不到脚本，Windows 会当成「无代理」或直接断网
        throw new Error('代理服务的 PAC 接口未就绪，请先开启「代理服务」再试')
      }
      // 时间戳做 query，避免 WinHTTP 按 URL 缓存上一次的 PAC 脚本（缓存命中会一直用旧规则）
      const pacUrl = `http://${ip}:${port}/pac.js?v=${Date.now()}`
      await api.unsetProxy(false)
      await shell.setSystemProxy({ pac: true, pacUrl })
      log.info(`开启 PAC 自动分流成功：${pacUrl}`)
      event.fire('status', { key: 'proxy.pacEnabled', value: true })
      // 固定代理已被关闭，同步状态，避免首页两个开关同时亮着
      event.fire('status', { key: 'proxy.enabled', value: false })
      return { pacUrl }
    },

    async closePac () {
      try {
        await shell.setSystemProxy({ pac: true })
        event.fire('status', { key: 'proxy.pacEnabled', value: false })
        log.info('关闭 PAC 自动分流成功')
        return true
      } catch (err) {
        log.error('关闭 PAC 自动分流失败:', err)
        return false
      }
    },

    async unsetProxy (setEnv) {
      if (setEnv == null) {
        const proxyConfig = config.get().proxy || {}
        setEnv = proxyConfig.setEnv ?? false
      }
      try {
        await shell.setSystemProxy({ setEnv })
        event.fire('status', { key: 'proxy.enabled', value: false })
        log.info('关闭系统代理成功')
        return true
      } catch (err) {
        log.error('关闭系统代理失败:', err)
        return false
      }
    },

    async setEnableLoopback () {
      await shell.enableLoopback()
      log.info('打开EnableLoopback成功')
      return true
    },
  }
  return api
}
module.exports = {
  key: 'proxy',
  config: {
    enabled: true,
    name: '系统代理',
    use: 'local',
    other: [],
    proxyHttp: false, // false=只代理HTTPS请求   true=同时代理HTTP和HTTPS请求
    setEnv: false,
    setCaBundle: false,

    // PAC 自动分流：由代理服务自身提供 /pac.js，系统代理设为「自动配置脚本」
    // 与固定系统代理互斥，开启时会自动关闭固定代理
    pacEnabled: false,

    // 排除国内域名 所需配置
    excludeDomesticDomainAllowList: true, // 是否排除国内域名，默认：需要排除
    autoUpdateDomesticDomainAllowList: true, // 是否自动更新国内域名
    remoteDomesticDomainAllowListFileUrl: 'https://raw.githubusercontent.com/pluwen/china-domain-allowlist/refs/heads/main/allow-list.sorl',
    domesticDomainAllowListFileAbsolutePath: null, // 自定义 domestic-domain-allowlist.txt 文件位置，可以是本地文件路径
    domesticDomainAllowListFilePath: './extra/proxy/domestic-domain-allowlist.txt', // 内置国内域名文件

    // 自定义系统代理排除列表
    excludeIpList: {
      // region 常用国内可访问域名

      // 中国大陆
      '*.cn': true,
      'cn.*': true,
      '*china*': true,

      // Github加速源：以下加速源代理后反而出现问题，从系统代理中排除掉
      '*.kkgithub.com': true,
      '*.ghproxy.*': true,

      // Github ssh
      'ssh.github.com': true,

      // DeepL
      'www.deepl.com': true,

      // CSDN
      '*.csdn.net': true,

      // 360 so
      '*.so.com': true,

      // 百度
      '*.baidu.com': true,
      '*.baiducontent.com': true,
      '*.bdimg.com': true,
      '*.bdstatic.com': true,
      '*.bdydns.com': true,

      // 腾讯
      '*.tencent.com': true,
      '*.qq.com': true,
      '*.weixin.com': true,
      '*.weixinbridge.com': true,
      '*.wechat.com': true,
      '*.idqqimg.com': true,
      '*.gtimg.com': true,
      '*.qpic.com': true,
      '*.qlogo.com': true,
      '*.myapp.com': true,

      // 阿里
      '*.aliyun.com': true,
      '*.alipay.com': true,
      '*.taobao.com': true,
      '*.tmall.com': true,
      '*.alipayobjects.com': true,
      '*.dingtalk.com': true,
      '*.mmstat.com': true,
      '*.alicdn.com': true,
      '*.hdslb.com': true,

      // Gitee
      'gitee.com': true,
      '*.gitee.com': true,
      '*.gitee.io': true,
      '*.giteeusercontent.com': true,

      // Mozilla Firefox
      '*.mozilla.org': true,
      '*.mozilla.com': true,
      '*.mozilla.net': true,
      '*.firefox.com': true,
      '*.firefox.org': true,
      '*.mozillademos.org': true,
      '*.mozillians.org': true,
      '*.mozillians.net': true,
      '*.mozillians.com': true,

      // OSS
      '*.sonatype.org': true,
      // Maven镜像
      '*.maven.org': true,
      // Maven Repository
      '*.mvnrepository.com': true,

      // 苹果
      '*.apple.com': true,
      '*.icloud.com': true,

      // 微软
      '*.microsoft.com': true,
      '*.windows.com': true,
      '*.office.com': true,
      '*.office.net': true,
      '*.live.com': true,
      '*.msn.com': true,

      // WPS
      '*.wps.com': true,
      '*.wps.net': true,
      '*.ksord.com': true,

      // 奇虎
      '*.qihoo.com': true,
      '*.qihucdn.com': true,
      // 360
      '*.360.com': true,
      '*.360safe.com': true,
      '*.360buyimg.com': true,
      '*.360buy.com': true,

      // 京东
      '*.jd.com': true,
      '*.jcloud.com': true,
      '*.jcloudcs.com': true,
      '*.jcloudcache.com': true,
      '*.jcloudcdn.com': true,
      '*.jcloudlb.com': true,

      // 哔哩哔哩
      '*.bilibili.com': true,
      '*.bilivideo.com': true,
      '*.biliapi.net': true,

      // 移动
      '*.10086.com': true,
      '*.10086cloud.com': true,

      // 移动：139邮箱
      '*.139.com': true,

      // 迅雷
      '*.xunlei.com': true,

      // 网站ICP备案查询
      '*.icpapi.com': true,

      // Navicat
      '*.navicat.com': true,

      // Github文件上传所使用的域名，被DS代理会导致文件上传经常失败，从系统代理中排除掉
      'objects-origin.githubusercontent.com': true,

      // cloudflare：排除以下域名，cloudflare的人机校验会更快，成功率更高。
      'challenges.cloudflare.com': true,

      // endregion

      // 本地地址，无需代理
      'localhost': true,
      'localhost.*': true, // 部分VPN会在host中添加这种格式的域名指向127.0.0.1，所以也排除掉
      '127.*.*.*': true,
      'test.*': true, // 本地开发时，测试用的虚拟域名格式，无需代理

      // 服务器端常用地址，无需代理
      '10.*.*.*': true,
      '172.16.*.*': true,
      '172.17.*.*': true,
      '172.18.*.*': true,
      '172.19.*.*': true,
      '172.20.*.*': true,
      '172.21.*.*': true,
      '172.22.*.*': true,
      '172.23.*.*': true,
      '172.24.*.*': true,
      '172.25.*.*': true,
      '172.26.*.*': true,
      '172.27.*.*': true,
      '172.28.*.*': true,
      '172.29.*.*': true,
      '172.30.*.*': true,
      '172.31.*.*': true,

      // 局域网地址，无需代理
      '192.168.*.*': true,
    },
  },
  status: {
    enabled: false,
    pacEnabled: false,
    proxyTarget: '',
  },
  plugin: ProxyPlugin,
}
