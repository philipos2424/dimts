import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Pressable, View } from 'react-native';
import { useApp } from '../AppContext';
import { audioUrlFor, authHeaders } from '../api';
import { color, radius, space } from '../theme';
import { Txt } from './Txt';

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Streams the recording through our own proxy. AudioSource carries the
 * identifying header, so the app never needs Twilio credentials and the
 * endpoint stays closed to anyone else.
 */
export function CallPlayer({ callId }: { callId: string }) {
  const { t, userPhone } = useApp();

  const player = useAudioPlayer(
    userPhone
      ? { uri: audioUrlFor(callId), headers: authHeaders(userPhone) }
      : null
  );
  const status = useAudioPlayerStatus(player);

  const progress =
    status.duration > 0 ? Math.min(status.currentTime / status.duration, 1) : 0;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        padding: space.md,
        backgroundColor: color.surface,
        borderRadius: radius.md,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={status.playing ? t('pause') : t('play')}
        disabled={!status.isLoaded}
        onPress={() => (status.playing ? player.pause() : player.play())}
        style={{
          width: 44,
          height: 44,
          borderRadius: radius.pill,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: status.isLoaded ? color.saffron : color.line,
        }}
      >
        <Txt
          size="subhead"
          weight="bold"
          style={{ color: color.ink, lineHeight: 20 }}
        >
          {status.playing ? '❚❚' : '▶'}
        </Txt>
      </Pressable>

      <View style={{ flex: 1, gap: space.xs }}>
        <View
          style={{
            height: 3,
            borderRadius: radius.pill,
            backgroundColor: color.line,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${progress * 100}%`,
              height: '100%',
              backgroundColor: color.saffron,
            }}
          />
        </View>
        <Txt size="caption" tone="muted">
          {status.isBuffering && !status.playing
            ? '…'
            : `${clock(status.currentTime)} / ${clock(status.duration)}`}
        </Txt>
      </View>
    </View>
  );
}
