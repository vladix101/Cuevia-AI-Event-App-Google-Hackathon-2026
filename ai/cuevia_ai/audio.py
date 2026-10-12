"""Audio normalization for Gemma audio input: 16 kHz, mono, 16-bit PCM WAV.

Gemma's audio encoder (Gemma 3n / Gemma 4 E2B/E4B) consumes 16 kHz mono audio. PCM WAV is
decoded with the standard library + numpy. Other containers (webm/ogg/mp3/m4a) are decoded
only when an ``ffmpeg`` binary is on PATH (it is installed in the Docker image); otherwise the
request fails with UNSUPPORTED_AUDIO_FORMAT rather than guessing.
"""

from __future__ import annotations

import io
import shutil
import subprocess
import wave

import numpy as np

from .errors import AIServiceError

TARGET_RATE = 16_000


def _decode_wav(data: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(data), "rb") as w:
        channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(frames)
    if width == 1:
        samples = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 2:
        samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        ints = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        ints = np.where(ints & 0x800000, ints - 0x1000000, ints)
        samples = ints.astype(np.float32) / 8388608.0
    elif width == 4:
        samples = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise AIServiceError(415, "UNSUPPORTED_AUDIO_FORMAT", f"Unsupported WAV sample width: {width} bytes.")
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, rate


def _resample(samples: np.ndarray, rate: int) -> np.ndarray:
    if rate == TARGET_RATE or samples.size == 0:
        return samples
    duration = samples.size / rate
    n_out = max(1, int(round(duration * TARGET_RATE)))
    x_old = np.linspace(0.0, duration, num=samples.size, endpoint=False)
    x_new = np.linspace(0.0, duration, num=n_out, endpoint=False)
    return np.interp(x_new, x_old, samples).astype(np.float32)


def _encode_wav(samples: np.ndarray) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TARGET_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


def _ffmpeg_to_wav(data: bytes) -> bytes:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise AIServiceError(
            415, "UNSUPPORTED_AUDIO_FORMAT",
            "Only PCM WAV is accepted without ffmpeg; send 16 kHz mono WAV or install ffmpeg.",
        )
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(TARGET_RATE),
         "-f", "wav", "-acodec", "pcm_s16le", "pipe:1"],
        input=data, capture_output=True, timeout=30, check=False,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise AIServiceError(415, "UNSUPPORTED_AUDIO_FORMAT", "Audio could not be decoded.")
    return proc.stdout


def normalize_audio(data: bytes, *, max_seconds: int) -> tuple[bytes, float]:
    """Return (16 kHz mono PCM16 WAV bytes, duration seconds)."""
    if not data:
        raise AIServiceError(422, "EMPTY_AUDIO", "Audio file is empty.")
    is_wav = data[:4] == b"RIFF" and data[8:12] == b"WAVE"
    try:
        samples, rate = _decode_wav(data if is_wav else _ffmpeg_to_wav(data))
    except (wave.Error, EOFError, ValueError):
        # e.g. IEEE-float WAV, which the stdlib reader does not handle.
        samples, rate = _decode_wav(_ffmpeg_to_wav(data))
    duration = samples.size / rate if rate else 0.0
    if duration <= 0:
        raise AIServiceError(422, "EMPTY_AUDIO", "Audio contains no samples.")
    if duration > max_seconds + 0.5:
        raise AIServiceError(
            413, "AUDIO_TOO_LONG", f"Audio chunk is {duration:.1f}s; maximum is {max_seconds}s per request."
        )
    return _encode_wav(_resample(samples, rate)), duration
