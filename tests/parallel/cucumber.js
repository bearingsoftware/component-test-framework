const { cucumberPreset } = require('../../dist/preset')

// Four workers by default; PARALLEL=1 runs the same suite serially.
module.exports = {
  default: cucumberPreset({
    requireModule: [],
    require: [`${__dirname}/support/**/*.js`],
    paths: [`${__dirname}/features/**/*.feature`],
    format: ['summary'],
    strict: true,
    parallel: Number(process.env.PARALLEL ?? 4),
  }),
}
