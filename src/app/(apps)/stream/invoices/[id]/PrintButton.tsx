'use client';

// Saves the invoice as a PDF through the browser's print dialog (the menu and buttons are hidden when printing).
export function PrintButton() {
  return <button className="btn primary" onClick={() => window.print()}>Print / save PDF</button>;
}
