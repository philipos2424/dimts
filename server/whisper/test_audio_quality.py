import io
from pathlib import Path
import sys
import unittest
import wave
import importlib.util
import os
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / '.data' / 'python'))
import numpy as np
from faster_whisper.audio import decode_audio
from audio_quality import inspect_channels
from fastapi.testclient import TestClient


class AudioQualityTests(unittest.TestCase):
    def test_silent_and_one_sided_decoded_recordings(self):
        for right_present, expected in [(False, 'missing_channel_signal'), (True, 'signal_present')]:
            samples = np.zeros((16000, 2), dtype=np.int16)
            tone = (2000 * np.sin(np.arange(8000) * 0.1)).astype(np.int16)
            samples[:8000, 0] = tone
            if right_present:
                samples[8000:, 1] = tone
            buffer = io.BytesIO()
            with wave.open(buffer, 'wb') as output:
                output.setnchannels(2); output.setsampwidth(2); output.setframerate(16000)
                output.writeframes(samples.tobytes())
            decoded = decode_audio(io.BytesIO(buffer.getvalue()), split_stereo=True)
            result = inspect_channels(list(decoded))
            self.assertEqual(result['status'], expected)
            self.assertEqual(result['channels'][0]['duration_sec'], 1)
        self.assertEqual(inspect_channels([np.zeros(16000), np.zeros(16000)])['status'], 'silent')

    def test_quiet_signal_late_in_long_recording_is_not_lost_to_global_average(self):
        values = np.zeros(16000 * 60)
        values[-3200:] = 0.0002
        self.assertEqual(inspect_channels([values, values])['status'], 'signal_present')

    def test_mono_cannot_confirm_both_sides_and_signal_is_not_claimed_as_speech(self):
        self.assertEqual(inspect_channels([np.full(16000, 0.01)])['status'], 'single_channel')
        self.assertEqual(inspect_channels([np.full(16000, 0.01)] * 2)['status'], 'signal_present')

    def test_invalid_and_empty_audio_is_rejected(self):
        for channels in [[], [np.array([])], [np.array([np.nan])], [np.zeros(2)] * 3]:
            with self.assertRaises(ValueError):
                inspect_channels(channels)

    def test_authenticated_worker_skips_silent_channels_and_rejects_unreadable_audio(self):
        spec = importlib.util.spec_from_file_location('quality_test_worker', Path(__file__).with_name('local-server.py'))
        worker = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'WHISPER_API_TOKEN': 'test-worker-token'}):
            spec.loader.exec_module(worker)
        client = TestClient(worker.app)
        headers = {'Authorization': f'Bearer {worker.token}'}
        def audio(samples):
            buffer = io.BytesIO()
            with wave.open(buffer, 'wb') as output:
                output.setnchannels(2); output.setsampwidth(2); output.setframerate(16000)
                output.writeframes(samples.astype(np.int16).tobytes())
            return {'file': ('test.wav', buffer.getvalue(), 'audio/wav')}
        silent = audio(np.zeros((16000, 2)))
        self.assertEqual(client.post('/transcribe', files=silent).status_code, 401)
        with patch.object(worker, 'WhisperModel', side_effect=AssertionError('Silent audio must not load a model')):
            response = client.post('/transcribe', headers=headers, files=silent)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['audio_quality']['status'], 'silent')
        self.assertTrue(all(not item['text'] for item in response.json()['transcripts']))
        self.assertEqual(client.post('/transcribe', headers=headers, files={'file': ('bad.wav', b'broken')}).status_code, 422)
        # No real inference or external model download is needed to check the
        # HTTP adapter: only the channel with signal should reach inference.
        class Model:
            calls = 0
            def transcribe(self, values, **kwargs):
                self.calls += 1
                return [SimpleNamespace(text='Hello', words=[])], SimpleNamespace(language='en', language_probability=0.9)
        worker.model = Model()
        samples = np.zeros((16000, 2)); samples[:, 0] = 2000 * np.sin(np.arange(16000) * 0.1)
        response = client.post('/transcribe', headers=headers, files=audio(samples))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['audio_quality']['status'], 'missing_channel_signal')
        self.assertEqual(worker.model.calls, 1)


if __name__ == '__main__':
    unittest.main()
