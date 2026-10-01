import { useAudioPlayer, useAudioPlayerStatus, type AudioSource } from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useApp } from '../AppContext';
import { audioUrlFor, authHeaders } from '../api';
import { color, radius, space } from '../theme';
import { Txt } from './Txt';

export function audioClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export type SeekRequest = { callId: string; sequence: number; seconds: number };
export function CallPlayer({ callId, seekRequest }: { callId: string; seekRequest?: SeekRequest | null }) {
  const { userPhone } = useApp();
  const [attempt, setAttempt] = useState(0);
  return <View style={{ padding: space.md, gap: space.sm, backgroundColor: color.surface, borderRadius: radius.md }}>
    <PlayerAttempt key={`${callId}:${userPhone}:${attempt}`} callId={callId} seekRequest={seekRequest?.callId === callId ? seekRequest : null} retry={() => setAttempt(n => n + 1)} />
  </View>;
}

function PlayerAttempt({ callId, retry, seekRequest }: { callId: string; retry: () => void; seekRequest?: SeekRequest | null }) {
  const { userPhone } = useApp();
  const [webSource, setWebSource] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (Platform.OS !== 'web' || !userPhone) return;
    // HTMLAudioElement cannot attach bearer headers. Fetch privately first;
    // never put the session in a URL or retain audio in the shared preload cache.
    const controller = new AbortController();
    let active = true, blobUrl: string | undefined;
    const timer = setTimeout(() => controller.abort(), 60_000);
    (async () => {
      try {
        const response = await fetch(audioUrlFor(callId), {
          headers: authHeaders(userPhone), signal: controller.signal, cache: 'no-store',
        });
        if (!response.ok) throw new Error('Audio unavailable');
        const blob = await response.blob();
        if (!blob.size) throw new Error('Empty audio');
        if (!active) return;
        blobUrl = URL.createObjectURL(blob);
        setWebSource(blobUrl);
      } catch {
        if (active) setError('Unable to load this recording. Check your connection and try again.');
      } finally { clearTimeout(timer); }
    })();
    return () => {
      active = false; controller.abort(); clearTimeout(timer);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [callId, userPhone]);

  const source: AudioSource = Platform.OS === 'web' ? webSource : userPhone
    ? { uri: audioUrlFor(callId), headers: authHeaders(userPhone) } : null;
  return <>
    {error ? <>
      <Txt tone="muted" accessibilityRole="alert">{error}</Txt>
      <Control label="Retry loading recording" onPress={retry} />
    </> : source ? <Playback source={source} retry={retry} seekRequest={seekRequest} /> : <Txt tone="muted">Loading recording…</Txt>}
  </>;
}

function Playback({ source, retry, seekRequest }: { source: AudioSource; retry: () => void; seekRequest?: SeekRequest | null }) {
  const { t } = useApp();
  // Native streams with bearer headers and byte-range support. Web uses a
  // private blob URL released on unmount, never a shared authenticated cache.
  const player = useAudioPlayer(source);
  const status = useAudioPlayerStatus(player);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lastSeek = useRef<number | null>(null);
  const mounted = useRef(true);
  const seekQueue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [positionMessage, setPositionMessage] = useState('');
  const loaded = status.isLoaded && Number.isFinite(status.duration) && status.duration > 0;
  useEffect(() => {
    if (!loaded || status.error || !seekRequest || lastSeek.current === seekRequest.sequence) return;
    lastSeek.current = seekRequest.sequence;
    const active = () => mounted.current && lastSeek.current === seekRequest.sequence;
    if (!Number.isFinite(seekRequest.seconds) || seekRequest.seconds < 0 || seekRequest.seconds >= status.duration) {
      setBusy(false); setPositionMessage(''); setError('This transcript timestamp is outside the available recording.'); return;
    }
    setBusy(true); setError(''); setPositionMessage('');
    seekQueue.current = seekQueue.current.then(async () => {
      if (!active()) return;
      try {
        player.pause();
        await player.seekTo(seekRequest.seconds);
        if (active()) setPositionMessage(`Positioned at ${audioClock(seekRequest.seconds)}. Press Play to listen.`);
      } catch { if (active()) setError('Unable to jump to this timestamp. Try loading the recording again.'); }
      finally { if (active()) setBusy(false); }
    });
  }, [loaded, status.error, seekRequest, player]);
  useEffect(() => {
    if (loaded || status.error) return;
    const timer = setTimeout(() => setError('This recording is taking too long to load. Try again.'), 60_000);
    return () => clearTimeout(timer);
  }, [loaded, status.error]);

  async function act(work: () => void | Promise<void>) {
    setBusy(true); setError('');
    try { await work(); }
    catch { setError('Playback failed. Try loading the recording again.'); }
    finally { setBusy(false); }
  }
  const disabled = !loaded || busy || !!status.error;
  const progress = loaded ? Math.min(Math.max(status.currentTime / status.duration, 0), 1) : 0;
  return <>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
      <Control label="Back 15 seconds" disabled={disabled} onPress={() => act(() => player.seekTo(Math.max(0, status.currentTime - 15)))} />
      <Control label={status.playing ? t('pause') : t('play')} disabled={disabled} onPress={() => act(async () => {
        if (status.playing) player.pause();
        else {
          if (status.didJustFinish || status.currentTime >= status.duration) await player.seekTo(0);
          player.play();
        }
      })} />
      <Control label="Forward 15 seconds" disabled={disabled} onPress={() => act(() => player.seekTo(Math.min(status.duration, status.currentTime + 15)))} />
      <Control label="Replay from start" disabled={disabled} onPress={() => act(async () => { await player.seekTo(0); player.play(); })} />
    </View>
    <View accessibilityRole="progressbar" accessibilityLabel="Playback position"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
      style={{ height: 4, backgroundColor: color.line, borderRadius: radius.pill, overflow: 'hidden' }}>
      <View style={{ width: `${progress * 100}%`, height: '100%', backgroundColor: color.saffron }} />
    </View>
    <Txt size="caption" tone="muted">{!loaded ? 'Loading recording…' :
      status.isBuffering ? 'Buffering…' : `${audioClock(status.currentTime)} / ${audioClock(status.duration)}`}</Txt>
    {positionMessage ? <Txt size="caption" tone="muted" accessibilityLiveRegion="polite">{positionMessage}</Txt> : null}
    {(error || status.error) && <>
      <Txt tone="muted" accessibilityRole="alert">{error || 'Unable to play this recording. Try loading it again.'}</Txt>
      <Control label="Retry loading recording" onPress={retry} />
    </>}
  </>;
}

function Control({ label, disabled = false, onPress }: { label: string; disabled?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm, opacity: disabled ? 0.5 : 1 }}>
    <Txt tone="accent" weight="bold">{label}</Txt>
  </Pressable>;
}
