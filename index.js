'use strict'

const fp = require('fastify-plugin')
const http = require('http')
const https = require('https')
const URL = require('url').URL
const lru = require('tiny-lru')
const requests = {
  'http:': http,
  'https:': https
}

module.exports = fp(function (fastify, opts, next) {
  const agents = {
    // with a column, so that it matches url.protocol
    // and we can avoid string manipulation at runtime
    'http:': new http.Agent(agentOption(opts)),
    'https:': new https.Agent(agentOption(opts))
  }
  const cache = lru(opts.cacheURLs || 100)
  const base = opts.base

  fastify.decorateReply('forward', function (dest, opts) {
    opts = opts || {}
    const req = this.request.req
    const onResponse = opts.onResponse
    const rewriteHeaders = opts.rewriteHeaders

    if (base) {
      dest = base + (dest || '')
    }

    // avoid parsing the destination URL if we can
    const url = cache.get(dest) || new URL(dest)
    cache.set(dest, url)

    req.log.info({ dest }, 'fechting from remote server')

    const requestDetails = {
      method: req.method,
      port: url.port,
      path: url.pathname,
      hostname: url.hostname,
      headers: req.headers,
      agent: agents[url.protocol]
    }

    const internal = requests[url.protocol].request(requestDetails)

    // TODO support different content-types
    internal.end(JSON.stringify(this.request.body))

    // TODO what about trailers?
    internal.on('error', (err) => {
      this.send(err)
    })
    internal.on('response', (res) => {
      req.log.info('response received')

      var headers = res.headers
      if (rewriteHeaders) {
        headers = rewriteHeaders(headers)
      }

      copyHeaders(headers, this)

      this.code(res.statusCode)

      if (onResponse) {
        onResponse(res)
      } else {
        this.send(res)
      }
    })
  })

  fastify.onClose((fastify, next) => {
    agents['http:'].destroy()
    agents['https:'].destroy()
    // let the event loop do a full run so that it can
    // actually destroy those sockets
    setImmediate(next)
  })

  next()
}, '>= 0.37.0')

function copyHeaders (headers, reply) {
  const headersKeys = Object.keys(headers)

  var i
  var header

  for (i = 0; i < headersKeys.length; i++) {
    header = headersKeys[i]
    reply.header(header, headers[header])
  }
}

function agentOption (opts) {
  return {
    keepAlive: true,
    keepAliveMsecs: opts.keepAliveMsecs || 60 * 1000, // 1 minute
    maxSockets: opts.maxSockets || 2048,
    maxFreeSockets: opts.maxFreeSockets || 2048,
    rejectUnauthorized: opts.rejectUnauthorized
  }
}
