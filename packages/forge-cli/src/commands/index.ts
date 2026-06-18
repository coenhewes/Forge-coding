/**
 * Aggregated exports for all CLI command modules.
 *
 * Each command is a single async function that takes a
 * {@link ParsedArgs} (produced by `./output.ts#parseArgs`) and
 * returns a {@link CommandResult}. The CLI dispatcher in
 * `../cli.ts` parses argv, calls `run*`, then `emit()`s the result.
 */

export { parseArgs, emit, getOption, getOptionWithDefault } from './output.js'
export type { CommandResult, ParsedArgs } from './output.js'

export { runInit } from './init.js'
export type { InitData } from './init.js'

export { runRun } from './run.js'

export { runSessions } from './sessions.js'
export type { SessionRow } from './sessions.js'

export { runStatus } from './status.js'
export type { StatusData } from './status.js'

export { runVerify } from './verify.js'
export type { VerifyData } from './verify.js'

export { runEvidence } from './evidence.js'
export type { EvidenceData } from './evidence.js'

export { runCheckpoint } from './checkpoint.js'
export type { CheckpointData } from './checkpoint.js'

export { runDoctor } from './doctor.js'
export type { DoctorReport, DoctorProbe } from './doctor.js'

export { runProviders } from './providers.js'
export type { ProvidersListData, ProvidersListRow, ProvidersTestData } from './providers.js'
