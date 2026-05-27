import { useEffect } from 'react';

/**
 * Bridges the visual `:user-invalid` state to the programmatic `aria-invalid`
 * attribute, so assistive tech learns a field is invalid at the same moment the
 * red styling appears — and not before (no premature "invalid entry" on a fresh,
 * untouched required field).
 *
 * React owns these inputs' `value` but never renders `aria-invalid`, so we set
 * the attribute directly from DOM listeners; React won't clobber an attribute it
 * doesn't render. There's no "user-invalid changed" event, so we re-check the
 * pseudo-class on the standard interaction events instead.
 */

/**
 * Mirror one control's `:user-invalid` state onto `aria-invalid`. Exported for
 * unit testing. Sets `aria-invalid="true"` when invalid, removes it otherwise —
 * we avoid stamping `aria-invalid="false"` on every field a user merely tabs
 * through.
 */
export function syncAriaInvalid(el: EventTarget | null): void {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
    return;
  }
  if (el.matches(':user-invalid')) {
    el.setAttribute('aria-invalid', 'true');
  } else {
    el.removeAttribute('aria-invalid');
  }
}

/**
 * Install the global ARIA-sync listeners once, for the lifetime of the app.
 * Call from the root component.
 */
export function useAriaInvalidSync(): void {
  useEffect(() => {
    // `:user-invalid` is Baseline 2023; where it's unsupported (notably jsdom in
    // tests, and any pre-2023 engine) we no-op. The native CSS styling degrades
    // to neutral there anyway, so there's nothing for the bridge to mirror.
    if (!CSS.supports?.('selector(:user-invalid)')) return;

    // blur/focus don't bubble — capture phase reaches them. Flagging on blur
    // means an invalid field is announced once the user leaves it.
    const onBlur = (e: FocusEvent) => syncAriaInvalid(e.target);

    // While typing, only re-sync fields already flagged invalid, so a correction
    // clears the error immediately without flagging fields mid-edit.
    const onInput = (e: Event) => {
      const el = e.target;
      if (el instanceof Element && el.hasAttribute('aria-invalid')) syncAriaInvalid(el);
    };

    // A submit attempt makes every empty required field `:user-invalid` at once;
    // sync them all so the whole form's ARIA state matches the visuals.
    const onSubmit = (e: Event) => {
      if (e.target instanceof HTMLFormElement) {
        e.target.querySelectorAll('input, textarea, select').forEach(syncAriaInvalid);
      }
    };

    document.addEventListener('blur', onBlur, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('submit', onSubmit, true);
    return () => {
      document.removeEventListener('blur', onBlur, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('submit', onSubmit, true);
    };
  }, []);
}
