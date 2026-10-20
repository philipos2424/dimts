import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { deleteContact, getPerson, renameContact, type Person } from '../../src/api';
import { useApp } from '../../src/AppContext';
import { Button } from '../../src/components/Button';
import { Card } from '../../src/components/Card';
import { CallerRecordingChoice } from '../../src/components/CallerRecordingChoice';
import { PromisesStrip } from '../../src/components/PromisesStrip';
import { Screen } from '../../src/components/Screen';
import { Txt } from '../../src/components/Txt';
import { font, radius, space, type, useTheme } from '../../src/theme';

/** Everything about one person: who they are, what you agreed, what is open. */
export default function PersonScreen() {
  const { c } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userPhone } = useApp();
  const router = useRouter();
  const [person, setPerson] = useState<Person | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(''), [company, setCompany] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false), [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    // Wait for the restored session before asking the server.
    if (!id || !userPhone) return;
    try {
      const result = await getPerson(id);
      setPerson(result); setName(result.contact.display_name ?? ''); setCompany(result.contact.company ?? ''); setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load this person.'); }
  }, [id, userPhone]);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!person || !name.trim()) return;
    setSaving(true);
    try { await renameContact(person.contact.id, name.trim(), company.trim(), person.contact.notes ?? ''); setEditing(false); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to save.'); }
    finally { setSaving(false); }
  }

  async function remove() {
    if (!person) return;
    setDeleting(true);
    try { await deleteContact(person.contact.id); router.replace('/'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to delete.'); setDeleting(false); }
  }

  if (!person) return <Screen>{error ? <Txt tone="danger">{error}</Txt> : <Txt tone="muted">Loading…</Txt>}</Screen>;
  const last = person.calls.find(call => call.agreements?.length);
  const input = { fontFamily: font.regular, fontSize: type.subhead, color: c.ink, backgroundColor: c.card, borderColor: c.line,
    borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm } as const;

  return (
    <Screen>
      {editing ? (
        <View style={{ gap: space.sm }}>
          <TextInput value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={c.faint} accessibilityLabel="Name" style={input} autoFocus />
          <TextInput value={company} onChangeText={setCompany} placeholder="Company" placeholderTextColor={c.faint} accessibilityLabel="Company" style={input} />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}><Button label="Save" onPress={save} busy={saving} disabled={!name.trim()} /></View>
            <View style={{ flex: 1 }}><Button label="Cancel" variant="quiet" onPress={() => setEditing(false)} /></View>
          </View>
        </View>
      ) : (
        <View style={{ gap: space.xs }}>
          <Txt size="screen" serif>{person.contact.display_name ?? person.contact.phone}</Txt>
          {person.contact.company ? <Txt tone="muted">{person.contact.company}</Txt> : null}
          <Txt tone="muted">{person.contact.phone}</Txt>
          {person.contact.name_source !== 'user' && person.contact.display_name ? (
            <Txt size="caption" tone="faint">Name taken from the conversation.</Txt>
          ) : null}
          <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
            <Button compact label="Call" onPress={() => router.push(`/dialer?number=${encodeURIComponent(person.contact.phone)}`)} />
            <Button compact variant="quiet" label="Ask about them"
              onPress={() => router.push(`/?draft=${encodeURIComponent(`What did ${person.contact.display_name ?? person.contact.phone} and I agree? `)}`)} />
            <Button compact variant="quiet" label="Fix name" onPress={() => setEditing(true)} />
          </View>
        </View>
      )}
      {error ? <Txt tone="danger">{error}</Txt> : null}

      {last && (
        <Card>
          <Txt size="caption" tone="muted" weight="bold">LAST TIME · {new Date(last.created_at).toLocaleDateString()}</Txt>
          {last.agreements!.map((a, i) => <Txt key={i}>{a.subject}: <Txt weight="bold">{a.value}</Txt></Txt>)}
        </Card>
      )}

      <CallerRecordingChoice contactId={person.contact.id} value={person.contact.recording_pref ?? 'default'} />

      <PromisesStrip promises={person.promises} onChange={load} />

      <View style={{ gap: space.sm }}>
        <Txt size="subhead" serif>Calls</Txt>
        {person.calls.map(call => (
          <Card key={call.id} onPress={() => router.push(`/call/${call.id}`)}>
            <Txt size="caption" tone="muted">{new Date(call.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {call.direction === 'inbound' ? 'Incoming' : 'Outgoing'}</Txt>
            {call.summary ? <Txt numberOfLines={2}>{call.summary}</Txt> : <Txt tone="faint">No notes</Txt>}
          </Card>
        ))}
      </View>

      {!confirming ? (
        <Button variant="quiet" label="Delete this person" onPress={() => setConfirming(true)} />
      ) : (
        <Card>
          <Txt>Delete {person.contact.display_name ?? 'this person'} and all {person.calls.length} calls with them? This cannot be undone.</Txt>
          <Button variant="danger" label="Delete person and calls" onPress={remove} busy={deleting} />
          <Button variant="quiet" label="Keep" onPress={() => setConfirming(false)} />
        </Card>
      )}
    </Screen>
  );
}
