import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useApp } from '../../src/AppContext';
import { ApiError, type CallDetail, getCall, reprocessCall, recoverCallRecording } from '../../src/api';
import { ActionList } from '../../src/components/ActionList';
import { Banner } from '../../src/components/Banner';
import { CallPlayer } from '../../src/components/CallPlayer';
import { FollowupReview } from '../../src/components/FollowupReview';
import { Section } from '../../src/components/Section';
import { Txt } from '../../src/components/Txt';
import { type Key, statusKey } from '../../src/i18n';
import { color, space } from '../../src/theme';
import { exportCall } from '../../src/exportCall';
import { DeleteCallControl, DeletionStatus } from '../../src/components/CallDeletion';

export default function CallDetailScreen() {
  const { t } = useApp();
  const { userPhone } = useApp();
  const navigation = useNavigation();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [call, setCall] = useState<CallDetail | null>(null);
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
    try {
      setCall(await getCall(id, userPhone));
      setErrorKey(null);
    } catch (err) {
      setErrorKey(err instanceof ApiError ? err.messageKey : 'errorGeneric');
    }
  }, [id, userPhone]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const title = call?.contact_name ?? call?.destination;
    if (title) navigation.setOptions({ title });
  }, [call?.contact_name, call?.destination, navigation]);

  // Keep polling while the pipeline is still running.
  useEffect(() => {
    if (!call || ['ready', 'failed', 'completed', 'missed', 'deleted'].includes(call.status)) return;
    const timer = setTimeout(load, 5000);
    return () => clearTimeout(timer);
  }, [call, load]);

  if (!call) {
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

  return (
    <ScrollView contentContainerStyle={{ padding: space.md, gap: space.lg }}>
      {errorKey && <Banner message={t(errorKey)} onDismiss={() => setErrorKey(null)} />}

      {call.audio_url && <CallPlayer callId={call.id} />}
      <View style={{ gap: space.sm }}>
        <Txt tone="muted" size="caption">Keep your own copy of this call.</Txt>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.lg }}>
          <Pressable accessibilityRole="button" disabled={!!exporting} onPress={() => saveCopy('notes')} style={{ minHeight: 44, justifyContent: 'center' }}>
            <Txt tone="accent">{exporting === 'notes' ? 'Preparing notes…' : 'Export call notes'}</Txt>
          </Pressable>
          {call.audio_url && <Pressable accessibilityRole="button" disabled={!!exporting} onPress={() => saveCopy('audio')} style={{ minHeight: 44, justifyContent: 'center' }}>
            <Txt tone="accent">{exporting === 'audio' ? 'Preparing recording…' : 'Export recording'}</Txt>
          </Pressable>}
        </View>
        {exportError ? <Txt tone="muted" accessibilityRole="alert">{exportError}</Txt> : null}
      </View>

      {notReady && (
        <View style={{ gap: space.sm }}>
          <Txt size="subhead" weight="bold">
            {t(statusKey(call.status))}
          </Txt>
          <Txt tone="muted">
            {call.status === 'failed' ? call.error ?? t('errorGeneric') :
              call.status === 'completed' ? 'Recording was off for this call.' :
              call.status === 'missed' ? 'This call was not answered.' :
              call.status === 'processing' && !call.audio_url ? 'The call finished. Waiting for its recording before transcription and summary can start.' : t('processingBody')}
          </Txt>
          {call.status === 'failed' && !call.audio_url && call.duration_sec != null && (
            <View style={{ gap: space.sm }}>
              <Txt size="caption" tone="muted" selectable>Call ID: {call.id}</Txt>
              <Pressable accessibilityRole="button" onPress={load} style={{ paddingVertical: space.sm }}>
                <Txt tone="accent" weight="bold">Check for delayed recording</Txt>
              </Pressable>
              {call.record_enabled && call.parent_consent_at && call.child_consent_at && <Pressable
                accessibilityRole="button" disabled={checkingRecording} onPress={checkRecording} style={{ minHeight: 44, justifyContent: 'center' }}>
                <Txt tone="accent">{checkingRecording ? 'Checking recording provider…' : 'Recover recording from provider'}</Txt>
              </Pressable>}
              {recoveryMessage ? <Txt tone="muted" accessibilityRole="alert">{recoveryMessage}</Txt> : null}
            </View>
          )}
          {call.status === 'failed' && call.recording_url && (
            <Pressable
              accessibilityRole="button"
              disabled={retryingProcessing}
              onPress={retryProcessing}
              style={{ paddingVertical: space.sm }}
            >
              <Txt tone="accent" weight="bold">
                {retryingProcessing ? 'Restarting processing…' : t('retry')}
              </Txt>
            </Pressable>
          )}
          {retryError ? <Txt tone="muted" accessibilityRole="alert">{retryError}</Txt> : null}
        </View>
      )}

      {call.summary && (
        <Section title={t('summary')}>
          <Txt style={{ lineHeight: 26 }}>{call.summary}</Txt>
        </Section>
      )}

      {call.next_moves && call.next_moves.length > 0 && (
        <Section title={t('nextMoves')}>
          <View style={{ gap: space.xs }}>
            {call.next_moves.map((move, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: space.sm }}>
                <Txt tone="accent">→</Txt>
                <Txt style={{ flex: 1 }}>{move}</Txt>
              </View>
            ))}
          </View>
        </Section>
      )}

      {call.action_items && call.action_items.length > 0 && (
        <Section title={t('actionItems')}>
          <ActionList items={call.action_items} />
        </Section>
      )}

      {call.key_points && call.key_points.length > 0 && (
        <Section title={t('keyPoints')}>
          <View style={{ gap: space.xs }}>
            {call.key_points.map((point, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: space.sm }}>
                <Txt tone="faint">—</Txt>
                <Txt style={{ flex: 1 }}>{point}</Txt>
              </View>
            ))}
          </View>
        </Section>
      )}

      {call.status === 'ready' && call.transcript && <FollowupReview key={call.id} callId={call.id} initial={call.followups} />}

      {call.transcript && (
        <Section title={t('transcript')}>
          <Txt tone="muted" style={{ lineHeight: 26, color: color.parchment }}>
            {call.transcript}
          </Txt>
        </Section>
      )}
      {!['initiating','ringing','in-progress'].includes(call.status) && <DeleteCallControl callId={call.id} onDeleted={load} />}
    </ScrollView>
  );
}
