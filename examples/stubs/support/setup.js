// A collector stub for a service that forwards events, and a UDP sink for its
// syslog. Both start on free ports; a real suite would hand their URLs to the
// service under test. The "service" here is a step that posts to the collector.
const assert = require('assert')
const dgram = require('dgram')
const http = require('http')
const { BeforeAll, AfterAll, Before, When, Then } = require('@cucumber/cucumber')
const { startCaptureServer, registerStubSteps } = require('../../../dist/stubs')

let collector
let syslog

BeforeAll(async () => {
  collector = await startCaptureServer({ kind: 'http' })
  syslog = await startCaptureServer({ kind: 'udp' })
})

AfterAll(async () => {
  await collector.stop()
  await syslog.stop()
})

Before(() => {
  collector.reset()
  syslog.reset()
})

registerStubSteps({ collector: () => collector, syslog: () => syslog })

When('the service posts {string} to the collector', function (event) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${collector.url}/events`, { method: 'POST' }, (res) => {
      this.status = res.statusCode
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
    req.end(event)
  })
})

When('the service logs {string} to syslog', function (line) {
  const socket = dgram.createSocket('udp4')
  return new Promise((resolve, reject) => {
    socket.send(line, syslog.port, '127.0.0.1', (err) => {
      socket.close()
      return err ? reject(err) : resolve()
    })
  })
})

Then('the service saw status {int}', function (status) {
  assert.equal(this.status, status)
})
