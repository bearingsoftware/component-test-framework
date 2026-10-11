// `@bearingsoftware/component-test-framework/openapi`: the code behind the
// `ctf` CLI, for scripts that want it directly. Registers nothing on import.
export { loadSpec, findOperation } from './openapi/spec'
export type { SpecOperation, LoadSpecOptions } from './openapi/spec'
export { readOperationMap } from './openapi/map-file'
export type { MapEntry, MapFile } from './openapi/map-file'
export { generateOperationMap, namedOperations, operationName } from './openapi/generate'
export type { GenerateOptions } from './openapi/generate'
export { checkOperationMaps, readAllowlist } from './openapi/check'
export type { CheckPair, CheckOptions, CheckResult, Problem } from './openapi/check'
export { auditCoverage, findFeatureFiles, DEFAULT_REFERENCE_PATTERNS } from './openapi/audit'
export type { AuditOptions, AuditResult, AuditedOperation } from './openapi/audit'
