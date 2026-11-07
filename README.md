# DevSidecar Clean

> 基于 [docmirror/dev-sidecar](https://github.com/docmirror/dev-sidecar) 二次开发的本地 MITM 代理，专注**隐私**、**稳定**与**实测可用**。
>
> 本项目由 **DS-1017-FLASH** 制作

---

## 一、这是什么

开发者边车（service sidecar）思路的本地代理：在本机监听 `127.0.0.1:31181`，把需要加速的请求接管后转发到更优的落地节点，用于加速 GitHub / NPM / Steam / Docker Hub 等站点。

- 支持 Windows / macOS / Linux
- 通过本地根证书做中间人解密（首次使用需安装证书）
- 全部加速规则、DNS、ECH 配置在「加速服务」页面可视化调整

---

## 二、相对原项目改进了什么

### 2.1 修复致命缺陷

| 问题 | 现象 | 处理 |
|---|---|---|
| CONNECT 隧道不转发数据 | 所有 HTTPS 页面打不开，端口仍回 `200 Connection Established` | 修复 `tlsFragment` 作用域错误 |
| 每条新连接白等 2 秒 | 首屏卡顿，连接复用后恢复，过一阵又卡 | 首包到达即转发，移除 2 秒兜底定时器 |
| 国内网站全量走代理 | 除 GitHub 外全部变慢 | 修正规则匹配导致的误接管 |
| `ENHANCED_SECTIONS is not defined` | 启动即崩溃 | 修复配置加载 |
| 日志明文落盘 | Cookie / `Authorization` 被写进日志文件 | 补全脱敏正则，默认只记录头名 |

### 2.2 DNS 与 ECH

- DoH 客户端按 Chromium 行为重写：补 `User-Agent`、`Accept`、重试与连接复用
- 修复 Cloudflare 托管域名「SNI 伪装必然 403」的错误配置
- `ech.dns` 由「唯一来源」改为「首选来源 + 自动回退」
- ECH 兜底提供方改为**一次性并发 + 5 秒总预算 + 失败冷却**（原实现串行，最坏要等 72 秒）
- A 记录兜底同样加 5 秒总预算，不再逐个超时
- `linux.do` / `pixiv.net` 改用实测可用的 DoT 提供方

### 2.3 Steam 加速

- 按实测重定 SNI 策略：Steam 社区用伪装 SNI，`api/login.steampowered.com` 用真实 SNI（伪装会触发握手失败）
- 抹除 `Alt-Svc` 响应头，阻止浏览器升级 HTTP/3 绕开代理
- 静态资源本地缓存 30 天
- 更新 Steam 社区边缘 IP（旧 Akamai 段已全部不通，原表现为卡 14 秒后 `500`）

### 2.4 隐私与安全

- 删除百度统计（`hm.baidu.com` 上报、路由切换上报）
- 删除启动时自动检查更新
- 远程配置由「24 小时自动拉取」改为**手动触发**
- 删除远程 JS 注入（原可在 `github.com` 同源上下文执行作者下发的脚本）
- 删除 overwall 中转（原会把你访问的 URL、请求头、响应体经作者服务器）
- 删除 P2P 节点分享
- 移除首页第三方徽章等外部资源请求

---

## 三、相对原项目新增了什么

### 3.1 PAC 自动分流（首页 / 托盘开关）

系统代理新增 **PAC 模式**：按域名自动分流，命中加速规则的站点走代理，其余一律直连。

- 规则来源：拦截规则、Docker/NPM 镜像、预设 IP、SMART DNS 映射、ECH 域名、NAT64 域名
- 直连优先：内网地址、白名单、`excludeIpList`
- 开关与「系统代理」互斥，首页一键切换
- 通过 `sysproxy.exe pac` 写入系统配置，与 Windows 的 `DefaultConnectionSettings` 保持一致，不会在广播后被系统还原
- 好处：只有真正需要加速的域名走代理，其它流量保持直连（对本机防火墙、内网访问、下载速度都更友好）

### 3.2 动态上游（现查 CDN 边缘）

对应传统规则里 `dynamic a <上游域名> 443` 的能力：

- 按域名模式配置上游 CNAME，每次解析时**现查**其 A 记录（60 秒缓存）
- 与预设 IP 合并成候选池，一起参与测速与并行拨号
- Akamai 这类 CDN 的边缘 IP 会持续轮换、也会被逐个阻断；写死 IP 一旦全灭就只能干等超时
- 默认已为 Steam 社区/商店配置 4 个 `edgesuite.net` 上游

### 3.3 并行拨号与切换粘性

- 一域多名时按 250ms 阶梯**并发拨号**，先连通者胜（Happy Eyeballs）
- 候选地址池完整交给连接层，不再只回传单个 IP
- 重新解析后**保持当前选中的地址**，不再把 `value` 重置回第一个（原表现为「刚能上、过一会儿又不行」）
- 失败地址按 30 秒起、5 分钟封顶拉黑，成功后立即解禁

### 3.4 TLS 指纹伪装

- 对「TCP 通、TLS 握手被按指纹重置」的站点，可指定浏览器指纹完成握手
- 基于 Rust + BoringSSL 实现，随安装包分发，不影响主流程
- 与 SNI 伪装、ECH、overwall 等互斥，按需启用

### 3.5 工程化

- GitHub Actions 手动触发构建，产物自动发布 Release
- 安装包版本号跟随 Release 标签
- 仅保留 `workflow_dispatch`，不再有自动构建与夜间构建

---

## 四、架构说明

原项目通过 git submodule 引用核心包，本仓库将其内联，便于直接修改：

```
packages/
  core/        配置、插件、系统代理、服务进程管理
  mitmproxy/   本地 MITM 代理、DNS、ECH、拦截器
  gui/         Electron 界面与桥接
```

---

## 五、快速开始

1. 从 [Releases](https://github.com/baipinaaa/dev-sidecar-clean/releases) 下载对应平台安装包
2. 安装后启动，按提示**安装根证书**（`~/.dev-sidecar/dev-sidecar.ca.crt`）
3. 打开首页的「代理服务」开关；按需选择「系统代理」或「PAC 分流」
4. 加速规则在「加速服务」页面调整，保存后自动生效

> 与其它代理软件同时使用时请谨慎：它们都会改写系统代理设置。

---

## 六、构建

需要 Node.js 22+ 与 pnpm。

```bash
pnpm install
cd packages/gui
npm run electron:build
```

或使用 GitHub Actions 的 `build-windows.yml`（手动触发，可指定 tag 自动发布）。

---

## 七、参考项目

| 项目 | 参考内容 |
|---|---|
| [docmirror/dev-sidecar](https://github.com/docmirror/dev-sidecar) | 上游项目，本仓库的起点 |
| [Hana-ame/ech-proxy](https://github.com/Hana-ame/ech-proxy) | PAC 分流思路、系统代理设置方式 |
| [dotnetcore/FastGithub](https://github.com/dotnetcore/FastGithub) | 通过修改 SNI 实现直连加速的思路 |
| [refraction-networking/utls](https://github.com/refraction-networking/utls) | TLS ClientHello 指纹伪装的设计思想 |
| [wreq-js](https://github.com/sqdshguy/wreq-js) | TLS 指纹的 Rust + BoringSSL 实现 |
| [RememberOurPromise/Total-ECH](https://github.com/RememberOurPromise/Total-ECH) | 自建 DoH + ECH 服务端方案 |
| Steamcommunity 302（闭源） | 仅作 CDN 动态上游、边缘 IP 优选等行为参考 |

---

## 八、免责声明

1. 本项目仅供**学习、研究与个人使用**，请在符合当地法律法规与服务条款的前提下使用。
2. 本项目按「现状」提供，**不提供任何明示或暗示的担保**，不保证可用性、稳定性与适用性。
3. 使用本项目产生的一切后果（包括但不限于网络异常、数据丢失、账号风险、违反第三方服务条款）由使用者自行承担，作者不承担任何责任。
4. 本项目会安装本地根证书并解密经过代理的 HTTPS 流量，请仅在**你信任的本机环境**中使用；公共电脑、共享设备请勿安装。
5. 加速能力依赖于第三方网络与 CDN 的可用性，任何站点无法访问均属正常现象，与作者无关。
6. 本项目与上游项目、上述参考项目的作者**均无隶属或背书关系**。
7. 如有侵权，请联系删除；若您不同意上述任何一条，请立即停止使用并删除本项目。

---

## 九、致谢

感谢上游项目 [docmirror/dev-sidecar](https://github.com/docmirror/dev-sidecar) 及其所有贡献者，以及社区中公开分享 ECH、TLS 指纹、CDN 优选经验的开发者。
