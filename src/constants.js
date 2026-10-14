// Shared contracts for launcher and renderer.
module.exports = {
  EXIT: { SUCCESS: 0, INTERNAL: 1, USAGE: 2, INPUT: 3, OUTPUT: 4, RENDER: 5, ENV: 6 },
  LIMITS: {
    DELAY_MIN: 0,
    DELAY_MAX: 600,
    WIDTH_MIN: 1,
    WIDTH_MAX: 7680,
    HEIGHT_MIN: 1,
    HEIGHT_MAX: 4320,
    NAME_MAX: 64,
  },
  TIMEOUTS_MS: { STARTUP: 15_000, LOAD: 30_000, CAPTURE: 10_000, GRACE: 2_000, EXIT_GRACE: 5_000 },
  DEFAULTS: { DELAY: 3, WIDTH: 1280, HEIGHT: 800, OUTPUT_DIR: '/tmp' },
};
