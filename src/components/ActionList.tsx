import { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { ActionItem } from '../api';
import { color, radius, space } from '../theme';
import { Txt } from './Txt';

/**
 * Checking an item is a reading aid, not a stored decision — the state is
 * local and deliberately does not sync, so nothing implies the other party
 * sees it.
 */
export function ActionList({ items }: { items: ActionItem[] }) {
  const [done, setDone] = useState<Record<number, boolean>>({});

  return (
    <View style={{ gap: space.sm }}>
      {items.map((item, index) => {
        const checked = Boolean(done[index]);

        return (
          <Pressable
            key={`${item.task}-${index}`}
            accessibilityRole="checkbox"
            accessibilityState={{ checked }}
            onPress={() => setDone((d) => ({ ...d, [index]: !d[index] }))}
            style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}
          >
            <View
              style={{
                width: 20,
                height: 20,
                marginTop: 3,
                borderRadius: radius.sm,
                borderWidth: 1.5,
                borderColor: checked ? color.saffron : color.line,
                backgroundColor: checked ? color.saffron : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {checked && (
                <Txt size="caption" weight="bold" style={{ color: color.ink, lineHeight: 14 }}>
                  ✓
                </Txt>
              )}
            </View>

            <View style={{ flex: 1 }}>
              <Txt
                tone={checked ? 'faint' : 'primary'}
                style={checked ? { textDecorationLine: 'line-through' } : undefined}
              >
                {item.task}
              </Txt>
              {item.owner && (
                <Txt size="caption" tone="muted">
                  {item.owner}
                </Txt>
              )}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
