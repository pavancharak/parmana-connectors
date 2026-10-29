/**
 * One JSON line per event, on stdout. Fields are chosen by the caller, and
 * none of them may carry a credential or an upstream response body.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export function log(event: string, fields: LogFields = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
}
