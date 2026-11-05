'use client';

// A header checkbox that ticks or clears every checkbox with the given name in the same form.
export function CheckAll({ name, label = 'Tick all' }: { name: string; label?: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      onChange={(e) => {
        const form = e.currentTarget.form;
        form?.querySelectorAll<HTMLInputElement>(`input[type=checkbox][name="${name}"]`).forEach((c) => { c.checked = e.currentTarget.checked; });
      }}
    />
  );
}
