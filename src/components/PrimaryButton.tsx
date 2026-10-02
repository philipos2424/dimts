import { Button } from './Button';

export function PrimaryButton({ label, onPress, busy = false, disabled = false, danger = false }:
  { label: string; onPress: () => void; busy?: boolean; disabled?: boolean; danger?: boolean }) {
  return <Button label={label} onPress={onPress} busy={busy} disabled={disabled} variant={danger ? 'danger' : 'primary'} />;
}
