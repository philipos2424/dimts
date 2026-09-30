"""Interleave synthetic speech into Twilio's outbound dual-channel shape."""
from pathlib import Path
import array
import wave

directory = Path(__file__).resolve().parents[2] / '.data' / 'audio-smoke'
def read(name):
    with wave.open(str(directory / f'{name}.wav')) as audio:
        assert audio.getnchannels() == 1 and audio.getsampwidth() == 2
        rate = audio.getframerate()
        values = array.array('h', audio.readframes(audio.getnframes()))
        return rate, values
rate, caller = read('caller')
rate_owner, owner = read('owner')
rate_reply, reply = read('reply')
assert rate == rate_owner == rate_reply
gap = rate // 2
length = len(caller) + len(owner) + len(reply) + gap * 2
stereo = array.array('h', [0]) * (length * 2)
for channel, start, speech in [(1, 0, caller), (0, len(caller) + gap, owner),
    (1, len(caller) + len(owner) + gap * 2, reply)]:
    for offset, sample in enumerate(speech):
        stereo[(start + offset) * 2 + channel] = sample
with wave.open(str(directory / 'conversation.wav'), 'wb') as output:
    output.setnchannels(2)
    output.setsampwidth(2)
    output.setframerate(rate)
    output.writeframes(stereo.tobytes())
print('Dual-channel conversation.wav generated')
