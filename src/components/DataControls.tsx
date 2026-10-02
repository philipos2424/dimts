import { useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { deleteAccount, getActivity, getPrivacyRequests, type ActivityEvent, type PrivacyRequest } from '../api';
import { useApp } from '../AppContext';
import { exportAllData } from '../exportData';
import { PrimaryButton } from './PrimaryButton';
import { Section } from './Section';
import { Txt } from './Txt';
import { color, font, radius, space, type } from '../theme';

const ACTION_LABELS: Record<string, string> = {
  signed_in: 'Signed in', signed_out: 'Signed out', terms_accepted: 'Accepted the terms', audio_played: 'Played a recording',
  data_exported: 'Downloaded your data', call_deleted: 'Deleted a call', contact_deleted: 'Deleted a contact',
  privacy_request_received: 'Received a privacy request', account_deleted: 'Deleted the account',
};

export function DataControls() {
  const { signedOut } = useApp();
  const [activity, setActivity] = useState<ActivityEvent[] | null>(null);
  const [requests, setRequests] = useState<PrivacyRequest[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => {
    getPrivacyRequests().then(setRequests).catch(() => {});
  }, []);

  async function download() {
    setExporting(true); setExportError('');
    try { await exportAllData(); }
    catch (err) { setExportError(err instanceof Error ? err.message : 'Unable to download your data.'); }
    finally { setExporting(false); }
  }

  async function removeAccount() {
    setDeleting(true); setDeleteError('');
    try { await deleteAccount(); signedOut(); }
    catch (err) { setDeleteError(err instanceof Error ? err.message : 'Unable to delete your account.'); setDeleting(false); }
  }

  function toggleActivity() {
    if (activity) setActivity(null);
    else getActivity().then(setActivity).catch(() => setActivity([]));
  }

  return (
    <Section title="Your data">
      {requests.length > 0 && (
        <View accessibilityRole="alert" style={{ backgroundColor: color.raised, borderRadius: radius.md, padding: space.md, gap: space.xs }}>
          <Txt weight="bold">{requests.length === 1 ? 'Someone asked' : `${requests.length} people asked`} for their call data to be deleted</Txt>
          <Txt tone="muted">Open their contact and choose Delete. Due by {new Date(requests[0].due_at).toLocaleDateString()}.</Txt>
        </View>
      )}
      <Txt tone="muted">Your calls are stored in Europe and kept until you delete them.</Txt>
      <PrimaryButton label="Download my data" onPress={download} busy={exporting} />
      {exportError ? <Txt accessibilityRole="alert" tone="muted">{exportError}</Txt> : null}

      <Pressable accessibilityRole="button" onPress={toggleActivity} style={{ minHeight: 44, justifyContent: 'center' }}>
        <Txt tone="accent">{activity ? 'Hide activity' : 'Show account activity'}</Txt>
      </Pressable>
      {activity?.map((event, index) => (
        <View key={`${event.created_at}-${index}`} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}>
          <Txt>{ACTION_LABELS[event.action] ?? event.action}</Txt>
          <Txt tone="muted" size="caption">{new Date(event.created_at).toLocaleString()}</Txt>
        </View>
      ))}
      {activity?.length === 0 && <Txt tone="muted">No activity yet.</Txt>}

      {!confirming ? (
        <Pressable accessibilityRole="button" onPress={() => setConfirming(true)} style={{ minHeight: 44, justifyContent: 'center' }}>
          <Txt style={{ color: color.madder }}>Delete my account</Txt>
        </Pressable>
      ) : (
        <View style={{ gap: space.sm }}>
          <Txt>This permanently deletes every call, recording, note and contact, and releases your business number. Type DELETE to confirm.</Txt>
          <TextInput value={typed} onChangeText={setTyped} autoCapitalize="characters" accessibilityLabel="Type DELETE to confirm"
            style={{ fontFamily: font.regular, fontSize: type.body, color: color.parchment, backgroundColor: color.surface,
              borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm }} />
          <PrimaryButton label="Delete everything" danger onPress={removeAccount} busy={deleting} disabled={typed !== 'DELETE'} />
          <Pressable accessibilityRole="button" onPress={() => { setConfirming(false); setTyped(''); }} style={{ minHeight: 44, justifyContent: 'center' }}>
            <Txt tone="accent">Keep my account</Txt>
          </Pressable>
          {deleteError ? <Txt accessibilityRole="alert" tone="muted">{deleteError}</Txt> : null}
        </View>
      )}
    </Section>
  );
}
