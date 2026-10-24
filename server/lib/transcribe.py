"""Local speech-to-text for short audio windows (free, no API). Prints JSON: [{"start": s, "text": "..."}].
Usage: python3 transcribe.py a.wav [b.wav ...]"""
import json, os, sys

from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "tiny.en")
ROOT = os.environ.get("WHISPER_DIR", "/opt/whisper")
model = WhisperModel(MODEL, device="cpu", compute_type="int8", download_root=ROOT, cpu_threads=2)
out = []
for f in sys.argv[1:]:
    try:
        segs, _ = model.transcribe(f, beam_size=1, vad_filter=True, condition_on_previous_text=False)
        out.append(" ".join(s.text.strip() for s in segs).strip())
    except Exception as e:  # one bad window never kills the batch
        out.append("")
print(json.dumps(out))
