/**
 * 日志脱敏：凭据打码；默认只保留 host。
 * 性能：大对象/大文本直接截断，避免日志把渲染进程拖死。
 */
const SECRET_QUERY_KEYS = /([?&](?:token|password|passwd|pwd|secret|key|code|auth|signature|sig|access_token)=)[^&\s]+/gi
const AUTH_HEADER = /((?:proxy-)?authorization\s*[:=]\s*)\S+/gi
const PASSWORD_KV = /((?:dspassword|password|passwd|token|secret|privateKey|private_key)\s*[:=]\s*)\S+/gi
// 【本版本定制】JSON 形式的敏感 headers：原正则要求 `authorization: xxx`，但
// createRequestHandler / createConnectHandler 是把 headers 经 JSON.stringify2 序列化后
// 再丢给日志的，形如 '"authorization":"Bearer xxx"'，引号阻断了上面的匹配，
// 导致 Cookie / Authorization 明文落盘。这里补一条 JSON 专用的正则。
const JSON_SECRET_KV = /("(?:cookie|set-cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-csrf-token|x-access-token|token|access_token|refresh_token|id_token|password|passwd|secret|session|sessionid|user_session|_gh_sess)"\s*:\s*")[^"]*/gi
const DS_BLOB = /\b(ds-(?:p2p|card):\/\/)[A-Za-z0-9._-]+/g
const MAX_TEXT = 8000
const MAX_JSON = 2000

function isDetail () {
  return process.env.DEV_SIDECAR_LOG_DETAIL === 'true'
}

function redactUrl (url) {
  try {
    const u = new URL(url)
    if (!isDetail()) {
      return `${u.protocol}//${u.host}`
    }
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return url
  }
}

function shortNodeId (id) {
  const s = String(id || '')
  return s.length > 12 ? `${s.slice(0, 8)}…` : s
}

function redactText (text) {
  if (text == null) {
    return text
  }
  let s = String(text)
  if (s.length > MAX_TEXT) {
    s = `${s.slice(0, MAX_TEXT)}…[truncated]`
  }
  s = s.replace(/\b[A-Za-z0-9_-]{32,}\b/g, (m) => shortNodeId(m))
  s = s.replace(DS_BLOB, '$1***')
  s = s.replace(AUTH_HEADER, '$1***')
  s = s.replace(JSON_SECRET_KV, '$1***')
  s = s.replace(SECRET_QUERY_KEYS, '$1***')
  s = s.replace(PASSWORD_KV, '$1***')
  s = s.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (m) => redactUrl(m))
  return s
}

function redactArg (arg) {
  if (typeof arg === 'string') {
    return redactText(arg)
  }
  if (arg instanceof Error) {
    const e = new Error(redactText(arg.message))
    e.name = arg.name
    return e
  }
  if (arg && typeof arg === 'object') {
    // 浅对象做一层脱敏；大对象不整体 JSON 序列化，避免卡 UI
    try {
      const keys = Object.keys(arg)
      if (keys.length > 40) {
        return '[object omitted]'
      }
      const out = {}
      for (const k of keys) {
        const v = arg[k]
        if (typeof v === 'string') {
          out[k] = redactText(v)
        } else if (v == null || typeof v !== 'object') {
          out[k] = v
        } else {
          out[k] = '[object]'
        }
      }
      return out
    } catch {
      return '[object omitted]'
    }
  }
  return arg
}

function wrapLogger (logger) {
  if (!logger || logger.__redacted) {
    return logger
  }
  const wrapLevel = (level) => (...args) => {
    try {
      logger[level](...args.map(redactArg))
    } catch {
      logger[level](...args)
    }
  }
  return {
    debug: wrapLevel('debug'),
    info: wrapLevel('info'),
    warn: wrapLevel('warn'),
    error: wrapLevel('error'),
    level: logger.level,
    category: logger.category,
    __redacted: true,
  }
}

module.exports = {
  redactText,
  redactArg,
  wrapLogger,
  isDetail,
  MAX_TEXT,
  MAX_JSON,
}
