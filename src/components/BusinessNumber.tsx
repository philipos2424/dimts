import { useEffect, useState } from 'react';
import { Pressable, Share, View } from 'react-native';
import { captureSessionGuard, claimBusinessNumber, getMe } from '../api';
import { useApp } from '../AppContext';
import { space } from '../theme';
import { Txt } from './Txt';

export function BusinessNumber() {
  const { userPhone } = useApp();
  return userPhone ? <BusinessNumberForAccount key={userPhone} /> : null;
}

function BusinessNumberForAccount() {
  const [number, setNumber] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let mounted = true;
    const stillSignedIn = captureSessionGuard();
    getMe().then(me => { if (mounted && stillSignedIn()) setNumber(me.agent_number); })
      .catch(() => { if (mounted && stillSignedIn()) setMessage('Could not load your business number. Try again.'); })
      .finally(() => { if (mounted && stillSignedIn()) setLoaded(true); });
    return () => { mounted = false; };
  }, []);
  async function claim() {
    setBusy(true); setMessage('');
    const stillSignedIn = captureSessionGuard();
    try { const result = await claimBusinessNumber(); if (stillSignedIn()) setNumber(result.agent_number); }
    catch (err) { if (stillSignedIn()) setMessage(err instanceof Error ? err.message : 'No number is available yet.'); }
    finally { if (stillSignedIn()) setBusy(false); }
  }
  return <View style={{ padding: space.md, gap: space.sm }}>
    <Txt weight="bold">Your business line</Txt>
    {number ? <>
      <Txt size="title">{number}</Txt>
      <Txt tone="muted">Share this number with callers. Incoming calls ring your verified mobile; every call becomes notes.</Txt>
      <Pressable accessibilityRole="button" onPress={() => Share.share({ message: number }).catch(() => setMessage('Could not open sharing.'))}>
        <Txt tone="accent">Share business number</Txt>
      </Pressable>
    </> : <>
      <Txt tone="muted">{loaded ? 'Get a dedicated number for incoming calls. Availability depends on the pilot’s number pool.' : 'Loading your business number…'}</Txt>
      {loaded && <Pressable accessibilityRole="button" disabled={busy} onPress={claim} style={{ paddingVertical: space.sm }}>
        <Txt tone="accent" weight="bold">{busy ? 'Assigning…' : 'Get my business number'}</Txt>
      </Pressable>}
    </>}
    {!!message && <Txt tone="muted">{message}</Txt>}
  </View>;
}
