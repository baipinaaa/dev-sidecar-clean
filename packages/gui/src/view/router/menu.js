export default function createMenus (app) {
  const plugins = [
    { title: 'NPM加速', path: '/plugin/node', icon: 'like' },
    { title: 'Git.exe代理', path: '/plugin/git', icon: 'github' },
    { title: 'PIP加速', path: '/plugin/pip', icon: 'bulb' },
    { title: 'Xget 加速', path: '/plugin/xget', icon: 'global' },
    { title: '网络检测', path: '/plugin/free-eye', icon: 'eye' },
    { title: '网页诊断', path: '/plugin/web-diagnostics', icon: 'global' },
  ]
  const menus = [
    { title: '首页', path: '/index', icon: 'home' },
    { title: '加速服务', path: '/server', icon: 'thunderbolt' },
    { title: '服务分组', path: '/service-group', icon: 'cluster' },
    { title: '系统代理', path: '/proxy', icon: 'deployment-unit' },
    { title: '日志与流量', path: '/traffic', icon: 'fund' },
    { title: 'GitHub状态监控', path: '/github-status', icon: 'line-chart' },
    { title: '设置', path: '/setting', icon: 'setting' },
    { title: '帮助中心', path: '/help', icon: 'star' },
    { title: '应用', path: '/plugin', icon: 'appstore', children: plugins },
  ]
  return menus
}
