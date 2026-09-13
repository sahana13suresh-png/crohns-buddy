/**
 * The Account_Data_Export download name (Requirement 10.4).
 *
 * Both halves of the export need this rule: the route stamps it into
 * `Content-Disposition`, and `AccountSettingsPage` names the file it actually
 * writes — the browser file is the merged document, so the client is the half
 * whose name the Patient sees. Keeping one implementation is what makes the two
 * agree even when the browser sits in a timezone whose local date differs from
 * the UTC one.
 *
 * It lives in `src/lib` rather than beside the route because the route module
 * reaches the DynamoDB client and the token verifier through its imports, and a
 * client component importing it would drag the AWS SDK into the browser bundle.
 * This module has no imports at all.
 */

/**
 * Download file name for `nowMs`, using the UTC date (Requirement 10.4).
 *
 * `toISOString()` is always UTC, so the date component is the UTC calendar date
 * regardless of the host's timezone.
 */
export function exportFileName(nowMs: number): string {
  const utcDate = new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD
  return `crohns-buddy-export-${utcDate}.json`;
}
