import { useRouter } from 'expo-router';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { useApp } from '../../src/AppContext';
import { Banner } from '../../src/components/Banner';
import { Empty } from '../../src/components/Empty';
import { Txt } from '../../src/components/Txt';
import { statusKey } from '../../src/i18n';
import { color, space, statusColor } from '../../src/theme';
import { formatDuration, formatWhen, useCalls } from '../../src/useCalls';

export default function Recents() {
  const { t, lang } = useApp();
  const router = useRouter();
  const { calls, loading, errorKey, refresh, clearError } = useCalls();

  if (!loading && calls.length === 0) {
    return (
      <View style={{ flex: 1 }}>
        {errorKey && <Banner message={t(errorKey)} onDismiss={clearError} />}
        <Empty title={t('noCallsTitle')} body={t('noCallsBody')} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {errorKey && <Banner message={t(errorKey)} onDismiss={clearError} />}

      <FlatList
        data={calls}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={refresh}
            tintColor={color.muted}
          />
        }
        ItemSeparatorComponent={() => (
          <View style={{ height: 1, backgroundColor: color.line, marginLeft: space.md }} />
        )}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/call/${item.id}`)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              paddingVertical: space.md,
              paddingRight: space.md,
              backgroundColor: pressed ? color.surface : 'transparent',
              // The leading edge carries the status, so the row needs no badge.
              borderLeftWidth: 3,
              borderLeftColor: statusColor[item.status] ?? color.faint,
              paddingLeft: space.md - 3,
            })}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Txt size="subhead">
                {item.contact_name ?? item.destination}
              </Txt>
              <Txt size="caption" tone="muted">
                {item.direction === 'inbound' ? t('incoming') : t('outgoing')}
                {'  '}
                {t(statusKey(item.status))}
                {item.duration_sec ? `  ${formatDuration(item.duration_sec)}` : ''}
              </Txt>
            </View>

            <Txt size="caption" tone="faint">
              {formatWhen(item.created_at, lang)}
            </Txt>
          </Pressable>
        )}
      />
    </View>
  );
}
