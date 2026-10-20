import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { getSignInMethods, removeSignInMethod, type SignInMethod } from '../api';
import { PROVIDER_LABELS } from '../socialSignIn';
import { Button } from './Button';
import { Section } from './Section';
import { Txt } from './Txt';
import { radius, space, useTheme } from '../theme';

const when = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';

/** Accounts that sign in without a text code. Hidden until the server offers any. */
export function SignInMethods() {
  const { c } = useTheme();
  const [methods, setMethods] = useState<SignInMethod[] | null>(null);
  const [available, setAvailable] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => getSignInMethods()
    .then(r => { setMethods(r.methods); setAvailable(r.available.length); })
    .catch(() => setError('Unable to load your sign-in methods.')), []);
  useEffect(() => { load(); }, [load]);

  async function remove(method: SignInMethod) {
    setBusy(method.provider); setError('');
    try { await removeSignInMethod(method.provider); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to remove it.'); }
    finally { setBusy(''); }
  }

  if (!error && (!methods || (!methods.length && !available))) return null;
  const linked = methods ?? [];
  return (
    <Section title="Sign-in methods">
      <Txt tone="muted">
        {linked.length
          ? 'These accounts sign you in without a text code. Your mobile number always works too.'
          : 'Sign out, then choose an available provider on the sign-in page to skip text codes next time.'}
      </Txt>
      {linked.map(method => (
        <View key={method.provider} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md,
          backgroundColor: c.card, borderRadius: radius.md, padding: space.md }}>
          <View style={{ flex: 1, gap: space.xs }}>
            <Txt weight="bold">{PROVIDER_LABELS[method.provider]}</Txt>
            <Txt tone="muted" size="caption">Added {when(method.created_at)} · last used {when(method.last_used_at)}</Txt>
          </View>
          <Button compact variant="quiet" label="Remove" busy={busy === method.provider} onPress={() => remove(method)} />
        </View>
      ))}
      {!!error && <Txt tone="danger">{error}</Txt>}
    </Section>
  );
}
