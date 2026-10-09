import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { setPromise, type PromiseItem, type Promises } from '../api';
import { dueLabel } from '../reminderTime';
import { Card } from './Card';
import { Txt } from './Txt';
import { space, useTheme } from '../theme';

function Row({ item, onChange }: { item: PromiseItem; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  async function mark(status: 'done' | 'dismissed') {
    setBusy(true);
    try { await setPromise(item.call_id, item.index, status); onChange(); }
    catch { setBusy(false); }
  }
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, opacity: busy ? 0.5 : 1 }}>
      <View style={{ flex: 1 }}>
        <Txt>{item.task}</Txt>
        <Txt size="caption" tone="muted">
          {item.contact_name ?? item.phone}
          {item.due ? <Txt size="caption" tone={item.overdue ? 'danger' : 'muted'} weight={item.overdue ? 'bold' : 'regular'}>
            {' · '}{item.overdue ? 'Overdue' : 'Due'} {dueLabel(item.due)?.replace(/^(Today|Tomorrow|Yesterday)/, s => s.toLowerCase())}
          </Txt> : null}
        </Txt>
      </View>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => mark('done')} hitSlop={8}>
        <Txt tone="ok" weight="bold">Done</Txt>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => mark('dismissed')} hitSlop={8}>
        <Txt tone="faint">Dismiss</Txt>
      </Pressable>
    </View>
  );
}

/** "You owe 2 · Waiting on 1": commitments from calls, until they are done. */
export function PromisesStrip({ promises, onChange }: { promises: Promises; onChange: () => void }) {
  const { c } = useTheme();
  const overdue = promises.you_owe.filter(p => p.overdue).length;
  // A missed promise is not news to skim past: open the list when one is overdue.
  const [open, setOpen] = useState(overdue > 0);
  const owe = promises.you_owe.length, waiting = promises.waiting_on.length;
  if (!owe && !waiting) return null;
  return (
    <Card style={{ backgroundColor: c.raised, borderColor: c.raised }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}
        style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Txt weight="bold">
          {overdue ? <Txt weight="bold" tone="danger">{overdue} overdue · </Txt> : null}
          {owe ? `You owe ${owe}` : ''}{owe && waiting ? ' · ' : ''}{waiting ? `Waiting on ${waiting}` : ''}
        </Txt>
        <Txt tone="brand">{open ? 'Hide' : 'Show'}</Txt>
      </Pressable>
      {open && (
        <View style={{ gap: space.md }}>
          {owe > 0 && <Txt size="caption" tone="muted" weight="bold">YOU PROMISED</Txt>}
          {promises.you_owe.map(item => <Row key={`${item.call_id}-${item.index}`} item={item} onChange={onChange} />)}
          {waiting > 0 && <Txt size="caption" tone="muted" weight="bold">THEY PROMISED</Txt>}
          {promises.waiting_on.map(item => <Row key={`${item.call_id}-${item.index}`} item={item} onChange={onChange} />)}
        </View>
      )}
    </Card>
  );
}
