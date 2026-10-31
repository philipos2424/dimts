import { useEffect, useState } from 'react';
import { Pressable, Share, View } from 'react-native';
import { useRouter } from 'expo-router';
import { captureSessionGuard, claimBusinessNumber, getMe } from '../api';
import { useApp } from '../AppContext';
import { canBuyHere } from '../billing';
import { space } from '../theme';
import { Txt } from './Txt';

export function BusinessNumber() {
  const { userPhone } = useApp();
  return userPhone ? <BusinessNumberForAccount key={userPhone} /> : null;
}

function BusinessNumberForAccount() {
  const router = useRouter();
  const [number, setNumber] = useState<string | null>(null);
  const [tier, setTier] = useState('free');
  const [releaseAt, setReleaseAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let mounted = true;
    const stillSignedIn = captureSessionGuard();
    getMe().then(me => { if (mounted && stillSignedIn()) { setNumber(me.agent_number); setTier(me.tier); setReleaseAt(me.number_release_at ?? null); } })
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
      {releaseAt && <Pressable accessibilityRole="link" onPress={() => router.push('/plans')}>
        <Txt tone="warn">Your plan has ended. This number stays yours until {new Date(releaseAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}.{canBuyHere ? ' Choose a plan to keep it ›' : ''}</Txt>
      </Pressable>}
    </> : loaded && tier === 'free' ? <>
      <Txt tone="muted">A business number for incoming calls comes with Pro and Business. Callers reach you on it, and every call becomes notes.</Txt>
      {/* Store rules: no path toward buying from a native app. */}
      {canBuyHere && <Pressable accessibilityRole="link" onPress={() => router.push('/plans')} style={{ paddingVertical: space.sm }}>
        <Txt tone="accent" weight="bold">See plans</Txt>
      </Pressable>}
    </> : <>
      <Txt tone="muted">{loaded ? 'Get a dedicated local number for incoming calls. It takes a few seconds.' : 'Loading your business number…'}</Txt>
      {loaded && <Pressable accessibilityRole="button" disabled={busy} onPress={claim} style={{ paddingVertical: space.sm }}>
        <Txt tone="accent" weight="bold">{busy ? 'Setting up your number…' : 'Get my business number'}</Txt>
      </Pressable>}
    </>}
    {!!message && <Txt tone="muted">{message}</Txt>}
  </View>;
}
