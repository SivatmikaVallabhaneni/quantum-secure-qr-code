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
# -----------------------------
@app.route('/generate-secure-qr', methods=['POST'])
def generate_secure_qr():
    data = request.get_json()

    if not data or "text" not in data:
        return jsonify({"error": "No text provided"}), 400

    text = data["text"]

    if not text.strip():
        return jsonify({"error": "Empty text"}), 400

    quantum_key = generate_quantum_key()
    session_id = generate_session_id()
    encrypted_result = encrypt_message(text, quantum_key)

    qr_payload = {
        "session_id": session_id,
        "encrypted_data": encrypted_result
    }

    return jsonify({
        "session_id": session_id,
        "quantum_key": quantum_key,
        "encrypted_data": encrypted_result,
        "qr_payload": qr_payload
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

        return jsonify({
            "decrypted_text": decrypted_text,
            "session_id": qr_payload.get("session_id", "Unknown")
        })

    except Exception as e:
        return jsonify({
            "error": "Decryption failed. Invalid key or corrupted data.",
            "details": str(e)
        }), 400


if __name__ == '__main__':
    app.run(port=5000, debug=True)