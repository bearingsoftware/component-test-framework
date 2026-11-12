const { cucumberPreset } = require('../../dist/preset')

// The preset, pointed at this directory and without ts-node: the support
// code here is JavaScript. In your own suite, cucumberPreset() alone does it.
module.exports = {
  default: cucumberPreset({
    requireModule: [],
    require: [`${__dirname}/support/**/*.js`],
    paths: [`${__dirname}/features/**/*.feature`],
    format: ['summary'],
    strict: true,
  }),
}
