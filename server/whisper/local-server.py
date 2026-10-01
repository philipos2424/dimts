"""Local audio transcription worker. Bind to loopback; never expose this port."""
import io
import os
from pathlib import Path
import secrets
import sys
from threading import Lock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / '.data' / 'python'))
env_file = ROOT / '.env'
for line in env_file.read_text(encoding='utf-8').splitlines() if env_file.exists() else []:
    if '=' in line and not line.lstrip().startswith('#'):
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip())

import av
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
import uvicorn
from audio_quality import inspect_channels

app = FastAPI()
model = None
lock = Lock()
token = os.environ.get('WHISPER_API_TOKEN')
if not token:
    raise RuntimeError('Set WHISPER_API_TOKEN in .env')

@app.get('/health')
def health():
    return {'ok': True, 'loaded': model is not None}

@app.post('/transcribe')
def transcribe(file: UploadFile = File(...), authorization: str = Header(default='')):
    global model
    if not secrets.compare_digest(authorization, f'Bearer {token}'):
        raise HTTPException(401, 'Unauthorized')
    audio = file.file.read(50 * 1024 * 1024 + 1)
    if len(audio) > 50 * 1024 * 1024:
        raise HTTPException(413, 'Audio exceeds 50 MB')
    if not lock.acquire(blocking=False):
        raise HTTPException(503, 'Transcription worker is busy; retry later')
    try:
        try:
            with av.open(io.BytesIO(audio)) as container:
                count = container.streams.audio[0].layout.nb_channels
                if count not in (1, 2):
                    raise HTTPException(422, 'Unsupported audio layout')
                stereo = count == 2
            decoded = decode_audio(io.BytesIO(audio), split_stereo=stereo)
            channels = list(decoded) if stereo else [decoded]
            quality = inspect_channels(channels)
        except (ValueError, IndexError, av.error.FFmpegError):
            raise HTTPException(422, 'Empty or unreadable audio') from None
        if quality['status'] != 'silent' and model is None:
            model = WhisperModel(os.environ.get('WHISPER_MODEL', 'base'), device='cpu',
                compute_type='int8', cpu_threads=4, download_root=str(ROOT / '.data' / 'whisper-models'))
        transcripts = []
        for index, channel in enumerate(channels):
            if not quality['channels'][index]['signal_present']:
                transcripts.append({'text': '', 'words': [], 'language_code': None,
                                    'language_probability': None})
                continue
            segments, info = model.transcribe(channel, beam_size=5, word_timestamps=True, vad_filter=True)
            text, words = [], []
            for segment in segments:
                text.append(segment.text.strip())
                for word in segment.words or []:
                    words.append({'text': word.word.strip(), 'type': 'word', 'start': word.start, 'end': word.end})
            transcripts.append({'text': ' '.join(text), 'words': words,
                'language_code': info.language, 'language_probability': info.language_probability})
        # Mono audio cannot establish which speaker owns each turn.
        return {'transcripts': transcripts, 'audio_quality': quality} if stereo else {
            **transcripts[0], 'audio_quality': quality}
    finally:
        lock.release()

if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=int(os.environ.get('WHISPER_PORT', '3104')))
