"""Private file storage (CVs, audio chunks) inside Firestore — no Cloud Storage bucket required.

A file is a metadata document in `blobs` plus ordered `parts` sub-documents of at most PART_BYTES
(Firestore documents are limited to 1 MiB). Writes go through one batch, so a file is stored
completely or not at all. Only the backend reads these documents; Firestore rules deny clients.
"""
from . import firebase

PART_BYTES = 512 * 1024


def _ref(path: str):
    return firebase.db().collection("blobs").document(path.replace("/", "~"))


def put(path: str, data: bytes, content_type: str) -> None:
    ref = _ref(path)
    delete(path)  # replacing a file must not leave stale trailing parts
    batch = firebase.db().batch()
    parts = [data[i:i + PART_BYTES] for i in range(0, len(data), PART_BYTES)] or [b""]
    for i, chunk in enumerate(parts):
        batch.set(ref.collection("parts").document(f"{i:04d}"), {"data": chunk})
    batch.set(ref, {"path": path, "content_type": content_type, "size": len(data), "parts": len(parts),
                    "created_at": firebase.now()})
    batch.commit()


def get(path: str) -> bytes:
    meta = _ref(path).get()
    if not meta.exists:
        raise FileNotFoundError(path)
    parts = sorted(_ref(path).collection("parts").stream(), key=lambda p: p.id)
    data = b"".join(p.get("data") for p in parts[:meta.get("parts")])
    if len(data) != meta.get("size"):
        raise IOError(f"incomplete blob {path}")
    return data


def exists(path: str) -> bool:
    return _ref(path).get().exists


def delete(path: str) -> None:
    ref = _ref(path)
    batch = firebase.db().batch()
    for p in ref.collection("parts").list_documents():
        batch.delete(p)
    batch.delete(ref)
    batch.commit()
