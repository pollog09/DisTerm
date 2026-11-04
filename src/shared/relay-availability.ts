/**
 * DisTerm ships with no relay server. Everything that rides one (phone access, Team Access, hosted
 * teams, live links) is off until a build is started with NODETERM_RELAY_URL. ONE sentence, so every
 * surface that goes disabled gives the same reason.
 */
export const RELAY_UNAVAILABLE_REASON =
  'Not available in this build: DisTerm has no relay server configured. See the README, “Off by default: anything that needs a relay”.'
