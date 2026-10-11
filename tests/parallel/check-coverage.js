// After the reference suite: every @ui scenario's coverage must be in the
// merged report, whichever worker ran it. Each page load adds one hit, so the
// hits add up to the number of @ui scenarios.
const fs = require('fs')
const path = require('path')

const expected = 8
const out = JSON.parse(fs.readFileSync(path.join(__dirname, '.nyc_output', 'out.json'), 'utf-8'))
const hits = Object.values(out['/shop/app.js'].s).reduce((sum, n) => sum + n, 0)
if (hits !== expected) {
  console.error(`merged coverage has ${hits} page loads, expected ${expected}`)
  process.exit(1)
}
console.log(`merged coverage has all ${expected} page loads`)
