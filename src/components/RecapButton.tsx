import { useState } from 'react';
import { Share } from 'react-native';
import { getRecap, trackEvent } from '../api';

import { Button } from './Button';
import { Txt } from './Txt';

// The one line the other person sees about Dimts: how a recap reaches new owners.
export const RECAP_SIGNATURE = '

— Notes by Dimts, the AI that remembers what was agreed on calls';

/** Write a short "here's what we agreed" and hand it to the share sheet. */
export function RecapButton({ callId }: { callId: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function share() {
    setBusy(true); setError('');
    try {
      const { text } = await getRecap(callId);
      const result = await Share.share({ message: text + RECAP_SIGNATURE });
      if (result.action === Share.sharedAction) trackEvent('recap_shared');
    } catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t write a recap. Try again.'); }
    finally { setBusy(false); }
  }
  return (
    <>
      <Button variant="quiet" label="Send recap to them" onPress={share} busy={busy} />
      {error ? <Txt tone="danger" size="caption" accessibilityRole="alert">{error}</Txt> : null}
    </>
  );
}
