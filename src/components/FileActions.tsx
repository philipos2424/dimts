import { useEffect, useState } from 'react';
import { Linking, TextInput, View } from 'react-native';
import { ApiError, getFileActions, getFileOptions, prepareFileActions, updateFileAction, type FileAction, type FileOptions } from '../api';
import { Button } from './Button';
import { Txt } from './Txt';
import { space, useTheme } from '../theme';

const labels: Record<FileAction['status'], string> = {
  needs_details: 'Choose a file and recipient', ready_for_review: 'Ready for your approval',
  sending: 'Sending — check status for the result', sent: 'Sent on Telegram by MiniMe',
  failed: 'Not sent. Review the details before trying again.', unknown: 'Result uncertain. Check status before sending anything again.', dismissed: 'Dismissed',
};

function Action({ callId, action, onChange }: { callId: string; action: FileAction; onChange: (action: FileAction) => void }) {
  const { c } = useTheme();
  const [options, setOptions] = useState<FileOptions | null>(null);
  const [file, setFile] = useState(action.file?.id || '');
  const [recipient, setRecipient] = useState(action.recipient?.id || '');
  const [caption, setCaption] = useState(action.caption);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editable = ['needs_details','ready_for_review','failed'].includes(action.status);
  const dirty = file !== (action.file?.id || '') || recipient !== (action.recipient?.id || '') || caption !== action.caption;
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError(e instanceof ApiError ? e.message : 'That did not finish. Refresh and try again.'); }
    finally { setBusy(false); }
  }
  async function update(operation: 'review' | 'send' | 'status' | 'dismiss') {
    const result = await updateFileAction(callId, action.id, operation, {
      version: action.version, document_id: file, customer_id: recipient, caption,
    });
    onChange(result.action);
    setCaption(result.action.caption);
    setFile(result.action.file?.id || ''); setRecipient(result.action.recipient?.id || '');
    setPreview(result.preview_url || null);
  }
  return <View style={{ gap: space.sm, borderWidth: 1, borderColor: c.line, padding: space.md }}>
    <Txt weight="bold">{action.request}</Txt>
    <Txt size="caption" tone="muted">{action.channel === 'telegram' ? 'Telegram' : 'WhatsApp'} · {labels[action.status]}</Txt>
    {action.evidence.map((quote, i) => <Txt key={i} size="caption" tone="muted" selectable>{quote}</Txt>)}
    {action.file && <Txt>File: {action.file.name}</Txt>}
    {action.recipient && <Txt>To: {action.recipient.name} · {action.recipient.phone}</Txt>}
    {action.status === 'sent' && action.message_id && <Txt size="caption" tone="muted">Telegram receipt: {action.message_id}</Txt>}
    {action.channel === 'whatsapp' && editable && <Txt tone="muted">WhatsApp file sending is not connected yet. This request has not been sent.</Txt>}
    {editable && action.channel === 'telegram' && <>
      <Button compact variant="quiet" label="Choose file and recipient" disabled={busy} onPress={() => run(async () => setOptions(await getFileOptions(callId, action.id)))} />
      {options && <>
        <Txt weight="bold">Recipient</Txt>
        {!options.recipients.length && <Txt tone="muted">Ask the caller to message your MiniMe business on Telegram and share their phone number, then refresh these choices.</Txt>}
        {options.recipients.map(item => <Button key={item.id} compact variant="quiet" disabled={busy}
          label={`${recipient === item.id ? '✓ ' : ''}${item.name} · ${item.phone}`} onPress={() => { setRecipient(item.id); setPreview(null); }} />)}
        <Txt weight="bold">File</Txt>
        {!options.files.length && <Txt tone="muted">Upload a file in MiniMe, then refresh these choices.</Txt>}
        {options.files.map(item => <Button key={item.id} compact variant="quiet" disabled={busy}
          label={`${file === item.id ? '✓ ' : ''}${item.name}`} onPress={() => { setFile(item.id); setPreview(null); }} />)}
      </>}
      <TextInput accessibilityLabel="Message with the file" placeholder="Optional message" placeholderTextColor={c.muted}
        value={caption} editable={!busy} onChangeText={value => { setCaption(value); setPreview(null); }} maxLength={1000} multiline
        style={{ borderWidth: 1, borderColor: c.line, color: c.ink, padding: space.sm, minHeight: 60 }} />
      <Button compact variant="quiet" label="Review selected file" disabled={busy || !file || !recipient} onPress={() => run(() => update('review'))} />
      {preview && !dirty && <Button compact variant="quiet" label="Open file preview (link expires in 1 minute)" disabled={busy}
        onPress={() => run(async () => { if (!/^https:\/\//.test(preview)) throw new Error(); await Linking.openURL(preview); })} />}
      {action.status === 'ready_for_review' && <Button label="Approve and send on Telegram" disabled={busy || dirty} onPress={() => run(() => update('send'))} />}
    </>}
    {editable && <Button compact variant="quiet" label="Dismiss request" disabled={busy} onPress={() => run(() => update('dismiss'))} />}
    {['sending','unknown'].includes(action.status) && <Button compact label="Check sending status" disabled={busy} onPress={() => run(() => update('status'))} />}
    {!!error && <Txt tone="danger" accessibilityRole="alert">{error}</Txt>}
  </View>;
}

export function FileActions({ callId }: { callId: string }) {
  const [actions, setActions] = useState<FileAction[]>([]);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  async function refresh() {
    const result = await getFileActions(callId);
    setAvailable(result.available); setActions(result.actions);
  }
  useEffect(() => { let alive = true; getFileActions(callId).then(r => {
    if (alive) { setAvailable(r.available); setActions(r.actions); }
  }).catch(() => { if (alive) setError('Could not load file actions.'); }); return () => { alive = false; }; }, [callId]);
  if (!available && !error) return null;
  return <View style={{ gap: space.sm }}>
    <Txt weight="bold">File requests</Txt>
    <Txt tone="muted">Review requests from this call and send a file through MiniMe.</Txt>
    <Button compact variant="quiet" label={busy ? 'Checking requests…' : actions.length ? 'Refresh file actions' : 'Find file requests'} disabled={busy}
      onPress={async () => {
        setBusy(true); setError('');
        try {
          if (actions.length || !available) await refresh();
          else { setActions((await prepareFileActions(callId)).actions); setChecked(true); }
        } catch (e) { setError(e instanceof ApiError ? e.message : 'Unable to prepare requests. Try again.'); }
        finally { setBusy(false); }
      }} />
    {checked && !actions.length && <Txt tone="muted">No Telegram or WhatsApp file requests found in this call.</Txt>}
    {actions.map(action => <Action key={action.id} callId={callId} action={action}
      onChange={updated => setActions(list => list.map(item => item.id === updated.id ? updated : item))} />)}
    {!!error && <Txt tone="danger" accessibilityRole="alert">{error}</Txt>}
  </View>;
}
