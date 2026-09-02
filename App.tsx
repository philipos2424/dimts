import React, { useState } from 'react';
import { View, Button, Text } from 'react-native';
import { Audio } from 'expo-av';

export default function App() {
  const [rec, setRec] = useState<Audio.Recording | null>(null);
  const [uri, setUri] = useState<string | null>(null);

  async function start() {
    await Audio.requestPermissionsAsync();
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true });
    const { recording } = await Audio.Recording.createAsync(
      Audio.RecordingOptionsPresets.HIGH_QUALITY
    );
    setRec(recording);
  }

  async function stop() {
    await rec?.stopAndUnloadAsync();
    setUri(rec!.getURI()); // local file — playable immediately
  }

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 20 }}>
      <Button title="● Start recording" onPress={start} />
      <Button title="■ Stop" onPress={stop} disabled={!rec} />
      {uri && <Text style={{ marginTop: 10 }}>Saved: {uri}</Text>}
    </View>
  );
}