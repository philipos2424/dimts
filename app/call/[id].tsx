import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useApp } from '../../src/AppContext';
import { ApiError, captureSessionGuard, type CallDetail, getCall, reprocessCall, recoverCallRecording } from '../../src/api';
import { AgreementList } from '../../src/components/AgreementList';
import { Button } from '../../src/components/Button';
import { CallPromises } from '../../src/components/CallPromises';
import { Card } from '../../src/components/Card';
import { ConflictList } from '../../src/components/ConflictList';
import { CapturePill } from '../../src/components/Pill';
import { RecapButton } from '../../src/components/RecapButton';
import { Banner } from '../../src/components/Banner';
import { audioClock, CallPlayer, type SeekRequest } from '../../src/components/CallPlayer';
import { FollowupReview } from '../../src/components/FollowupReview';
import { Section } from '../../src/components/Section';
import { Txt } from '../../src/components/Txt';
import { EndCall } from '../../src/components/EndCall';
import { type Key, statusKey } from '../../src/i18n';
import { space, useTheme } from '../../src/theme';
import { exportCall } from '../../src/exportCall';
import { DeleteCallControl, DeletionStatus } from '../../src/components/CallDeletion';

export default function CallDetailScreen() {
  const { c } = useTheme();
  const { t } = useApp();
  const { userPhone } = useApp();
  const { id, t: startAt, focus } = useLocalSearchParams<{ id: string; t?: string; focus?: string }>();
  const router = useRouter();
  const focused = useRef(false);
  const [showTranscript, setShowTranscript] = useState(false);

  const [call, setCall] = useState<CallDetail | null>(null);
  const [callOwner, setCallOwner] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const loadSequence = useRef(0);
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);
  const [errorKey, setErrorKey] = useState<Key | null>(null);
  const [exporting, setExporting] = useState<'notes' | 'audio' | null>(null);
  const [exportError, setExportError] = useState('');
  const [retryingProcessing, setRetryingProcessing] = useState(false);
  const [retryError, setRetryError] = useState('');
  async function retryProcessing() {
    if (!id || !userPhone || retryingProcessing) return;
    setRetryingProcessing(true); setRetryError('');
    try { await reprocessCall(id, userPhone); await load(); }
    catch { setRetryError('Unable to restart processing. It may already be running. Refresh and try again.'); }
    finally { setRetryingProcessing(false); }
  }
  const [checkingRecording, setCheckingRecording] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  async function checkRecording() {
    if (!id || checkingRecording) return;
    setCheckingRecording(true); setRecoveryMessage('');
    try {
      const result = await recoverCallRecording(id);
      setRecoveryMessage(result.status === 'unavailable' ? 'No completed recording was found yet. Try again later.' :
        result.status === 'ambiguous' ? 'More than one recording was found. Contact the operator with this call ID to investigate.' :
        result.status === 'unsupported' ? 'The recording could not be confirmed as usable audio from both people. Contact the operator with this call ID.' :
        'Recording found. Refreshing your call.');
      await load();
    } catch (err) { setRecoveryMessage(err instanceof ApiError && err.status === 429
      ? 'Please wait a minute before checking the provider again.'
      : 'Unable to check the recording provider. Please try again in a minute.'); }
    finally { setCheckingRecording(false); }
  }
  async function saveCopy(kind: 'notes' | 'audio') {
    if (!id || exporting) return;
    setExporting(kind); setExportError('');
    try { await exportCall(id, kind); }
    catch (err) { setExportError(err instanceof Error && err.name !== 'AbortError' ? err.message : 'Export took too long. Please try again.'); }
    finally { setExporting(null); }
  }

  const load = useCallback(async () => {
    if (!id || !userPhone) return;
    const sequence = ++loadSequence.current, stillSignedIn = captureSessionGuard();
    try {
      const result = await getCall(id, userPhone);
      if (sequence !== loadSequence.current || !stillSignedIn()) return;
      setCall(result);
      setCallOwner(userPhone);
      setErrorKey(null);
    } catch (err) {
      if (sequence !== loadSequence.current || !stillSignedIn()) return;
      setErrorKey(err instanceof ApiError ? err.messageKey : 'errorGeneric');
    }
  }, [id, userPhone]);

  useEffect(() => {
    setCall(null); setSeekRequest(null); setErrorKey(null);
    load();
    return () => { loadSequence.current++; };
  }, [load]);


  // Opened from Ask or a conflict: jump to the cited second once audio exists.
  const seeded = useRef(false);
  useEffect(() => {
    const seconds = Number(startAt);
    if (seeded.current || !call?.audio_url || !Number.isFinite(seconds) || seconds < 0) return;
    seeded.current = true;
    setSeekRequest({ callId: call.id, sequence: 1, seconds });
  }, [call?.audio_url, call?.id, startAt]);

  // Keep polling while the pipeline is still running.
  useEffect(() => {
    if (!call || ['ready', 'failed', 'completed', 'missed', 'deleted'].includes(call.status)) return;
    const timer = setTimeout(load, 5000);
    return () => clearTimeout(timer);
  }, [call, load]);

  if (!call || call.id !== id || callOwner !== userPhone) {
    return (
      <View style={{ flex: 1 }}>
        {errorKey && <Banner message={t(errorKey)} onDismiss={() => setErrorKey(null)} />}
      </View>
    );
  }

  const notReady = call.status !== 'ready';
  if (call.deleted_at) return <ScrollView contentContainerStyle={{ padding: space.md }}>
    {errorKey && <Banner message={t(errorKey)} onDismiss={() => setErrorKey(null)} />}
    <DeletionStatus record={call} refresh={load} />
  </ScrollView>;

  const contactName = call.contact_name ?? 'Them';
  const play = (seconds: number) => {
    setSeekRequest(previous => ({ callId: call.id, sequence: (previous?.sequence ?? 0) + 1, seconds }));
    scroll.current?.scrollTo({ y: 0, animated: true });
  };
  const agreements = call.agreements ?? [];
  const conflicts = call.conflicts ?? [];

  return (
    <ScrollView ref={scroll} style={{ backgroundColor: c.bg }}
      contentContainerStyle={{ padding: space.md, gap: space.lg, width: '100%', maxWidth: 720, alignSelf: 'center' }}>
      {['initiating', 'ringing', 'in-progress'].includes(call.status) && <EndCall id={call.id} onEnded={() => { void load(); }} />}
      {errorKey && <Banner message={t(errorKey)} onDismiss={() => setErrorKey(null)} />}

      <View style={{ gap: space.sm }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.sm }}>
          <Pressable accessibilityRole="link" disabled={!call.contact_id} onPress={() => call.contact_id && router.push(`/person/${call.contact_id}`)} style={{ flexShrink: 1 }}>
            <Txt size="screen" serif>{call.contact_name ?? call.destination}</Txt>
            {call.company ? <Txt tone="muted">{call.company}</Txt> : null}
          </Pressable>
          <CapturePill capture={call.capture ?? 'none'} />
        </View>
        <Txt size="caption" tone="muted">
          {call.direction === 'inbound' ? t('incoming') : t('outgoing')} · {new Date(call.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
        </Txt>
        {call.audio_url && <CallPlayer callId={call.id} seekRequest={seekRequest} />}
      </View>

      {notReady && (
        <Card>
          <Txt size="subhead" weight="bold">{t(statusKey(call.status))}</Txt>
          <Txt tone="muted">
            {call.status === 'failed' ? call.error ?? t('errorGeneric') :
              call.status === 'completed' ? 'Recording was off for this call.' :
              call.status === 'missed' ? 'This call was not answered.' :
              call.status === 'processing' && !call.audio_url ? 'The call finished. Waiting for its recording before transcription and summary can start.' : t('processingBody')}
          </Txt>
          {call.status === 'failed' && !call.audio_url && call.duration_sec != null && (
            <View style={{ gap: space.sm }}>
              <Button compact variant="quiet" label="Check for delayed recording" onPress={() => { void load(); }} />
              {call.recording_authorized && <Button compact variant="quiet" busy={checkingRecording}
                label="Recover recording from provider" onPress={checkRecording} />}
              {recoveryMessage ? <Txt tone="muted" accessibilityRole="alert">{recoveryMessage}</Txt> : null}
            </View>
          )}
          {call.status === 'failed' && call.recording_url && (
            <Button compact label={t('retry')} busy={retryingProcessing} onPress={retryProcessing} />
          )}
          {retryError ? <Txt tone="muted" accessibilityRole="alert">{retryError}</Txt> : null}
        </Card>
      )}

      {agreements.length > 0 && (
        <Section title="What was agreed">
          <AgreementList agreements={agreements} onPlay={play} contactName={contactName} />
        </Section>
      )}

      {conflicts.length > 0 && (
        <Section title="Differs from before">
          <ConflictList conflicts={conflicts} onPlay={play} />
        </Section>
      )}

      {call.status === 'ready' && call.transcript && (
        <View onLayout={event => { if (focus === 'next' && !focused.current) { focused.current = true; scroll.current?.scrollTo({ y: event.nativeEvent.layout.y, animated: true }); } }}
          style={{ gap: space.md }}>
          <Section title="Next steps">
            {call.next_moves && call.next_moves.length > 0 && (
              <View style={{ gap: space.xs }}>
                {call.next_moves.map((move, i) => (
                  <View key={i} style={{ flexDirection: 'row', gap: space.sm }}>
                    <Txt tone="brand">→</Txt>
                    <Txt style={{ flex: 1 }}>{move}</Txt>
                  </View>
                ))}
              </View>
            )}
            <FollowupReview key={call.id} callId={call.id} initial={call.followups} />
            <RecapButton callId={call.id} />
          </Section>
        </View>
      )}

      {call.action_items && call.action_items.length > 0 && (
        <Section title="Promises">
          <CallPromises callId={call.id} items={call.action_items} contactName={contactName} />
        </Section>
      )}

      {call.summary && (
        <Section title={t('summary')}>
          <Txt style={{ lineHeight: 24 }}>{call.summary}</Txt>
          {call.key_points && call.key_points.length > 0 && call.key_points.map((point, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: space.sm }}>
              <Txt tone="faint">—</Txt>
              <Txt style={{ flex: 1 }}>{point}</Txt>
            </View>
          ))}
        </Section>
      )}

      {call.transcript && (
        <Section title={t('transcript')}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showTranscript }} onPress={() => setShowTranscript(!showTranscript)}>
            <Txt tone="brand">{showTranscript ? 'Hide transcript' : 'Show transcript'}</Txt>
          </Pressable>
          {showTranscript && (call.transcript_turns?.length ? <View style={{ gap: space.sm }}>
            <Txt tone="muted" size="caption">Times are approximate and start at the beginning of the recording.</Txt>
            {call.transcript_turns.map((turn, index) => <View key={index} style={{ gap: space.xs }}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Go to ${audioClock(turn.start)}, ${turn.speaker}`}
                disabled={!call.audio_url} style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => play(turn.start)}>
                <Txt tone="brand">{audioClock(turn.start)} · {turn.speaker === 'User' ? 'You' : turn.speaker === 'Caller' ? contactName : turn.speaker}</Txt>
              </Pressable>
              <Txt selectable style={{ lineHeight: 24 }}>{turn.text}</Txt>
            </View>)}
          </View> : <Txt tone="muted" selectable style={{ lineHeight: 24 }}>{call.transcript}</Txt>)}
        </Section>
      )}

      <View style={{ gap: space.sm, borderTopWidth: 1, borderTopColor: c.line, paddingTop: space.md }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.lg }}>
          <Pressable accessibilityRole="button" disabled={!!exporting} onPress={() => saveCopy('notes')} style={{ minHeight: 44, justifyContent: 'center' }}>
            <Txt tone="brand">{exporting === 'notes' ? 'Preparing notes…' : 'Export notes'}</Txt>
          </Pressable>
          {call.audio_url && <Pressable accessibilityRole="button" disabled={!!exporting} onPress={() => saveCopy('audio')} style={{ minHeight: 44, justifyContent: 'center' }}>
            <Txt tone="brand">{exporting === 'audio' ? 'Preparing recording…' : 'Export recording'}</Txt>
          </Pressable>}
        </View>
        {exportError ? <Txt tone="muted" accessibilityRole="alert">{exportError}</Txt> : null}
        {!['initiating','ringing','in-progress'].includes(call.status) && <DeleteCallControl callId={call.id} onDeleted={load} />}
        <Txt size="caption" tone="faint" selectable>Call ID: {call.id}</Txt>
      </View>
    </ScrollView>
  );
}
