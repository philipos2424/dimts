import { View } from 'react-native';
import { Txt } from './Txt';
import { radius, space, type Tone, useTheme } from '../theme';

export function Pill({ label, tone = 'muted' }: { label: string; tone?: Tone }) {
  const { c } = useTheme();
  return (
    <View style={{ alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2, backgroundColor: c.raised }}>
      <Txt size="caption" weight="bold" tone={tone}>{label}</Txt>
    </View>
  );
}

/** The one-glance answer to "did it actually record both of us?" */
export function CapturePill({ capture }: { capture: string }) {
  if (capture === 'both') return <Pill tone="ok" label="✓ Both voices" />;
  if (capture === 'one_voice') return <Pill tone="warn" label="⚠ Only one voice" />;
  if (capture === 'no_audio') return <Pill tone="danger" label="⚠ No audio" />;
  if (capture === 'pending') return <Pill tone="gold" label="Writing notes…" />;
  if (capture === 'unknown') return <Pill tone="warn" label="Recording kept, no notes" />;
  return <Pill label="Not recorded" />;
}
