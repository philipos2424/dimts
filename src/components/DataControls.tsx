import { useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { deleteAccount, getActivity, getMe, getPrivacyRequests, patchRetention, type ActivityEvent, type PrivacyRequest, type Retention as Months } from '../api';
import { useApp } from '../AppContext';
import { exportAllData } from '../exportData';
import { PrimaryButton } from './PrimaryButton';
import { Section } from './Section';
import { Txt } from './Txt';
import { font, radius, space, type, useTheme } from '../theme';

const ACTION_LABELS: Record<string, string> = {
  signed_in: 'Signed in', signed_out: 'Signed out', terms_accepted: 'Accepted the terms', audio_played: 'Played a recording',
  data_exported: 'Downloaded your data', call_deleted: 'Deleted a call', contact_deleted: 'Deleted a contact',
  privacy_request_received: 'Received a privacy request', account_deleted: 'Deleted the account',
  call_auto_deleted: 'Deleted an old call automatically', retention_changed: 'Changed how long calls are kept',
  session_revoked: 'Signed out a device', sessions_revoked_others: 'Signed out all other devices',
  sessions_revoked_all: 'Signed out everywhere', contact_auto_deleted: 'Removed an old contact automatically',
};

export function DataControls() {
  const { c } = useTheme();
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
        <View accessibilityRole="alert" style={{ backgroundColor: c.raised, borderRadius: radius.md, padding: space.md, gap: space.xs }}>
          <Txt weight="bold">{requests.length === 1 ? 'Someone asked' : `${requests.length} people asked`} for their call data to be deleted</Txt>
          <Txt tone="muted">Open their contact and choose Delete. Due by {new Date(requests[0].due_at).toLocaleDateString()}.</Txt>
        </View>
      )}
      <Retention />
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
          <Txt style={{ color: c.danger }}>Delete my account</Txt>
        </Pressable>
      ) : (
        <View style={{ gap: space.sm }}>
          <Txt>This permanently deletes every call, recording, note and contact, and releases your business number. Type DELETE to confirm.</Txt>
          <TextInput value={typed} onChangeText={setTyped} autoCapitalize="characters" accessibilityLabel="Type DELETE to confirm"
            style={{ fontFamily: font.regular, fontSize: type.body, color: c.ink, backgroundColor: c.card,
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

const PERIODS: { months: Months; label: string }[] = [
  { months: null, label: 'Until I delete' }, { months: 3, label: '3 months' }, { months: 6, label: '6 months' },
  { months: 12, label: '1 year' }, { months: 24, label: '2 years' },
];

/** How long calls are kept. Older calls are deleted every night. */
function Retention() {
  const { c } = useTheme();
  const [months, setMonths] = useState<Months | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => { getMe().then(me => setMonths(me.retention_months ?? null)).catch(() => setMonths(null)); }, []);

  async function choose(next: Months) {
    const before = months;
    setMonths(next); setError('');
    try { await patchRetention(next); }
    catch { setMonths(before); setError('Couldn’t save. Try again.'); }
  }

  return (
    <View style={{ gap: space.sm }}>
      <Txt tone="muted">Your calls are stored in the EU. Keep them:</Txt>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {PERIODS.map(p => {
          const active = months === p.months;
          return (
            <Pressable key={String(p.months)} accessibilityRole="radio" accessibilityState={{ selected: active, disabled: months === undefined }}
              disabled={months === undefined} onPress={() => choose(p.months)}
              style={{ minHeight: 36, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.pill,
                borderWidth: 1, borderColor: active ? c.brand : c.line, backgroundColor: active ? c.brand : 'transparent' }}>
              <Txt size="caption" tone={active ? 'onBrand' : undefined}>{p.label}</Txt>
            </Pressable>
          );
        })}
      </View>
      {months != null && <Txt size="caption" tone="muted">Calls older than {PERIODS.find(p => p.months === months)?.label} are deleted automatically each night, with their recordings.</Txt>}
      {error ? <Txt accessibilityRole="alert" tone="danger">{error}</Txt> : null}
    </View>
  );
}
