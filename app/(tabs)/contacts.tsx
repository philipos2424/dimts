import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Platform, Pressable, ScrollView, Share, TextInput, View } from 'react-native';
import { useApp } from '../../src/AppContext';
import { Contact, exportContact, listContacts, saveContact } from '../../src/api';
import { Txt } from '../../src/components/Txt';
import { color, radius, space } from '../../src/theme';

export default function Contacts() {
  const { userPhone } = useApp();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    if (userPhone) listContacts(userPhone).then(setContacts).catch(e => setError(e.message));
  }, [userPhone]);
  useFocusEffect(refresh);
  async function save() {
    if (!editing || !userPhone) return;
    setBusy(true); setError('');
    try { await saveContact(editing, userPhone); setEditing(null); refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to save'); }
    finally { setBusy(false); }
  }
  async function share(contact: Contact) {
    if (!userPhone) return;
    try {
      const vcard = await exportContact(contact.id, userPhone);
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([vcard], { type: 'text/vcard' }));
        const link = document.createElement('a'); link.href = url; link.download = 'contact.vcf'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else await Share.share({ message: vcard, title: contact.display_name || contact.phone });
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to export'); }
  }
  const input = { color: color.parchment, backgroundColor: color.raised, padding: space.md, borderRadius: radius.sm };
  return <ScrollView contentContainerStyle={{ padding: space.md, gap: space.md }}>
    {error ? <Txt tone="muted">{error}</Txt> : null}
    {!contacts.length && <Txt tone="muted">Contacts appear here after your calls.</Txt>}
    {contacts.map(contact => <View key={contact.id} style={{ padding: space.md, gap: space.sm, backgroundColor: color.surface, borderRadius: radius.md }}>
      <Txt size="title">{contact.display_name || contact.phone}</Txt>
      <Txt tone="muted">{contact.phone}{contact.company ? ` · ${contact.company}` : ''}</Txt>
      {contact.notes ? <Txt>{contact.notes}</Txt> : null}
      <View style={{ flexDirection: 'row', gap: space.lg }}>
        <Pressable accessibilityRole="button" onPress={() => { setEditing({ ...contact }); setError(''); }}><Txt tone="accent">Edit contact</Txt></Pressable>
        <Pressable accessibilityRole="button" onPress={() => share(contact)}><Txt tone="accent">Export contact</Txt></Pressable>
      </View>
      {editing?.id === contact.id && <View style={{ gap: space.sm }}>
        <TextInput accessibilityLabel="Contact name" placeholder="Name" value={editing.display_name || ''}
          onChangeText={display_name => setEditing({ ...editing, display_name })} style={input} />
        <TextInput accessibilityLabel="Company" placeholder="Company" value={editing.company || ''}
          onChangeText={company => setEditing({ ...editing, company })} style={input} />
        <TextInput accessibilityLabel="Contact notes" placeholder="Notes" value={editing.notes || ''} multiline
          onChangeText={notes => setEditing({ ...editing, notes })} style={input} />
        <Pressable accessibilityRole="button" disabled={busy} onPress={save}><Txt tone="accent">{busy ? 'Saving…' : 'Save'}</Txt></Pressable>
        <Pressable accessibilityRole="button" onPress={() => setEditing(null)}><Txt tone="muted">Cancel</Txt></Pressable>
      </View>}
    </View>)}
  </ScrollView>;
}
