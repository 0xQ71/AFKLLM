/** Harness redirect: from-scratch landings must write_file, not apply_diff. */

export const WRITE_FILE_REQUIRED_PREFIX = 'WRITE_FILE_REQUIRED:'

export function formatWriteFileRequiredError(
  relativePath: string,
  extra?: string
): string {
  const p = (relativePath ?? '').replace(/\\/g, '/') || 'this file'
  const tail = extra?.trim() ? ` ${extra.trim()}` : ''
  return (
    `${WRITE_FILE_REQUIRED_PREFIX} call write_file with the COMPLETE file. ` +
    `Do not apply_diff a new landing module. Path: "${p}".${tail}`
  )
}
