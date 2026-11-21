const { cucumberPreset } = require('../../dist/preset')

module.exports = {
  default: cucumberPreset({
    requireModule: [],
    require: [`${__dirname}/support/**/*.js`],
    paths: [`${__dirname}/features/**/*.feature`],
    format: ['summary'],
    strict: true,
  }),
}
