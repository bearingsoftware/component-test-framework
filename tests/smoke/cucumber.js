const { cucumberPreset } = require('../../dist/preset')

// The preset's own defaults, pointed at this directory and without
// ts-node, since the support code here is plain JavaScript.
module.exports = {
  default: cucumberPreset({
    requireModule: [],
    require: [`${__dirname}/support/**/*.js`],
    paths: [`${__dirname}/features/**/*.feature`],
    format: ['summary'],
    strict: true,
  }),
}
