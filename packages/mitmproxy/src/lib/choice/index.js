const { LRUCache } = require('lru-cache')
const log = require('../../utils/util.log.server')

const cacheSize = 1024

// 坏地址拉黑时长：首次 2 分钟，连续失败翻倍，上限 15 分钟
// （浏览器对连不通的地址也只是短时间内不再尝试，而不是永远不用）
const BAN_BASE_MS = 2 * 60 * 1000
const BAN_MAX_MS = 15 * 60 * 1000

class ChoiceCache {
  constructor () {
    this.cache = new LRUCache({
      maxSize: cacheSize,
      sizeCalculation: () => {
        return 1
      },
    })
  }

  get (key) {
    return this.cache.get(key)
  }

  getOrCreate (key, backupList) {
    log.info('get counter:', key)
    let item = this.cache.get(key)
    if (item == null) {
      item = new DynamicChoice(key)
      item.setBackupList(backupList)
      this.cache.set(key, item)
    }
    return item
  }
}

class DynamicChoice {
  constructor (key) {
    this.key = key
    this.countMap = {} /* ip -> count { value, total, error, keepErrorCount, successRate }  */
    this.value = null // 当前使用的host
    this.backupList = [] // 备选host列表
    this.createTime = new Date()
  }

  doRank () {
    // 将count里面根据成功率排序
    const countList = []
    for (const key in this.countMap) {
      countList.push(this.countMap[key])
    }

    // 将countList根据成功率排序
    countList.sort((a, b) => {
      return b.successRate - a.successRate
    })

    log.info('Do rank:', JSON.stringify(countList))

    const newBackupList = countList.map(item => item.value)
    this.setBackupList(newBackupList)
  }

  /**
   * 该地址当前是否处于拉黑期（刚失败过，短期内不再尝试）
   *
   * 只对字符串（IP / 域名）生效：`req/proxy.js` 会把 proxy 配置对象当 key 用，
   * 对象作为 map key 会全部挤到同一个 '[object Object]' 上，不能用来记拉黑。
   */
  isBanned (ip, now = Date.now()) {
    if (typeof ip !== 'string') {
      return false
    }
    const count = this.countMap[ip]
    return count != null && count.banUntil != null && count.banUntil > now
  }

  successRateOf (ip) {
    const count = this.countMap[ip]
    return count == null ? 0.5 : count.successRate
  }

  /**
   * 设置新的backup列表
   *
   * 【定制版改造】换 IP 要「粘性」：
   *   原实现每次 DNS 解析都把 value 重置成列表第一个，于是刚切到可用 IP，下一次解析又
   *   撞回坏 IP，表现为「能上一会儿、过一会儿又不行」。现在只要当前地址还在新候选里且
   *   没被拉黑，就保持不变；需要换时才按成功率排序挑选。
   *
   * @param newBackupList 新的backupList
   */
  setBackupList (newBackupList) {
    let defaultTotal = newBackupList.length
    for (const ip of newBackupList) {
      if (!this.countMap[ip]) {
        this.countMap[ip] = {
          value: ip,
          total: defaultTotal,
          error: 0,
          keepErrorCount: 0,
          successRate: 0.5,
          banUntil: 0,
        }
        defaultTotal--
      }
    }

    // 拉黑期内的地址不进候选；若整个列表都在拉黑期内（例如只解析出一个地址），仍然保留
    let list = newBackupList.filter(ip => !this.isBanned(ip))
    if (list.length === 0) {
      list = [...newBackupList]
    }

    // 粘性：当前地址仍在候选中时保持不变
    const current = this.value
    if (current != null && list.includes(current)) {
      this.backupList = list.filter(ip => ip !== current)
      return
    }

    // 需要换：成功率高的在前（同分保持 DNS 给出的原顺序）
    list.sort((a, b) => this.successRateOf(b) - this.successRateOf(a))
    this.value = list.shift()
    this.backupList = list
    if (this.value != null) {
      log.info(`选择新地址: ${this.key} ➜ ${this.value}, backupList: ${JSON.stringify(this.backupList)}`)
    }
  }

  countStart (value) {
    this.doCount(value, false)
  }

  /**
   * 换下一个
   * @param count 计数器
   */
  changeNext (count) {
    log.info('切换backup', count, this.backupList)
    // 不再清零失败计数：失败历史要留着参与成功率排序，短期回避由 banUntil 负责

    const valueBackup = this.value
    if (this.backupList.length > 0) {
      // 跳过仍在拉黑期内的地址；全部被拉黑时退化为原来的顺序切换
      const now = Date.now()
      let index = this.backupList.findIndex(ip => !this.isBanned(ip, now))
      if (index < 0) {
        index = 0
      }
      this.value = this.backupList.splice(index, 1)[0]
      log.info(`切换backup完成: ${this.key}, ip: ${valueBackup} ➜ ${this.value}, this:`, this)
    } else {
      this.value = null
      log.info(`切换backup完成: ${this.key}, backupList为空了，设置this.value: from '${valueBackup}' to null. this:`, this)
    }
  }

  /**
   * 重置失败计数，从候选中重新选择一个「真实IP」（不是域名兜底项）
   *
   * 真实IP连续失败后 value 会退化成域名兜底项（见 `dns/base.js` 的 `ipList.push(hostname)`），
   * 此时下游会把域名交给系统DNS解析（可能被投毒或阻断），需要给真实IP一次新的机会。
   *
   * @param hostname 域名兜底项（不会被选中）
   * @returns {boolean} 是否成功选出了真实IP（false 表示候选中只有域名兜底项）
   */
  resetChoice (hostname) {
    const ipList = []
    for (const key in this.countMap) {
      const count = this.countMap[key]
      count.keepErrorCount = 0 // 清空连续失败
      count.total = 0
      count.error = 0
      count.successRate = 1.0
      count.banUntil = 0 // 解除拉黑
      if (key !== hostname) {
        ipList.push(key)
      }
    }

    if (ipList.length === 0) {
      return false
    }

    const valueBackup = this.value
    this.backupList = ipList
    this.value = this.backupList.shift()
    this.doCount(this.value, false)
    log.info(`重置失败计数完成: ${this.key}, ip: ${valueBackup} ➜ ${this.value}, backupList: ${JSON.stringify(this.backupList)}`)
    return true
  }

  /**
   * 记录使用次数或错误次数
   * @param ip
   * @param isError
   */
  doCount (ip, isError) {
    let count = this.countMap[ip]
    if (count == null) {
      count = this.countMap[ip] = { value: ip, total: 5, error: 0, keepErrorCount: 0, successRate: 1, banUntil: 0 }
    }

    if (isError) {
      count.error++ // 失败次数+1
      count.keepErrorCount++ // 连续失败次数+1
      if (typeof ip === 'string') {
        // 拉黑刚失败的地址：连续失败越多，拉黑越久（2min → 4min → 8min → 15min 封顶）
        const banMs = Math.min(BAN_BASE_MS * Math.pow(2, Math.max(0, count.keepErrorCount - 1)), BAN_MAX_MS)
        count.banUntil = Date.now() + banMs
        log.info(`地址失败拉黑 ${Math.round(banMs / 1000)}s: ${this.key} ➜ ${ip}`)
      }
    } else {
      count.keepErrorCount = 0 // 成功后重置连续失败计数
      count.banUntil = 0 // 解除拉黑
    }
    count.total++ // 总次数+1

    // 计算成功率
    count.successRate = 1.0 - (count.error / count.total)

    // 判断是否需要切换下一个
    if (isError && this.value === ip) {
      // 连续失败 1 次就切：坏 IP 不值得等 3 次 × 15s = 45s
      if (count.keepErrorCount >= 1) {
        this.changeNext(count)
      } else if (count.successRate < 0.4) {
        // 成功率小于40%,切换下一个
        this.changeNext(count)
      }
    }
  }
}

module.exports = {
  DynamicChoice,
  ChoiceCache,
}
