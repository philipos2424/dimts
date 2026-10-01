"""Conservative signal checks, not speech recognition or proof of audibility."""
import numpy as np


def inspect_channels(channels, sample_rate=16000):
    if sample_rate <= 0 or not channels or len(channels) > 2:
        raise ValueError('Unsupported audio layout')
    results = []
    for channel in channels:
        values = np.asarray(channel, dtype=np.float32)
        if values.ndim != 1 or not values.size or not np.isfinite(values).all():
            raise ValueError('Empty or invalid decoded audio')
        # A small floor detects near-digital silence; it does not classify noise
        # as speech or reject quiet speech using an arbitrary volume preference.
        window = max(1, int(sample_rate * 0.2))
        peak = float(np.max(np.abs(values)))
        active = any(float(np.sqrt(np.mean(part.astype(np.float64) ** 2))) > 0.0001
                     for start in range(0, values.size, window)
                     for part in [values[start:start + window]])
        results.append({'duration_sec': round(values.size / sample_rate, 3),
                        'peak': peak, 'signal_present': active})
    present = sum(item['signal_present'] for item in results)
    status = ('silent' if present == 0 else 'single_channel' if len(results) == 1
              else 'missing_channel_signal' if present != 2 else 'signal_present')
    return {'version': 1, 'status': status, 'channels': results}
