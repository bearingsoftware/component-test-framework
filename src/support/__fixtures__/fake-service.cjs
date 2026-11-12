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
// GRANDCHILD_STOP_MS: start a child in the same process group that takes that
// long to exit on SIGINT, as `go run`'s child does. It reports its pid once its
// SIGINT handler is installed, so a stop can't beat it to a default SIGINT.
// GRANDCHILD_CLOSE_OUTPUT: it also closes stdout and stderr first.
if (process.env.GRANDCHILD_STOP_MS) {
  const { spawn } = require('child_process')
  const grandchild = spawn(
    process.execPath,
    [
      '-e',
      `process.on('SIGINT', () => setTimeout(() => process.exit(0), ${Number(process.env.GRANDCHILD_STOP_MS)}));
       setInterval(() => {}, 1000);
       console.log('grandchild ' + process.pid);
       if (${Boolean(process.env.GRANDCHILD_CLOSE_OUTPUT)}) { require('fs').closeSync(1); require('fs').closeSync(2) }`,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
}
