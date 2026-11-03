'use client';

import { useState } from 'react';

// After an invite: the sign-in link to send the person (until invite emails are switched on).
export function InviteLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="banner">
      Send them this link to sign in: <code style={{ wordBreak: 'break-all' }}>{link}</code>{' '}
      <button type="button" className="btn sm" onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy link'}</button>
    </div>
  );
}
