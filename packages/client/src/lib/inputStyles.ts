/**
 * Shared Tailwind validation styling for native form controls (<input>,
 * <textarea>, <select>). Centralising the variant string keeps the
 * invalid/valid feedback identical across every form and gives a single place
 * to tune it — append it to each control's existing class string.
 *
 * Feedback uses the native `:user-invalid` / `:user-valid` pseudo-classes
 * (Baseline 2023), so error/success styling appears only *after* the user has
 * committed to a value (blur) or attempted to submit — never prematurely while
 * typing or on first paint. The `aria-invalid` attribute is mirrored separately
 * by `useAriaInvalidSync`; the styling here is purely CSS.
 *
 * Green confirmation is scoped to `required:` fields so optional inputs never
 * light up green — keeping the emphasis on errors rather than success. The
 * red/green tokens match the error palette used by ToastRegion.
 */
export const inputValidation = [
  'user-invalid:border-red-500 user-invalid:bg-red-50',
  'dark:user-invalid:border-red-400 dark:user-invalid:bg-red-900/20',
  'required:user-valid:border-green-600 dark:required:user-valid:border-green-500',
].join(' ');
