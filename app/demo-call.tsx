import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useApp } from '../src/AppContext';
import { getCall, startDemoCall, type DemoLine } from '../src/api';
import { Button } from '../src/components/Button';
import { Txt } from '../src/components/Txt';
import { radius, space, useTheme } from '../src/theme';

const LIVE = new Set(['initiating', 'ringing', 'in-progress']);

/**
 * Onboarding: see Dimts work in about a minute without finding a second
 * person. Dimts rings your phone, a pretend client talks to you, and your
 * answers become the notes.
 */
export default function DemoCall() {
  const { c } = useTheme();
  const { userPhone } = useApp();
  const router = useRouter();
  const [callId, setCallId] = useState<string | null>(null);
  const [script, setScript] = useState<DemoLine[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!callId || status === 'ready' || status === 'failed') return;
    const timer = setInterval(() => {
      getCall(callId, userPhone ?? '').then(call => {
        setStatus(call.status);
        if (call.status === 'failed') setFailure(call.error ?? 'The demo call did not finish.');
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [callId, status, userPhone]);

  async function start() {
    setBusy(true); setFailure('');
    try {
      const demo = await startDemoCall();
      setCallId(demo.callId); setScript(demo.script); setStatus(demo.status);
    } catch (err) { setFailure(err instanceof Error ? err.message : 'The demo call could not start.'); }
    finally { setBusy(false); }
  }

  const live = !!status && LIVE.has(status);
  return <ScrollView contentContainerStyle={{ padding: space.md, gap: space.lg, width: '100%', maxWidth: 640, alignSelf: 'center' }}>
    <View style={{ gap: space.sm }}>
      <Txt size="screen" weight="bold">See Dimts in one minute</Txt>
      <Txt tone="muted">
        Dimts calls your phone and a pretend client asks about a quote. Answer the way you would on a real call.
        A minute after you hang up, your notes are ready: the price you gave, the start date and the promise you made.
      </Txt>
    </View>

    {!callId && <View style={{ gap: space.sm }}>
      <Button label="Call me now" busy={busy} onPress={() => { void start(); }} />
      <Txt size="caption" tone="faint">
        Free: it does not use your minutes. Your phone {userPhone ?? ''} rings from a Dimts number. The call is recorded,
        and you hear “This call is recorded and summarized by Dimts AI.” first.
      </Txt>
    </View>}

    {!!callId && <View style={{ gap: space.xs }}>
      <Txt weight="bold" accessibilityLiveRegion="polite">
        {status === 'ready' ? 'Your notes are ready.'
          : status === 'processing' ? 'Writing your notes…'
          : status === 'failed' ? 'The demo did not finish.'
          : status === 'in-progress' ? 'On the call. Answer the client below.'
          : 'Calling your phone. Answer it.'}
      </Txt>
      {status === 'processing' && <Txt tone="muted">This usually takes under a minute.</Txt>}
    </View>}

    {status === 'ready' && callId && <Button label="See your notes" onPress={() => router.replace(`/call/${callId}`)} />}
    {failure ? <View style={{ gap: space.sm }}>
      <Txt accessibilityRole="alert" tone="danger">{failure}</Txt>
      {status === 'failed' && <Button label="Try again" variant="quiet" busy={busy}
        onPress={() => { setCallId(null); setStatus(null); void start(); }} />}
    </View> : null}

    {script.length > 0 && (live || status === 'processing') && <View style={{ gap: space.md }}>
      <Txt size="caption" weight="bold" tone="gold" style={{ letterSpacing: 1, textTransform: 'uppercase' }}>What the client says</Txt>
      {script.map((line, i) => <View key={i} style={{ gap: space.xs, padding: space.md, borderRadius: radius.md,
        borderWidth: 1, borderColor: c.line, backgroundColor: c.card }}>
        <Txt>“{line.client}”</Txt>
        {line.reply && <Txt tone="accent">You: {line.reply}</Txt>}
      </View>)}
      <Txt size="caption" tone="muted">Say your own price and dates: they are what end up in the notes.</Txt>
    </View>}
  </ScrollView>;
}
