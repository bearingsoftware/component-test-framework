// A stand-in for a service under test, for process.test.ts. Serves
// /health on PORT, answering with MARKER so a test can tell which
// environment it was started with. STOP_DELAY_MS delays exit on SIGINT
// ("ignore" never exits on it); CRASH_AFTER_MS exits with code 3.
const http = require('http')
const port = Number(process.env.PORT)
const server = http.createServer((req, res) => {
  res.writeHead(req.url === '/health' ? 200 : 404)
  res.end(process.env.MARKER ?? '')
})
server.listen(port, '127.0.0.1', () => console.log(`started ${process.env.MARKER ?? ''}`))
process.on('SIGINT', () => {
  if (process.env.STOP_DELAY_MS === 'ignore') return
  setTimeout(() => process.exit(0), Number(process.env.STOP_DELAY_MS ?? 0))
})
if (process.env.CRASH_AFTER_MS)
  setTimeout(() => process.exit(3), Number(process.env.CRASH_AFTER_MS))
