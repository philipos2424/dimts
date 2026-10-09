import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ApiError, deleteCall, listCallDeletions, retryCallDeletion, type DeletionRecord } from '../api';
import { useApp } from '../AppContext';
import { Section } from './Section';
import { Txt } from './Txt';
import { space } from '../theme';

function Button({ children, onPress, disabled = false }: { children: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={{ minHeight: 44, justifyContent: 'center' }}>
    <Txt tone="accent">{children}</Txt>
  </Pressable>;
}

export function DeletionStatus({ record, refresh }: { record: DeletionRecord; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function retry() {
    setBusy(true); setError('');
    try { await retryCallDeletion(record.id); await refresh(); }
    catch (err) { setError(err instanceof ApiError && err.status === 429 ? 'Wait a minute before checking again.' : 'Unable to retry provider deletion. Please try again later.'); }
    finally { setBusy(false); }
  }
  return <View style={{ gap: space.sm }}>
    <Txt>Call content removed from Dimts.</Txt>
    <Txt tone="muted">{record.provider_deletion_status === 'confirmed' ? 'The recording is no longer available through the provider’s recording API.' :
      record.provider_deletion_status === 'not_required' ? 'No provider recording was created for this call.' :
      record.provider_deletion_status === 'unknown' ? 'Provider recording removal is not yet confirmed. Retry to check it.' : 'Checking removal of the provider recording…'}</Txt>
    {record.provider_deletion_error === 'multiple_recordings' && <Txt tone="muted">More than one recording was found. Contact the operator with this call ID to resolve removal.</Txt>}
    {['account_unverified','account_changed'].includes(record.provider_deletion_error ?? '') && <Txt tone="muted">The original recording account cannot be checked with the current configuration. Contact the operator with this call ID to resolve removal.</Txt>}
    <Txt size="caption" tone="muted" selectable>Call ID: {record.id}</Txt>
    <Txt size="caption" tone="muted">Our phone carrier may retain call metadata for up to 40 days and take up to 30 days to remove media from all systems after deletion. Saved copies outside Dimts are unaffected.</Txt>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.lg }}>
      <Button onPress={() => { void refresh(); }} disabled={busy}>Refresh status</Button>
      {['pending','unknown'].includes(record.provider_deletion_status ?? '') && <Button onPress={retry} disabled={busy}>{busy ? 'Checking…' : 'Retry provider removal'}</Button>}
    </View>
    {error ? <Txt accessibilityRole="alert" tone="muted">{error}</Txt> : null}
  </View>;
}

export function DeleteCallControl({ callId, onDeleted }: { callId: string; onDeleted: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function remove() {
    setBusy(true); setError('');
    try { await deleteCall(callId); await onDeleted(); }
    catch (err) { setError(err instanceof ApiError && err.status === 409 ? 'This call or a Google action has not finished. Check its status before deleting.' : 'Unable to delete this call. Refresh to check its status, then try again.'); }
    finally { setBusy(false); }
  }
  return <Section title="Delete this call">
    {confirming ? <View style={{ gap: space.sm }}>
      <Txt>Remove the recording, transcript, AI notes and proposals? This cannot be undone.</Txt>
      <Txt tone="muted">Dimts also requests removal of the provider recording and shows its result. Call IDs, recording references, consent and usage records are retained. Contacts, saved copies and existing Google Calendar events or Gmail drafts remain.</Txt>
      <Button onPress={remove} disabled={busy}>{busy ? 'Deleting…' : 'Confirm deletion'}</Button>
      <Button onPress={() => setConfirming(false)} disabled={busy}>Cancel</Button>
    </View> : <Button onPress={() => setConfirming(true)}>Delete recording and notes</Button>}
    {error ? <Txt tone="muted" accessibilityRole="alert">{error}</Txt> : null}
  </Section>;
}

export function CallDeletionHistory() {
  const { userPhone } = useApp();
  const currentPhone = useRef(userPhone); currentPhone.current = userPhone;
  const [records, setRecords] = useState<DeletionRecord[]>([]), [error, setError] = useState('');
  async function refresh() {
    const owner = userPhone;
    try { const next = await listCallDeletions(); if (currentPhone.current === owner) { setRecords(next); setError(''); } }
    catch { if (currentPhone.current === owner) setError('Unable to load removal status. Please try again.'); }
  }
  useEffect(() => { setRecords([]); setError(''); if (userPhone) void refresh(); }, [userPhone]);
  return <Section title="Recording privacy">
    <Txt tone="muted">Recordings and notes remain until you delete their call. Open a finished call to export or remove its content. Deleting a call does not erase downloaded copies or changes already made in Google apps.</Txt>
    <Button onPress={() => { void refresh(); }}>Refresh removal history</Button>
    {error ? <Txt accessibilityRole="alert" tone="muted">{error}</Txt> : null}
    {records.map(record => <DeletionStatus key={record.id} record={record} refresh={refresh} />)}
  </Section>;
}
