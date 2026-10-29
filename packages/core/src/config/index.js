const path = require('node:path')
const configLoader = require('./local-config-loader')
const { applyRemoteConfigUrlHttps } = require('./remote-config-url')

function getRootCaCertPath () {
  return path.join(configLoader.getUserBasePath(), '/dev-sidecar.ca.crt')
}

function getRootCaKeyPath () {
  return path.join(configLoader.getUserBasePath(), '/dev-sidecar.ca.key.pem')
}

/**
 * 官方（共享）远程配置地址 —— 以「最高优先级 + 一次性覆写」的方式落到用户配置上。
 *
 * 为什么要覆写：配置合并顺序是「用户 > 个人远程 > 共享远程 > 默认」，用户配置优先级最高，
 * 所以用户本地残留的历史官方地址会盖住默认值。
 *
 * 为什么只覆写一次：只纠正 ONCE_OVERRIDE_DEPRECATED_REMOTE_CONFIG_URLS 里列出的历史官方地址。
 * 纠正之后本地址就归用户所有了 —— 用户可以在「设置」里自由改成其它地址（例如自建镜像），
 * 程序不再干预；personalUrl（个人远程配置）始终由用户掌控，且优先级更高。
 */
const HIGHEST_PRIORITY_ONCE_OVERRIDE_OFFICIAL_REMOTE_CONFIG_URL = 'https://ds-official-config.bestar.de5.net/remote_config.json5'

/** 历史官方地址：命中即被一次性纠正为 HIGHEST_PRIORITY_ONCE_OVERRIDE_OFFICIAL_REMOTE_CONFIG_URL */
const ONCE_OVERRIDE_DEPRECATED_REMOTE_CONFIG_URLS = [
  // v1.6.0 ~ v1.7.3 默认（docmirror 官方仓库 master 分支）
  'https://gitee.com/docmirror/dev-sidecar/raw/master/packages/core/src/config/remote_config.json5',
  // 更早期（2021-08 尚未定型，路径在 gui/extra 下）
  'https://gitee.com/docmirror/dev-sidecar/raw/master/packages/gui/extra/config_remote.json5',
  // v1.8.0 默认（GitHub raw）
  'https://github.com/docmirror/dev-sidecar/raw/master/packages/core/src/config/remote_config.json5',
  // v1.8.1 ~ v1.8.9、v2.0.0-RC1 默认（王良仓库 docmirror 分支）
  'https://gitee.com/wangliang181230/dev-sidecar/raw/docmirror/packages/core/src/config/remote_config.json5',
  // 开发期中间变体（2024-01 ~ 2024-04，未随 tag 发布）
  'https://gitee.com/wangliang181230/dev-sidecar/raw/master/packages/core/src/config/remote_config.json5',
  'https://gitee.com/wangliang181230/dev-sidecar/raw/master/packages/core/src/config/remote_config.json',
  'https://gitee.com/wangliang181230/dev-sidecar/raw/myself/packages/core/src/config/remote_config.json',
  'https://gitee.com/wangliang181230/dev-sidecar/raw/config/remote_config.json',
  'https://gitee.com/wangliang181230/dev-sidecar/raw/remote_config/remote_config.json',
  'https://gitee.com/wangliang181230/dev-sidecar/raw/remote_config/packages/core/src/config/remote_config.json',
  'https://gitee.com/wangliang181230/dev-sidecar/raw/docmirror/packages/core/src/config/remote_config.json',
  // v2.0.0-RC2 ~ v2.0.0.3、v2.0.1-test 默认：所属 Gitee 仓库被 Gitee 强制设为 private 后失效（见 issue #591）
  'https://gitee.com/wangliang181230/dev-sidecar/raw/docmirror2.x/packages/core/src/config/remote_config.json',
  // v2.0.1 ~ v2.0.2 默认：迁移到 dev-sidecar-config 仓库后的地址（Gitee 直链形式）
  'https://gitee.com/wangliang181230/dev-sidecar-config/raw/main/remote_config.json',
  // v2.1.0 起的地址（giteeusercontent / github raw 两种代理形式）
  'https://raw.giteeusercontent.com/wangliang181230/dev-sidecar-config/raw/main/remote_config.json',
  'https://raw.githubusercontent.com/wangliang181230/dev-sidecar-config/main/remote_config.json',
  // 第三方 fork，仅出现在 2026-04-27 一次开发提交；非官方默认，如担心覆盖用户自选镜像可删掉此条
  'https://gitee.com/wzbdyr/dev-sidecar-config/raw/main/remote_config20260426.json',
]

const defaultConfig = {
  app: {
    metaInfo: {
      // version / updateLog 由下方 SYNC:OFFICIAL-FALLBACK 区块从官方配置填充
      id: 'internal',
    },
    mode: 'default',
    autoStart: {
      enabled: false,
    },
    remoteConfig: {
      enabled: true,
      // 共享（官方）远程配置地址：默认值见 HIGHEST_PRIORITY_ONCE_OVERRIDE_OFFICIAL_REMOTE_CONFIG_URL
      url: HIGHEST_PRIORITY_ONCE_OVERRIDE_OFFICIAL_REMOTE_CONFIG_URL,
      // 个人远程配置地址
      personalUrl: '',
    },
    startShowWindow: true, // 启动时是否打开窗口：true=打开窗口, false=隐藏窗口
    needCheckHideWindow: true, // 是否需要在隐藏窗口时做检查
    showHideShortcut: 'Alt + S', // 显示/隐藏窗口快捷键
    windowSize: { width: 1200, height: 860 }, // 启动时，窗口的尺寸
    theme: 'dark', // 主题：light=亮色, dark=暗色
    autoChecked: false, // 是否自动检查更新（本版本定制：默认关闭，且启动时的自动检查已从代码中移除）
    skipPreRelease: true, // 是否忽略预发布版本
    dock: {
      hideWhenWinClose: false,
    },
    closeStrategy: 0,
    showShutdownTip: true,
    showHomeAd: true,
    homeAd: {
      text: '',
      url: '',
      description: '',
    },

    // 日志相关配置
    logDisabled: false, // 完全禁用日志：控制台不输出，日志文件也不写入
    logDetail: false, // 详细调试日志：保留 URL path 等；仍会脱敏凭据。问题排查时再开
    migratedTo: '', // 数据迁移标记，如 '3.0.0'；空表示尚未执行对应迁移
    logFileSavePath: path.join(configLoader.getUserBasePath(), '/logs'), // 日志文件保存路径
    keepLogFileCount: 15, // 保留日志文件数
    maxLogFileSize: 1, // 最大日志文件大小
    maxLogFileSizeUnit: 'GB', // 最大日志文件大小单位
  },
  server: {
    enabled: true,
    // 绑定IP：代理端口（默认 31181）的监听地址，控制"谁能连你的代理"。
    // 0.0.0.0 = 局域网其它机器也可使用；127.0.0.1 = 仅本机。
    // 注意：MITM 假 TLS 服务器是内部件，始终绑 127.0.0.1，不受此项影响。
    host: '127.0.0.1',
    port: 31181,
    fakeServerMaxLength: 100, // fakeServer的最大缓存数量

    // 【本版本定制】TLS ClientHello 分段发送（TCP segmentation）
    // 作用：把首个 ClientHello 在 TCP 层切成若干小段依次发送，让按 SNI 做 DPI 的中间设备
    //       无法跨段重组出域名，从而放行。不改任何字节 —— SNI 仍是真实域名，证书照常校验，
    //       CDN 也能按真实 SNI 正确路由（这是它相对「SNI 伪装成 baidu.com」的关键优势）。
    // 适用：TCP 能连、但 TLS 握手被 RST 或注入 的站点（典型：只按 SNI 封锁的域名）。
    // 不适用：IP 层就被封锁的站点，或握手后数据面被识别的情况。
    // 作用域：仅 CONNECT 纯隧道；配置在 intercepts 里的域名会被 MITM，走不到这里。
    tlsFragment: {
      enabled: true,
      size: 32, // 每段字节数（太小会增加系统调用开销，太大可能不足以打散 SNI）
      maxBytes: 2048, // 只对首包前 N 字节分段，超出部分一次写完
      domains: [
        '*linux.do',
        '*pixiv.net',
      ],
    },
    setting: {
      NODE_TLS_REJECT_UNAUTHORIZED: true,
      verifySsl: true,
      allowTls12: false,
      script: {
        enabled: true,
        defaultDir: './extra/scripts/',
      },
      userBasePath: configLoader.getUserBasePath(),
      rootCaFile: {
        certPath: getRootCaCertPath(),
        keyPath: getRootCaKeyPath(),
      },

      // 默认超时时间配置
      defaultTimeout: 20000, // 请求超时时间
      defaultKeepAliveTimeout: 30000, // 连接超时时间

      // 指定域名超时时间配置
      timeoutMapping: {
        'github.com': {
          timeout: 20000,
          keepAliveTimeout: 30000,
        },
      },

      // 慢速IP延迟时间：测速超过该值时，则视为延迟高，显示为橙色
      lowSpeedDelay: 200,
    },
    compatible: {
      // **** 自定义兼容配置 **** //
      // connect阶段所需的兼容性配置
      connect: {
        // 参考配置（无path）
        // 'xxx.xxx.xxx.xxx:443': {
        //   ssl: false
        // }
      },
      // request阶段所需的兼容性配置
      request: {
        // 参考配置（配置方式同 `拦截配置`）
        // 'xxx.xxx.xxx.xxx:443': {
        //   '.*': {
        //     rejectUnauthorized: false
        //   }
        // }
      },
    },
    // Cloudflare 路由重定向：命中 Cloudflare IP 段时改写为优选地址
    cloudflareRoute: {
      enabled: false,
      preferredEndpoint: '', // 优选地址，可填写 IP 或 CNAME 域名
    },
    intercept: {
      enabled: true,
    },
    // intercepts / preSetIpList / whiteList / dns 由下方 SYNC:OFFICIAL-FALLBACK 区块从官方配置填充
  },
  proxy: {},
  plugin: {},
  help: {},
}

// >>> SYNC:OFFICIAL-FALLBACK:BEGIN
// 「internal 底本」：官方配置的规则类节点，由 _script/sync-official-config.mjs 在构建时自动更新，请勿手改。
// 来源地址：https://ds-official-config.bestar.de5.net/remote_config.json5
// 来源版本：202610122340（修复部分规则匹配过宽的问题）
// 下载失败时脚本不会改动本区块，即保留上一次的同步结果。
// 用 Object.assign 整体替换（不是深合并），这样官方「删掉」的键也会跟着消失。
/* eslint-disable no-template-curly-in-string -- 官方配置里存在 ${...} 形式的普通字符串（如代理目标），并非模板串 */
Object.assign(defaultConfig, {
  proxy: {
    // 【本版定制】官方配置默认 false（不排除国内域名），导致所有国内网站都要绕道
    // 127.0.0.1:31181 做 MITM 转发，极卡。改为 true，让国内域名直连。
    excludeDomesticDomainAllowList: true,
    // 【本版定制】官方配置把白名单源指向第三方代理 ghproxy.net，改为 GitHub 原始地址，
    // 避免启动时向第三方发送请求。
    remoteDomesticDomainAllowListFileUrl: 'https://raw.githubusercontent.com/pluwen/china-domain-allowlist/refs/heads/main/allow-list.sorl',
    excludeIpList: {
      'objects-origin.githubusercontent.com': true,
      '*.ghproxy.net': true,
      '*.ghp.ci': true,
      '*.kkgithub.com': true,
      '*.dgithub.xyz': true,
      'pages.github.com': true,
      'help.github.com': true,
      'docs.github.com': true,
      '*.github.blog': true,
      'analytics.githubassets.com': true,
      'ghcc.githubassets.com': true,
      'www.docker.com': true,
      'login.docker.com': true,
      'api.dso.docker.com': true,
      'desktop.docker.com': true,
      'docs.docker.com': true,
      '*.live.com': null,
      '*.s-microsoft.com': true,
      '*.xboxlive.com': true,
      '*.mihoyo.com': true,
      '*.elastic.co': false,
      '*.bilicomic.com': true,
      '[2049:8c54:813:10c::140]': true,
      '[2409:8a0c:a442:ff40:a51f:4b9c:8b41:25ea]': true,
      '[2606:2800:147:120f:30c:1ba0:fc6:265a]': true,
      '*.cmicapm.com': true,
      '*.cloudflare-cn.com': true,
      '*.microsoftonline.com': true,
      '*.msedge.net': true,
      '*kaspersky*.com': true,
      '*.upd.kaspersky.com': true,
      '*.lanhuapp.com': true,
      '*.soboten.com': true,
      '*.sandboxie-plus.com': true,
      '*.wuyou.net': true,
      '*.pyecharts.org': true,
      '*.bcloudlink.com': true,
      '*.qijishow.com': true,
      '*.z-lib.fo': true,
      '*.finalshell.com': true,
      '*.minebbs.com': true,
      '*.spigotmc.org': true,
      '*.virustotal.com': true,
      '*.gitlab.com': true,
      '*.deepseek.com': true,
      '*steaminventoryhelper.com': true,
      '*.youdemai.com': true,
      '*.casualthink.com': true,
      '44.239.165.12': true,
      '3.164.110.117': true,
      'cn.*': null,
      'challenges.cloudflare.com': null,
    },
  },
  plugin: {
    free_eye: {
      Route: {
        timeout: 0.1,
        addrs: {
          IPv4: '8.8.8.8',
          IPv6: '2001:4860:4860::8888',
        },
        port: 53,
      },
      DNS: {
        timeout: 3,
        allow: [
          'baidu.cn',
          'taobao.com',
          'www.gov.cn',
        ],
        block: [
          'wikipedia.org',
          'youtube.com',
          'facebook.com',
        ],
      },
      TCP: {
        timeout: 3,
        addrs: {
          IPv4: {
            allow: [
              '114.114.114.114',
              '223.6.6.6',
            ],
            block: [
              '8.8.8.8',
              '1.1.1.1',
            ],
          },
          IPv6: {
            allow: [
              '2402:4e00::',
              '2400:3200:baba::1',
            ],
            block: [
              '2001:4860:4860::8888',
              '2606:4700:4700::1111',
            ],
          },
        },
        ports: [
          80,
          443,
        ],
      },
      TLS: {
        timeout: 3,
        addrs: {
          IPv4: '172.67.148.147',
          IPv6: '2606:4700:3036::ac43:9493',
        },
        snis: {
          allow: 'baidu.cn',
          block: 'wikipedia.org',
        },
      },
    },
  },
  help: {
    dataList: [
      {
        title: '〇、远程配置说明',
        rowClass: 'title1',
        children: [
          {
            title: '从2.0.2起，dev-sidecar原生支持显示配置元数据，不再额外手动标注。',
            rowClass: 'title2',
          },
        ],
      },
      {
        title: '一、问题处理',
        rowClass: 'title1',
        children: [
          {
            title: '1、解决Github访问不了或速度很慢的问题（切换高速IP）',
            url: 'https://github.com/docmirror/dev-sidecar/wiki/%E8%A7%A3%E5%86%B3Github%E8%AE%BF%E9%97%AE%E4%B8%8D%E4%BA%86%E6%88%96%E9%80%9F%E5%BA%A6%E5%BE%88%E6%85%A2%E7%9A%84%E9%97%AE%E9%A2%98',
          },
          {
            title: '2、Linux安装证书失败的避坑（Linux手动安装证书详细教程）',
            url: 'https://github.com/docmirror/dev-sidecar/issues/238',
          },
          {
            title: '3、解决Linux（deb）系统下无法安装根证书的问题（如何以root启动dev-sidecar）',
            url: 'https://github.com/docmirror/dev-sidecar/issues/135',
          },
          {
            title: '4、在Arch/Fedora下的证书安装',
            url: 'https://github.com/docmirror/dev-sidecar/issues/204',
          },
          {
            title: '5、在 WSL 中的使用方法（debian系Linux手动安装证书简明教程）',
            url: 'https://github.com/docmirror/dev-sidecar/issues/73',
          },
          {
            title: '6、macOS提示“dev-sidecar.app已损坏/不安全”',
            url: 'https://github.com/docmirror/dev-sidecar/issues/471',
          },
          {
            title: '> 点击前往Issue区查找更多帮助信息',
            url: 'https://github.com/docmirror/dev-sidecar/issues?q=state%3Aclosed%20label%3A%22%E5%85%B6%E4%BB%96%E7%94%A8%E6%88%B7%E5%8F%AF%E5%8F%82%E8%80%83%22',
          },
        ],
      },
      {
        title: '二、功能说明',
        rowClass: 'title1',
        children: [
          {
            title: '> 功能太多，点击前往Wiki页面查看',
            url: 'https://github.com/docmirror/dev-sidecar/wiki',
          },
        ],
      },
      {
        title: '三、DevSidecar技术交流群',
        rowClass: 'title1',
        children: [
          {
            title: 'QQ 1群：390691483，人数：500 / 500（满）',
            url: 'http://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=hIG_VClE1CU2gHuLSSTaazMlo6M760iL&authKey=5VUMMwzH5FeabLDbZNZJbqmZk1gfmB%2B%2FlotO%2Brszz%2BW3E8xwKD2hTg2%2FV2LJEKL7&noverify=0&group_code=390691483',
          },
          {
            title: 'QQ 2群：667666069，人数：500 / 500（满）',
            url: 'http://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=n4nksr4sji93vZtD5e8YEHRT6qbh6VyQ&authKey=XKBZnzmoiJrAFyOT4V%2BCrgX5c13ds59b84g%2FVRhXAIQd%2FlAiilsuwDRGWJct%2B570&noverify=0&group_code=667666069',
          },
          {
            title: 'QQ 3群：419807815，人数：500 / 500（满）',
            url: 'http://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=zRkm0eHUhRmWWJA5O35C7BOKPZ4_gmrz&authKey=X9JHezR1BOalcEmvV6If04TN%2BIbzjAayBDaOSiuOg1SPpPguA7RqoLSHVEeo7A4e&noverify=0&group_code=419807815',
          },
          {
            title: 'QQ 4群：438148299，人数：1012 / 2000（推荐）',
            url: 'http://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=i_NCBB5f_Bkm2JsEV1tLs2TkQ79UlCID&authKey=nMsVJbJ6P%2FGNO7Q6vsVUadXRKnULUURwR8zvUZJnP3IgzhHYPhYdcBCHvoOh8vYr&noverify=0&group_code=438148299',
          },
          {
            title: 'QQ 5群：767622917，人数：200 / 500',
            url: 'http://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=nAWi_Rxj7mM4Unp5LMiatmUWhGimtbcB&authKey=aswmlWGjbt3GIWXtvjB2GJqqAKuv7hWjk6UBs3MTb%2Biyvr%2Fsbb1kA9CjF6sK7Hgg&noverify=0&group_code=767622917',
          },
        ],
      },
      {
        title: '四、版本更新日志和下载地址',
        rowClass: 'title1',
        url: 'https://github.com/docmirror/dev-sidecar/releases',
        children: [
          {
            title: 'v2.3.x',
            rowClass: 'title2',
            children: [
              {
                title: '[ 2026-10-03 ] v2.3.0（支持 ECH 加密 SNI、请求自动重试，新增「日志与流量」「GitHub 状态监控」页）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.3.0',
              },
            ],
          },
          {
            title: 'v2.2.x',
            rowClass: 'title2',
            children: [
              {
                title: '[ 2026-07-02 ] v2.2.0（实验性自动更新、HTTP/2 代理、按需 IP 探测，修复诸多安全漏洞）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.2.0',
              },
            ],
          },
          {
            title: 'v2.1.x',
            rowClass: 'title2',
            children: [
              {
                title: '[ 2026-06-29 ] v2.1.1（修复 v2.1.0 中的问题及诸多安全漏洞）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.1.1',
              },
              {
                title: '[ 2026-06-28 ] v2.1.0（稳定性提升，free eye 插件回归）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.1.0',
              },
            ],
          },
          {
            title: 'v2.0.x',
            rowClass: 'title2',
            children: [
              {
                title: '待办事项',
                url: 'https://github.com/docmirror/dev-sidecar/milestone/9',
              },
              {
                title: '[ 2026-04-18 ] v2.0.2（支持IPv6、性能和稳定性提升）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.0.2',
              },
              {
                title: '[ 2026-04-12 ] v2.0.1（可在支持IPv6网络直连看YouTube视频了）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.0.1',
              },
              {
                title: '[ 2026-02-02 ] v2.0.0.3（修复脚本插入的 BUG）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.0.0.3',
              },
              {
                title: '[ 2025-12-31 ] v2.0.1-test（测试版：从 v2.0.0.2 继承，引入 free eye 插件、修复导入 BUG；版本号故意不合规以避免触发自动更新）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.0.1-test',
              },
              {
                title: '[ 2025-05-15 ] v2.0.0.2',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.0.0.2',
              },
              {
                title: '[ 2025-03-06 ] v2.0.0.1（修复了UDP类型DNS并发调用时IP赋值混乱的问题）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.0.0.1',
              },
              {
                title: '[ 2025-03-05 ] v2.0.0',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.0.0',
              },
              {
                title: '[ 2025-02-18 ] v2.0.0-RC6',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.0.0-RC6',
              },
              {
                title: '[ 2025-02-07 ] v2.0.0-RC5',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.0.0-RC5',
              },
              {
                title: '[ 2025-01-22 ] v2.0.0-RC4',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.0.0-RC4',
              },
              {
                title: '[ 2025-01-13 ] v2.0.0-RC3（存在应用启动失败BUG，建议升级到 v2.0.0-RC4 及以上版本）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.0.0-RC3',
              },
              {
                title: '[ 2025-01-10 ] v2.0.0-RC2',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.0.0-RC2',
              },
              {
                title: '[ 2024-12-10 ] v2.0.0-RC1',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v2.0.0-RC1',
              },
            ],
          },
          {
            title: 'v1.8.x',
            rowClass: 'title2',
            children: [
              {
                title: '[ 2024-11-07 ] v1.8.9',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.8.9',
              },
              {
                title: '[ 2024-10-18 ] v1.8.8（紧急修复彩蛋BUG）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.8.8',
              },
              {
                title: '[ 2024-10-17 ] v1.8.7（存在彩蛋BUG，建议升级到 v1.8.8 及以上版本）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.8.7',
              },
              {
                title: '[ 2024-09-30 ] v1.8.6（存在彩蛋BUG，建议升级到 v1.8.8 及以上版本）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.8.6',
              },
              {
                title: '[ 2024-09-20 ] v1.8.5（存在彩蛋BUG，建议升级到 v1.8.8 及以上版本）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.8.5',
              },
              {
                title: '[ 2024-09-09 ] v1.8.4',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.8.4',
              },
              {
                title: '[ 2024-08-27 ] v1.8.3',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.8.3',
              },
              {
                title: '[ 2024-07-08 ] v1.8.2',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.8.2',
              },
              {
                title: '[ 2024-04-28 ] v1.8.1',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.8.1',
              },
              {
                title: '[ 2024-04-08 ] v1.8.0',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.8.0',
              },
            ],
          },
          {
            title: 'v1.7.x',
            rowClass: 'title2',
            children: [
              {
                title: '[ 2022-03-14 ] v1.7.3',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.7.3',
              },
              {
                title: '[ 2021-12-06 ] v1.7.2',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.7.2',
              },
              {
                title: '[ 2021-11-23 ] v1.7.1（升级 electron 版本，修复证书过期与 GitHub 静态资源加载问题）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.7.1',
              },
              {
                title: '[ 2021-11-21 ] v1.7.0',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.7.0',
              },
            ],
          },
          {
            title: 'v1.6.x',
            rowClass: 'title2',
            children: [
              {
                title: '[ 2021-09-12 ] v1.6.2（默认配置支持远程更新，mac 顶栏图标跟随主题切换）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.6.2',
              },
              {
                title: '[ 2021-08-21 ] v1.6.1（修复 Windows 下无法开机自启的问题）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.6.1',
              },
              {
                title: '[ 2021-08-19 ] 1.6.0（支持 Ubuntu，Mac 应用名改为小写）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/1.6.0',
              },
            ],
          },
          {
            title: 'v1.5.x',
            rowClass: 'title2',
            children: [
              {
                title: '[ 2021-04-05 ] v1.5.1（支持增量更新）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.5.1',
              },
              {
                title: '[ 2021-03-27 ] v1.5.0（新增模式切换与 IP 测速功能）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.5.0',
              },
            ],
          },
          {
            title: 'v1.4.x',
            rowClass: 'title2',
            children: [
              {
                title: '[ 2021-01-10 ] v1.4.0（支持 mac）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.4.0',
              },
            ],
          },
          {
            title: 'v1.3.x',
            rowClass: 'title2',
            children: [
              {
                title: '[ 2020-12-04 ] v1.3.1（新增 git 代理开关与增强功能）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.3.1',
              },
              {
                title: '[ 2020-12-04 ] v1.3.0（新增 git 代理开关与增强功能）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.3.0',
              },
            ],
          },
          {
            title: 'v1.2.x',
            rowClass: 'title2',
            children: [
              {
                title: '[ 2020-11-29 ] v1.2.2（修复 win7 设置代理不生效、360 设置代理缓慢）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/v1.2.2',
              },
              {
                title: '[ 2020-11-19 ] 1.2.0（修复 GitHub README 引用图片打不开，新增插入脚本功能）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/1.2.0',
              },
            ],
          },
          {
            title: 'v1.1.x',
            rowClass: 'title2',
            children: [
              {
                title: '[ 2020-11-14 ] 1.1.0（新增日志，修复升级后未完全退出导致的升级失败）',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/1.1.0',
              },
            ],
          },
          {
            title: 'v1.0.x',
            rowClass: 'title2',
            children: [
              {
                title: '[ 2020-11-11 ] 1.0.2',
                url: 'https://github.com/docmirror/dev-sidecar/releases/tag/1.0.2',
              },
            ],
          },
        ],
      },
    ],
  },
})
Object.assign(defaultConfig.server, {
  intercepts: {
    'github.com': {
      // 【本版本定制】已移除原本的 tampermonkeyScript / script 远程脚本注入规则（原本指向 ds-official-config.bestar.de5.net）
      '^(/[\\w-.]+){2,}/?(\\?.*)?$': null,
      '^((/[^/]+){2,})/raw((/[^/]+)+\\.(jpg|jpeg|png|gif))(\\?.*)?$': {
        sni: 'baidu.com',
        cacheDays: 365,
        desc: '仓库内图片重定向，缓存1年。',
      },
      '^((/[^/]+){2,})/raw((/[^/]+)+\\.js)(\\?.*)?$': {
        sni: 'baidu.com',
        responseReplace: {
          headers: {
            'content-type': 'application/javascript; charset=utf-8',
          },
        },
        desc: '仓库内脚本，设置响应头Content-Type。作用：方便script拦截器直接使用，避免引起跨域问题和脚本内容限制问题。',
      },
      '.*': {
        sni: 'baidu.com',
      },
    },
    'api.github.com': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    'github.githubassets.com': {
      // 【本版本定制】已移除 '/assets/fakefile.js' 条目（它只服务于远程脚本注入）
      '^(/[^/]+)*/[^./]+\\.(svg|png|gif|jpg|jpeg|ico|js|css)(\\?.*)?$': {
        cacheDays: 365,
        sni: 'baidu.com',
        desc: '图片、JS文件、CSS文件，缓存1年',
      },
    },
    'opengraph.githubassets.com': {
      '^/(([^/]+/){3}issues/\\d+)?(\\?.*)?$': {
        cacheDays: 365,
      },
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*.githubusercontent.com': {
      '.*': {
        sni: 'baidu.com',
        requestReplace: {
          headers: {
            'accept-language': 'en-US,en;q=0.8',
          },
        },
      },
    },
    'collector.github.com': {
      '/github/collect': {
        success: true,
        status: 204,
        desc: '采集数据，快速成功',
      },
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*.github.io': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*.gravatar.com': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*.windows.net': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '(userlocations|locationhistory-pa|locationhistoryaggregates-pa|locationhistoryplacedetails-pa).googleapis.com': {
      '.*': {
        abort: true,
      },
    },
    '*.googleapis.com': {
      '.*': {
        sni: 'www.google.cn',
      },
    },
    'fonts.googleapis.com': {
      '.*': {
        proxy: 'fonts.googleapis.cn',
      },
    },
    'ajax.googleapis.com': {
      '.*': {
        proxy: 'ajax.proxy.ustclug.org',
        desc: '根据2026年4月24日时访问https://mirrors.ustc.edu.cn 的说明，修正internal v202604122348中指向ajax.lug.ustc.edu.cn的配置',
      },
    },
    'www.google.com': {
      '/recaptcha/.*': {
        proxy: 'www.recaptcha.net',
        desc: 'reCAPTCHA 静态资源走国内镜像，与下方 www.gstatic.com 的同源规则配套',
      },
    },
    '^(?!.*(translate-pa).google(?:apis|usercontent)?.com).*google(?:apis|usercontent)?.com$': {
      '.*': {
        sni: 'www.google.cn',
        desc: '部分需要走其它代理的服务',
      },
    },
    '^.*(youtube.com|gstatic.com|youtube.nocookie.com|youtu.be|ggpht.com|i.ytimg.com|blogger.com|doodles.google|about.google|android.com)$': {
      '.*': {
        sni: 'www.google.cn',
      },
    },
    '^.*\\.google\\.com(\\.\\w+)?$': {
      '.*': {
        sni: 'www.google.cn',
      },
    },
    '^(?<pre>.*).googlevideo.com$': {
      '.*': {
        proxy: '\${pre}.xn--ngstr-lra8j.com',
        sni: 'g.cn',
        options: true,
      },
    },
    'www.gstatic.com': {
      '/recaptcha/.*': {
        proxy: 'www.recaptcha.net',
      },
    },
    'ms-sso.copilot.microsoft.com': {
      '.*': {
        sni: 'microsoft.com',
        verifyHost: 'graph.windows.net',
      },
    },
    '*.pixiv.org': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*.pximg.net': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*.nikke-global.com': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    'i.pximg.net': {
      '.*': {
        cacheDays: 365,
        requestReplace: {
          headers: {
            referer: 'https://www.pixiv.net/',
          },
          desc: '篡改请求头\'Referer\'，使Pixiv图片链接可以单独在浏览器打开',
        },
      },
    },
    '*.youtube.com': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*.youtu.be': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*.youtube-nocookie.com': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*.ggpht.com': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    'i.ytimg.com': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    'cdn.jsdelivr.net': {
      '^/.*\\.(js|css|png|jpg|jpeg|gif|json)(\\?.*)?$': {
        proxy: 'fastly.jsdelivr.net',
        backup: [
          'gcore.jsdelivr.net',
        ],
      },
    },
    '*.huggingface.co': {
      '.*': {
        sni: 'huggingface.cn',
        verifyHost: 'huggingface.cn',
      },
    },
    'update.greasyfork.org': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    'cn.vuejs.org': {
      '.*': {
        sni: 'vuejs.org',
      },
    },
    '*z-library.sk': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*z-lib.help': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '^.*(wikipedia|wikimedia|wikinews|wiktionary|wikiversity|wikidata|wikiquote|wikivoyage|wikifunctions|wikibooks).org$': {
      '.*': {
        sni: 'mediawiki.org',
      },
    },
    '*w.wiki': {
      '.*': {
        sni: 'mediawiki.org',
      },
    },
    '*reddit.com': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*redditstatic.com': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    'redd.it': {
      '.*': {
        redirect: 'www.reddit.com',
      },
    },
    '*redd.it': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*redditmedia.com': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*steamcommunity.com': {
      '.*\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|eot)(\?.*)?$': {
        sni: 'baidu.com',
        cacheDays: 30,
        responseReplace: { headers: { 'alt-svc': '[remove]' } },
      },
      '^(?!/discussions|/Profile|/app.*/discussions).*$': {
        sni: 'baidu.com',
        // 【本版定制】抹除 Alt-Svc，阻止浏览器发现 HTTP/3。DS 是 HTTP 代理，
        // UDP/443 的 QUIC 不会被代理，浏览器一旦走 h3 就完全绕过了 DS。
        responseReplace: { headers: { 'alt-svc': '[remove]' } },
        desc: '讨论区锁区,考虑不拦截丢给彩蛋',
      },
    },
    '^(?!.*cloudflare).*steamstatic.com$': {
      // 【本版定制】Steam 静态资源缓存。原版这里没有任何缓存，
      // 使得每次刷新页面都要回源拉一遍相同的头像/封面/JS/CSS（Steam 资源地址
      // 都带 hash 或时间戳，同 URL 内容不会变），白白多付一次 MITM + 回源 RTT。
      '.*\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|eot)(\?.*)?$': {
        sni: 'baidu.com',
        cacheDays: 30,
        responseReplace: { headers: { 'alt-svc': '[remove]' } },
      },
      '.*': {
        sni: 'baidu.com',
        responseReplace: { headers: { 'alt-svc': '[remove]' } },
      },
    },
    '^(store|checkout).steampowered.com$': {
      '.*': {
        sni: 'baidu.com',
        responseReplace: { headers: { 'alt-svc': '[remove]' } },
      },
    },
    'external-content.duckduckgo.com': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*duckduckgo.com': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*dropbox.com': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*f-droid.org': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    'fdroid.org': {
      '.*': {
        sni: 'baidu.com',
      },
    },
    '*apkmirror.com': {
      '.*': {
        sni: 'none',
      },
    },
    '*.claude.ai': {
      '.*': {
        sni: 'claude.ai',
      },
    },
    'jsd.proxy.aks.moe': {
      '^.*\\?DS_DOWNLOAD$': {
        requestReplace: {
          doDownload: true,
        },
        responseReplace: {
          doDownload: true,
        },
      },
    },
    'fastly.jsdelivr.net': {
      '^.*\\?DS_DOWNLOAD$': {
        requestReplace: {
          doDownload: true,
        },
        responseReplace: {
          doDownload: true,
        },
      },
    },
    'jsdelivr.pai233.top': {
      '^.*\\?DS_DOWNLOAD$': {
        requestReplace: {
          doDownload: true,
        },
        responseReplace: {
          doDownload: true,
        },
      },
    },
    'raw.incept.pw': {
      '^.*\\?DS_DOWNLOAD$': {
        requestReplace: {
          doDownload: true,
        },
        responseReplace: {
          doDownload: true,
        },
      },
    },
    'packages.elastic.co': {
      '.*': {
        proxy: 'elastic.proxy.ustclug.org',
      },
    },
    'ppa.launchpad.net': {
      '.*': {
        proxy: 'launchpad.proxy.ustclug.org',
      },
    },
    'downloads.openwrt.org': {
      '.*': {
        proxy: 'openwrt.proxy.ustclug.org',
      },
    },
    'registry.npmjs.org': {
      '.*': {
        desc: '既然ds有NPM镜像了，这个就没什么必要了，先不配置了',
      },
    },
    'repo1.maven.org': {
      '.*': {
        proxy: 'maven.proxy.ustclug.org',
      },
    },
    '*.instagram.com': {
      '.*': {
        sni: 'g.cn',
      },
    },
    '*.cdninstagram.com': {
      '.*': {
        sni: 'g.cn',
      },
    },
    '*.intercom.io': {
      '.*': {
        sni: 'g.cn',
      },
    },
    '*startpage.com': {
      '.*': {
        sni: 'www.baidu.com',
      },
    },
    // ================== 【定制版新增】S302 规则包补全 ==================
    // 数据来源：S302_rules_latest.ini 共 973 个域名中本版未覆盖的 695 条，按根域归并为 69 项
    // 处理方式沿用 DS 对 *.instagram.com / *startpage.com 的既有做法：SNI 伪装
    // 说明：SNI 伪装只解决「TLS 握手 SNI 被阻断」；若目标 IP 层被封，仍需优选 IP 或中转
    // 关闭单项：在 ~/.dev-sidecar/config.json 里把该键设为 null 即可
    //
    // ⚠ 重要：Cloudflare 托管的目标**不能**用 sni 伪装。CF 按 SNI 选择 zone 与证书，
    //   SNI=baidu.com 而 Host=目标域名时 CF 一律返回 403 Forbidden（实测与 registry.npmjs.org /
    //   discord.com 均如此，且不会有任何回退重试）。这类域名只能靠 ECH，见 server.dns.ech.domains。

    // ---- 社交 / 娱乐 ----
    // Discord 全家桶托管在 Cloudflare，不做 sni（CF 会 403），改由 ech.domains 走 ECH
    '*twitch.tv': { '.*': { sni: 'baidu.com' } },
    '*ttvnw.net': { '.*': { sni: 'baidu.com' } },
    '*jtvnw.net': { '.*': { sni: 'baidu.com' } },
    '*twitchcdn.net': { '.*': { sni: 'baidu.com' } },
    '*spotify.com': { '.*': { sni: 'baidu.com' } },
    'scdn.co': { '.*': { sni: 'baidu.com' } },
    '*.scdn.co': { '.*': { sni: 'baidu.com' } },
    '*pinterest.com': { '.*': { sni: 'baidu.com' } },
    '*pinterest.jp': { '.*': { sni: 'baidu.com' } },
    '*pinterest.kr': { '.*': { sni: 'baidu.com' } },
    '*pinterest.info': { '.*': { sni: 'baidu.com' } },
    '*pinimg.com': { '.*': { sni: 'baidu.com' } },
    '*imgur.com': { '.*': { sni: 'baidu.com' } },
    '*artstation.com': { '.*': { sni: 'baidu.com' } },
    '*fandom.com': { '.*': { sni: 'baidu.com' } },
    '*nocookie.net': { '.*': { sni: 'baidu.com' } },

    // ---- 游戏平台 / 模组 ----
    '*epicgames.com': { '.*': { sni: 'baidu.com' } },
    'ubi.com': { '.*': { sni: 'baidu.com' } },
    '*.ubi.com': { '.*': { sni: 'baidu.com' } },
    '*p76prod.systems': { '.*': { sni: 'baidu.com' } },
    '*minecraft.net': { '.*': { sni: 'baidu.com' } },
    '*mojang.com': { '.*': { sni: 'baidu.com' } },
    '*minecraftservices.com': { '.*': { sni: 'baidu.com' } },
    // nexusmods / modcdn / parsec / battlemetrics / blockbench / steamdb 托管在 Cloudflare，
    // 不做 sni（CF 会 403），改由 ech.domains 走 ECH
    '*nexus-cdn.com': { '.*': { sni: 'baidu.com' } },
    'mod.io': { '.*': { sni: 'baidu.com' } },
    '*.mod.io': { '.*': { sni: 'baidu.com' } },
    'itch.io': { '.*': { sni: 'baidu.com' } },
    '*.itch.io': { '.*': { sni: 'baidu.com' } },
    '*hsguru.com': { '.*': { sni: 'baidu.com' } },
    '*opencritic.com': { '.*': { sni: 'baidu.com' } },
    '*gamespot.com': { '.*': { sni: 'baidu.com' } },

    // ---- Steam（原版只覆盖 store/checkout/community/.steamstatic.com，以下为缺口）----
    // 【实测修正】这三个域名的 SNI 从未被墙，伪装成 baidu.com 反而直接不通：
    //   api.steampowered.com   + sni:'baidu.com' → ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR
    //   login.steampowered.com + sni:'baidu.com' → 同上（Steam 登录直接失败）
    // 真实 SNI @ 23.201.103.x 实测：api total=127ms、login 302/301ms，TCP 仅 25~28ms。
    // 保留拦截器只为抹除 Alt-Svc（阻断 HTTP/3），上游一律用真实 SNI。
    'api.steampowered.com': { '.*': { responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    'login.steampowered.com': { '.*': { responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    'help.steampowered.com': { '.*': { responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    '*steam-chat.com': { '.*': { sni: 'baidu.com', responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    '*cloudflare.steamstatic.com': { '.*': { sni: 'baidu.com', responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    '*steamusercontent.com': { '.*': { sni: 'baidu.com', responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    // 【实测修正】eccdnx 是 Steam 的国内 CDN（白山→阿里），实测：
    //   真实 SNI @ media.st.dl.eccdnx.com → 2/2 通 382ms
    //   伪装 baidu.com                      → ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE
    // 它本来就不被墙，伪装只会让服务器認不得 SNI。
    '*st.dl.eccdnx.com': { '.*': { responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    '*queniujq.cn': { '.*': { sni: 'baidu.com', responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    'replay.csgo.com.cn': { '.*': { sni: 'baidu.com', responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    'steamstore-a.akamaihd.net': { '.*': { sni: 'baidu.com', responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    'steamcommunity-a.akamaihd.net': { '.*': { sni: 'baidu.com', responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    'steamcdn-a.akamaihd.net': { '.*': { sni: 'baidu.com', responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    'steamuserimages-a.akamaihd.net': { '.*': { sni: 'baidu.com', responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    'steamvideo-a.akamaihd.net': { '.*': { sni: 'baidu.com', responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    'steamusercontent-a.akamaihd.net': { '.*': { sni: 'baidu.com', responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    'steambroadcast.akamaized.net': { '.*': { sni: 'baidu.com', responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    'steambroadcastchat.akamaized.net': { '.*': { sni: 'baidu.com', responseReplace: { headers: { 'alt-svc': '[remove]' } } } },
    'epicgames-download1.akamaized.net': { '.*': { sni: 'baidu.com', responseReplace: { headers: { 'alt-svc': '[remove]' } } } },

    // ---- 云盘 / 下载 ----
    'mega.io': { '.*': { sni: 'baidu.com' } },
    '*.mega.io': { '.*': { sni: 'baidu.com' } },
    'mega.nz': { '.*': { sni: 'baidu.com' } },
    '*.mega.nz': { '.*': { sni: 'baidu.com' } },
    '*mega.co.nz': { '.*': { sni: 'baidu.com' } },
    '*yandex.com': { '.*': { sni: 'baidu.com' } },
    '*yandex.net': { '.*': { sni: 'baidu.com' } },
    '*yandex.ru': { '.*': { sni: 'baidu.com' } },
    '*dropboxusercontent.com': { '.*': { sni: 'baidu.com' } },
    '*pixeldrain.com': { '.*': { sni: 'baidu.com' } },

    // ---- 开发者 / 素材 ----
    '*vercel.app': { '.*': { sni: 'baidu.com' } },
    '*vercel.com': { '.*': { sni: 'baidu.com' } },
    '*xda-developers.com': { '.*': { sni: 'baidu.com' } },
    '*xdaforums.com': { '.*': { sni: 'baidu.com' } },
    'hf.co': { '.*': { sni: 'baidu.com' } },
    '*.hf.co': { '.*': { sni: 'baidu.com' } },
    // unpkg / cloudflarestorage 托管在 Cloudflare，不做 sni，改由 ech.domains 走 ECH
    '*docker.io': { '.*': { sni: 'baidu.com' } },
    'support-assets.githubassets.com': { '.*': { sni: 'baidu.com' } },

    // ---- 人机验证 ----
    // hcaptcha 托管在 Cloudflare，不做 sni，改由 ech.domains 走 ECH
    '*arkoselabs.com': { '.*': { sni: 'baidu.com' } },
    '*recaptcha.net': { '.*': { sni: 'baidu.com' } },

    // ---- TLS 指纹伪装（TLS Fingerprint Impersonation）----
    // 【定制版新增】用 wreq-js（Rust + BoringSSL）把上游 ClientHello 指纹伪装成真实浏览器，
    // 绕过按 JA3/JA4 指纹判定并 RST 的站点。默认**未启用任何域名**。
    //
    // 启用方式（取消注释并改成自己需要的域名）：
    //   'example.com': { '.*': { fingerprint: 'chrome_149' } },
    //
    // 可选字段：
    //   fingerprint         —— 浏览器档位，共 133 个：chrome_100~chrome_149、firefox_*、safari_*、
    //                          edge_*、opera_*、okhttp_* 等。完整列表见接口 GET /wreq-profiles 或
    //                          require('wreq-js').getProfiles()
    //   fingerprintOs       —— 伪装的操作系统：windows / macos / linux / android / ios（不填跟随档位）
    //   fingerprintTimeout  —— 上游超时毫秒数，默认 30000
    //
    // 使用前提（重要）：
    //   1. 本拦截器会接管整个请求，与 sni / unVerifySsl / ech / proxy 互斥（只有 fingerprint 生效）；
    //   2. 它只能解决「TCP 通、TLS 握手被按指纹 RST」的情形；对 IP 层被封、或需要 SNI 伪装的站点无效；
    //   3. 仍会先走 dev-sidecar 自己的 DNS（doH / preSetIpList），解析结果通过 wreq 的 resolve 透传，
    //      不会退回被污染的系统 DNS。
    //
    // 配置示例（pixiv 这类「IP 不通」的站点加了也没用，请先用 fingerprint 测 TCP 是否可达）：
    //   'pixiv.net': { '.*': { fingerprint: 'chrome_149', fingerprintTimeout: 20000 } },
  },
  preSetIpList: {
    'github.com': {
      '20.200.245.247': true,
      '20.27.177.113': true,
      '20.205.243.166': true,
      '20.26.156.215': false,
      '20.87.245.0': false,
      '4.237.22.38': false,
      '20.201.28.151': false,
      '140.82.113.3': false,
      '140.82.114.4': false,
      '140.82.116.3': false,
      '140.82.116.4': false,
      '140.82.121.3': false,
      '140.82.121.4': false,
    },
    'gist.github.com': {
      '20.27.177.113': true,
      '20.200.245.247': true,
      '20.205.243.166': false,
      '140.82.116.3': true,
      '140.82.116.4': true,
      '4.237.22.38': true,
    },
    'github.dev': {
      '20.43.185.14': true,
      '20.99.227.183': true,
      '51.137.3.17': true,
      '52.224.38.193': true,
    },
    'github.githubassets.com': {
      '2606:50c0:8000::154': true,
      '2606:50c0:8001::154': true,
      '2606:50c0:8002::154': true,
      '2606:50c0:8003::154': true,
      '185.199.108.154': true,
      '185.199.109.154': true,
      '185.199.110.154': true,
      '185.199.111.154': true,
    },
    '*.githubusercontent.com': {
      '185.199.111.133': true,
      '185.199.108.133': true,
      '185.199.109.133': true,
      '185.199.110.133': true,
    },
    'i.pximg.net': {
      '210.140.139.132': true,
      '210.140.139.137': true,
      '203.137.29.48': true,
      '210.140.139.134': true,
      '203.137.29.49': true,
      '210.140.139.133': true,
      '210.140.139.135': true,
      '203.137.29.47': true,
    },
    'a.pixiv.org': {
      '210.140.139.182': true,
      '210.140.139.183': true,
      '210.140.139.184': true,
    },
    'api.fanbox.cc': {
      '172.64.146.116': true,
    },
    '*.fanbox.cc': {
      '210.140.139.155': true,
    },
    '^(aistudio|.*pa.clients6|apis|gemini|console.cloud|notebooklm|mail).google.com$': {
      '8.137.102.117': {
        desc: 'AI Studio相关,阿里云,解锁地区限制,新加坡,仅大陆访问',
      },
      '47.102.115.14': false,
    },
    'stitch.withgoogle.com': {
      '8.137.102.117': {
        desc: 'AI Studio相关,阿里云,解锁地区限制,新加坡,仅大陆访问',
      },
      '47.102.115.14': false,
    },
    'scholar.googleusercontent.com': {
      '142.251.190.206': true,
      '172.217.204.206': true,
      '172.253.122.206': true,
    },
    '(*account*|scholar).google.com': {
      '172.217.204.206': true,
      '142.251.189.206': true,
    },
    '^(?!fonts).*(with)?google(apis|usercontent)?.com.*$': {
      '8.137.102.117': false,
      '142.251.189.206': {
        desc: '自动地区官方',
      },
    },
    '^(.*\\.)?usercontent\\.goog$': {
      '47.102.115.14': {
        desc: '阿里云中转,日本,实测0.45s,首选',
      },
      '8.137.102.117': {
        desc: '阿里云中转,新加坡,实测0.50s,备用',
      },
    },
    '^.*(youtube.com|gstatic.com|youtube.nocookie.com|youtu.be|ggpht.com|i.ytimg.com|blogger.com|doodles.google|about.google|android.com|antigravity.google)$': {
      '8.137.102.117': false,
      '142.251.189.206': {
        desc: '自动地区官方',
      },
    },
    '*.youtube.com': {
      '8.137.102.117': false,
      '142.251.189.206': {
        desc: '自动地区官方',
      },
    },
    '*.youtu.be': {
      '8.137.102.117': false,
      '142.251.189.206': {
        desc: '自动地区官方',
      },
    },
    '*.youtube-nocookie.com': {
      '8.137.102.117': false,
      '142.251.189.206': {
        desc: '自动地区官方',
      },
    },
    '*.ggpht.com': {
      '8.137.102.117': false,
      '142.251.189.206': {
        desc: '自动地区官方',
      },
    },
    'i.ytimg.com': {
      '8.137.102.117': false,
      '142.251.189.206': {
        desc: '自动地区官方',
      },
    },
    '*.gstatic.com': {
      '8.137.102.117': false,
      '142.251.189.206': {
        desc: '自动地区官方',
      },
    },
    '*.huggingface.co': {
      '3.167.200.113': true,
    },
    '*.greasyfork.org': {
      '96.126.98.220': true,
      '50.116.4.196': true,
    },
    '*.cn-greasyfork.org': {
      '96.126.98.220': true,
      '50.116.4.196': true,
    },
    '*.instagram.com': {
      '163.70.159.174': true,
      '57.144.144.34': true,
      '57.144.216.34': true,
      '157.240.229.174': true,
      '57.144.188.34': true,
      '157.240.210.174': true,
      '157.240.252.174': true,
      '102.132.97.174': true,
      '31.13.94.174': true,
      '31.13.85.174': true,
      '102.132.104.174': true,
    },
    '*.cdninstagram.com': {
      '57.144.152.192': true,
      '57.144.220.192': true,
      '57.144.216.192': true,
    },
    '*z-library.sk': {
      '176.123.7.105': true,
    },
    '*z-lib.help': {
      '176.123.7.105': true,
    },
    'upload.wikimedia.org': {
      '208.80.153.240': true,
      '185.15.58.240': true,
    },
    '^.*(wikipedia|wikimedia|wikinews|wiktionary|wikiversity|wikidata|wikiquote|wikivoyage|wikifunctions).org$': {
      '208.80.153.224': true,
      '185.15.58.224': true,
    },
    '*w.wiki': {
      '208.80.153.224': true,
      '185.15.58.224': true,
    },
    '*reddit.com': {
      '146.75.33.140': true,
    },
    '*redditstatic.com': {
      '146.75.33.140': true,
    },
    '*redd.it': {
      '146.75.33.140': true,
    },
    '*redditmedia.com': {
      '146.75.33.140': true,
    },
    'community.cloudflare.steamstatic.com': {
      '23.209.46.70': true,
      '104.18.42.105': true,
      '172.64.145.151': true,
    },
    'clientconfig.akamai.steamstatic.com': {
      // 【本版定制】原为 ' 23.208.12.191'（带前导空格），net.isIP 判不通过，
      // 永远连接失败，等于少了一个候选 IP。
      '23.208.12.191': true,
      '23.32.91.19': true,
      '2.16.168.104': true,
      '2.16.168.109': true,
      '23.32.91.17': true,
      '23.208.12.174': true,
    },
    'community.steamstatic.com': {
      '146.75.47.52': true,
      '151.101.91.52': true,
      '199.232.163.52': true,
      '146.75.115.52': true,
      '199.232.215.52': true,
      '199.232.211.52': true,
      '151.101.79.52': true,
    },
    'cdn.steamcommunity.com': {
      '23.221.227.5': true,
    },
    '*.steamcommunity.com': {
      // 104.79.200.218 实测 tcp=252ms / tls=734ms / total=1244ms，比前两个慢 3 倍以上，
      // 留着它只会在前两个 IP 失败时把请求拖入超时。
      '23.209.217.19': true,
      '23.15.140.216': true,
      '104.79.200.218': false,
    },
    '^(store|checkout).steampowered.com$': {
      '23.209.218.108': true,
      '184.31.230.122': true,
      '23.35.102.114': true,
      '104.83.198.104': true,
      '23.51.62.114': true,
      '23.55.98.103': true,
    },
    // ---- 【实测新增】Steam 全站真实 IP 优选 ----
    // 本机实测：Akamai 的 Steam 边缘节点 TCP 仅 20~35ms（国内直连量级），
    // 而原来靠 DNS 解析会被污染到 184.24.154.x（整段 TCP 不通）。
    // 这些 IP 配合真实 SNI 可用；改 sni:'baidu.com' 会落到 a248.e.akamai.net
    // 兑现节点或直接 TLS 报错，因此上面 intercepts 已去掉这些域名的 sni。
    'api.steampowered.com': {
      '23.201.103.36': true,
      '23.201.103.52': true,
      '23.35.148.163': true,
      '23.35.148.167': true,
    },
    'login.steampowered.com': {
      '23.201.103.12': true,
      '23.35.148.164': true,
    },
    'help.steampowered.com': {
      '23.51.128.101': true,
    },
    'cdn.akamai.steamstatic.com': {
      '23.49.104.214': true,
      '23.49.104.198': true,
    },
    'store.akamai.steamstatic.com': {
      '23.49.104.199': true,
      '23.49.104.204': true,
    },
    'shared.akamai.steamstatic.com': {
      '23.49.104.212': true,
      '23.49.104.214': true,
    },
    'cdn.cloudflare.steamstatic.com': {
      '23.210.7.168': true,
      '23.210.7.177': true,
      '23.210.7.179': true,
    },
    'steamstore-a.akamaihd.net': {
      '23.49.104.199': true,
      '23.49.104.204': true,
    },
    'steamcommunity-a.akamaihd.net': {
      '23.49.104.206': true,
      '23.49.104.207': true,
    },
    'steamcdn-a.akamaihd.net': {
      '23.203.133.147': true,
    },
    'steamuserimages-a.akamaihd.net': {
      '23.49.104.196': true,
      '23.49.104.199': true,
    },
    'steamvideo-a.akamaihd.net': {
      '23.49.104.41': true,
    },
    'steamusercontent-a.akamaihd.net': {
      '23.49.104.197': true,
      '23.49.104.210': true,
    },
    'steambroadcast.akamaized.net': {
      '23.217.136.140': true,
      '23.217.136.142': true,
    },
    'steambroadcastchat.akamaized.net': {
      '23.49.104.196': true,
      '23.49.104.214': true,
    },
    'images.steamusercontent.com': {
      '23.49.104.198': true,
      '23.49.104.201': true,
    },
    'steam-chat.com': {
      '23.35.100.199': true,
    },
    '^(.+\\.)?x\\.com$': {
      '172.67.172.22': true,
    },
    '*twimg.com': {
      '172.67.172.22': true,
    },
    '*twitter.com': {
      '172.67.172.22': true,
    },
    '*t.co': {
      '172.67.172.22': true,
    },
    'external-content.duckduckgo.com': {
      '20.43.160.189': true,
    },
    '*duckduckgo.com': {
      '20.43.161.105': true,
    },
    '*onedrive.live.com': {
      '13.107.42.13': true,
    },
    '*dropbox.com': {
      '162.125.248.18': true,
    },
    'forum.f-droid.org': {
      '37.218.242.53': true,
    },
    '*f-droid.org': {
      '37.218.243.72': true,
    },
    'fdroid.org': {
      '37.218.243.72': true,
    },
    '*apkmirror.com': {
      '104.17.67.215': true,
    },
    '*startpage.com': {
      '67.63.58.139': true,
    },
    '*.claude.ai': {
      '2a01:4f8:c2c:123f:64:5:a04f:680a': true,
    },
    'cdn.jsdelivr.net': {
      '104.16.89.20': true,
    },
  },
  whiteList: {
    '*.icloud.com': true,
    '*.lenovo.net': true,
    'localhost': true,
    '127.*.*.*': true,
    '192.168.*.*': true,
    'cn.*': null,
    '192.168.*': null,
  },
  dns: {
    providers: {
      'local': {
        server: '127.0.0.1',
      },
      'aliyun': {
        server: '223.5.5.5',
      },
      'safe360': {
        server: 'tls://dot.360.cn',
        forSNI: true,
      },
      'cf-DoT': {
        // 【定制版重大勘误】原来的 server 是 'tls://1.1.1.1'，实测本网络对 1.1.1.1 是
        // **IP 级全封**：80 / 443 / 853 三个端口全部 timeout（DoT 实测 0/3，每次卡 6007ms）。
        // 而 dns.mapping 里有几十条规则指向 'cf-DoT'（*.github.io、*.cloudflare.com、
        // img.shields.io、*.jetbrains.com ……），导致这些域名每次 DNS 都要白等 6 秒超时，
        // 这是「除了 github 之外其他都很卡」的重要根因之一。
        //
        // 这里保持 provider 名字不变（避免改动几十条 mapping），只把 server 换成
        // 实测可用的 DoT：dns.bebasid.com:853 + SNI=baidu.com → 3/3 成功、234ms、返回正确 IP。
        server: 'tls://dns.bebasid.com',
        sni: 'baidu.com',
      },
      'bebasid': {
        server: 'tls://dns.bebasid.com',
        sni: 'baidu.com',
      },
      'cf-DoH': {
        // 【定制版重大勘误²】原来带 sni:'baidu.com'，实测这对 DoH 是有害的：
        //   带 SNI 伪装：0/3 成功；去掉 SNI：1/3 成功。
        // 原因有两个：
        //   1. Cloudflare 边缘按 SNI 选站点，SNI≠Host 会直接返回 403；
        //   2. https.js 在配了 sni 时会关掉证书校验（SNI 与证书域名不一致必然校验失败）。
        // DoH 本身已经是加密+证书校验的，不需要再用 SNI 伪装去躲，保持真实 SNI 更安全也更快。
        server: 'https://cloudflare-dns.com/dns-query',
      },
      'quad9-ip': {
        server: 'https://9.9.9.9/dns-query',
      },
      'cf-ip': {
        server: 'https://1.1.1.1/dns-query',
      },
      'rubyfish': {
        server: 'https://rubyfish.cn/dns-query',
      },
    },
    mapping: {
      '*.xn--ngstr-lra8j.com': 'bebasid',
      '*.googlevideo.com': 'bebasid',
      '*.gvt1.com': 'bebasid',
      '*.jetbrains.com': 'cf-DoT',
      '*.azureedge.net': 'cf-DoT',
      '*.stackoverflow.com': 'cf-DoT',
      '*.github.io': 'cf-DoT',
      '*.electronjs.org': 'cf-DoT',
      '*.amazonaws.com': 'cf-DoT',
      '*.yarnpkg.com': 'cf-DoT',
      '*.cloudfront.net': 'cf-DoT',
      '*.cloudflare.com': 'cf-DoT',
      'img.shields.io': 'cf-DoT',
      '*.vuepress.vuejs.org': 'cf-DoT',
      '*.gh.docmirror.top': 'cf-DoT',
      '*.v2ex.com': 'cf-DoT',
      '*.pypi.org': 'cf-DoT',
      '*.pixiv.org': 'cf-DoT',
      '*.pximg.net': 'cf-DoT',
      '*.onesignal.com': 'cf-DoT',
      '*.iubenda.com': 'cf-DoT',
      '*.brave.com': 'cf-DoT',
      '*.vsassets.io': 'cf-DoT',
      // ===== 【定制版新增】S302 补全项走境外 DoT，避开国内 DNS 污染 =====
      // Steam 自有 CDN（eccdnx.com / steamstatic / steamusercontent）故意不加，
      // 它们在国内有落地节点，改用境外解析反而会拿到更远的 IP
      '*discord.com': 'cf-DoT',
      '*discord.gg': 'cf-DoT',
      '*discordapp.com': 'cf-DoT',
      '*discordapp.net': 'cf-DoT',
      '*twitch.tv': 'cf-DoT',
      '*ttvnw.net': 'cf-DoT',
      '*jtvnw.net': 'cf-DoT',
      '*twitchcdn.net': 'cf-DoT',
      '*spotify.com': 'cf-DoT',
      'scdn.co': 'cf-DoT',
      '*.scdn.co': 'cf-DoT',
      '*pinterest.com': 'cf-DoT',
      '*pinterest.jp': 'cf-DoT',
      '*pinterest.kr': 'cf-DoT',
      '*pinterest.info': 'cf-DoT',
      '*pinimg.com': 'cf-DoT',
      '*imgur.com': 'cf-DoT',
      '*artstation.com': 'cf-DoT',
      '*fandom.com': 'cf-DoT',
      '*nocookie.net': 'cf-DoT',
      '*epicgames.com': 'cf-DoT',
      'ubi.com': 'cf-DoT',
      '*.ubi.com': 'cf-DoT',
      '*p76prod.systems': 'cf-DoT',
      '*minecraft.net': 'cf-DoT',
      '*mojang.com': 'cf-DoT',
      '*minecraftservices.com': 'cf-DoT',
      '*nexusmods.com': 'cf-DoT',
      '*nexus-cdn.com': 'cf-DoT',
      'mod.io': 'cf-DoT',
      '*.mod.io': 'cf-DoT',
      '*modcdn.io': 'cf-DoT',
      'itch.io': 'cf-DoT',
      '*.itch.io': 'cf-DoT',
      '*parsec.app': 'cf-DoT',
      '*parsecusercontent.com': 'cf-DoT',
      '*battlemetrics.com': 'cf-DoT',
      '*hsguru.com': 'cf-DoT',
      '*opencritic.com': 'cf-DoT',
      '*blockbench.net': 'cf-DoT',
      '*gamespot.com': 'cf-DoT',
      '*steamdb.info': 'cf-DoT',
      // 【本版定制】linux.do 在国内被 DNS 污染（nslookup 返回 Twitter 的 199.59.149.203 /
      // Facebook 的 2a03:2880:: 段），而它只在 ech.domains 里，A 记录仍然走本地 DNS。
      // 实测（2026-10-29）：
      //   bebasid DoT   → 104.20.16.234 / 172.66.166.61  ← 正确，且这两个 IP 实测 TCP 443 分别 177/183ms 可通
      //   aliyun UDP    → 199.96.62.41                   ← 污染
      //   cf-DoH        → SNI=baidu.com 返回 403（CF 要求 SNI 与 Host 一致），真名 SNI 被 RST
      //   cf-DoT        → tls://1.1.1.1 在当前网络 IP 级被封（实测 80/443/853 全部 timeout）
      '*linux.do': 'bebasid',
      // 【本版定制】pixiv.net 不在 Cloudflare 上（下发的 HTTPS 记录里没有 ECH 参数），
      // 放进 ech.domains 只会把它的 A 查询误导向 ECH 专用 DNS。这里改为直接指定 DNS：
      // 实测（2026-10-29）阿里 / 腾讯 / 360 对 pixiv.net 全部返回污染结果
      // （31.13.x / 74.86.3.208 / 185.45.6.103 / 108.160.172.232），
      // 而 bebasid DoT 返回真实段 210.140.139.152~161。
      '*pixiv.net': 'bebasid',
      // 【本版定制】steamcommunity.com 主站同样被污染（128.121.243.77）。
      // 注意：`_lookupWithPreSetIpList()` 优先于 dns.mapping，而 `*.steamcommunity.com`
      // 已有 preSetIpList，所以正常路径不会走到这里。此条仅在预设 IP 全部失败、
      // 回退到「用系统 DNS 解析域名」时充当兜底。
      '*steamcommunity.com': 'cf-DoT',
      'mega.io': 'cf-DoT',
      '*.mega.io': 'cf-DoT',
      'mega.nz': 'cf-DoT',
      '*.mega.nz': 'cf-DoT',
      '*mega.co.nz': 'cf-DoT',
      '*yandex.com': 'cf-DoT',
      '*yandex.net': 'cf-DoT',
      '*yandex.ru': 'cf-DoT',
      '*dropboxusercontent.com': 'cf-DoT',
      '*pixeldrain.com': 'cf-DoT',
      '*vercel.app': 'cf-DoT',
      '*vercel.com': 'cf-DoT',
      '*xda-developers.com': 'cf-DoT',
      '*xdaforums.com': 'cf-DoT',
      'hf.co': 'cf-DoT',
      '*.hf.co': 'cf-DoT',
      '*unpkg.com': 'cf-DoT',
      '*docker.io': 'cf-DoT',
      '*cloudflarestorage.com': 'cf-DoT',
      '*hcaptcha.com': 'cf-DoT',
      '*arkoselabs.com': 'cf-DoT',
      '*recaptcha.net': 'cf-DoT',
    },
    familyMapping: {
      '*.xn--ngstr-lra8j.com': '6',
      '*.googlevideo.com': '6',
      '*.gvt1.com': '6',
      '*.jetbrains.com': '4',
      '*.azureedge.net': '4',
      '*.stackoverflow.com': '4',
      '*.github.com': '4',
      '*github*.com': '4',
      '*.github.io': '4',
      '*.docker.com': '4',
      '*.electronjs.org': '4',
      '*.amazonaws.com': '4',
      '*.yarnpkg.com': '4',
      '*.cloudfront.net': '4',
      '*.cloudflare.com': '4',
      'img.shields.io': '4',
      '*.vuepress.vuejs.org': '4',
      '*.gh.docmirror.top': '4',
      '*.v2ex.com': '4',
      '*.pypi.org': '4',
      '*.pixiv.org': '4',
      '*.pximg.net': '4',
      '*.onesignal.com': '4',
      '*.iubenda.com': '4',
      '*.brave.com': '4',
      '*duckduckgo.com': '4',
      '*.gstatic.com': '4',
      '*.googleapis.com': '4',
      '*.vsassets.io': '4',
    },
    speedTest: {
      enabled: true,
      interval: 60000,
      hostnameList: [
        'google.com',
        'github.com',
      ],
      dnsProviders: [
        'cf-DoT',
        'safe360',
      ],
    },
    ech: {
      domains: [
        '*t.co',
        '*twitter.com',
        '*twimg.com',
        '*sci-hub.pub',
        '^(.+.)?x.com$',
        '*docker.com',
        // 【定制版】pixiv.net 已从这里移除：它不在 Cloudflare 上，
        // 下发的 HTTPS 记录里没有 ECH 参数（实测 SvcParams 只有 1/4/6，key=5 缺失），
        // 而且放在这里会让它的 A 查询被导向 ECH 专用 DNS。A 记录改由 dns.mapping 指定 cf-DoH。
        '*chatgpt.com',
        '*civitai.com',
        '*ldstatic.com',
        'civitai.com',
        '*linux.do',
        'greasyfork.org',
        // ---- 【定制版新增】Cloudflare 托管 + SNI 被封：只能走 ECH，sni 伪装会被 CF 403 ----
        '*discord.com',
        '*discord.gg',
        '*discordapp.com',
        '*discordapp.net',
        '*nexusmods.com',
        '*modcdn.io',
        '*parsec.app',
        '*parsecusercontent.com',
        '*battlemetrics.com',
        '*blockbench.net',
        '*steamdb.info',
        '*unpkg.com',
        '*cloudflarestorage.com',
        '*hcaptcha.com',
      ],
      preSetIpDomains: [
        '*ldstatic.com',
        '*t.co',
        '*twitter.com',
        '*twimg.com',
        '^(.+.)?x.com$',
      ],
      // 【定制版】ECH 专用 DNS 改用 'bebasid'（DoT）：
      //   - cf-DoH（cloudflare-dns.com）在本网络实测只有 1/3 成功率
      //   - bebasid（dns.bebasid.com:853 + SNI=baidu.com）实测 3/3、234ms
      //   - 历史运行日志里有 19 次 `[ECH] 获取到该域名的ECH参数` 来自 bebasid
      dns: 'bebasid',
      enabled: true,
      use: true,
      publicName: 'cloudflare-ech.com',
      cacheSize: 512,
      emptyTtl: 600000,
      minTtl: 60000,
      maxTtl: 3600000,
      tryAllProviders: true,
      parallelDelay: 200,
    },
    nat64: {
      enabled: true,
      prefix: '',
      domains: [
        '*chatgpt.com',
      ],
      // 【定制版】同 ech.dns，改走实测更稳的 DoT
      dns: 'bebasid',
    },
  },
})
Object.assign(defaultConfig.app.metaInfo, {
  version: 202610122340,
  updateLog: '修复部分规则匹配过宽的问题',
})
/* eslint-enable no-template-curly-in-string */
// <<< SYNC:OFFICIAL-FALLBACK:END

/**
 * 修正合并后的远程配置地址：
 * 1. 命中 ONCE_OVERRIDE_DEPRECATED_REMOTE_CONFIG_URLS 的历史官方地址 → 一次性纠正为官方地址；
 * 2. 裸 HTTP 地址 → 改写为 HTTPS（远程配置已不支持裸HTTP，见 ./remote-config-url.js）。
 *
 * 注意：只修正内存中的合并结果，持久化写回由 config-api.js 的 persistRemoteConfigUrlHttps 负责。
 *
 * @param {object} config 合并后的配置
 * @returns {object} 原 config（就地修改）
 */
function applyRemoteConfigUrlFix (config) {
  const remoteConfig = config?.app?.remoteConfig
  if (remoteConfig == null) {
    return config
  }

  if (ONCE_OVERRIDE_DEPRECATED_REMOTE_CONFIG_URLS.includes(remoteConfig.url)) {
    remoteConfig.url = HIGHEST_PRIORITY_ONCE_OVERRIDE_OFFICIAL_REMOTE_CONFIG_URL
  }

  return applyRemoteConfigUrlHttps(config)
}

// 从本地文件中加载配置。此启动快照仅供模块初始化期消费者使用，不属于默认配置。
const configFromFiles = applyRemoteConfigUrlFix(
  configLoader.getConfigFromFiles(configLoader.getUserConfig(), defaultConfig),
)

module.exports = { defaultConfig, configFromFiles, applyRemoteConfigUrlFix }
