from flask import Flask, request, jsonify
from flask_cors import CORS
from qiskit import QuantumCircuit, transpile
from qiskit_aer import AerSimulator
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad
import base64
import hashlib
import uuid

app = Flask(__name__)
CORS(app)

# Plaintext character cap: AES-CBC + JSON wrapper must fit in one QR (model 40, byte mode ~2953 max).
# Raised for higher-quality images; frontend matches this constant.
# (A 1 MB file is allowed on upload, then scaled/encoded client-side to fit this cap.)
MAX_PLAINTEXT_CHARS = 1800
# Client may supply a key string (e.g. E91 sifted bits) instead of server-generated quantum random.
MAX_QUANTUM_KEY_CHARS = 4096


@app.route('/')
def home():
    return "Quantum Secure QR Backend is Running!"


# -----------------------------
# Quantum Key Generation
# -----------------------------
def generate_quantum_key():
    qc = QuantumCircuit(2, 2)

    qc.h(0)
    qc.cx(0, 1)
    qc.measure([0, 1], [0, 1])

    backend = AerSimulator()
    compiled_circuit = transpile(qc, backend)

    key = ""

    for _ in range(32):   # 64-bit binary key
        job = backend.run(compiled_circuit, shots=1)
        result = job.result()
        counts = result.get_counts()
        key += list(counts.keys())[0]

    return key


# -----------------------------
# Session ID
# -----------------------------
def generate_session_id():
    return "QSID-" + uuid.uuid4().hex[:10]


# -----------------------------
# AES Encryption
# -----------------------------
def encrypt_message(message, quantum_key):
    aes_key = hashlib.sha256(quantum_key.encode()).digest()

    cipher = AES.new(aes_key, AES.MODE_CBC)
    encrypted_bytes = cipher.encrypt(pad(message.encode(), AES.block_size))

    iv = base64.b64encode(cipher.iv).decode('utf-8')
    encrypted_data = base64.b64encode(encrypted_bytes).decode('utf-8')

    return {
        "iv": iv,
        "ciphertext": encrypted_data
    }


# -----------------------------
# AES Decryption
# -----------------------------
def decrypt_message(encrypted_data, quantum_key):
    aes_key = hashlib.sha256(quantum_key.encode()).digest()

    iv = base64.b64decode(encrypted_data["iv"])
    ciphertext = base64.b64decode(encrypted_data["ciphertext"])

    cipher = AES.new(aes_key, AES.MODE_CBC, iv)
    decrypted_bytes = unpad(cipher.decrypt(ciphertext), AES.block_size)

    return decrypted_bytes.decode('utf-8')


# -----------------------------
# Generate Secure QR Route
# Accepts either { "text": "..." } or { "image_base64": "...", "mime_type": "image/jpeg" }
# -----------------------------
@app.route('/generate-secure-qr', methods=['POST'])
def generate_secure_qr():
    data = request.get_json()

    if not data:
        return jsonify({"error": "No JSON body"}), 400

    media_type = "text"
    mime_type = None
    text = None

    if data.get("image_base64"):
        media_type = "image"
        mime_type = (data.get("mime_type") or "image/jpeg").strip()
        raw = data["image_base64"]
        if isinstance(raw, str) and raw.strip().startswith("data:") and "," in raw:
            raw = raw.split(",", 1)[1]
        text = raw.strip() if isinstance(raw, str) else ""
    elif "text" in data:
        text = data["text"]
        if not isinstance(text, str):
            return jsonify({"error": "text must be a string"}), 400
    else:
        return jsonify({"error": "Provide text or image_base64"}), 400

    if not text or not str(text).strip():
        return jsonify({"error": "Empty payload"}), 400

    text = str(text)
    if len(text) > MAX_PLAINTEXT_CHARS:
        return jsonify({
            "error": "Payload too large for QR capacity",
            "max_chars": MAX_PLAINTEXT_CHARS,
            "hint": "Use a smaller image or shorter text; images are auto-compressed in the app.",
        }), 400

    # Optional: key from client (simulated E91 / QKD output). Same string is required for decrypt.
    raw_key = data.get("quantum_key")
    if raw_key is not None and isinstance(raw_key, str) and raw_key.strip():
        quantum_key = raw_key.strip()
        if len(quantum_key) > MAX_QUANTUM_KEY_CHARS:
            return jsonify({
                "error": "quantum_key too long",
                "max_chars": MAX_QUANTUM_KEY_CHARS,
            }), 400
        key_source = "client_e91"
    else:
        quantum_key = generate_quantum_key()
        key_source = "server_qrng"

    session_id = generate_session_id()
    encrypted_result = encrypt_message(text, quantum_key)

    qr_payload = {
        "session_id": session_id,
        "encrypted_data": encrypted_result,
        "media_type": media_type,
    }
    if mime_type:
        qr_payload["mime_type"] = mime_type

    return jsonify({
        "session_id": session_id,
        "quantum_key": quantum_key,
        "encrypted_data": encrypted_result,
        "qr_payload": qr_payload,
        "media_type": media_type,
        "mime_type": mime_type,
        "key_source": key_source,
    })


# -----------------------------
# Decrypt Secure QR Route
# -----------------------------
@app.route('/decrypt-secure-qr', methods=['POST'])
def decrypt_secure_qr():
    data = request.get_json()

    if not data or "qr_payload" not in data or "quantum_key" not in data:
        return jsonify({"error": "Missing payload or key"}), 400

    try:
        qr_payload = data["qr_payload"]
        quantum_key = data["quantum_key"]

        encrypted_data = qr_payload["encrypted_data"]
        decrypted_text = decrypt_message(encrypted_data, quantum_key)

        media_type = qr_payload.get("media_type") or "text"
        mime_type = qr_payload.get("mime_type")

        out = {
            "decrypted_text": decrypted_text,
            "session_id": qr_payload.get("session_id", "Unknown"),
            "media_type": media_type,
        }
        if mime_type:
            out["mime_type"] = mime_type

        return jsonify(out)

    except Exception as e:
        return jsonify({
            "error": "Decryption failed. Invalid key or corrupted data.",
            "details": str(e)
        }), 400


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
