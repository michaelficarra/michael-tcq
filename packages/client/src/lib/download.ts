/**
 * Trigger a browser download of `text` as a file named `filename`. Uses a
 * transient object URL and a synthetic anchor click — no dependencies, native
 * browser APIs only.
 */
export function downloadFile(text: string, filename: string, mimeType = 'text/plain') {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
