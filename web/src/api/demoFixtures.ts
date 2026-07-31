/**
 * Sample values used ONLY by the in-memory demo adapter and by the placeholder
 * text the account screen shows before a real account exists.
 *
 * They live here, not in `config/arc.ts`, because that module is the generated
 * projection of `config/chains.json` and must stay free of hand-written
 * literals — the registry is the single source of chain and contract data
 * (AGENTS.md section 5). None of the values below is chain configuration: they
 * are recorded Arc Testnet demo results.
 */

/** ExecutionAccount address from a recorded Phase 3 demo swap. */
export const DEMO_EXECUTION_ACCOUNT =
  "0x0c4753338912E6D896190E573E4AfBD75967b01F";

/** Demo sender account (`clean-privacy-arc`). */
export const DEMO_SENDER =
  "unlink1qqp4mxgu8ytqjqxx4y8ckmc5hun4a3us9kd883dk45fhec94z5328ss473w44urw5xqe9c2qgnevthms724hdf9x5275f4nr02le48s59zpkrs";

/** Demo recipient account (`clean-privacy-arc-recipient`). */
export const DEMO_RECIPIENT =
  "unlink1qq5hyn92dvk0wsu44qq22y7hag5gykx90fvxd4085hzd49sqvsg4lrrkvr9ayf4dj55rdr4txqhksdzam3mgx9v3fxn5drgjsefwm02kg3z0y3";
